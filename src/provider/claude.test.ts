import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLAUDE_API_VERSION,
  CLAUDE_DEFAULT_MAX_TOKENS,
  createClaudeProvider,
} from './claude.js';
import {
  claudeError,
  claudeRateLimited,
  claudeText,
  claudeThinkingToolCall,
  claudeToolCall,
} from './fixtures/claude.js';
import { failed, fakeTransport, ok } from './testing/fake-transport.js';

/**
 * Anthropic 的适配器。
 *
 * 这家与另外两家的线格式**没有**共同点:system 是顶层参数、工具结果装在 user 消息
 * 里、工具声明叫 input_schema、max_tokens 必填。所以它在 chat-completions.ts 之外
 * 独立实现,这里的断言也一条都不共用。
 *
 * 夹具是手写的(见 fixtures/claude.ts 抬头)—— 手上没有 Anthropic 密钥。这些测试
 * 钉住的是"我们发出去的形状对不对",不是"厂商真的这么回"。
 */

const CONFIG = { apiKey: '测试密钥', model: 'claude-sonnet-5-5' };

test('system 是顶层参数,tools 用 input_schema,认证走 x-api-key', async () => {
  const transport = fakeTransport([ok(claudeText)]);

  await createClaudeProvider({ ...CONFIG, transport }).send({
    system: '你是一个编程助手。',
    messages: [{ role: 'user', text: '看一下当前目录' }],
    tools: [
      {
        name: 'run_command',
        description: '在 PowerShell 里执行一条命令。',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ],
  });

  const body = transport.sentBody() as Record<string, unknown>;

  assert.equal(transport.sentUrl(), 'https://api.anthropic.com/v1/messages');
  assert.equal(transport.sentHeaders()['x-api-key'], '测试密钥');
  assert.equal(transport.sentHeaders()['anthropic-version'], CLAUDE_API_VERSION);
  assert.equal(
    transport.sentHeaders()['authorization'],
    undefined,
    'Anthropic 不认 Authorization: Bearer —— 发过去只会得到 401',
  );

  assert.equal(
    body['max_tokens'],
    CLAUDE_DEFAULT_MAX_TOKENS,
    'max_tokens 在 Anthropic 这边是必填的,别家不填有默认值,它不填直接 400',
  );
  assert.deepEqual(
    body['tools'],
    [
      {
        name: 'run_command',
        description: '在 PowerShell 里执行一条命令。',
        input_schema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ],
    '工具声明这边叫 input_schema,不是 parameters',
  );
  assert.equal(
    typeof body['system'],
    'object',
    '开了缓存时 system 是内容块数组 —— 缓存的标记要打在块上,字符串挂不住',
  );
});

test('工具调用与工具结果:块在 content 里,结果装在 user 消息中', async () => {
  const transport = fakeTransport([ok(claudeText)]);

  await createClaudeProvider({ ...CONFIG, transport }).send({
    system: 'sys',
    messages: [
      { role: 'user', text: '看一下当前目录' },
      {
        role: 'assistant',
        text: '我看一下当前目录。',
        toolCalls: [
          { id: 'toolu_1', name: 'run_command', input: { command: 'Get-Location' } },
          { id: 'toolu_2', name: 'run_command', input: { command: 'Get-Date' } },
        ],
      },
      {
        role: 'tool',
        results: [
          { id: 'toolu_1', output: 'exit code: 0' },
          { id: 'toolu_2', output: 'exit code: 0' },
        ],
      },
    ],
    tools: [],
  });

  const body = transport.sentBody() as { messages: { role: string; content: unknown[] }[] };

  assert.deepEqual(
    body.messages.map((m) => m.role),
    ['user', 'assistant', 'user'],
    '工具结果没有 tool 角色,它是 user 消息里的一种内容块',
  );
  assert.deepEqual(body.messages[1]?.content, [
    { type: 'text', text: '我看一下当前目录。' },
    { type: 'tool_use', id: 'toolu_1', name: 'run_command', input: { command: 'Get-Location' } },
    { type: 'tool_use', id: 'toolu_2', name: 'run_command', input: { command: 'Get-Date' } },
  ]);
  assert.deepEqual(
    (body.messages[2]?.content as { type: string }[]).map((b) => b.type),
    ['tool_result', 'tool_result'],
    '并行调用的两个结果要装进**同一条** user 消息,分成两条会被接口拒绝',
  );
});

test('相邻的同角色消息合并,空的 assistant 整条丢掉', async () => {
  const transport = fakeTransport([ok(claudeText)]);

  await createClaudeProvider({ ...CONFIG, transport }).send({
    system: 'sys',
    messages: [
      { role: 'user', text: '第一句' },
      { role: 'assistant', text: null },
      { role: 'assistant', text: '第二句' },
      { role: 'assistant', text: '第三句' },
    ],
    tools: [],
  });

  const body = transport.sentBody() as { messages: { role: string; content: unknown[] }[] };

  assert.deepEqual(
    body.messages.map((m) => m.role),
    ['user', 'assistant'],
    '连着两条 assistant 会被接口拒绝 —— 一次只发文本、紧接着又有一轮工具调用时就会撞上',
  );
  assert.deepEqual(
    (body.messages[1]?.content as { text?: string }[]).map((b) => b.text),
    ['第二句', '第三句'],
    '既没文本也没工具调用的 assistant 是空 content 数组,那是接口错误,整条丢掉',
  );
});

test('解析响应:文本与 tool_use 块分开取,input 已经是对象', async () => {
  const plain = fakeTransport([ok(claudeText)]);
  const plainReply = await createClaudeProvider({ ...CONFIG, transport: plain }).send({
    system: 'sys',
    messages: [],
    tools: [],
  });
  assert.equal(plainReply.text, '收到');
  assert.deepEqual(plainReply.toolCalls, []);

  const calling = fakeTransport([ok(claudeToolCall)]);
  const callingReply = await createClaudeProvider({ ...CONFIG, transport: calling }).send({
    system: 'sys',
    messages: [],
    tools: [],
  });
  assert.equal(callingReply.text, '我看一下当前目录。');
  assert.deepEqual(
    callingReply.toolCalls,
    [{ id: 'toolu_01A09q90qw90lq917835lq9', name: 'run_command', input: { command: 'Get-Location' } }],
    '这边的 input 已经是对象,不像另两家是 JSON 字符串 —— 两边都 JSON.parse 会炸',
  );
});

test('开了 thinking 时,上一轮的原始 content 必须一字不差地送回去', async () => {
  const first = fakeTransport([ok(claudeThinkingToolCall)]);
  const reply = await createClaudeProvider({
    ...CONFIG,
    thinking: { enabled: true },
    transport: first,
  }).send({ system: 'sys', messages: [{ role: 'user', text: '看一下当前目录' }], tools: [] });

  assert.ok(reply.vendorState, 'thinking 块没有内部表示,只能原样存下来');

  // 第二轮:上一轮的 assistant 带着 vendorState 回去。
  const second = fakeTransport([ok(claudeText)]);
  await createClaudeProvider({ ...CONFIG, thinking: { enabled: true }, transport: second }).send({
    system: 'sys',
    messages: [
      { role: 'user', text: '看一下当前目录' },
      {
        role: 'assistant',
        text: null,
        toolCalls: reply.toolCalls,
        vendorState: reply.vendorState,
      },
      { role: 'tool', results: [{ id: reply.toolCalls[0]!.id, output: 'exit code: 0' }] },
    ],
    tools: [],
  });

  const body = second.sentBody() as { messages: { role: string; content: unknown[] }[] };
  assert.deepEqual(
    body.messages[1]?.content,
    claudeThinkingToolCall.content,
    'Anthropic 要求 thinking 块连同 signature 原封不动地回去,少一块就 400',
  );

  const thinking = (body.messages[1]?.content as { type: string }[])[0];
  assert.equal(thinking?.type, 'thinking');
});

test('缓存断点打在 system 与最后一条消息的末尾', async () => {
  const transport = fakeTransport([ok(claudeText)]);

  await createClaudeProvider({ ...CONFIG, transport }).send({
    system: 'sys',
    messages: [
      { role: 'user', text: '第一句' },
      { role: 'assistant', text: '第二句' },
      { role: 'user', text: '第三句' },
    ],
    tools: [],
  });

  const body = transport.sentBody() as {
    system: { cache_control?: unknown }[];
    messages: { content: Record<string, unknown>[] }[];
  };

  assert.deepEqual(body.system[0]?.cache_control, { type: 'ephemeral' });
  assert.deepEqual(
    body.messages.at(-1)?.content.at(-1)?.['cache_control'],
    { type: 'ephemeral' },
    'Anthropic 的缓存是"从头到断点"的前缀,断点打在末尾才盖得住整段对话',
  );
});

test('cache: false 时一个断点都不打', async () => {
  const transport = fakeTransport([ok(claudeText)]);

  await createClaudeProvider({ ...CONFIG, cache: false, transport }).send({
    system: 'sys',
    messages: [{ role: 'user', text: '第一句' }],
    tools: [],
  });

  const body = transport.sentBody() as {
    system: unknown;
    messages: { content: Record<string, unknown>[] }[];
  };

  assert.equal(
    body.system,
    'sys',
    '关掉缓存时 system 就是普通字符串。按 1.25 倍计费的首次写入对"一句话就退出"是亏的',
  );
  assert.equal(body.messages[0]?.content.at(-1)?.['cache_control'], undefined);
});

test('thinking 的预算被夹在 max_tokens 之内', async () => {
  const auto = fakeTransport([ok(claudeText)]);
  await createClaudeProvider({ ...CONFIG, thinking: { enabled: true }, transport: auto }).send({
    system: 'sys',
    messages: [],
    tools: [],
  });
  assert.deepEqual((auto.sentBody() as { thinking?: unknown }).thinking, {
    type: 'enabled',
    // 默认取一半 —— 想太久就没额度说话了。
    budget_tokens: CLAUDE_DEFAULT_MAX_TOKENS / 2,
  });

  const clamped = fakeTransport([ok(claudeText)]);
  await createClaudeProvider({
    ...CONFIG,
    maxTokens: 2_000,
    thinking: { enabled: true, budgetTokens: 999_999 },
    transport: clamped,
  }).send({ system: 'sys', messages: [], tools: [] });
  assert.deepEqual(
    (clamped.sentBody() as { thinking?: unknown }).thinking,
    { type: 'enabled', budget_tokens: 1_024 },
    '预算必须小于 max_tokens,否则接口报错;还得留出余量给正式回答,不然模型想完了没额度说话',
  );

  const off = fakeTransport([ok(claudeText)]);
  await createClaudeProvider({
    ...CONFIG,
    thinking: { enabled: false },
    transport: off,
  }).send({ system: 'sys', messages: [], tools: [] });
  assert.ok(!('thinking' in (off.sentBody() as object)), '关掉就是不发这个字段');
});

test('连 max_tokens 都没给时厂商的报错原样透出', async () => {
  // 这条夹具的 message 就是 "max_tokens: Field required" —— 它正是"忘了给必填项"
  // 时用户会看到的东西。把它归一成"请求失败",用户就再也查不出来了。
  const failure = { status: 400, body: JSON.stringify(claudeError) };
  const transport = fakeTransport([failure]);

  await assert.rejects(
    () =>
      createClaudeProvider({ ...CONFIG, transport }).send({
        system: 'sys',
        messages: [],
        tools: [],
      }),
    (error: Error) => {
      assert.match(error.message, /Anthropic 接口返回 HTTP 400/);
      assert.ok(error.message.includes(failure.body));
      return true;
    },
  );
});

test('限流(429)与参数错误(400)是两条不同的报错', async () => {
  const limited = fakeTransport([failed(429, claudeRateLimited)]);
  await assert.rejects(
    () =>
      createClaudeProvider({ ...CONFIG, transport: limited }).send({
        system: 'sys',
        messages: [],
        tools: [],
      }),
    (error: Error) => {
      assert.match(error.message, /HTTP 429/);
      assert.match(error.message, /rate_limit_error/);
      return true;
    },
    '限流要等一会儿再试,参数错误改配置才行 —— 抹平这个区别,agent 只会盲目重试',
  );
});

test('baseUrl 可覆盖,且容忍结尾的斜杠', async () => {
  const transport = fakeTransport([ok(claudeText)]);

  await createClaudeProvider({
    ...CONFIG,
    baseUrl: 'https://proxy.example.com/anthropic/',
    transport,
  }).send({ system: 'sys', messages: [], tools: [] });

  assert.equal(transport.sentUrl(), 'https://proxy.example.com/anthropic/v1/messages');
});
