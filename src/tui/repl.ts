import { createInterface } from 'node:readline';

import { createSession } from '../core/session.js';
import type { LoopEvent } from '../core/loop.js';
import type { Toolset } from '../core/toolset.js';
import type { Provider } from '../provider/types.js';

export type ReplOptions = {
  provider: Provider;
  tools: Toolset;
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
 * TUI 框架的选型已被推迟(ADR-0006),这里刻意不引入任何框架。它只做四件事:
 * 读一行、把这一行递给会话、把会话里发生的事显示出来、把控制权还回来。
 *
 * 对话状态不在这里 —— 它归 createSession,连同"一次一轮"那个不变量。这里只剩
 * 输入节奏:哪一行先、哪一行后,以及用户按 Ctrl+C 时该丢什么。
 *
 * 不给测试缝 —— 终端界面的快照测试极不稳定,维护成本高于收益(见规格的
 * Testing Decisions)。所以这里只放展示与输入节奏,不放判断。
 */
export async function startRepl(options: ReplOptions): Promise<void> {
  const session = createSession({
    provider: options.provider,
    tools: options.tools,
    system: options.system,
    onEvent: renderEvent,
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n› ',
  });

  /** 还没轮到处理的输入行。 */
  const pending: string[] = [];
  let draining = false;
  let inTurn = false;
  let closing = false;

  const say = (text: string): void => {
    process.stdout.write(`${text}\n`);
  };

  async function handle(text: string): Promise<void> {
    if (EXIT_COMMANDS.has(text)) {
      closing = true;
      rl.close();
      return;
    }
    if (text === '') return;

    try {
      const result = await session.send(text);

      if (result.text) say(`\n${result.text}`);
      if (result.stoppedBecause === 'turn-limit') {
        say('\n(已达这一轮的调用上限,先停在这里。接着说就行。)');
      }
      if (result.stoppedBecause === 'aborted') say('\n(已中断。接着说就行。)');
    } catch (error) {
      // 厂商的原始报错原样显示,不做友好化 —— "余额不足"和"参数不支持"
      // 是两种不同的下一步,包成一句"出错了"就把这个区别抹掉了。
      say(`\n出错了:${(error as Error).message}`);
    }
  }

  /**
   * 一次只处理一行。
   *
   * 终端里粘贴一段多行文本时,readline 会把每一行几乎同时交出来。任它们各自
   * 往下走,几轮就会同时在跑。会话本身也守住了这个不变量,但这里必须自己排一遍:
   * 否则 Ctrl+C 掐掉的只是"当前那一轮",后面排着的几行会接着跑完 —— 而用户按下
   * 它是想让它停下来。
   */
  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;

    try {
      while (!closing && pending.length > 0) {
        const text = pending.shift();
        if (text === undefined) break;

        inTurn = true;
        try {
          await handle(text);
        } finally {
          inTurn = false;
        }
      }
    } finally {
      draining = false;
    }

    if (!closing) rl.prompt();
  }

  rl.on('line', (line) => {
    pending.push(line.trim());
    void drain();
  });

  // Ctrl+C 有两种含义,取决于此刻在做什么:
  //   空闲时 —— 退出。
  //   有事在做时 —— 丢掉排队的、掐掉正在跑的,但**不**退出会话。用户按下它是想
  //   让这件事停下来,不是想丢掉整个对话。
  //
  // **必须注册在 readline 接口上。** 实测(真 ConPTY,Node 22.21.1):
  //   - 终端模式下 readline 先截走 Ctrl+C,发的是接口上的 'SIGINT',
  //     `process.on('SIGINT')` **不会**触发。
  //   - 而且此时若接口上没有监听者,readline 会 pause 输入流 —— 表现为整个会话
  //     无声无息地死掉,连后面的输入都不再响应。这个失败模式极难从表面推断。
  // 进程上的那份留给非终端场景(输入是管道、输出是控制台),那时 readline 不在
  // 终端模式、不截按键,进程级信号才是能到的那个。
  const onInterrupt = (): void => {
    if (!inTurn && pending.length === 0) {
      rl.close();
      return;
    }
    pending.length = 0;
    say('\n(正在中断…)');
    session.abort();
  };

  rl.on('SIGINT', onInterrupt);
  process.on('SIGINT', onInterrupt);

  await new Promise<void>((resolve) => {
    rl.on('close', resolve);
    rl.prompt();
  });

  // 退出时把提示行收干净,免得终端停在半个 prompt 上。
  process.stdout.write('\n');
}
