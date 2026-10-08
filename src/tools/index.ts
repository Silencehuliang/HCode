import type { Tool } from '../core/tool.js';
import { createRunCommandTool } from './run-command.js';

/**
 * 全部工具的注册处。
 *
 * 加一个工具是两件事:写一个 handler,在这个列表里加一行。主循环不认识这里的
 * 任何名字 —— 它只拿到一个 Toolset,所以加工具不必碰它。
 */
export function createTools(): Tool[] {
  return [createRunCommandTool()];
}
