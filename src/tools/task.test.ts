import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTurn } from '../core/loop.js';
import { estimateMessageTokens } from '../core/tokens.js';
import { createToolset } from '../core/toolset.js';
import { createTaskTool } from './task.js';
import type { Tool } from '../core/tool.js';
import type { Message, Provider, ProviderRequest, ProviderResponse } from '../provider/types.js';

function scripted(
  ...responses: (ProviderResponse | Error)[]
): { provider: Provider; requests: ProviderRequest[] } {
  const queue = [...responses];
  const requests: ProviderRequest[] = [];

  return {
    requests,
    provider: {
      id: 'scripted',
      model: 'scripted',
      async send(request) {
        // 快照:runTurn 会继续往同一个数组里 push,存引用的话看到的会是最终态而不是当时那一份。
        requests.push({ ...request, messages: structuredClone(request.messages) });
        const next = queue.shift();
        if (!next) throw new Error('脚本用完了');
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

/** 一个只会吐同样一坨大文本的探查工具。 */
function bigReadTool(size: number): Tool {
  return {
    spec: { name: 'read_file', description: '读文件', inputSchema: { type: 'object' } },
    async run() {
      return 'Y'.repeat(size);
    },
  };
}

test('子任务有自己的消息历史 —— 拿不到主对话的上下文', async () => {
  const sub = scripted({ text: '结论:在 a.ts 里', toolCalls: [] });

  const tool = createTaskTool({
    provider: sub.provider,
    tools: [],
    system: '子 agent 提示',
  });

  await tool.run({ description: '找用法', prompt: '找出 readConfig 在哪被调用' });

  const first = sub.requests[0]!;

  assert.deepEqual(
    first.messages,
    [{ role: 'user', text: '找出 readConfig 在哪被调用' }],
    '子任务的历史必须从零开始 —— 一旦带上主对话,隔离就没了,它也就没有存在的理由',
  );
  assert.equal(first.tools.length, 0, '给什么用什么:这里没给工具,它就不该看到工具');
});

test('子任务用的是自己的系统提示,不是主对话那份', async () => {
  const sub = scripted({ text: '结论', toolCalls: [] });

  await createTaskTool({ provider: sub.provider, tools: [], system: '子 agent 提示' }).run({
    description: '找用法',
    prompt: '查一下',
  });

  assert.equal(sub.requests[0]!.system, '子 agent 提示');
});

test('主对话只收到结论,收不到子任务的中间过程', async () => {
  const blob = 'Z'.repeat(20_000);

  const sub = scripted(
    { text: null, toolCalls: [{ id: 's1', name: 'read_file', input: { path: 'big.ts' } }] },
    { text: '结论:big.ts 第 12 行有个 TODO。', toolCalls: [] },
  );

  const task = createTaskTool({
    provider: sub.provider,
    tools: [{ ...bigReadTool(20_000), async run() { return blob; } }],
    system: '子 agent 提示',
  });

  const main = scripted(
    { text: null, toolCalls: [{ id: 'c1', name: 'task', input: { description: '翻一下', prompt: '查 big.ts' } }] },
    { text: '好', toolCalls: [] },
  );

  const result = await runTurn(
    { provider: main.provider, tools: createToolset([task]), system: '主提示' },
    [{ role: 'user', text: 'big.ts 里有什么' }],
  );

  const text = JSON.stringify(result.messages);

  assert.match(text, /结论:big\.ts 第 12 行有个 TODO/, '结论要带回来');
  assert.ok(
    !text.includes('Z'.repeat(1_000)),
    '子 agent 读到的原文不该出现在主对话里 —— 出现了就说明隔离没做成',
  );
});

test('子任务失败时,失败信息回到主对话而不是静默消失', async () => {
  const sub = scripted(new Error('GLM 接口返回 HTTP 429:rate limit exceeded'));

  const task = createTaskTool({ provider: sub.provider, tools: [], system: '子 agent 提示' });

  const output = await task.run({ description: '翻一下', prompt: '查一下' });

  assert.match(output, /失败/, '要说清是失败了,而不是给一个空结论');
  assert.match(output, /429/, '错误原文要带上 —— 模型靠它判断该重试还是该换路');
  assert.match(output, /翻一下/, '要说是哪次子任务失败了');
});

test('主对话的上下文量不随子任务规模增长', async () => {
  async function mainConversation(subTurns: number): Promise<Message[]> {
    const calls = Array.from({ length: subTurns }, (_, index) => ({
      id: `s${index}`,
      name: 'read_file',
      input: { path: `f${index}.ts` },
    }));

    const sub = scripted(
      ...calls.map((call) => ({ text: null, toolCalls: [call] })),
      { text: '结论:一共三处。', toolCalls: [] },
    );

    const task = createTaskTool({
      provider: sub.provider,
      tools: [bigReadTool(20_000)],
      system: '子 agent 提示',
      // 要翻 40 次就得让它有 40 轮 —— 默认的 25 轮会让它半路停下,那测的就不是规模了。
      maxTurns: 60,
    });

    const main = scripted(
      { text: null, toolCalls: [{ id: 'c1', name: 'task', input: { description: '翻', prompt: '查' } }] },
      { text: '好', toolCalls: [] },
    );

    const result = await runTurn(
      { provider: main.provider, tools: createToolset([task]), system: '主提示' },
      [{ role: 'user', text: '开始' }],
    );

    return result.messages;
  }

  const small = await mainConversation(2);
  const large = await mainConversation(40);

  const smallTokens = estimateMessageTokens(small);
  const largeTokens = estimateMessageTokens(large);

  assert.equal(
    largeTokens,
    smallTokens,
    `子 agent 翻 2 个文件和翻 40 个文件,主对话占的位置必须一样 —— 这正是把它派出去的理由。实际:${smallTokens} vs ${largeTokens}`,
  );
  assert.ok(
    largeTokens < 500,
    `主对话只该多出"派出去"和"结论"两条。实际:${largeTokens}`,
  );
});

test('轮次用尽时给出可操作的说明,而不是一句空结论', async () => {
  // 子 agent 一直要工具,永远不收敛。
  const sub = scripted(
    ...Array.from({ length: 30 }, (_, index) => ({
      text: null,
      toolCalls: [{ id: `s${index}`, name: 'read_file', input: {} }],
    })),
  );

  const task = createTaskTool({
    provider: sub.provider,
    tools: [bigReadTool(10)],
    system: '子 agent 提示',
    maxTurns: 3,
  });

  const output = await task.run({ description: '翻', prompt: '查' });

  assert.match(output, /轮次上限|范围/, `要给下一步的方向。实际:${output}`);
  assert.ok(output.length > 10, '不能是空字符串 —— 那和静默失败没区别');
});

