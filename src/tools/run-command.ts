import { execFile } from 'node:child_process';

import type { Tool } from '../core/tool.js';

type CommandOutcome = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs: number;
};

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** 模型可以显式请求更长的时间(装依赖、跑测试),但设了上限。 */
function resolveTimeout(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(requested, MAX_TIMEOUT_MS);
}

/**
 * 每次调用前把子进程的输出编码钉成 UTF-8。默认控制台代码页是 936(GBK),
 * 不注入的话中文输出与报错会变成乱码,而**乱码的报错模型无法自我纠正**。
 *
 * 这是 harness 的职责,不能写进提示词让模型自己抄 —— 实测过,模型会把它
 * 逐字抄进每条命令,而这条前导本来就在做同一件事。
 */
const PREAMBLE =
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ';

const GBK = (() => {
  try {
    return new TextDecoder('gbk');
  } catch {
    return null;
  }
})();

/**
 * 双路解码。前导对**解析级**错误无效 —— 命令整串无法解析时它不会执行,
 * 输出仍是 GBK。所以先试 UTF-8,出现替换字符再回退。
 */
function decode(bytes: Buffer): string {
  if (bytes.length === 0) return '';
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  if (GBK) {
    const gbk = GBK.decode(bytes);
    if (!gbk.includes('�')) return gbk;
  }
  return utf8;
}

/** 换行与行尾空白的归一化 —— 属于通道处理,不属于语义判断。 */
function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

const HEAD_CHARS = 8_000;
const TAIL_CHARS = 4_000;

/**
 * 头尾都留。命令的上下文在头部(列目录的结果),而**失败原因常常在尾部**
 * (npm install 的报错就在最后几十行),只留一头总会丢掉最该看的那部分。
 *
 * 截断必须显式标注 —— 模型需要知道自己看到的是不完整的。
 */
function truncate(text: string): string {
  if (text.length <= HEAD_CHARS + TAIL_CHARS) return text;
  const omitted = text.length - HEAD_CHARS - TAIL_CHARS;
  return `${text.slice(0, HEAD_CHARS)}\n… [省略 ${omitted} 字符] …\n${text.slice(-TAIL_CHARS)}`;
}

function execute(command: string, timeoutMs: number, cwd?: string): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PREAMBLE + command],
      {
        encoding: 'buffer',
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        ...(cwd ? { cwd } : {}),
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          stdout: truncate(normalize(decode(stdout))),
          stderr: truncate(normalize(decode(stderr))),
          timedOut: error?.killed === true,
          timeoutMs,
        });
      },
    );
  });
}

function format(outcome: CommandOutcome): string {
  const lines = [
    outcome.timedOut ? 'exit code: (超时终止)' : `exit code: ${outcome.exitCode}`,
    '--- stdout ---',
    outcome.stdout,
    '--- stderr ---',
    outcome.stderr,
  ];

  // 超时必须显式标注,不能只留空输出 —— 空输出会被模型误读成
  // "命令成功但没有结果",而事实是命令根本没跑完。
  if (outcome.timedOut) {
    lines.push(
      '--- 超时 ---',
      `命令在 ${outcome.timeoutMs} 毫秒后仍未返回,进程已被终止。上面的输出可能不完整。`,
    );
  }

  return lines.join('\n');
}

/**
 * PowerShell 执行工具。契约见 docs/shell-tool-contract.md。
 *
 * 设计立场:搬运事实,不做判断。工具负责把通道修好(编码、截断、超时),
 * 但把退出码、stdout、stderr 原样交给模型,不替它判断什么算失败。
 */
export function createRunCommandTool(): Tool {
  return {
    spec: {
      name: 'run_command',
      description: '在 PowerShell 里执行一条命令。',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的 PowerShell 命令' },
          cwd: {
            type: 'string',
            description: '工作目录。默认会话启动目录 —— 每次调用都是新进程,cd 不会保持',
          },
          timeout: { type: 'number', description: '超时毫秒数,默认 120000,上限 600000' },
        },
        required: ['command'],
      },
    },

    async run(input) {
      const { command, cwd, timeout } = input as {
        command: string;
        cwd?: string;
        timeout?: unknown;
      };
      return format(await execute(command, resolveTimeout(timeout), cwd));
    },
  };
}
