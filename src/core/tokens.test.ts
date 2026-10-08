import { test } from 'node:test';
import assert from 'node:assert/strict';

import { estimateMessageTokens, estimateTokens } from './tokens.js';
import type { Message } from '../provider/types.js';

test('空字符串是 0', () => {
  assert.equal(estimateTokens(''), 0);
});

test('英文按 4 字符 1 token 估', () => {
  assert.equal(estimateTokens('a'.repeat(400)), 100);
});

test('中文按 1 字符 1 token 估', () => {
  const tokens = estimateTokens('中'.repeat(100));

  assert.ok(
    tokens >= 90 && tokens <= 110,
    `中文一个字差不多就是一个 token,按英文那套除以 4 会把中文对话低估四倍 —— 预算算不准,压缩就永远来不及。实际:${tokens}`,
  );
});

test('中英混排两边都算进去', () => {
  const tokens = estimateTokens(`${'中'.repeat(50)}${'a'.repeat(200)}`);

  assert.ok(tokens >= 95 && tokens <= 110, `实际:${tokens}`);
});

test('消息里每一部分都算,包括工具调用参数和工具输出', () => {
  const messages: Message[] = [
    { role: 'user', text: 'x'.repeat(400) },
    {
      role: 'assistant',
      text: null,
      toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a'.repeat(400) } }],
    },
    { role: 'tool', results: [{ id: 'c1', output: 'y'.repeat(400) }] },
  ];

  const tokens = estimateMessageTokens(messages);

  assert.ok(
    tokens >= 300,
    `工具参数和工具输出恰恰是对话里最占地方的部分,漏掉它们等于没在估。实际:${tokens}`,
  );
});
