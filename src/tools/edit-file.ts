import { readFileSync, writeFileSync } from 'node:fs';

import type { Tool } from '../core/tool.js';

/** 文件自己的换行风格。写入时必须沿用,否则整个文件的 diff 会变成"每一行都改了"。 */
function detectEol(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * 把片段统一成文件自己的换行。read_file 把行尾归一成了 LF,模型拿到的片段自然是
 * LF —— 直接拿它去 CRLF 文件里找,会一处都找不到。
 */
function toEol(text: string, eol: string): string {
  return text.replace(/\r?\n/g, eol);
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  let from = 0;
  for (;;) {
    const index = text.indexOf(needle, from);
    if (index === -1) return found;
    found.push(index);
    from = index + needle.length;
  }
}

function commonPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length);
  let index = 0;
  while (index < limit && a[index] === b[index]) index++;
  return index;
}

/**
 * 找不到时指一个最像的位置。
 *
 * 只说"没找到",模型只能把整个文件重读一遍;而它给的那段往往和真内容只差几个字符
 * (一个数字、一处缩进)。指出最接近的那一行,通常一眼就能对上。
 */
function closestLine(original: string, needle: string): { line: number; text: string } | null {
  const lines = original.split(/\r?\n/);
  const target = needle.split(/\r?\n/)[0] ?? '';

  let bestLine = 0;
  let bestText = '';
  let bestScore = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (line === target) return { line: index + 1, text: line };

    const score = commonPrefixLength(line, target);
    if (score > bestScore) {
      bestScore = score;
      bestLine = index + 1;
      bestText = line;
    }
  }

  // 前缀短到这种程度的"相似"都是噪音,报出去只会误导。
  return bestScore >= 4 ? { line: bestLine, text: bestText } : null;
}

function edit(path: string, oldString: string, newString: string): string {
  // 不存在就让 readFileSync 抛 —— Node 的原文最准确,由 toolset 原样交回模型。
  const original = readFileSync(path, 'utf8');
  const eol = detectEol(original);

  const needle = toEol(oldString, eol);
  const replacement = toEol(newString, eol);
  const hits = occurrences(original, needle);

  if (hits.length === 0) {
    const near = closestLine(original, needle);
    const hint = near
      ? `最接近的是第 ${near.line} 行:${near.text}`
      : '它的第一行在文件里也找不到 —— 内容可能已经变了,重新读一遍这个文件。';
    return `没有找到要替换的原文:\n${oldString}\n${hint}`;
  }

  if (hits.length > 1) {
    const where = hits.map((index) => lineOf(original, index)).join('、');
    return (
      `这段在文件里出现了 ${hits.length} 处(第 ${where} 行),没有动它。\n` +
      '请把上下文加长,让匹配唯一 —— 猜哪一处是静默的错,改完看不出来。'
    );
  }

  const at = hits[0] ?? 0;
  const updated = original.slice(0, at) + replacement + original.slice(at + needle.length);
  writeFileSync(path, updated);

  const start = lineOf(original, at);
  const end = start + replacement.split(eol).length - 1;
  const range = start === end ? `第 ${start} 行` : `第 ${start}-${end} 行`;
  return `已改 ${path} ${range}。`;
}

/**
 * 改文件。按原文片段精确替换,**不整份重写** —— 这样 diff 才是可审查的。
 *
 * 有歧义(找不到、或找到多处)时一律不动文件,并把情况说清楚。静默猜一处是这类
 * 工具最坏的失败方式:改动看着成功了,错在别处。
 */
export function createEditFileTool(): Tool {
  return {
    spec: {
      name: 'edit_file',
      description:
        '把文件里的一段原文替换成新内容。**这是改已有文件的默认方式** —— 整份重写请用 write_file,但那会产出不可审查的 diff。\n' +
        '"原文"必须在文件里唯一出现;找不到或有歧义时会告诉你,并**不会**改动文件。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          old_string: {
            type: 'string',
            description: '要被替换的原文。要足够长,保证在文件里唯一',
          },
          new_string: { type: 'string', description: '替换成什么。空串表示删除' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },

    async run(input) {
      const { path, old_string: oldString, new_string: newString } = input as {
        path: string;
        old_string: string;
        new_string: string;
      };
      return edit(path, oldString, newString);
    },
  };
}
