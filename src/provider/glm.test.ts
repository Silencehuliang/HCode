import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGlmProvider } from './glm.js';
import { glmError, glmText, glmToolCall } from './fixtures/glm.js';
import { failed, fakeTransport, ok } from './testing/fake-transport.js';

test('把 Harness 的对话映射成 GLM 的线格式', async () => {
  const transport = fakeTransport([ok(glmText)]);
  const provider = createGlmProvider({ apiKey: '测试密钥', model: 'glm-5.3', transport });

  await provider.send({
    system: '你是一个编程助手。',
    messages: [
      { role: 'user', text: '看一下当前目录' },
      {
        role: 'assistant',
        text: null,
        toolCalls: [{ id: 'call_1', name: 'run_command', input: { command: 'Get-Location' } }],
      },
      { role: 'tool', results: [{ id: 'call_1', output: 'exit code: 0' }] },
      { role: 'assistant', text: '当前目录是 E:\\WorkStation。' },
    ],
    tools: [],
  });

  assert.deepEqual(transport.sentBody(), {
    model: 'glm-5.3',
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
      { role: 'assistant', content: '当前目录是 E:\\WorkStation。' },
    ],
  });
});

test('解析 GLM 的响应:纯文本与工具调用之分', async () => {
  const plain = fakeTransport([ok(glmText)]);
  const plainReply = await createGlmProvider({
    apiKey: '测试密钥',
    model: 'glm-5.3',
    transport: plain,
  }).send({ system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools: [] });

  assert.equal(plainReply.text, '收到');
  assert.deepEqual(plainReply.toolCalls, [], '模型没要求工具时应当是空数组,不是 undefined');

  const calling = fakeTransport([ok(glmToolCall)]);
  const callingReply = await createGlmProvider({
    apiKey: '测试密钥',
    model: 'glm-5.3',
    transport: calling,
  }).send({ system: 'sys', messages: [{ role: 'user', text: 'hi' }], tools: [] });

  assert.deepEqual(
    callingReply.toolCalls,
    [
      {
        id: 'call_bbeb27c5ab7b4a10b435a276',
        name: 'run_command',
        input: { command: 'Get-Location' },
      },
    ],
    'arguments 是 JSON 字符串,要还原成对象;直接把它当对象用会让工具拿到一串文本',
  );
  assert.equal(
    callingReply.text,
    null,
    '这一轮的 content 是空串 —— 空串与"没有文本"是同一件事,留着空串会让对话里多出一条无意义的 assistant 文本',
  );
});

test('默认打到智谱的开放平台,密钥只出现在认证头里', async () => {
  const transport = fakeTransport([ok(glmText)]);

  await createGlmProvider({ apiKey: '测试密钥', model: 'glm-5.3', transport }).send({
    system: 'sys',
    messages: [],
    tools: [],
  });

  assert.equal(transport.sentUrl(), 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  assert.equal(transport.sentHeaders()['authorization'], 'Bearer 测试密钥');
});

test('baseUrl 可覆盖,且容忍结尾的斜杠', async () => {
  const transport = fakeTransport([ok(glmText)]);

  await createGlmProvider({
    apiKey: '测试密钥',
    model: 'glm-5.3',
    baseUrl: 'http://127.0.0.1:7863/v1/',
    transport,
  }).send({ system: 'sys', messages: [], tools: [] });

  assert.equal(
    transport.sentUrl(),
    'http://127.0.0.1:7863/v1/chat/completions',
    '配置里写没写结尾斜杠是用户的事,不该拼出 //chat/completions',
  );
});

test('工具按线格式包装成 function,空数组则不发送', async () => {
  const transport = fakeTransport([ok(glmText)]);

  await createGlmProvider({ apiKey: '测试密钥', model: 'glm-5.3', transport }).send({
    system: 'sys',
    messages: [],
    tools: [
      {
        name: 'run_command',
        description: '在 PowerShell 里执行一条命令。',
        inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      },
    ],
  });

  assert.deepEqual(transport.sentBody(), {
    model: 'glm-5.3',
    messages: [{ role: 'system', content: 'sys' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'run_command',
          description: '在 PowerShell 里执行一条命令。',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      },
    ],
  });
});

test('厂商报错时抛出原始响应,不归一成通用错误', async () => {
  // 断言"原样"就必须拿传输层实际交付的那串字节来比,而不是手抄一份期望文案 ——
  // 手抄的那份会随着厂商措辞变化而与夹具脱节,却在测试里看着像是对的。
  const failure = { status: 400, body: JSON.stringify(glmError) };
  const transport = fakeTransport([failure]);

  await assert.rejects(
    () =>
      createGlmProvider({ apiKey: '测试密钥', model: 'glm-5.3', transport }).send({
        system: 'sys',
        messages: [],
        tools: [],
      }),
    (error: Error) => {
      assert.match(error.message, /HTTP 400/, 'HTTP 状态要带上,否则分不清是客户端写错还是服务端挂了');
      assert.ok(
        error.message.includes(failure.body),
        `厂商的原始报错必须原样透出 —— 归一成"请求失败"会抹掉"模型不存在"与"余额不足"的区别,而用户要靠这个区别决定下一步。\n实际抛出:${error.message}`,
      );
      return true;
    },
  );
});
