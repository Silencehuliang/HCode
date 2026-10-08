import type { Message } from '../provider/types.js';

/**
 * 中日韩文字。它们的编码效率跟英文完全不是一回事:一个汉字差不多就是一个 token,
 * 而英文是四个字符一个。
 */
const CJK = /[ᄀ-ᇿ⺀-〿぀-ヿ㄰-㆏㐀-䶿一-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯]/;

/** 每条消息的固定开销(角色、分隔符这些)。 */
const MESSAGE_OVERHEAD = 4;

/**
 * 粗略估一段文本占多少 token。
 *
 * 不引分词器:这里要的只是一个**能触发压缩**的近似值,不需要精确。估得偏小会让
 * 压缩来不及,所以宁可略微高估。
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;

  for (const char of text) {
    if (CJK.test(char)) wide++;
    else narrow++;
  }

  return wide + Math.ceil(narrow / 4);
}

/** 估一段对话占多少 token。工具参数与工具输出都要算 —— 它们恰恰是最占地方的部分。 */
export function estimateMessageTokens(messages: Message[]): number {
  let total = 0;

  for (const message of messages) {
    total += MESSAGE_OVERHEAD;

    if (message.role === 'user') {
      total += estimateTokens(message.text);
      continue;
    }

    if (message.role === 'assistant') {
      total += estimateTokens(message.text ?? '');
      for (const call of message.toolCalls ?? []) {
        total += estimateTokens(call.name) + estimateTokens(JSON.stringify(call.input) ?? '');
      }
      continue;
    }

    for (const result of message.results) total += estimateTokens(result.output);
  }

  return total;
}
