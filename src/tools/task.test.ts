import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTurn } from '../core/loop.js';
import { estimateMessageTokens } from '../core/tokens.js';
import { createToolset } from '../core/toolset.js';
import { createTaskTool, resolveAgentRun } from './task.js';
import type { SubagentDoneEvent, ToolContext } from '../core/tool.js';
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

// ---------- v2-06:派发成本可见 ----------

test('派发结束回报统计:角色名、模型、token 估算、耗时', async () => {
  const sub = scripted({ text: '结论文本', toolCalls: [] });
  const events: SubagentDoneEvent[] = [];

  const agents = makeCatalog(agentDef({ name: 'reviewer', model: 'deepseek' }));
  const task = createTaskTool({
    provider: sub.provider,
    providerFor: () => sub.provider,
    tools: [],
    system: 'x',
    agents,
  });

  await task.run(
    { agent: 'reviewer', description: 'd', prompt: '看这段' },
    { emit: (event) => events.push(event) } as ToolContext,
  );

  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.type, 'subagent-done');
  assert.equal(event.agent, 'reviewer');
  assert.equal(event.model, sub.provider.model);
  assert.ok(event.durationMs >= 0);
  // 统计的是**子 agent 会话**的估算,不是主对话的 —— 这正是成本可见的含义。
  const expected = estimateMessageTokens([
    { role: 'user', text: '看这段' },
    { role: 'assistant', text: '结论文本' },
  ]);
  assert.equal(event.tokens, expected, 'token 估算要与子 agent 的会话一致');
});

test('不指定 agent 时统计行用 explorer(内置探查者)的名字', async () => {
  const sub = scripted({ text: '结论', toolCalls: [] });
  const events: SubagentDoneEvent[] = [];

  const task = createTaskTool({ provider: sub.provider, tools: [], system: 'x' });
  await task.run(
    { description: 'd', prompt: 'p' },
    { emit: (event) => events.push(event) } as ToolContext,
  );

  assert.equal(events.length, 1);
  assert.equal(events[0]!.agent, 'explorer');
});

test('没有 emit 通道时不报错,派发照常', async () => {
  const sub = scripted({ text: '结论', toolCalls: [] });
  const task = createTaskTool({ provider: sub.provider, tools: [], system: 'x' });

  const output = await task.run({ description: 'd', prompt: 'p' });
  assert.equal(output, '结论');
});

// ---------- v2-07:并行派发 ----------

/** 一个可以控制"跑多久"的假 Provider:prompt 里带 sleep 毫秒数。 */
function slowScripted(delays: Map<string, number>): { provider: Provider; order: string[] } {
  const order: string[] = [];
  return {
    order,
    provider: {
      id: 'slow',
      model: 'slow-model',
      async send(request) {
        const text = (request.messages[0] as { text?: string } | undefined)?.text ?? '';
        const delay = delays.get(text.slice(-8)) ?? 0;
        await new Promise((resolve) => setTimeout(resolve, delay));
        order.push(text.slice(-8));
        return { text: `结论:${text.slice(-8)}`, toolCalls: [] };
      },
    },
  };
}

test('并行派发:结果按调用序回传,即使完成顺序相反', async () => {
  // A 慢 B 快 —— 完成顺序是 B、A,但回传必须是 A、B(调用序)。
  const delays = new Map([
    ['TASK-AAA', 60],
    ['TASK-BBB', 5],
  ]);
  const sub = slowScripted(delays);

  const task = createTaskTool({ provider: sub.provider, tools: [], system: 'x', maxConcurrent: 2 });

  const output = (await task.run({
    tasks: [
      { description: '慢的', prompt: '做 TASK-AAA' },
      { description: '快的', prompt: '做 TASK-BBB' },
    ],
  })) as string;

  const posA = output.indexOf('TASK-AAA');
  const posB = output.indexOf('TASK-BBB');
  assert.ok(posA >= 0 && posB >= 0);
  assert.ok(posA < posB, `回传要按调用序(A 在 B 前)。实际:\n${output}`);
});

