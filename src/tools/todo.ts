import type { Tool } from '../core/tool.js';
import { renderTodos, type TodoStatus, type TodoStore } from '../core/todos.js';

const STATUSES = ['pending', 'in_progress', 'done'] as const;

function isStatus(value: unknown): value is TodoStatus {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${what} 要是一个对象,收到的是 ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function parseItems(input: unknown): { text: string; status?: TodoStatus }[] {
  const { items } = asRecord(input, 'todo_write 的入参');
  if (!Array.isArray(items)) throw new Error('todo_write 的 items 要是一个数组');

  return items.map((raw, index) => {
    const entry = asRecord(raw, `items[${index}]`);
    const { text, status } = entry;

    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error(`items[${index}].text 要是一句非空的说明`);
    }
    if (status !== undefined && !isStatus(status)) {
      throw new Error(`items[${index}].status 只能是 ${STATUSES.join(' / ')},收到的是 ${JSON.stringify(status)}`);
    }

    return status === undefined ? { text } : { text, status };
  });
}

function parseUpdates(input: unknown): { id: string; status: TodoStatus }[] {
  const { updates } = asRecord(input, 'todo_update 的入参');
  if (!Array.isArray(updates)) throw new Error('todo_update 的 updates 要是一个数组');

  return updates.map((raw, index) => {
    const entry = asRecord(raw, `updates[${index}]`);
    const { id, status } = entry;

    if (typeof id !== 'string' || id === '') throw new Error(`updates[${index}].id 要是清单里的那一条的 id`);
    if (!isStatus(status)) {
      throw new Error(`updates[${index}].status 只能是 ${STATUSES.join(' / ')},收到的是 ${JSON.stringify(status)}`);
    }

    return { id, status };
  });
}

/**
 * 待办清单的三个工具。
 *
 * 它们存在是为了让**开工前的计划**和**执行中的进度**都落在同一个地方,并且落在
 * 用户看得见的地方 —— 工具结果本来就会显示在会话里,所以清单不需要另开一个面板。
 *
 * 一次只允许一条 `in_progress`:那是"现在做到哪了"这个问题的答案,而它只能有一个。
 * 这条约束写在工具描述里,交给模型遵守 —— 在这里强行改会造成静默的行为偏差。
 */
export function createTodoTools(store: TodoStore): Tool[] {
  return [
    {
      spec: {
        name: 'todo_write',
        description: [
          '建立或重排这次的待办清单。这是**开工前的计划**,不是执行日志。',
          '多步任务(要动两个以上文件、要跑几步验证)在动手之前先用它把步骤列出来,',
          '用户会在你真正开始前就看到你打算怎么做,从而在你跑偏之前纠正方向。',
          '整份替换:传进来的就是全部条目。只改某一步的状态请用 todo_update,不要重写整份。',
          '同一时刻最多让一条处于 in_progress。',
        ].join(''),
        inputSchema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              description: '按执行顺序排列的全部步骤。一条一事,写清"做什么"而不是"做什么类的事"。',
              items: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: '这一步要做什么' },
                  status: { type: 'string', enum: [...STATUSES] },
                },
                required: ['text'],
              },
            },
          },
          required: ['items'],
        },
      },
      async run(input) {
        return renderTodos(store.replace(parseItems(input)));
      },
    },

    {
      spec: {
        name: 'todo_update',
        description: [
          '把清单里的某一条改成另一个状态。用 id 点名,只动那一条,其余条目保持原样。',
          '做法:做完一步就把它标成 done,并把**下一步**标成 in_progress —— ',
          '用户靠这个看出当前进行到哪一步。可以一次改多条。',
        ].join(''),
        inputSchema: {
          type: 'object',
          properties: {
            updates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: '清单里那一条的 id' },
                  status: { type: 'string', enum: [...STATUSES] },
                },
                required: ['id', 'status'],
              },
            },
          },
          required: ['updates'],
        },
      },
      async run(input) {
        return renderTodos(store.setStatus(parseUpdates(input)));
      },
    },

    {
      spec: {
        name: 'todo_read',
        description: [
          '读回当前的待办清单。',
          '会话被压缩过之后用它确认进度:清单本身可能已经不在这段上下文里了,',
          '但它并没有丢 —— 它一直存在会话外面。',
        ].join(''),
        inputSchema: { type: 'object', properties: {} },
      },
      async run() {
        return renderTodos(store.read());
      },
    },
  ];
}
