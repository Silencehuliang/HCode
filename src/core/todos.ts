export type TodoStatus = 'pending' | 'in_progress' | 'done';

export type Todo = { readonly id: string; readonly text: string; readonly status: TodoStatus };

export type TodoItemInput = { text: string; status?: TodoStatus };

const MARKS: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[>]',
  done: '[x]',
};

/**
 * 把清单画成文本。
 *
 * 模型和用户看的是**同一份文本**,不各画一套:所以它在界面上看到的,正是它自己
 * 刚写下去的东西。两边分头渲染的话,迟早会出现"模型说它记下了、界面上却没有"。
 *
 * 带上 id,因为下一步改状态要用它。
 */
export function renderTodos(todos: Todo[]): string {
  if (todos.length === 0) return '待办清单是空的(还没有建立计划)。';

  const done = todos.filter((todo) => todo.status === 'done').length;
  const lines = todos.map((todo) => `${MARKS[todo.status]} ${todo.id}. ${todo.text}`);

  return [`待办清单(${done}/${todos.length} 已完成):`, ...lines].join('\n');
}

export type TodoStore = {
  read(): Todo[];
  /** 整份替换。用于建立计划或重排顺序。 */
  replace(items: TodoItemInput[]): Todo[];
  /** 按 id 改状态,**基于当前清单**,不碰没提到的条目。 */
  setStatus(updates: { id: string; status: TodoStatus }[]): Todo[];
};

/**
 * 待办清单。会话内唯一一份。
 *
 * 两种更新方式分开,是因为它们的语义真的不同:`replace` 是"我重新想了一遍计划",
 * `setStatus` 是"第 2 步做完了"。如果只有 `replace`,模型每改一个状态就得重写
 * 整份清单 —— 而它手里那份往往已经过时了(比如中途插进来一次压缩),于是一次
 * 更新会把别的进度一起抹回去。这就是"同一轮内的多次更新互相覆盖"。
 *
 * 状态只活在内存里。落盘是 v2 的事(见规格的范围分层)。
 */
export function createTodoStore(): TodoStore {
  let todos: Todo[] = [];
  let nextId = 1;

  return {
    read() {
      return todos.map((todo) => ({ ...todo }));
    },

    replace(items) {
      // 文本没变就沿用原来的 id:模型改完状态之后,手里的 id 不会因为一次重排
      // 突然指到别的条目上。
      const byText = new Map(todos.map((todo) => [todo.text, todo.id]));

      todos = items.map((item) => ({
        id: byText.get(item.text) ?? String(nextId++),
        text: item.text,
        status: item.status ?? 'pending',
      }));

      return this.read();
    },

    setStatus(updates) {
      const known = new Set(todos.map((todo) => todo.id));
      const unknown = updates.map((update) => update.id).filter((id) => !known.has(id));

      if (unknown.length > 0) {
        // 报错时把当前清单一起带上 —— 模型据此能自己改对,不必再问一轮。
        // 静默新建一条,会让清单里凭空多出一条没人认领的待办。
        throw new Error(
          `待办清单里没有 id 为 ${unknown.join('、')} 的条目。当前清单:\n${renderTodos(todos)}`,
        );
      }

      const byId = new Map(updates.map((update) => [update.id, update.status]));
      todos = todos.map((todo) => {
        const status = byId.get(todo.id);
        return status === undefined ? todo : { ...todo, status };
      });

      return this.read();
    },
  };
}
