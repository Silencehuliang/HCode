import { readFileSync } from 'node:fs';

import type { Tool } from '../core/tool.js';

const DEFAULT_LIMIT = 2000;

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

/** 去掉结尾的那一个换行再切。否则每份以换行结尾的文件都会多出一条幽灵空行。 */
function splitLines(text: string): string[] {
  const body = text.replace(/\r?\n$/, '');
  return body === '' ? [] : body.split(/\r?\n/);
}

function read(path: string, offset: number, limit: number): string {
  // 不存在就让 readFileSync 抛 —— Node 的原文比我们自己编一句准确。
  const raw = readFileSync(path);

  if (raw.includes(0)) {
    return `这看起来是二进制文件(含 NUL 字节,共 ${raw.length} 字节),没有当作文本读。`;
  }

  const lines = splitLines(raw.toString('utf8'));
  const slice = lines.slice(offset - 1, offset - 1 + limit);

  if (slice.length === 0) {
    return `文件只有 ${lines.length} 行,offset=${offset} 超出去了。`;
  }

  const rendered = slice.map((line, index) => `${offset + index}\t${line}`).join('\n');
  const remaining = lines.length - (offset - 1) - slice.length;

  if (remaining === 0) return rendered;

  // 说清还剩多少、以及接着读的确切参数。只截断不说明,模型会以为自己看到的是全文。
  return `${rendered}\n…(还有 ${remaining} 行没有显示:用 offset=${offset + slice.length} 接着读)`;
}

/**
 * 读文件。带行号,超出上限时截断并说明怎么接着读。
 *
 * "让 agent 基于真实内容而不是猜测工作"这条验收,起点就是这个工具 —— 它读回什么,
 * 模型就只可能知道什么。
 */
export function createReadFileTool(): Tool {
  return {
    spec: {
      name: 'read_file',
      description:
        '读取一个文本文件,返回带行号的内容。' +
        '行号形如 `12\\t内容`,是我们加给你看位置的,**不属于文件内容**,不要把它抄进编辑内容里。' +
        `默认最多读 ${DEFAULT_LIMIT} 行;超出时会告诉你还剩多少行以及怎么接着读。`,
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径。相对路径按当前工作目录解析' },
          offset: { type: 'number', description: '从第几行开始读(从 1 开始),默认 1' },
          limit: { type: 'number', description: `最多读多少行,默认 ${DEFAULT_LIMIT}` },
        },
        required: ['path'],
      },
    },

    async run(input) {
      const { path, offset, limit } = input as {
        path: string;
        offset?: unknown;
        limit?: unknown;
      };
      return read(path, toPositiveInt(offset, 1), toPositiveInt(limit, DEFAULT_LIMIT));
    },
  };
}
