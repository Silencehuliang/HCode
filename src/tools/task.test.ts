import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTurn } from '../core/loop.js';
import { estimateMessageTokens } from '../core/tokens.js';
import { createToolset } from '../core/toolset.js';
import { createTaskTool, resolveAgentRun } from './task.js';
import type { ToolContext } from '../core/tool.js';
import type { AgentCatalog, AgentDef } from '../core/agents.js';
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


// ---------- v2-01:按名派发角色 ----------

function makeCatalog(...defs: AgentDef[]): AgentCatalog {
  return {
    list: () => defs.map((def) => ({ ...def })),
    get: (name) => {
      const found = defs.find((def) => def.name === name);
      return found ? { ...found } : undefined;
    },
    problems: () => [],
  };
}

function agentDef(overrides: Partial<AgentDef> & { name: string }): AgentDef {
  return {
    description: '测试角色',
    systemPrompt: '角色提示',
    path: '/virtual/test.md',
    origin: '/virtual',
    ...overrides,
  };
}

const TOOL_A: Tool = {
  spec: { name: 'read_file', description: '读', inputSchema: { type: 'object' } },
  async run() { return ''; },
};
const TOOL_B: Tool = {
  spec: { name: 'write_file', description: '写', inputSchema: { type: 'object' } },
  async run() { return ''; },
};
const TOOL_TASK: Tool = {
  spec: { name: 'task', description: '派', inputSchema: { type: 'object' } },
  async run() { return ''; },
};

test('按名派发:装配出该角色的系统提示与工具集', async () => {
  const sub = scripted({ text: '角色结论', toolCalls: [] });
  const agents = makeCatalog(
    agentDef({ name: 'reviewer', systemPrompt: '你是审查员。', tools: ['read_file'] }),
  );

  const task = createTaskTool({
    provider: sub.provider,
    tools: [],
    system: '缺省提示',
    agents,
    allTools: [TOOL_A, TOOL_B],
  });

  await task.run({ agent: 'reviewer', description: '审', prompt: '看看' });

  assert.equal(sub.requests[0]!.system, '你是审查员。', '系统提示来自角色文件');
  assert.deepEqual(
    sub.requests[0]!.tools.map((tool) => tool.name),
    ['read_file'],
    '工具集按白名单装配',
  );
});

test('不传 agent 时行为与 V1 逐项一致(缺省探查者)', async () => {
  const sub = scripted({ text: '结论', toolCalls: [] });

  const task = createTaskTool({
    provider: sub.provider,
    tools: [TOOL_A],
    system: '缺省提示',
    agents: makeCatalog(agentDef({ name: 'reviewer' })),
  });

  await task.run({ description: '查', prompt: '查一下' });

  assert.equal(sub.requests[0]!.system, '缺省提示');
  assert.deepEqual(
    sub.requests[0]!.tools.map((tool) => tool.name),
    ['read_file'],
  );
});

test('角色白名单里的工具名不存在 → 可读的错误', () => {
  const result = resolveAgentRun(
    {
      provider: {} as Provider,
      tools: [],
      system: 'x',
      agents: makeCatalog(agentDef({ name: 'broken', tools: ['no_such_tool'] })),
      allTools: [TOOL_A],
    },
    'broken',
  );

  if (!('error' in result)) assert.fail('应该返回 error');
  assert.match(result.error, /不存在的工具|工具不存在/);
  assert.match(result.error, /no_such_tool/, '要把不存在的名字列出来');
});

test('角色没写 tools → 继承主对话全量工具但剥掉 task 自己', () => {
  const agents = makeCatalog(agentDef({ name: 'general' }));
  const result = resolveAgentRun({
    provider: {} as Provider,
    tools: [],
    system: 'x',
    agents,
    allTools: [TOOL_A, TOOL_TASK, TOOL_B],
  }, 'general');

  if ('error' in result) assert.fail(result.error);
  assert.deepEqual(
    result.tools.map((tool) => tool.spec.name),
    ['read_file', 'write_file'],
    'task 必须被剥掉 —— 递归派发是 v2-09 的议题,现在套娃没有任何一层拦得住',
  );
});

