import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTodoStore, renderTodos } from './todos.js';

test('建立清单后能按原顺序读回来', () => {
  const store = createTodoStore();

  store.replace([{ text: '读配置' }, { text: '改适配器' }, { text: '跑测试' }]);

  assert.deepEqual(
    store.read().map((todo) => todo.text),
    ['读配置', '改适配器', '跑测试'],
  );
});

test('没写状态的条目默认是未开始', () => {
  const store = createTodoStore();

  store.replace([{ text: '第一步' }]);

  assert.equal(store.read()[0]!.status, 'pending');
});

test('改一条的状态不碰别的条目', () => {
  const store = createTodoStore();
  store.replace([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
  const second = store.read()[1]!.id;

  store.setStatus([{ id: second, status: 'done' }]);

  assert.deepEqual(
    store.read().map((todo) => todo.status),
    ['pending', 'done', 'pending'],
  );
});

test('同一轮内的多次更新互相不覆盖', () => {
  const store = createTodoStore();
  store.replace([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
  const [a, b, c] = store.read().map((todo) => todo.id);

  // 模型在同一轮里连着发三次更新。若每次都是"凭手里的快照重写整份清单",
  // 后一次就会把前一次的进度抹掉 —— 而用户看到的是清单莫名其妙倒退。
  store.setStatus([{ id: a!, status: 'done' }]);
  store.setStatus([{ id: b!, status: 'in_progress' }]);
  store.setStatus([{ id: c!, status: 'done' }]);

  assert.deepEqual(
    store.read().map((todo) => todo.status),
    ['done', 'in_progress', 'done'],
  );
});

test('一次调用里改多条,也一条都不丢', () => {
  const store = createTodoStore();
  const todos = store.replace([{ text: 'a' }, { text: 'b' }]);

  store.setStatus([
    { id: todos[0]!.id, status: 'done' },
    { id: todos[1]!.id, status: 'done' },
  ]);

  assert.deepEqual(
    store.read().map((todo) => todo.status),
    ['done', 'done'],
  );
});

test('改一个不存在的 id 会报错,并把当前清单带回去', () => {
  const store = createTodoStore();
  store.replace([{ text: '读配置' }]);

  assert.throws(
    () => store.setStatus([{ id: '99', status: 'done' }]),
    (error: Error) => {
      assert.match(error.message, /99/, '要说清是哪个 id 找不到');
      assert.match(
        error.message,
        /读配置/,
        '要把当前清单一起带上 —— 模型据此能自己改对,不必再问一轮',
      );
      return true;
    },
  );

  assert.equal(store.read().length, 1, '报错的调用不能悄悄新建一条');
});

test('重排之后,文本没变的条目沿用原来的 id', () => {
  const store = createTodoStore();
  const before = store.read();
  store.replace([{ text: '读配置' }, { text: '跑测试' }]);
  const configId = store.read()[0]!.id;

  store.replace([{ text: '读配置', status: 'done' }, { text: '跑测试' }, { text: '写文档' }]);

  assert.equal(
    store.read()[0]!.id,
    configId,
    'id 一变,模型手里的引用就指到别的条目上了',
  );
  assert.equal(store.read()[0]!.status, 'done', '重排时显式给的状态要生效');
  assert.ok(before.length === 0);
});

test('渲染出来的清单带状态标记与进度,人和模型看的是同一份', () => {
  const store = createTodoStore();
  const [a, b] = store.replace([{ text: '读配置' }, { text: '跑测试' }]);
  store.setStatus([{ id: a!.id, status: 'done' }, { id: b!.id, status: 'in_progress' }]);

  const text = renderTodos(store.read());

  assert.match(text, /\[x\]/, '已完成要有标记');
  assert.match(text, /\[>\]/, '进行中要有标记,而且要能一眼分出它和已完成');
  assert.match(text, /1\/2/, '要能直接看出做到哪一步了');
  assert.match(text, new RegExp(a!.id), '要带 id,下一步改状态要用它');
});