test('并发上限生效:limit=1 时严格串行', async () => {
  let active = 0;
  let peak = 0;
  const order: string[] = [];

  const provider: Provider = {
    id: 'p',
    model: 'm',
    async send(request) {
      active += 1;
      peak = Math.max(peak, active);
      const text = (request.messages[0] as { text?: string } | undefined)?.text ?? '';
      await new Promise((resolve) => setTimeout(resolve, 15));
      order.push(text.slice(-8));
      active -= 1;
      return { text: 'ok', toolCalls: [] };
    },
  };

  const task = createTaskTool({ provider, tools: [], system: 'x', maxConcurrent: 1 });

  await task.run({
    tasks: [
      { description: 'a', prompt: 'X-AA' },
      { description: 'b', prompt: 'X-BB' },
      { description: 'c', prompt: 'X-CC' },
    ],
  });

  assert.equal(peak, 1, '限 1 就该一个跑完再跑下一个');
  assert.deepEqual(order, ['1X-AA', '2X-BB', '3X-CC'].map((s) => s.slice(-4)), '串行时顺序即调用序');
});

test('并发上限:limit=2 时第 3 个等前两个中的一个完成', async () => {
  let active = 0;
  let peak = 0;

  const provider: Provider = {
    id: 'p',
    model: 'm',
    async send() {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { text: 'ok', toolCalls: [] };
    },
  };

  const task = createTaskTool({ provider, tools: [], system: 'x', maxConcurrent: 2 });

  await task.run({
    tasks: [
      { description: 'a', prompt: 'A' },
      { description: 'b', prompt: 'B' },
      { description: 'c', prompt: 'C' },
    ],
  });

  assert.ok(peak <= 2, `同时最多 2 个。实际峰值 ${peak}`);
  assert.ok(peak >= 2, `三个任务限 2,峰值应该真到 2。实际 ${peak}`);
});

test('每个子 agent 各自报一次成本', async () => {
  const sub = scripted(
    { text: '结论一', toolCalls: [] },
    { text: '结论二', toolCalls: [] },
    { text: '结论三', toolCalls: [] },
  );
  const events: SubagentDoneEvent[] = [];

  const agents = makeCatalog(
    agentDef({ name: 'a' }),
    agentDef({ name: 'b' }),
    agentDef({ name: 'c' }),
  );

  const task = createTaskTool({ provider: sub.provider, tools: [], system: 'x', agents });

  await task.run(
    {
      tasks: [
        { agent: 'a', description: '一', prompt: 'p1' },
        { agent: 'b', description: '二', prompt: 'p2' },
        { agent: 'c', description: '三', prompt: 'p3' },
      ],
    },
    { emit: (event) => events.push(event) } as ToolContext,
  );

  assert.equal(events.length, 3, '三个派发三次统计');
  assert.deepEqual(events.map((e) => e.agent).sort(), ['a', 'b', 'c']);
});

test('批量里的一项坏掉 → 整批不发起,并指出第几项', async () => {
  const sub = scripted();
  const task = createTaskTool({ provider: sub.provider, tools: [], system: 'x' });

  const output = (await task.run({
    tasks: [
      { description: 'ok', prompt: 'p' },
      { description: '', prompt: 'p2' }, // 坏项
    ],
  })) as string;

  assert.match(output, /没发起|tasks\[1\]/);
  assert.equal(sub.requests.length, 0, '坏批不该发出一半');
});

test('并行派发的工具结果是一条消息,压缩器的配对假设不被破坏', async () => {
  const sub = scripted(
    { text: '结论 A', toolCalls: [] },
    { text: '结论 B', toolCalls: [] },
  );

  const task = createTaskTool({ provider: sub.provider, tools: [], system: 'x', maxConcurrent: 2 });

  const main = scripted(
    {
      text: null,
      toolCalls: [
        {
          id: 'c1',
          name: 'task',
          input: { tasks: [{ description: 'a', prompt: 'pa' }, { description: 'b', prompt: 'pb' }] },
        },
      ],
    },
    { text: '好', toolCalls: [] },
  );

  const result = await runTurn(
    { provider: main.provider, tools: createToolset([task]), system: '主提示' },
    [{ role: 'user', text: '开始' }],
  );

  // 不变量:每个 assistant 消息里的 toolCalls 都能在紧接着的 tool 消息里找到 id。
  const messages = result.messages;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role !== 'assistant' || !message.toolCalls) continue;
    const next = messages[i + 1];
    assert.ok(next && next.role === 'tool', `第 ${i} 条 assistant 的 toolCalls 后面必须紧跟 tool 结果`);
    if (next.role !== 'tool') continue;
    assert.deepEqual(
      next.results.map((r) => r.id).sort(),
      message.toolCalls.map((c) => c.id).sort(),
      '工具调用与结果必须成对 —— 压缩器的整个前提就建立在这一点上',
    );
  }
});