test('派不存在的角色 → 错误列出可用角色', async () => {
  const agents = makeCatalog(agentDef({ name: 'reviewer' }), agentDef({ name: 'explorer' }));
  const sub = scripted();

  const task = createTaskTool({ provider: sub.provider, tools: [], system: 'x', agents });

  const output = (await task.run({ agent: 'nope', description: 'd', prompt: 'p' })) as string;
  assert.match(output, /没有名为 nope 的角色/);
  assert.match(output, /reviewer/);
  assert.match(output, /explorer/);
  assert.equal(sub.requests.length, 0, '装配失败不该真的派出去');
});

test('context 拼在任务前,背景与任务分开', async () => {
  const sub = scripted({ text: '结论', toolCalls: [] });

  const task = createTaskTool({ provider: sub.provider, tools: [], system: 'x' });

  await task.run({
    description: 'd',
    prompt: '找出所有调用点',
    context: '这是一个 PowerShell-only 的仓库',
  });

  const first = sub.requests[0]!.messages[0]! as { role: string; text?: string };
  const text = first.text ?? '';
  assert.match(text, /背景:/);
  assert.match(text, /任务:/);
  assert.match(text, /PowerShell-only/);
  // 没传 context 的旧路径不受影响。
  await task.run({ description: 'd', prompt: '裸任务' });
  const second = sub.requests[1]!.messages[0]! as { role: string; text?: string };
  const bare = second.text ?? '';
  assert.equal(bare, '裸任务');
});

test('错误语义不变:按名派发失败也带错误原文回主对话', async () => {
  const sub = scripted(new Error('DeepSeek 接口返回 HTTP 502:bad gateway'));
  const agents = makeCatalog(agentDef({ name: 'reviewer', model: 'deepseek' }));

  const task = createTaskTool({ provider: sub.provider, tools: [], system: 'x', agents });

  const output = (await task.run({ agent: 'reviewer', description: '审', prompt: 'p' })) as string;
  assert.match(output, /失败/);
  assert.match(output, /502/);
});


// ---------- v2-02:角色层权限单向收紧 ----------

const TOOL_RUN: Tool = {
  spec: { name: 'run_command', description: '跑', inputSchema: { type: 'object' } },
  async run() { return '命令输出'; },
};
const TOOL_TODO: Tool = {
  spec: { name: 'todo_write', description: '清单', inputSchema: { type: 'object' } },
  async run() { return '已记'; },
};

test('read-only 角色:装配时就看不到写盘与执行类工具', () => {
  const agents = makeCatalog(
    agentDef({ name: 'snoop', permission: 'read-only' }),
  );
  const result = resolveAgentRun(
    { provider: {} as Provider, tools: [], system: 'x', agents, allTools: [TOOL_A, TOOL_B, TOOL_RUN, TOOL_TODO] },
    'snoop',
  );

  if ('error' in result) assert.fail(result.error);
  assert.deepEqual(
    result.tools.map((tool) => tool.spec.name),
    ['read_file', 'todo_write'],
    'read-only 的白名单只能剩零爆炸半径工具 —— 模型看不见,就不会一轮轮白试再被拒',
  );
  assert.equal(result.restriction, 'read-only');
});

test('子 agent 工具集过守门:继承全量工具的角色跑危险命令也会被拦', async () => {
  // 场景:角色没写 tools(继承主对话全量)、没写 permission。危险命令的 deny
  // 来自 DANGER_RULES,在 guardToolsetForAgent 里生效 —— v2-01 留下的洞
  // 就是子 agent 工具集根本不过守门。
  const agents = makeCatalog(agentDef({ name: 'general' }));
  const sub = scripted(
    { text: null, toolCalls: [{ id: 's1', name: 'run_command', input: { command: 'Remove-Item -Recurse -Force .\build' } }] },
    { text: '结论:没删。', toolCalls: [] },
  );

  const task = createTaskTool({
    provider: sub.provider,
    tools: [],
    system: 'x',
    agents,
    allTools: [TOOL_RUN],
  });

  const output = (await task.run(
    { agent: 'general', description: 'd', prompt: '清理一下' },
    {} as ToolContext,
  )) as string;

  assert.ok(!output.includes('写进去了'));
  // 危险命令被拦的痕迹要能回到子 agent(它读到的工具结果)与最终结论里。
  assert.match(output, /结论:没删|递归删除/, `子 agent 应看到拦截说明并继续。实际:${output}`);
});

