import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSession } from './session.js';
import type { Provider, ProviderRequest, ProviderResponse } from '../provider/types.js';

/**
 * 会说两句话的假 Provider:记下每一次开始与结束,并按最后一条用户消息决定回多慢。
 *
 * 这样"两轮有没有同时跑"就从时序上直接可读 —— 而不需要去看内部实现。
 */
function slowFirstProvider(order: string[]): Provider {
  return {
    id: 'fake',
    model: 'fake-1',
    async send(request: ProviderRequest): Promise<ProviderResponse> {
      const last = request.messages.at(-1);
      const said = last?.role === 'user' ? last.text : '?';

      order.push(`${said} 开始`);
      await new Promise((resolve) => setTimeout(resolve, said === '第一句' ? 30 : 1));
      order.push(`${said} 结束`);

      return { text: `回应:${said}`, toolCalls: [] };
    },
  };
}

test('连着说两句时,第二句看得到第一句的上下文', async () => {
  const session = createSession({
    provider: slowFirstProvider([]),
    tools: [],
    system: '你是一个编程助手。',
  });

  await session.send('第一句');
  await session.send('第二句');

  assert.deepEqual(
    session.messages.map((message) => (message.role === 'tool' ? '工具' : message.text)),
    ['第一句', '回应:第一句', '第二句', '回应:第二句'],
  );
});

test('同时说两句时依次执行 —— 对话是共享状态,两轮同时动它就会互相覆盖', async () => {
  const order: string[] = [];
  const session = createSession({
    provider: slowFirstProvider(order),
    tools: [],
    system: '你是一个编程助手。',
  });

  // 不 await 第一句就发第二句。真实场景:用户在终端里粘贴一段多行文本,
  // readline 会把每一行几乎同时交出来。
  const first = session.send('第一句');
  const second = session.send('第二句');
  await Promise.all([first, second]);

  assert.deepEqual(
    order,
    ['第一句 开始', '第一句 结束', '第二句 开始', '第二句 结束'],
    '第二轮必须在第一轮结束后才开始。交错的话,两条对话线会各自基于一份过期的对话继续,谁最后结束谁把它覆盖掉',
  );

  assert.deepEqual(
    session.messages.map((message) => (message.role === 'tool' ? '工具' : message.text)),
    ['第一句', '回应:第一句', '第二句', '回应:第二句'],
    '排了两句之后,对话里两句都要在',
  );
});
