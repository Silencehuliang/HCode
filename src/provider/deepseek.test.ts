import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDeepSeekProvider } from './deepseek.js';
import { deepseekError, deepseekText, deepseekToolCall } from './fixtures/deepseek.js';
import { fakeTransport, ok } from './testing/fake-transport.js';

/**
 * DeepSeek 的适配器。
 *
 * 它与 glm.ts 共用 chat-completions.ts,线格式逐字相同 —— 但那份"相同"是实测出来的
 * 巧合,不是契约:两份夹具录的都是**本地网关**,不是 api.deepseek.com。所以这里不
 * 复用 glm 的断言,自己写一遍。哪天共享模块被人改坏,两个文件会各自红一次,而不是
 * 一起绿着没人发现。
 */

const CONFIG = { apiKey: '测试密钥', model: 'deepseek-v4.1-flash' };

test('把 Harness 的对话映射成 DeepSeek 的线格式', async () => {
  const transport = fakeTransport([ok(deepseekText)]);

  await createDeepSeekProvider({ ...CONFIG, transport }).send({
    system: '你是一个编程助手。',
    messages: [
      { role: 'user', text: '看一下当前目录' },
      {
        role: 'assistant',
        text: null,
        toolCalls: [{ id: 'call_1', name: 'run_command', input: { command: 'Get-Location' } }],
      },
      { role: 'tool', results: [{ id: 'call_1', output: 'exit code: 0' }] },
    ],
    tools: [],
  });

  assert.deepEqual(transport.sentBody(), {
    model: 'deepseek-v4.1-flash',
    messages: [
      { role: 'system', content: '你是一个编程助手。' },
      { role: 'user', content: '看一下当前目录' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'run_command', arguments: '{"command":"Get-Location"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'exit code: 0' },
    ],
  });
});

test('默认打到 DeepSeek 开放平台,密钥只出现在认证头里', async () => {
  const transport = fakeTransport([ok(deepseekText)]);

  await createDeepSeekProvider({ ...CONFIG, transport }).send({
    system: 'sys',
    messages: [],
    tools: [],
  });

  assert.equal(transport.sentUrl(), 'https://api.deepseek.com/chat/completions');
  assert.equal(transport.sentHeaders()['authorization'], 'Bearer 测试密钥');
});

test('解析 DeepSeek 的响应:纯文本与工具调用之分', async () => {
  const plain = fakeTransport([ok(deepseekText)]);
  const plainReply = await createDeepSeekProvider({ ...CONFIG, transport: plain }).send({
    system: 'sys',
    messages: [],
    tools: [],
  });
  assert.equal(plainReply.text, '收到');
  assert.deepEqual(plainReply.toolCalls, []);

  const calling = fakeTransport([ok(deepseekToolCall)]);
  const callingReply = await createDeepSeekProvider({ ...CONFIG, transport: calling }).send({
    system: 'sys',
    messages: [],
    tools: [],
  });

  assert.deepEqual(
    callingReply.toolCalls,
    [
      {
        id: 'call_00_7boGWIjHzZONKFNLcJSl3257',
        name: 'run_command',
        input: { command: 'Get-Location' },
      },
    ],
    'arguments 是 JSON 字符串,要还原成对象',
  );
  assert.equal(callingReply.text, null, '这一轮的 content 是空串');
});

test('思维链留在厂商那一侧,不进 core', async () => {
  // 这份夹具里 message.reasoning_content 是有内容的 —— 思维链归厂商,Provider 的
  // 出口只有 text 与 toolCalls 两个字段。哪天有人图省事把 reasoning_content 塞进
  // text,这条会红。
  const transport = fakeTransport([ok(deepseekToolCall)]);
  const reply = await createDeepSeekProvider({ ...CONFIG, transport }).send({
    system: 'sys',
    messages: [],
    tools: [],
  });

  assert.equal(reply.text, null);
  assert.ok(
    !JSON.stringify(reply).includes('current directory'),
    `思维链不该出现在 core 拿到的任何字段里,实际:${JSON.stringify(reply)}`,
  );
});

test('不给 thinking 就不发这个字段,给了就按开关发', async () => {
  const silent = fakeTransport([ok(deepseekText)]);
  await createDeepSeekProvider({ ...CONFIG, transport: silent }).send({
    system: 'sys',
    messages: [],
    tools: [],
  });
  assert.ok(
    !('thinking' in (silent.sentBody() as object)),
    '不表态就是不表态 —— 替用户选一个默认值,各家的默认并不一样',
  );

  const off = fakeTransport([ok(deepseekText)]);
  await createDeepSeekProvider({
    ...CONFIG,
    thinking: { enabled: false },
    transport: off,
  }).send({ system: 'sys', messages: [], tools: [] });
  assert.deepEqual((off.sentBody() as { thinking?: unknown }).thinking, { type: 'disabled' });

  const on = fakeTransport([ok(deepseekText)]);
  await createDeepSeekProvider({ ...CONFIG, thinking: { enabled: true }, transport: on }).send({
    system: 'sys',
    messages: [],
    tools: [],
  });
  assert.deepEqual((on.sentBody() as { thinking?: unknown }).thinking, { type: 'enabled' });
});

test('厂商报错时抛出原始响应,不归一成通用错误', async () => {
  const failure = { status: 402, body: JSON.stringify(deepseekError) };
  const transport = fakeTransport([failure]);

  await assert.rejects(
    () =>
      createDeepSeekProvider({ ...CONFIG, transport }).send({
        system: 'sys',
        messages: [],
        tools: [],
      }),
    (error: Error) => {
      assert.match(error.message, /DeepSeek 接口返回 HTTP 402/);
      assert.ok(
        error.message.includes(failure.body),
        `厂商的原始报错必须原样透出 —— "余额不足"和"参数不支持"对用户是两件完全不同的事。\n实际抛出:${error.message}`,
      );
      return true;
    },
  );
});