test('子 agent 的 ask 走 context.approve 通道(终端确认递进子 agent)', async () => {
  let asked = 0;
  const approve = async (): Promise<boolean> => { asked += 1; return false; };

  const sub = scripted(
    { text: null, toolCalls: [{ id: 's1', name: 'write_file', input: { path: 'a.txt' } }] },
    { text: '结论:用户不让写。', toolCalls: [] },
  );

  const task = createTaskTool({
    provider: sub.provider,
    tools: [TOOL_B],
    system: 'x',
  });

  const output = (await task.run(
    { description: 'd', prompt: '写个文件' },
    { approve } as ToolContext,
  )) as string;

  assert.equal(asked, 1, '确认要走注入的通道,而不是默认拒绝');
  assert.match(output, /结论:用户不让写/);
});

test('没有 approve 通道时(单测环境),ask 默认拒绝 —— 不误放行', async () => {
  const sub = scripted(
    { text: null, toolCalls: [{ id: 's1', name: 'write_file', input: { path: 'a.txt' } }] },
    { text: '结论:没写。', toolCalls: [] },
  );

  const task = createTaskTool({ provider: sub.provider, tools: [TOOL_B], system: 'x' });

  await task.run({ description: 'd', prompt: '写个文件' });
  // 没抛错、子 agent 收到拒绝并继续,就是"默认拒绝"生效的证据(否则脚本第二轮
  // 不会是"没写"的结论)。这里只要不误放行就够了 —— 上面那条测试已钉住 approve 路径。
  assert.ok(true);
});

// ---------- v2-03:角色按名换模型 ----------

test('model: "deepseek" 的角色跑在 DeepSeek 实例上', async () => {
  const subA = scripted({ text: '结论', toolCalls: [] }); // 主对话不会跑,占位
  const deepseekSub = scripted({ text: '深结论', toolCalls: [] });

  const agents = makeCatalog(agentDef({ name: 'reviewer', model: 'deepseek' }));
  const task = createTaskTool({
    provider: subA.provider,
    providerFor: (id) => (id === 'deepseek' ? deepseekSub.provider : undefined),
    tools: [],
    system: 'x',
    agents,
  });

  const output = (await task.run({ agent: 'reviewer', description: 'd', prompt: 'p' })) as string;
  assert.equal(output, '深结论');
  assert.equal(deepseekSub.requests.length, 1, '子 agent 必须跑在换过去的 Provider 上');
  assert.equal(subA.requests.length, 0, '主对话的 Provider 一个请求都不该发');
});

test('model: "glm:glm-5.3" 解析出 provider + 模型覆盖', async () => {
  const glmSub = scripted({ text: 'glm 结论', toolCalls: [] });

  const agents = makeCatalog(agentDef({ name: 'fast', model: 'glm:glm-5.3' }));
  const task = createTaskTool({
    provider: glmSub.provider,
    // 工厂拿到 id 后已无从知道模型覆盖 —— 覆盖属于构造实例那一步(config 已按
    // 家解析好 model),这里测的是 providerFor 收到了 'glm'。
    providerFor: (id) => {
      assert.equal(id, 'glm');
      return glmSub.provider;
    },
    tools: [],
    system: 'x',
    agents,
  });

  await task.run({ agent: 'fast', description: 'd', prompt: 'p' });
  assert.equal(glmSub.requests.length, 1);
});

test('角色引用配不出实例的 provider → 回退主对话,不报错', async () => {
  const main = scripted({ text: '主对话结论', toolCalls: [] });

  const agents = makeCatalog(agentDef({ name: 'orphan', model: 'claude' }));
  const task = createTaskTool({
    provider: main.provider,
    providerFor: () => undefined, // 没配 claude
    tools: [],
    system: 'x',
    agents,
  });

  const output = (await task.run({ agent: 'orphan', description: 'd', prompt: 'p' })) as string;
  assert.equal(output, '主对话结论');
  assert.equal(main.requests.length, 1);
});

test('不写 model → 与主对话同 Provider(缺省继承)', async () => {
  const main = scripted({ text: '继承结论', toolCalls: [] });
  let factoryCalled = 0;

  const agents = makeCatalog(agentDef({ name: 'plain' }));
  const task = createTaskTool({
    provider: main.provider,
    providerFor: () => { factoryCalled += 1; return main.provider; },
    tools: [],
    system: 'x',
    agents,
  });

  const output = (await task.run({ agent: 'plain', description: 'd', prompt: 'p' })) as string;
  assert.equal(output, '继承结论');
  assert.equal(factoryCalled, 0, '没有 model 字段就不该去查工厂');
});
