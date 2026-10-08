import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runTurn } from '../core/loop.js';
import { createTodoStore } from '../core/todos.js';
import { createToolset } from '../core/toolset.js';
import { createTools } from './index.js';
import type { Provider, ProviderResponse } from '../provider/types.js';

/** 照本宣科地回放设定好的响应,并记下每次请求。 */
function scripted(...responses: ProviderResponse[]): Provider {
  const queue = [...responses];
  return {
    id: 'scripted',
    model: 'scripted',
    async send() {
      const next = queue.shift();
      if (!next) throw new Error('脚本用完了');
      return next;
    },
  };
}

function tools(todos = createTodoStore()) {
  return { todos, toolset: createToolset(createTools({ todos })) };
}

test('待办工具注册在统一的工具列表里', () => {
  const { toolset } = tools();
  const names = toolset.specs.map((spec) => spec.name);

  for (const name of ['todo_write', 'todo_update', 'todo_read']) {
    assert.ok(names.includes(name), `${name} 没有注册,模型看不到它`);
  }
});

test('todo_write 把渲染好的清单作为结果回给模型', async () => {
  const { toolset } = tools();

  const output = await toolset.run({
    id: 'c1',
    name: 'todo_write',
    input: { items: [{ text: '读配置' }, { text: '跑测试' }] },
  });

  assert.match(output, /读配置/, '模型要能看见自己刚写下去的东西');
  assert.match(output, /\[ \]/, '要有状态标记');
});

test('同一轮的多次更新都不会丢 —— 走真实主循环', async () => {
  const { todos, toolset } = tools();

  const provider = scripted(
    {
      text: null,
      toolCalls: [
        {
          id: 'c1',
          name: 'todo_write',
          input: { items: [{ text: '读配置' }, { text: '改适配器' }, { text: '跑测试' }] },
        },
      ],
    },
    {
      text: null,
      toolCalls: [
        { id: 'c2', name: 'todo_update', input: { updates: [{ id: '1', status: 'done' }] } },
        { id: 'c3', name: 'todo_update', input: { updates: [{ id: '2', status: 'in_progress' }] } },
      ],
    },
    { text: '好了', toolCalls: [] },
  );

  await runTurn({ provider, tools: toolset, system: 'x' }, [{ role: 'user', text: '开始' }]);

  assert.deepEqual(
    todos.read().map((todo) => todo.status),
    ['done', 'in_progress', 'pending'],
    '同一轮里连发两次更新,后一次不能把前一次抹掉',
  );
});

test('id 写错时报错原文回传给模型,而不是把整轮对话弄丢', async () => {
  const { toolset } = tools();

  await toolset.run({ id: 'c1', name: 'todo_write', input: { items: [{ text: '读配置' }] } });

  const output = await toolset.run({
    id: 'c2',
    name: 'todo_update',
    input: { updates: [{ id: '42', status: 'done' }] },
  });

  assert.match(output, /42/, '要说清是哪个 id 找不到');
  assert.match(output, /读配置/, '要带上当前清单,模型据此能自己改对');
});

test('入参不合法时给的是能照着改的说明,不是一句类型错误', async () => {
  const { toolset } = tools();

  const output = await toolset.run({
    id: 'c1',
    name: 'todo_update',
    input: { updates: [{ id: '1', status: '做完了' }] },
  });

  assert.match(output, /pending/, '要列出合法取值');
  assert.match(output, /做完了/, '要说清它给的哪个值不合法');
});
