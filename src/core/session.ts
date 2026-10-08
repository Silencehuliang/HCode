import { runTurn, type LoopEvent, type TurnResult } from './loop.js';
import { compact } from './compact.js';
import { estimateMessageTokens } from './tokens.js';
import type { Message, Provider } from '../provider/types.js';
import type { Toolset } from './toolset.js';

export type SessionDeps = {
  provider: Provider;
  tools: Toolset;
  system: string;
  maxTurns?: number;
  /** 上下文预算(约多少 token)。给了它,才会在每轮开始前压缩。 */
  budget?: number;
  /** 估算方式。默认按字符粗估(见 tokens.ts)。 */
  estimate?: (messages: Message[]) => number;
  /** 每轮进行中发生的事,交给界面显示。 */
  onEvent?: (event: LoopEvent) => void;
};

export type Session = {
  /** 到目前为止的完整对话。 */
  readonly messages: Message[];
  /** 说一句,等这一轮结束。 */
  send(text: string): Promise<TurnResult>;
  /** 叫停正在跑的这一轮。没有在跑时是空操作。 */
  abort(): void;
};

/**
 * 一段持续下去的对话。
 *
 * 它存在的理由是**守住一个不变量**:一次只有一轮在动对话。这个不变量必须由
 * 会话自己持有,不能推给调用方 —— 调用方哪怕有一次忘了 await(终端里粘贴一段
 * 多行文本就是这样,readline 会把每一行几乎同时交出来),两轮就会各自基于一份
 * 过期的对话继续,谁最后结束谁把对方的记录覆盖掉。这类错误只在长会话里显形。
 *
 * 界面因此可以只做两件事:把用户的话递进来、把事件显示出去。
 */
export function createSession(deps: SessionDeps): Session {
  let messages: Message[] = [];
  let running: AbortController | null = null;

  /** 排队的链条。每一次 send 挂在上一次的尾巴后面。 */
  let tail: Promise<unknown> = Promise.resolve();

  return {
    get messages() {
      return messages;
    },

    abort() {
      running?.abort();
    },

    send(text) {
      const turn = tail.then(async () => {
        const before = messages;

        // 压缩在**用户这句话进来之前**做。反过来做的话,刚说出口的这句也可能被
        // 摘掉,而模型会表现得像没听见 —— 用户只会觉得"它怎么答非所问"。
        if (deps.budget !== undefined) {
          const compaction = await compact(messages, {
            estimate: deps.estimate ?? estimateMessageTokens,
            budget: deps.budget,
            // 摘要走同一个 provider。失败就让它抛出去 —— 用一句占位符默默顶上,
            // 等于把之前的对话真的丢掉,却看起来像成功了。
            summarize: async (prompt) => {
              const response = await deps.provider.send({
                system: deps.system,
                messages: [{ role: 'user', text: prompt }],
                tools: [],
              });
              return response.text ?? '(模型没有返回摘要内容)';
            },
          });
          messages = compaction.messages;
        }

        messages = [...messages, { role: 'user', text }];
        running = new AbortController();

        try {
          const result = await runTurn({ ...deps, signal: running.signal }, messages);
          messages = result.messages;
          return result;
        } catch (error) {
          // 这一轮整个失败了(厂商报错之类),把用户那句话退回去 —— 否则重试
          // 一次就会在对话里留下两句紧挨着的用户消息。
          messages = before;
          throw error;
        } finally {
          running = null;
        }
      });

      // 一次失败不能卡住后面排队的。错误本身照常交给调用方。
      tail = turn.catch(() => {});
      return turn;
    },
  };
}
