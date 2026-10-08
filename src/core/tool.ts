import type { ToolSpec } from '../provider/types.js';

/**
 * 执行一次工具时,Harness 交给它的上下文。
 *
 * signal 是给长命令用的:一条跑十分钟的 `npm install` 必须能被用户按 Ctrl+C 掐掉。
 * 工具自己没法知道用户按了什么,所以由上层把它递进来。
 */
export type ToolContext = {
  signal?: AbortSignal;
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
