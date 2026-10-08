import { execFile } from 'node:child_process';

import type { Tool } from '../core/tool.js';

type CommandOutcome = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/** 换行与行尾空白的归一化 —— 属于通道处理,不属于语义判断。 */
function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

function execute(command: string): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          exitCode: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
          stdout: normalize(stdout ?? ''),
          stderr: normalize(stderr ?? ''),
        });
      },
    );
  });
}

function format(outcome: CommandOutcome): string {
  return [
    `exit code: ${outcome.exitCode}`,
    '--- stdout ---',
    outcome.stdout,
    '--- stderr ---',
    outcome.stderr,
  ].join('\n');
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
        },
        required: ['command'],
      },
    },

    async run(input) {
      const { command } = input as { command: string };
      return format(await execute(command));
    },
  };
}
