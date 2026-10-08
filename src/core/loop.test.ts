import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTurn } from './loop.js';
import type { Tool } from './tool.js';
import type { Provider, ProviderRequest, ProviderResponse } from '../provider/types.js';

/**
 * 假 Provider —— 主缝上的替身。按顺序吐出预设的回应,使整个主循环
 * 变成确定性的,并记录每次收到的请求以便断言回喂内容。
 *
 * 这是本项目唯一允许的替身:模型是唯一不可控的外部输入。shell 工具不去
 * mock —— 它对着真实 PowerShell 测(见 docs/shell-tool-contract.md)。
 */
type FakeProvider = Provider & { readonly requests: ProviderRequest[] };

function fakeProvider(...responses: ProviderResponse[]): FakeProvider {
  const requests: ProviderRequest[] = [];
  let next = 0;
  return {
    id: 'fake',
    model: 'fake-1',
    requests,
    async send(request) {
      requests.push(request);
      const response = responses[next++];
      if (!response) throw new Error(`假 Provider 的回应已用尽(第 ${next} 次调用)`);
      return response;
    },
  };
}

function fakeTool(name: string, run: (input: unknown) => Promise<string>): Tool {
  return {
    spec: { name, description: `${name} 的测试替身`, inputSchema: { type: 'object' } },
    run,
  };
}

test('模型没有要求工具时,循环返回它的文本', async () => {
  const deps = {
    provider: fakeProvider({ text: '你好,我是 hcode。', toolCalls: [] }),
    tools: [],
    system: '你是一个编程助手。',
  };

  const result = await runTurn(deps, [{ role: 'user', text: '打个招呼' }]);

  assert.equal(result.text, '你好,我是 hcode。');
});

test('模型要求工具时,循环执行它、把结果回喂,直到模型不再要求工具', async () => {
  const received: unknown[] = [];
  const echo = fakeTool('echo', async (input) => {
    received.push(input);
    return `echoed:${JSON.stringify(input)}`;
  });

  const provider = fakeProvider(
    { text: null, toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 42 } }] },
    { text: '看到结果了。', toolCalls: [] },
  );

  const result = await runTurn(
    { provider, tools: [echo], system: '你是一个编程助手。' },
    [{ role: 'user', text: '跑一下 echo' }],
  );

  assert.equal(result.text, '看到结果了。');
  assert.deepEqual(received, [{ value: 42 }], '工具应当以模型给出的入参执行');

  const fedBack = provider.requests[1]?.messages.some(
    (message) =>
      message.role === 'tool' &&
      message.results.some((resultItem) => resultItem.output.includes('echoed')),
  );
  assert.ok(fedBack, '工具结果应当被回喂给模型,否则模型看不到自己命令的结果');
});