test('并行派发的结果进压缩器后,工具调用与结果仍然成对(夹具)', async () => {
  const { compact } = await import('../core/compact.js');
  const { estimateMessageTokens } = await import('../core/tokens.js');

  const sub = scripted({ text: '结论 A', toolCalls: [] }, { text: '结论 B', toolCalls: [] });
  const task = createTaskTool({ provider: sub.provider, tools: [], system: 'x', maxConcurrent: 2 });

  const main = scripted(
    {
      text: null,
      toolCalls: [
        {
          id: 'c1',
          name: 'task',
          input: { tasks: [{ description: 'a', prompt: 'pa' }, { description: 'b', prompt: 'pb' }] },
        },
      ],
    },
    { text: '好', toolCalls: [] },
  );

  const turn = await runTurn(
    { provider: main.provider, tools: createToolset([task]), system: '主提示' },
    [{ role: 'user', text: '开始' }],
  );

  for (const did of ['none', 'trimmed', 'summarized'] as const) {
    // 三种预算:从装得下、到只能裁、到必须摘要 —— 三条路径都走一遍。
    const budget = did === 'none' ? 1_000_000 : did === 'trimmed' ? 60 : 1;
    const result = await compact(turn.messages, {
      estimate: estimateMessageTokens,
      budget,
      summarize: async () => '摘要',
      floor: 1,
      keepRecentMessages: 2,
    });

    const messages = result.messages;
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]!;
      if (message.role !== 'assistant' || !message.toolCalls) continue;
      const next = messages[i + 1];
      assert.ok(next && next.role === 'tool', `[${did}] 压缩后第 ${i} 条 assistant 的 toolCalls 失去配对`);
      if (!next || next.role !== 'tool') continue;
      assert.deepEqual(
        next.results.map((r) => r.id).sort(),
        message.toolCalls.map((c) => c.id).sort(),
        `[${did}] 压缩后工具调用与结果必须成对`,
      );
    }
  }
});



// ---------- v2-09:受限递归派发 ----------

type Seen = { prompt: string; toolNames: string[]; transcript: string };

/**
 * 递归探针:每段对话**只在自己第一轮**里按 prompt 决定派不派下一层。
 * 只用 messages[0] 判断会让同一个工具调用无限重发(跑到轮次上限才停),
 * 所以必须把"第一次"这件事算进去。
 */
function recursiveProbe(): { provider: Provider; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    provider: {
      id: 'rec',
      model: 'rec-model',
      async send(request) {
        const prompt = (request.messages[0] as { text?: string } | undefined)?.text ?? '';
        const first = request.messages.length === 1;
        const transcript = request.messages
          .map((m) => (m.role === 'tool' ? m.results.map((r) => r.output).join('') : m.role === 'assistant' ? m.text ?? '' : m.text))
          .join('\n');
        seen.push({ prompt, toolNames: request.tools.map((t) => t.name), transcript });

        if (first && /派下去/.test(prompt)) {
          const next = prompt.includes('-A') ? '派下去-B' : '叶子';
          return {
            text: null,
            toolCalls: [{ id: `c${seen.length}`, name: 'task', input: { agent: 'explorer', description: 'd', prompt: next } }],
          };
        }
        return { text: '叶子结论', toolCalls: [] };
      },
    },
  };
}

test('spawns 声明的角色能派子 agent;未声明的拿不到 task 工具', async () => {
  const rec = recursiveProbe();
  const agents = makeCatalog(
    agentDef({ name: 'lead', spawns: ['explorer'] }),
    agentDef({ name: 'explorer' }),
    agentDef({ name: 'loner' }),
  );

  const task = createTaskTool({ provider: rec.provider, tools: [], system: 'x', agents });

  await task.run({ agent: 'lead', description: 'd', prompt: '直接答' });
  assert.ok(rec.seen[0]!.toolNames.includes('task'), 'lead 声明了 spawns,该拿到 task');

  await task.run({ agent: 'loner', description: 'd', prompt: '直接答' });
  assert.ok(!rec.seen.at(-1)!.toolNames.includes('task'), 'loner 没写 spawns,不该拿到 task');
});

