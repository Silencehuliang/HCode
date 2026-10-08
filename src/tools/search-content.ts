import { readFileSync } from 'node:fs';

import type { Tool } from '../core/tool.js';
import { walkFiles } from './walk.js';

const DEFAULT_MAX_RESULTS = 100;
/** 单个文件超过这个大小就不搜了 —— 那不是源码。 */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LINE_CHARS = 300;

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

function search(root: string, pattern: string, maxResults: number): string {
  // 正则不合法就让 RegExp 抛 —— 原文回给模型,它自己会看出来括号少了一个。
  const regex = new RegExp(pattern);

  const files = walkFiles(root);
  const hits: string[] = [];
  let filesWithHits = 0;

  for (const file of files) {
    let raw: Buffer;
    try {
      raw = readFileSync(file.abs);
    } catch {
      continue;
    }
    if (raw.length > MAX_FILE_BYTES || raw.includes(0)) continue;

    const lines = raw.toString('utf8').split(/\r?\n/);
    const matched: string[] = [];

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      if (!regex.test(line)) continue;
      const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
      matched.push(`${file.rel}:${index + 1}: ${shown.trim()}`);
    }

    if (matched.length === 0) continue;
    filesWithHits++;
    hits.push(...matched);
  }

  if (hits.length === 0) {
    return `在 ${files.length} 个文件里没有匹配 ${pattern} 的行。`;
  }

  const shown = hits.slice(0, maxResults);
  const tail =
    hits.length > shown.length
      ? `\n…(命中 ${hits.length} 行,只显示了前 ${shown.length} 行)`
      : '';

  return `命中 ${hits.length} 行,分布在 ${filesWithHits} 个文件:\n${shown.join('\n')}${tail}`;
}

/**
 * 按内容搜索。正则可表达"概念"而不只是字面(比如 `fetch\(|axios` 找所有发请求的地方)。
 *
 * 自己遍历而不复用 PowerShell 的 Select-String:搜索是高频工具,输出格式必须稳,
 * 而解析 shell 的文本输出是脆弱面 —— 而且那会绕回代码页问题,把语义判断塞回
 * shell 工具层,与它的契约相悖。
 */
export function createSearchContentTool(): Tool {
  return {
    spec: {
      name: 'search_content',
      description:
        '在文件内容里按正则搜索,返回 `路径:行号: 内容`。\n' +
        '正则,不是字面量 —— `fetch\\(|axios` 一次找出所有发请求的地方。\n' +
        '默认跳过 node_modules、.git、dist 等目录。',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '正则表达式(JavaScript 语法)' },
          path: { type: 'string', description: '搜索的根目录,默认当前工作目录' },
          max_results: {
            type: 'number',
            description: `最多返回多少行,默认 ${DEFAULT_MAX_RESULTS}`,
          },
        },
        required: ['pattern'],
      },
    },

    async run(input) {
      const { pattern, path, max_results: maxResults } = input as {
        pattern: string;
        path?: string;
        max_results?: unknown;
      };
      return search(
        path ?? process.cwd(),
        pattern,
        toPositiveInt(maxResults, DEFAULT_MAX_RESULTS),
      );
    },
  };
}
