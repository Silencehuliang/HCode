import type { Message } from '../provider/types.js';

/**
 * 会话内的任务表(v2-11)。
 *
 * **只在内存里,绝不落盘。** 这不是省事,是判断:一个会话的后台任务和这个会话
 * 的上下文是一个东西的两面 —— 子 agent 手上的消息数组、它读过的文件、它攒下的
 * 结论,全都只在这次运行里有意义。把它写到磁盘上,下次启动读回来的是一个**没有
 * 历史的孤儿**:它记得自己查过什么,却不知道当时为什么查、后来结论怎么被用了。
 * 所以进程走、任务表走,这是设计而不是缺陷 —— 本文件刻意不 import `node:fs`。
 *
 * 它也不做调度:Node 是单进程,所谓"后台"就是一个没有 await 的 Promise,真正的
 * 并发来自 event loop,不需要守护进程、不需要 job 队列(那是另一个平台的解法)。
 */

export type TaskState = 'running' | 'done' | 'failed';

export type TaskEntry = {
  id: string;
  /** 角色名;没点名的派发也记作 explorer,与成本行一致。 */
  agent: string;
  description: string;
  state: TaskState;
  startedAt: number;
  finishedAt?: number;
  tokens: number;
  /** 结论(完成时)。失败时为空 —— 失败的是 error。 */
  text?: string;
  error?: string;
  /**
   * 子 agent 自己的消息数组。留着它是为了 **followup**:补一句指令要能接着原
   * 消息数组往下跑,而不是冷启动一个新 agent 把前面查过的东西再查一遍。
   */
  messages?: Message[];
  /** 原始委派参数 —— followup 要按同一个角色重新装配。 */
  spec: { agent?: string; description: string; prompt: string; context?: string };
};

export type TaskRegistry = {
  /** 开一条新记录(状态 running)。id 形如 t1、t2 —— 人能念、模型好引用。 */
  start(entry: { agent: string; description: string; spec: TaskEntry['spec'] }): TaskEntry;
  finish(id: string, result: { text: string; tokens: number; messages: Message[] }): void;
  fail(id: string, error: string): void;
  get(id: string): TaskEntry | undefined;
  /** 按开始顺序列出。 */
  list(): TaskEntry[];
};

export function createTaskRegistry(): TaskRegistry {
  const entries = new Map<string, TaskEntry>();
  let counter = 0;

  const must = (id: string): TaskEntry => {
    const entry = entries.get(id);
    if (!entry) throw new Error(`没有这个任务:${id}`);
    return entry;
  };

  return {
    start({ agent, description, spec }) {
      counter += 1;
      const entry: TaskEntry = {
        id: `t${counter}`,
        agent,
        description,
        state: 'running',
        startedAt: Date.now(),
        tokens: 0,
        spec,
      };
      entries.set(entry.id, entry);
      return entry;
    },
    finish(id, result) {
      const entry = must(id);
      entry.state = 'done';
      entry.finishedAt = Date.now();
      entry.tokens += result.tokens;
      entry.text = result.text;
      entry.messages = result.messages;
    },
    fail(id, error) {
      const entry = must(id);
      entry.state = 'failed';
      entry.finishedAt = Date.now();
      entry.error = error;
    },
    get(id) {
      return entries.get(id);
    },
    list() {
      return [...entries.values()];
    },
  };
}

/** 把一条记录渲染成一行(给 task_status 用)。 */
export function renderTaskLine(entry: TaskEntry): string {
  const elapsed = ((entry.finishedAt ?? Date.now()) - entry.startedAt) / 1000;
  const tokens = entry.tokens >= 1000 ? `${(entry.tokens / 1000).toFixed(1)}k` : String(entry.tokens);
  const state =
    entry.state === 'running' ? '运行中' : entry.state === 'done' ? '已完成' : '失败';
  const tail =
    entry.state === 'done'
      ? `~${tokens} token · ${elapsed.toFixed(1)}s`
      : entry.state === 'running'
        ? `已跑 ${elapsed.toFixed(0)}s`
        : `—— ${entry.error ?? '没有错误信息'}`;
  return `${entry.id} · ${entry.agent} · ${state} · ${entry.description} · ${tail}`;
}
