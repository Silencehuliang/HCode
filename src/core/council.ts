import { contractInstruction } from './output-contract.js';
import { formatTokens } from './tokens.js';

/**
 * 多模型共识(v2-14)。
 *
 * 这个模块只放**纯的东西**:提示词、拼给议员的问题、把各家回答合成一份报告的渲染。
 * 真正去问模型的那部分在 tools/council.ts —— 分开是为了让"报告长什么样"能单独
 * 测,不必先跑一遍模型。
 *
 * 一件必须说清的事:**议员没有工具**。它们看不到用户的工作区,只看得到问题本身。
 * 所以主对话有责任把材料(相关代码、报错原文、已经跑出来的结论)贴进问题里 ——
 * 这一条写进了工具说明、@council 的展开文案和文档里,因为它是这个功能最容易被
 * 用错的地方:拿着一个空问题去问三家,得到的是三段聪明的空话。
 */

/** 至少两家才谈得上"共识"。一家的话这个工具只是绕远路的普通提问。 */
export const MIN_COUNCILORS = 2;

/**
 * 议员的系统提示。
 *
 * 它的任务是让几家的回答**可比**:同一份输入、同一种交付形状,合成角色才挑得出
 * 一致与分歧。所以要压住那些让回答没法对齐的东西(复述问题、客套、"我打算验证
 * 一下")。
 */
export const COUNCIL_SYSTEM_PROMPT = [
  '你是一家多模型评审团里的一名议员。同一个问题会同时发给几家模型,再由一个记录员把大家的回答合成一份共识报告。',
  '合成本身的价值在于挑出各家不一致的地方,所以含糊其辞没有意义。',
  '',
  '你要做的只有一件事:直接给出你的判断。',
  '—— 先给结论,再给理由。理由要能被复核:引用具体文件、函数、命令与报错的原话。',
  '—— 明说你不确定的地方,以及什么证据能推翻你。',
  '—— 你没有工具,看不到任何文件,也执行不了命令。看不着的东西就说看不着,不要写"接下来我会去检查 X"。',
  '—— 不要复述问题,不要客套,不要写"作为一名 AI 模型"。',
].join('\n');

/**
 * 记录员的系统提示。
 *
 * 它要交付的是一个 JSON(见 COUNCIL_OUTPUT_FIELDS),而"只回 JSON"这句话由
 * output-contract 拼在 prompt 里 —— 提示词里不重复一遍,免得两处措辞漂移。
 */
export const SYNTHESIS_SYSTEM_PROMPT = [
  '你是多模型评审团里的记录员。几家模型对同一个问题各给了一份回答,你要把它们合成一份报告。',
  '',
  '你的读者是一个准备做决定的人,他已经看过各家原话 —— 所以要下的功夫不在于复述,在于挑拣:',
  '—— 一致的点收拢成几条结论,别把三家的同义句抄三遍。',
  '—— 分歧的点逐条写清:分歧在哪、各方立的什么理由、要判出高下还需要什么证据。',
  '—— 一家答得比别家好、或者别家指出它错了,都要说出来。',
  '—— 谁也没提到、但你看出问题的地方,也可以点一句。',
].join('\n');

/** 合成报告的骨架(v2-10 的输出约定复用:校验、重试、失败回原文都照那套走)。 */
export const COUNCIL_OUTPUT_FIELDS = ['共识', '分歧'] as const;

/** 一名议员的回答。failed 为真时 text 是"为什么没答上来",不是它的观点。 */
export type CouncilVote = {
  id: string;
  model: string;
  text: string;
  tokens: number;
  failed?: boolean;
};

/** 交给记录员的 prompt:问题、各家原话、以及输出约定。 */
export function synthesisPrompt(question: string, votes: readonly CouncilVote[]): string {
  const parts = [
    `问题:\n${question}`,
    votes
      .map((vote) => `【${vote.id} · ${vote.model}】${vote.failed === true ? '(这一家没答上来)' : ''}\n${vote.text}`)
      .join('\n\n'),
    contractInstruction([...COUNCIL_OUTPUT_FIELDS]),
    // 实测:只说"字段是 共识/分歧",记录员会把每一节写成对象数组
    // ([{"点":"…","说明":"…"}]),报告里就成了一坨原始 JSON。要求它写成短句。
    '两节都写成短句的列表(字符串数组),一条一句 —— 不要写成嵌套的对象。',
  ];
  return parts.join('\n\n');
}

