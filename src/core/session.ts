import { runTurn, type LoopEvent, type TurnResult } from './loop.js';
import type { Message, Provider } from '../provider/types.js';
import type { Tool } from './tool.js';

export type SessionDeps = {
  provider: Provider;
  tools: Tool[];
  system: string;
  maxTurns?: number;
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
