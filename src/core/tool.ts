import type { ToolSpec } from '../provider/types.js';

/**
 * 一个工具:对模型呈现的样子(spec),加上它怎么执行(run)。
 *
 * run 直接返回喂给模型的文本 —— 工具结果最终就是文本,中途转成结构体
 * 只是多一层要维护的映射。
 */
export interface Tool {
  readonly spec: ToolSpec;
  run(input: unknown): Promise<string>;
}
