import { runTurn } from './loop.js';
import { estimateMessageTokens } from './tokens.js';
import type { Provider } from '../provider/types.js';
import type { Toolset } from './toolset.js';

/**
 * 一次子任务的结果。
 *
 * 带上 tokens 是因为多角色协作最大的隐性代价就是它:只给结论、不给花了多少,
 * 用户没法判断"侦察用便宜模型"这类策略到底省没省。它不是账单,是估算 ——
 * 见 tokens.ts 的说明。
 */
export type SubagentResult = {
  text: string;
  tokens: number;
};

export type SubagentDeps = {
  provider: Provider;
  /** 子 agent 手上的工具。刻意与主对话不同 —— 见下面。 */
  tools: Toolset;
  system: string;
  maxTurns?: number;
};

const TURN_LIMIT_NOTE =
  '子任务到轮次上限时还在调用工具,没有给出结论。多半是范围开得太大了 —— 换一个更窄的提示重派,或者自己来做。';

/**
 * 派一个子任务出去,只把它最后说的话带回来。
 *
 * 它存在的唯一理由是**上下文隔离**。让主对话自己去翻三十个文件,那三十份原文就
 * 永久占住了主对话的位置 —— 而其中的结论可能只有三行,而且后面再也用不到。子
 * agent 让"翻的过程"发生在另一个消息数组里,过程随它一起被丢掉,只留下结论。
 *
 * 所以这里刻意不给它主对话的历史,也不把它的过程回传:一给,隔离就没了,这个
 * 模块也就没有存在的必要了。
 *
 * 它不自己挑工具。给什么用什么 —— "子 agent 只能读"这条约束由调用方在装配时
 * 落实(见 tools/index.ts 的 createExplorerTools),而不是在这里运行时拦截。
 * 运行时拦截会让模型以为它手上有那个工具,一次次试着调用再被拒。
 */
export async function runSubagent(
  deps: SubagentDeps,
  prompt: string,
  signal?: AbortSignal,
): Promise<SubagentResult> {
  const result = await runTurn(
    { ...deps, ...(signal ? { signal } : {}) },
    [{ role: 'user', text: prompt }],
  );

  return {
    text: result.text === null ? TURN_LIMIT_NOTE : result.text,
    tokens: estimateMessageTokens(result.messages),
  };
}
