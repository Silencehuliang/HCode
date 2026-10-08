import type { Tool } from '../core/tool.js';
import type { TodoStore } from '../core/todos.js';
import { createEditFileTool } from './edit-file.js';
import { createFindFilesTool } from './find-files.js';
import { createReadFileTool } from './read-file.js';
import { createRunCommandTool } from './run-command.js';
import { createSearchContentTool } from './search-content.js';
import { createWriteFileTool } from './write-file.js';
import { createTodoTools } from './todo.js';

/**
 * 全部工具的注册处。
 *
 * 加一个工具是两件事:写一个 handler,在这个列表里加一行。主循环不认识这里的
 * 任何名字 —— 它只拿到一个 Toolset,所以加工具不必碰它。
 */
/**
 * 子 agent 手上的工具:只有只读的三个。
 *
 * 刻意不包含 task 自己 —— 否则子 agent 能再派子 agent,一层套一层,而每一层的
 * 轮次上限都拦不住它。
 *
 * 也不包含写文件与执行命令:派出去的是帮我查清楚,改东西该由主对话来做,
 * 那样用户才看得到每一次改动、也才有机会拦住它。
 */
export function createExplorerTools(): Tool[] {
  return [createReadFileTool(), createSearchContentTool(), createFindFilesTool()];
}

export function createTools(deps: { todos: TodoStore }): Tool[] {
  return [
    createRunCommandTool(),
    ...createExplorerTools(),
    createWriteFileTool(),
    createEditFileTool(),
    ...createTodoTools(deps.todos),
  ];
}
