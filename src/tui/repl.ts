import { createInterface } from 'node:readline';

import { runTurn, type LoopEvent } from '../core/loop.js';
import type { Tool } from '../core/tool.js';
import type { Message, Provider } from '../provider/types.js';

export type ReplOptions = {
  provider: Provider;
  tools: Tool[];
  system: string;
};

const EXIT_COMMANDS = new Set(['/exit', '/quit', '/q']);

/** 工具调用显示成什么样。把命令原文亮出来 —— 用户要能看到它打算跑什么。 */
function renderToolCall(name: string, input: unknown): string {
  const { command } = (input ?? {}) as { command?: unknown };
  return typeof command === 'string' ? `\n⏺ ${name}\n  ${command}` : `\n⏺ ${name}`;
}

function renderEvent(event: LoopEvent): void {
  if (event.type === 'tool-call') {
    process.stdout.write(`${renderToolCall(event.name, event.input)}\n`);
  } else {
    // 工具结果是给模型看的原文,原样显示 —— 用户要看到的就是 stdout 与 stderr。
    process.stdout.write(`${event.output}\n`);
  }
}

/**
 * 极简交互界面。
 *
 * TUI 框架的选型已经被推迟(ADR-0006),这里刻意不引入任何框架。它只做四件事:
 * 读一行、把这一行交给主循环、把循环里发生的事显示出来、把控制权还回来。
 *
 * 不给测试缝 —— 终端界面的快照测试极不稳定,维护成本高于收益(见规格的
 * Testing Decisions)。所以这里只放展示,不放判断。
 */
export async function startRepl(options: ReplOptions): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n› ',
  });

  let messages: Message[] = [];
  let running: AbortController | null = null;

  // Ctrl+C 有两种含义,取决于此刻在做什么:
  //   空闲时 —— 退出。
  //   命令跑着的时候 —— 掐掉它,但**不**退出会话。用户按下它是想让这件事停下来,
  //   不是想丢掉整个对话。
  process.on('SIGINT', () => {
    if (running) {
      process.stdout.write('\n(正在中断…)\n');
      running.abort();
      return;
    }
    rl.close();
  });

  await new Promise<void>((resolve) => {
    rl.on('close', resolve);

    rl.on('line', (line) => {
      void (async () => {
        const text = line.trim();

        if (EXIT_COMMANDS.has(text)) {
          rl.close();
          return;
        }

        if (text !== '') {
          messages = [...messages, { role: 'user', text }];
          running = new AbortController();

          try {
            const result = await runTurn(
              {
                provider: options.provider,
                tools: options.tools,
                system: options.system,
                signal: running.signal,
                onEvent: renderEvent,
              },
              messages,
            );

            // 交还的是完整对话,不是这一轮 —— 会话因此能一直继续下去。
            messages = result.messages;

            if (result.text) process.stdout.write(`\n${result.text}\n`);
            if (result.stoppedBecause === 'turn-limit') {
              process.stdout.write('\n(已达这一轮的调用上限,先停在这里。接着说就行。)\n');
            }
            if (result.stoppedBecause === 'aborted') {
              process.stdout.write('\n(已中断。接着说就行。)\n');
            }
          } catch (error) {
            // 厂商的原始报错原样显示,不做友好化 —— "余额不足"和"参数不支持"
            // 是两种不同的下一步,包成一句"出错了"就把这个区别抹掉了。
            process.stdout.write(`\n出错了:${(error as Error).message}\n`);
          } finally {
            running = null;
          }
        }

        rl.prompt();
      })();
    });

    rl.prompt();
  });

  // 退出时把提示行收干净,免得回车后终端停在半个 prompt 上。
  process.stdout.write('\n');
}
