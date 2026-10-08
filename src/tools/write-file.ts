import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Tool } from '../core/tool.js';

function countLines(text: string): number {
  const body = text.replace(/\r?\n$/, '');
  return body === '' ? 0 : body.split(/\r?\n/).length;
}

function write(path: string, content: string): string {
  const existed = existsSync(path);

  // 父目录一并建出来。让模型先跑一条 mkdir 是白费一步,而且那一步失败时它还得
  // 自己判断该不该重试。
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);

  const lines = countLines(content);
  return existed
    ? `已覆写 ${path}(原有内容已被替换,共 ${lines} 行)。`
    : `已新建 ${path}(${lines} 行)。`;
}

/**
 * 新建或整份覆写。
 *
 * 它是 `edit_file` 的补充而不是替代:改写已有文件时,整份重写产出的 diff 是"整个
 * 文件都变了",没法审查。所以工具描述里把这件事说给模型听。
 */
export function createWriteFileTool(): Tool {
  return {
    spec: {
      name: 'write_file',
      description:
        '新建文件,或整份覆写已有文件。父目录不存在会自动创建。\n' +
        '**改已有文件请优先用 edit_file** —— 整份重写会丢掉原有内容,产出的 diff 也没法审查。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '要写入的完整内容' },
        },
        required: ['path', 'content'],
      },
    },

    async run(input) {
      const { path, content } = input as { path: string; content: string };
      return write(path, content);
    },
  };
}
