import type { ToolSpec } from '../provider/types.js';

/**
 * 执行一次工具时,Harness 交给它的上下文。
 *
 * signal 是给长命令用的:一条跑十分钟的 `npm install` 必须能被用户按 Ctrl+C 掐掉。
 * 工具自己没法知道用户按了什么,所以由上层把它递进来。
 */
/**
 * 一次子 agent 派发结束的统计。走 ToolContext 递给工具,由界面渲染成一行 ——
 * core 不碰 stdout。
 */
export type SubagentDoneEvent = {
  type: 'subagent-done';
  agent: string;
  model: string;
  tokens: number;
  durationMs: number;
  /** 这一趟开在独立车道上时的分支名(v2-13)。有它说明改动落在另一条分支上,没碰主工作区。 */
  lane?: string;
};

export type ToolContext = {
  signal?: AbortSignal;
  /**
   * 把内部发生的事回报给界面(task 派发结束时给一行统计)。与 approve 同一
   * 个通道家族:界面在手上,core 只管把话说出去。
   */
  emit?: (event: SubagentDoneEvent) => void;
  /**
   * 权限确认通道,由守门层注入(见 permission.ts)。工具自己不读它 —— 它是给
   * task 这类"内部还会再跑一层工具"的工具用的:派出去的子 agent 也要过同一道
   * 权限门,而终端在主界面手上,只能从这里递过去。
   */
  approve?: (request: { tool: string; input: unknown }) => Promise<boolean>;
};

/**
 * 一个工具:对模型呈现的样子(spec),加上它怎么执行(run)。
 *
 * run 直接返回喂给模型的文本 —— 工具结果最终就是文本,中途转成结构体
 * 只是多一层要维护的映射。
 */
export interface Tool {
  readonly spec: ToolSpec;
  run(input: unknown, context?: ToolContext): Promise<string>;
}