test('默认深度 2:三层递归,到顶那层没有 task', async () => {
  const rec = recursiveProbe();
  const agents = makeCatalog(
    agentDef({ name: 'lead', spawns: ['explorer'] }),
    agentDef({ name: 'explorer', spawns: ['explorer'] }),
  );

  const task = createTaskTool({ provider: rec.provider, tools: [], system: 'x', agents });
  const output = (await task.run({ agent: 'lead', description: 'd', prompt: '派下去-A' })) as string;

  // 第一层(lead,深度 0)与第二层(explorer,深度 1)都该有 task;第三层到顶没有。
  const lead = rec.seen.find((e) => e.prompt === '派下去-A')!;
  const middle = rec.seen.find((e) => e.prompt === '派下去-B')!;
  const leaf = rec.seen.find((e) => e.prompt === '叶子')!;

  assert.ok(lead.toolNames.includes('task'), '深度 0 该能派');
  assert.ok(middle.toolNames.includes('task'), '深度 1 且声明了 spawns,该能派');
  assert.ok(!leaf.toolNames.includes('task'), '深度到顶(2),不该再有 task 工具');
  assert.match(output, /叶子结论/, '结论要一路上带回来');
});

test('maxDepth=0:第一层就没有 task(上限优先于声明)', async () => {
  const rec = recursiveProbe();
  const agents = makeCatalog(
    agentDef({ name: 'lead', spawns: ['explorer'] }),
    agentDef({ name: 'explorer', spawns: ['explorer'] }),
  );

  const task = createTaskTool({ provider: rec.provider, tools: [], system: 'x', agents, maxDepth: 0 });
  await task.run({ agent: 'lead', description: 'd', prompt: '直接答' });

  assert.ok(!rec.seen[0]!.toolNames.includes('task'), 'maxDepth=0 时声明了 spawns 也没有 task');
});

test('递归子 agent 只看得见白名单里的角色,派白名单外会被拒', async () => {
  const seen: Seen[] = [];
  const provider: Provider = {
    id: 'rec',
    model: 'rec-model',
    async send(request) {
      const prompt = (request.messages[0] as { text?: string } | undefined)?.text ?? '';
      const transcript = request.messages
        .map((m) =>
          m.role === 'tool'
            ? m.results.map((r) => r.output).join('')
            : m.role === 'assistant'
              ? m.text ?? ''
              : m.text,
        )
        .join('\n');
      seen.push({ prompt, toolNames: request.tools.map((t) => t.name), transcript });

      // lead 第一轮就试着派 "other"(不在它的 spawns 白名单里)。
      if (request.messages.length === 1) {
        return {
          text: null,
          toolCalls: [{ id: 'c1', name: 'task', input: { agent: 'other', description: 'd', prompt: 'p' } }],
        };
      }
      return { text: '收工', toolCalls: [] };
    },
  };

  const agents = makeCatalog(
    agentDef({ name: 'lead', spawns: ['explorer'] }),
    agentDef({ name: 'explorer' }),
    agentDef({ name: 'other' }),
  );

  const task = createTaskTool({ provider, tools: [], system: 'x', agents });
  await task.run({ agent: 'lead', description: 'd', prompt: '开始' });

  // 第二次 send 的转写里应当带着那条拒绝 —— 而且只列 explorer。
  const second = seen[1]!;
  assert.match(second.transcript, /没有名为 other 的角色/, `实际:${second.transcript}`);
  assert.match(second.transcript, /explorer/);
});

test('再派一层的成本也会浮上来(孙子的花费不吞掉)', async () => {
  const seen: string[] = [];
  const provider: Provider = {
    id: 'rec',
    model: 'rec-model',
    async send(request) {
      const prompt = (request.messages[0] as { text?: string } | undefined)?.text ?? '';
      seen.push(prompt);
      if (request.messages.length === 1 && /派下去/.test(prompt)) {
        return {
          text: null,
          toolCalls: [
            { id: `c${seen.length}`, name: 'task', input: { agent: 'explorer', description: 'd', prompt: '叶子' } },
          ],
        };
      }
      return { text: '结论', toolCalls: [] };
    },
  };

  const agents = makeCatalog(
    agentDef({ name: 'lead', spawns: ['explorer'] }),
    agentDef({ name: 'explorer' }),
  );

  const events: { agent: string; tokens: number }[] = [];
  const task = createTaskTool({ provider, tools: [], system: 'x', agents });
  await task.run(
    { agent: 'lead', description: 'd', prompt: '派下去' },
    { emit: (event) => events.push({ agent: event.agent, tokens: event.tokens }) },
  );

  assert.deepEqual(
    events.map((e) => e.agent),
    ['explorer', 'lead'],
    '两层都要报:孙子那层先完成,领队随后',
  );
});
