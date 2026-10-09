import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createTaskRegistry, renderTaskLine } from './task-registry.js';

test('任务表:开记录 / 完成 / 失败 / 按开始顺序列出', () => {
  const registry = createTaskRegistry();
  const first = registry.start({ agent: 'explorer', description: '查用法', spec: { description: '查用法', prompt: 'p' } });
  const second = registry.start({ agent: 'reviewer', description: '审一遍', spec: { description: '审一遍', prompt: 'p' } });

  assert.equal(first.id, 't1');
  assert.equal(second.id, 't2');
  assert.equal(first.state, 'running');
  assert.deepEqual(registry.list().map((e) => e.id), ['t1', 't2']);

  registry.finish('t1', { text: '结论', tokens: 1200, messages: [{ role: 'user', text: 'p' }] });
  const done = registry.get('t1')!;
  assert.equal(done.state, 'done');
  assert.equal(done.text, '结论');
  assert.equal(done.tokens, 1200);
  assert.equal(done.messages?.length, 1, '消息数组要留着 —— followup 靠它接着跑');
  assert.ok(done.finishedAt !== undefined);

  registry.fail('t2', '接口 500');
  assert.equal(registry.get('t2')!.state, 'failed');
  assert.equal(registry.get('t2')!.error, '接口 500');

  assert.equal(registry.get('t9'), undefined);
});

test('新的任务表是空的 —— 状态不跨会话,也不落盘', () => {
  const registry = createTaskRegistry();
  registry.start({ agent: 'explorer', description: 'd', spec: { description: 'd', prompt: 'p' } });
  assert.equal(registry.list().length, 1);

  // "会话结束"就是把这个对象丢掉。下一场会话拿到的是新的空表。
  const next = createTaskRegistry();
  assert.deepEqual(next.list(), []);

  // 而且它不碰磁盘:源码里没有 fs。上面那条断言容易在重构里被悄悄破坏,
  // 这条是最后一道 —— 一旦有人给任务表加了持久化,这里会红。
  const source = readFileSync(new URL('../../src/core/task-registry.ts', import.meta.url), 'utf8');
  assert.ok(!/from 'node:fs'/.test(source), '任务表一旦落盘就不再是"会话内"的了');
});

test('渲染成行:运行中/已完成/失败三种样子', () => {
  const registry = createTaskRegistry();
  registry.start({ agent: 'explorer', description: '查用法', spec: { description: '查用法', prompt: 'p' } });
  assert.match(renderTaskLine(registry.get('t1')!), /t1 · explorer · 运行中 · 查用法 · 已跑 \d+s/);

  registry.finish('t1', { text: 'x', tokens: 2400, messages: [] });
  assert.match(renderTaskLine(registry.get('t1')!), /t1 · explorer · 已完成 · 查用法 · ~2\.4k token · \d+\.\ds/);

  const second = registry.start({ agent: 'reviewer', description: '审', spec: { description: '审', prompt: 'p' } });
  registry.fail(second.id, '接口 500');
  assert.match(renderTaskLine(second), /失败 · 审 · —— 接口 500/);
});
