import type { ToolCallRequest, ToolSpec } from '../provider/types.js';
import type { Tool, ToolContext } from './tool.js';

/**
 * 工具的分发结构。主循环只认识它,不认识任何具体工具。
 *
 * run **永不抛出**。工具的失败是给模型看的信息,不是给进程看的异常:模型看到
 * "文件不存在"会换一条路径,而一次抛异常会把整轮对话连同已经跑出来的进展一起
 * 丢掉 —— 它连自己错在哪都看不到。
 */
export type Toolset = {
  readonly specs: ToolSpec[];
  run(call: ToolCallRequest, context?: ToolContext): Promise<string>;
};

export function createToolset(tools: Tool[]): Toolset {
  const byName = new Map(tools.map((tool) => [tool.spec.name, tool]));

  return {
    specs: tools.map((tool) => tool.spec),

    async run(call, context) {
      const tool = byName.get(call.name);

      // 模型叫错名字是常事(它会写 run_powershell、Bash、read 之类)。把真正可用的
      // 列回去,它下一轮就能自己改对 —— 而我们什么也不用做。
      if (!tool) {
        return `没有名为 ${call.name} 的工具。可用的工具是:${[...byName.keys()].join('、')}。`;
      }

      try {
        return await tool.run(call.input, context);
      } catch (error) {
        // 原文照传。吞成一句"执行失败","文件不存在"与"没有权限"就分不出来了,
        // 而这两种情况模型的下一步完全不同。见规格的验收:工具错误原文完整回传。
        const detail = error instanceof Error ? error.message : String(error);
        return `工具 ${call.name} 抛出错误:${detail}`;
      }
    },
  };
}