/**
 * 两次都没按约定交时的报告正文。
 *
 * 刻意不复用 output-contract 的 contractFailure:那句话是回给**模型**的措辞
 * (「角色 X 没按输出约定交付」),而这里是给用户看的报告里的一节 —— 换一个
 * 说法,别让用户去找"这个角色是谁"。
 */
export function synthesisFailure(missing: readonly string[], text: string): string {
  return [
    `记录员两次都没有按约定给报告(缺 ${missing.join('、')})。它最后说的是(原文照传):`,
    '',
    text,
  ].join('\n');
}

/** 一节报告:数组按条目另起行,字符串原样接在标题后面,空的自成一个说明。 */
function formatSection(label: string, value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return `${label}:${trimmed === '' ? '(这一节是空的)' : trimmed}`;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
    return items.length === 0
      ? `${label}:(这一节是空的)`
      : `${label}:\n${items.map((item) => `- ${item}`).join('\n')}`;
  }
  return `${label}:${JSON.stringify(value)}`;
}

/**
 * 合成的报告。
 *
 * 一条消息交回去(不是 N 条):压缩器的地基是"每个工具调用都能在紧接的 tool
 * 消息里找到成对 id",拆成多条会把这条地基敲掉 —— 与 task 的批量回传同一个理由。
 */
export function renderCouncilReport(
  question: string,
  votes: readonly CouncilVote[],
  synthesis: { ok: true; value: Record<string, unknown> } | { ok: false; text: string },
  totalTokens: number,
): string {
  const lines = [
    `多模型共识 —— 同一个问题同时问了 ${votes.length} 家,下面是各家的回答原样,最后是记录员的合成报告。`,
    '',
    `问题:${question}`,
    '',
  ];

  for (const vote of votes) {
    lines.push(`【${vote.id} · ${vote.model}】`, vote.text, '');
  }

  lines.push('合成报告:');
  if (synthesis.ok) {
    lines.push(formatSection('共识', synthesis.value['共识']));
    lines.push(formatSection('分歧', synthesis.value['分歧']));
  } else {
    lines.push(synthesis.text);
  }

  lines.push('', `(合计 ~${formatTokens(totalTokens)} token,估算 —— 这是几家的账,不是一家的。)`);
  return lines.join('\n');
}

/**
 * 系统提示里的那句提醒。少于两家时返回空串:能问的家不够,提它只会让模型去试
 * 一个注定失败的工具。
 */
export function renderCouncilNote(ids: readonly string[]): string {
  if (ids.length < MIN_COUNCILORS) return '';
  return [
    `要交叉验证一个判断、或者想看看几家模型的说法一不一致,可以用 council 工具(现在能问:${ids.join('、')})。`,
    '它把同一个问题同时问给这几家,再合成一份"哪里一致、哪里分歧"的报告。',
    '注意议员没有工具、看不到你的工作区 —— 相关代码和结论要你贴进 question 里。',
    '用户写 @council <问题> 也是这个意思。',
  ].join('\n');
}

const COUNCIL_MENTION = /^@council(?:\s+([\s\S]*))?$/i;

/**
 * `@council <问题>` 的展开。
 *
 * 它不走角色点名那条路: council 不是一个角色(没有角色文件、不进花名册),而是
 * 主对话手上的一个工具。名字认不出时宁可报错也不当普通文本发出去 —— 与 @角色名
 * 同一个理由:静默发出去,用户会以为点名生效了。
 */
export function expandCouncilMention(
  line: string,
): { kind: 'plain' } | { kind: 'mention'; text: string } | { kind: 'empty'; message: string } {
  const match = COUNCIL_MENTION.exec(line.trim());
  if (!match) return { kind: 'plain' };

  const rest = (match[1] ?? '').trim();
  if (rest === '') {
    return {
      kind: 'empty',
      message: '@council 后面要带上问题 —— 比如:@council 这个重试策略有没有并发上的坑',
    };
  }

  return {
    kind: 'mention',
    text: [
      `用 council 工具对下面这个问题做一次多模型共识。`,
      '议员没有工具、看不到工作区,所以把相关代码、报错原文或已有结论一并交给它:',
      rest,
    ].join('\n'),
  };
}
