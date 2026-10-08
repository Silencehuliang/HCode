import type { Message } from '../provider/types.js';

export type CompactionResult = {
  messages: Message[];
  /** 做了什么。`none` 表示根本没超限。 */
  did: 'none' | 'trimmed' | 'summarized';
};

export type CompactDeps = {
  /** 估算一段对话占多少 token。注入进来,压缩逻辑因此不需要真分词器。 */
  estimate: (messages: Message[]) => number;
  /** 预算上限。 */
  budget: number;
  /** 摘要器。**只有前两步都压不下去时**才会被调用。 */
  summarize: (prompt: string) => Promise<string>;
  /** 至少保留最近这么多次工具输出不动。默认 1。 */
  floor?: number;
  /** 摘要时至少保留最近这么多条消息不动。默认 4。 */
  keepRecentMessages?: number;
};

const DEFAULT_FLOOR = 1;
const DEFAULT_KEEP_RECENT_MESSAGES = 4;

/** 短于这个长度的工具输出压不出空间,留着原样。 */
const TRIM_FLOOR = 200;

function marker(originalLength: number): string {
  return `[工具输出已压缩:原 ${originalLength} 字符已省略。需要细节就重新读一次。]`;
}

/**
 * 把最早的若干次工具输出换成一句说明。
 *
 * **只动 `output` 这个字符串**,不增删任何一条消息。少一条或多一条,厂商接口就会
 * 因为 tool_call 找不到配对的 result 而整轮报错 —— 压缩本身把对话搞坏了,是最坏的
 * 一种失败:它发生在最长的会话里,而那正是用户最舍不得丢的会话。
 */
function trimToolOutputs(messages: Message[], keep: number): Message[] {
  const outputs = messages.flatMap((message, index) => (message.role === 'tool' ? [index] : []));
  const untouched = new Set(outputs.slice(Math.max(0, outputs.length - keep)));

  return messages.map((message, index) => {
    if (message.role !== 'tool' || untouched.has(index)) return message;

    return {
      role: 'tool' as const,
      results: message.results.map((result) =>
        result.output.length <= TRIM_FLOOR
          ? result
          : { id: result.id, output: marker(result.output.length) },
      ),
    };
  });
}

/**
 * 从最旧的开始一次裁一条,裁到刚好装得下就停。
 *
 * 一次裁一条而不是"固定只留最近 N 条",是因为 N 没法通用:同样留 3 条,在
 * 一次 `npm install` 之后和在一次 `git status` 之后差着两个数量级。装得下就不再
 * 动更近的输出,保真度能留多少留多少。
 */
function trimUntilItFits(messages: Message[], deps: CompactDeps): Message[] {
  const total = messages.flatMap((message) => (message.role === 'tool' ? [message] : [])).length;
  if (total === 0) return messages;

  const floor = deps.floor ?? DEFAULT_FLOOR;

  for (let keep = total - 1; keep >= floor; keep--) {
    const candidate = trimToolOutputs(messages, keep);
    if (deps.estimate(candidate) <= deps.budget) return candidate;
  }

  return trimToolOutputs(messages, floor);
}

function transcript(messages: Message[]): string {
  return messages
    .map((message) => {
      if (message.role === 'user') return `[用户] ${message.text}`;
      if (message.role === 'assistant') {
        const calls = (message.toolCalls ?? [])
          .map((call) => `${call.name} ${JSON.stringify(call.input)}`)
          .join('、');
        return `[助手] ${message.text ?? ''}${calls ? `(调用 ${calls})` : ''}`;
      }
      return `[工具结果] ${message.results.map((result) => result.output).join('\n')}`;
    })
    .join('\n\n');
}

/**
 * 摘要的提示词由压缩自己拿着,而不是交给注入方。
 *
 * "哪些东西必须留下来"是这个模块的知识,不是调用方的 —— 摘要把关键结论丢掉,
 * 后果也只有这里最清楚。注入方只负责把它送到模型那儿。
 */
const SUMMARY_INSTRUCTIONS = [
  '把下面这段对话压缩成一份交接说明,给一个没看过原文的助手接着做。',
  '',
  '必须保留:',
  '- 已经确定的结论,以及得出结论所依据的事实 —— 不要只留下结论,要留下为什么',
  '- 涉及的文件路径、函数名、命令,以及它们各自是什么作用',
  '- 用户明确提出的要求、偏好,以及被否掉的做法',
  '- 还没做完的事,和下一步该做什么',
  '',
  '可以丢掉:工具的完整输出、试错过程、已经作废的中间结果。',
  '',
  '直接给说明本身,不要加"好的"之类的开场。',
  '',
  '对话原文:',
].join('\n');

/**
 * 找到摘要的切割点:保留最后若干条,再把切割点往前推到最近的用户消息。
 *
 * 这个回退是必须的。切在中间会留下一个孤零零的 tool 结果,它对应的 tool_call
 * 已经被摘要吃掉了 —— 厂商接口会因此直接拒绝整轮请求,而报错信息通常只说
 * "tool_call_id 找不到",很难从这里联想到是压缩造成的。
 */
function summaryCut(messages: Message[], keepRecent: number): number {
  let cut = Math.max(0, messages.length - keepRecent);
  while (cut < messages.length && messages[cut]!.role !== 'user') cut++;
  return cut;
}

/**
 * 压缩一段过长的对话。分三步,能停就停:
 *
 * 1. 没超预算 —— 什么都不做。
 * 2. 裁旧的工具输出。工具输出是对话里最占地方、也最不值得留原文的部分。
 * 3. 还超限 —— 把更早的对话交给模型摘成一份说明。
 *
 * 摘要那一步的原文取自**未裁剪**的消息:先裁后摘会让摘要只能读到一句"此处省略
 * 4000 字符",那样摘出来的东西是空的。
 */
export async function compact(
  messages: Message[],
  deps: CompactDeps,
): Promise<CompactionResult> {
  if (deps.estimate(messages) <= deps.budget) return { messages, did: 'none' };

  const trimmed = trimUntilItFits(messages, deps);
  if (deps.estimate(trimmed) <= deps.budget) return { messages: trimmed, did: 'trimmed' };

  const cut = summaryCut(messages, deps.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES);
  if (cut === 0) return { messages: trimmed, did: 'trimmed' };

  const older = messages.slice(0, cut);
  const recent = messages.slice(cut);
  const summary = await deps.summarize(
    `${SUMMARY_INSTRUCTIONS}\n\n${transcript(older)}`,
  );

  const summarized: Message[] = [
    { role: 'user', text: `[这是之前对话的摘要,不是用户刚说的话]\n\n${summary}` },
    ...recent,
  ];

  return { messages: trimUntilItFits(summarized, deps), did: 'summarized' };
}
