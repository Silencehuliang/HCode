import type { Message, Provider } from '../provider/types.js';
import type { Tool } from './tool.js';

/**
 * 一轮对话最多调用模型的次数。到达后交还控制而不是继续 —— 上限存在的意义
 * 是防住模型陷入工具循环,不是替调用方决定任务该不该结束。
 */
export const DEFAULT_MAX_TURNS = 25;

/**
 * 循环进行中发生的事,报给调用方用于显示。
 *
 * 有了它,界面才能在命令**开始执行之前**把它显示出来。只在最后交还对话是做不到
 * 这一点的:一条跑两分钟的 `npm install` 会让用户盯着空屏,而它正在做的事恰恰是
 * 用户最需要看到、也最需要有机会拦下的。
 */
export type LoopEvent =
  | { type: 'tool-call'; name: string; input: unknown }
  | { type: 'tool-result'; output: string };

export type LoopDeps = {
  provider: Provider;
  tools: Tool[];
  system: string;
  maxTurns?: number;
  onEvent?: (event: LoopEvent) => void;
  /** 用户叫停。工具拿它掐掉正在跑的进程,循环拿它决定不再问模型。 */
  signal?: AbortSignal;
};

export type TurnResult = {
  text: string | null;
  /** 本轮结束时的完整对话,含本轮新增的全部消息。调用方据此继续会话。 */
  messages: Message[];
  /** 非正常结束时说明原因。 */
  stoppedBecause?: 'turn-limit' | 'aborted';
};

/**
 * 跑一轮对话:反复调用模型、执行它要求的工具、把结果回喂,直到模型不再要求工具。
 *
 * 到达轮次上限时**不抛异常** —— 抛异常会把已经跑出来的对话丢掉,而调用方
 * 恰恰需要它来决定下一步。交还控制,由调用方决定继续还是放弃。
 *
 * 循环属于 Agent,机制属于 Harness —— 这里只有循环。
 */
export async function runTurn(
  deps: LoopDeps,
  messages: Message[],
): Promise<TurnResult> {
  const conversation: Message[] = [...messages];
  const toolSpecs = deps.tools.map((tool) => tool.spec);
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS;

  for (let turn = 0; turn < maxTurns; turn++) {
    // 被中断了就不再问模型,直接交还 —— 已经发生的对话一条不丢,调用方可以
    // 在原基础上继续。用户中断通常只是想换个说法,不是想丢掉上下文。
    if (deps.signal?.aborted) {
      return { text: null, messages: conversation, stoppedBecause: 'aborted' };
    }

    const response = await deps.provider.send({
      system: deps.system,
      messages: conversation,
      tools: toolSpecs,
    });

    conversation.push({
      role: 'assistant',
      text: response.text,
      ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
    });

    if (response.toolCalls.length === 0) {
      return { text: response.text, messages: conversation };
    }

    // 最后一轮也要执行 —— 否则对话会留下没有对应工具结果的 tool_use,
    // 那样交还给调用方的对话在下一次请求时是无效的。
    const results = [];
    for (const call of response.toolCalls) {
      const tool = deps.tools.find((candidate) => candidate.spec.name === call.name);
      if (!tool) throw new Error(`模型要求了不存在的工具:${call.name}`);
      deps.onEvent?.({ type: 'tool-call', name: call.name, input: call.input });
      const output = await tool.run(
        call.input,
        deps.signal ? { signal: deps.signal } : undefined,
      );
      deps.onEvent?.({ type: 'tool-result', output });
      results.push({ id: call.id, output });
    }
    conversation.push({ role: 'tool', results });
  }

  return { text: null, messages: conversation, stoppedBecause: 'turn-limit' };
}
