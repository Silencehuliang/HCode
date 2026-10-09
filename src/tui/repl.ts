import { createInterface } from 'node:readline';

import { createSession } from '../core/session.js';
import type { LoopEvent } from '../core/loop.js';
import { guardToolset, type PermissionRequest } from '../core/permission.js';
import { expandAgentMention } from '../core/agents.js';
import { expandCouncilMention } from '../core/council.js';
import { createToolset } from '../core/toolset.js';
import type { Tool } from '../core/tool.js';
import type { Provider } from '../provider/types.js';

export type ReplOptions = {
  provider: Provider;
  /** 未加守门的工具。权限这一层由界面来问,因为终端在界面手上。 */
  tools: Tool[];
  system: string;
  /** 上下文预算(约多少 token)。到了就压缩。 */
  budget?: number;
  /** 可点名的角色名(@点名用)。不给就关闭 @ 展开。 */
  agentNames?: string[];
  /**
   * 开着 council 工具没有(v2-14)。开着才认 `@council` —— 能问的家不到两家
   * 时工具压根不注册,这时认出 @council 反而是骗人。
   */
  council?: boolean;
  /** council 没开时,`@council` 该收到的那句解释(由调用方按"为什么没开"写)。 */
  councilOffNote?: string;
  /** 用户层的权限规则(settings.json 的 permissions)。 */
  rules?: readonly { pattern: string; verdict: 'allow' | 'ask' | 'deny' }[];
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
    return;
  }
  if (event.type === 'subagent-done') {
    // 多角色最大的隐性代价是 token 成本 —— 一行说清这次派发花了什么。
    // 车道分支也写在这一行:改了东西却没看到"落在哪条分支上",是没法审的。
    const tokens = event.tokens >= 1000 ? `${(event.tokens / 1000).toFixed(1)}k` : `${event.tokens}`;
    const seconds = (event.durationMs / 1000).toFixed(1);
    const lane = event.lane !== undefined ? ` · 车道 ${event.lane}` : '';
    process.stdout.write(
      `\n⏺ [${event.agent} · ${event.model} · ~${tokens} token · ${seconds}s${lane}]\n`,
    );
    return;
  }
  // 工具结果是给模型看的原文,原样显示 —— 用户要看到的就是 stdout 与 stderr。
  process.stdout.write(`${event.output}\n`);
}

/** 问用户的话。要说清"要动什么",否则他没法判断。 */
function describe(request: PermissionRequest): string {
  const input = (request.input ?? {}) as { path?: unknown; command?: unknown };

  if (typeof input.path === 'string') return `⏺ ${request.tool}  ${input.path}`;
  if (typeof input.command === 'string') return `⏺ ${request.tool}  ${input.command}`;
  return `⏺ ${request.tool}`;
}

/**
 * 极简交互界面。
 *
 * TUI 框架的选型已被推迟(ADR-0006),这里刻意不引入任何框架。它只做四件事:
 * 读一行、把这一行递给会话、把会话里发生的事显示出来、把控制权还回来。
 *
 * 对话状态不在也不该在这里 —— 它归 createSession,连同"一次一轮"那个不变量。
 * 但**权限确认**在这里,因为终端在它手上:只有它能拦住正在跑的那一轮、问一句、
 * 再决定放不放行。
 *
 * 不给测试缝 —— 终端界面的快照测试极不稳定(见规格的 Testing Decisions)。所以这里
 * 只放展示与输入节奏,不放判断:该不该拦是 `decide` 那个纯函数的事。
 */
export async function startRepl(options: ReplOptions): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n› ',
  });

  /** 还没轮到处理的输入行。 */
  const pending: string[] = [];
  /** 正在等一个 y/n 回答。它存在时,输入行归它,不进队列。 */
  let answerWaiter: ((line: string) => void) | null = null;

  let draining = false;
  let inTurn = false;
  let closing = false;

  const say = (text: string): void => {
    process.stdout.write(`${text}\n`);
  };

  /**
   * 问一次。走的是和主循环同一条输入线 —— 所以 while 等回答时,那一行必须归这里,
   * 否则用户敲的 `y` 会被当成新的一句话发出去,而提问永远等不到答案。
   */
  function ask(request: PermissionRequest): Promise<boolean> {
    say(`\n${describe(request)}`);
    process.stdout.write('允许吗?[y/N] ');

    return new Promise((resolve) => {
      answerWaiter = (line) => resolve(/^y(es)?$/i.test(line.trim()));
    });
  }

  const session = createSession({
    provider: options.provider,
    tools: guardToolset(createToolset(options.tools), {
      approve: ask,
      ...(options.rules !== undefined ? { rules: options.rules } : {}),
    }),
    system: options.system,
    onEvent: renderEvent,
    ...(options.budget !== undefined ? { budget: options.budget } : {}),
  });

  async function handle(text: string): Promise<void> {
    if (EXIT_COMMANDS.has(text)) {
      closing = true;
      rl.close();
      return;
    }
    if (text === '') return;

    // @council:排在角色点名前面 —— council 不是角色(没有角色文件、不进花名册),
    // 是主对话手上的一个工具,所以不归 expandAgentMention 管。
    let outgoing = text;
    if (options.council === true) {
      const council = expandCouncilMention(text);
      if (council.kind === 'empty') {
        say(`\n${council.message}`);
        return;
      }
      if (council.kind === 'mention') outgoing = council.text;
    } else if (/^@council(?:\s|$)/i.test(outgoing)) {
      // 只配出一家密钥时这个工具根本没注册。这时候按角色点名去报"没有名为 council
      // 的角色",会把用户领到岔路上 —— 他要的是共识,不是名字打错了。
      say(`\n${options.councilOffNote ?? '这次没有开多模型共识。'}`);
      return;
    }

    // @角色名:在发给模型之前先展开成"派某个角色去做"的明确指令。名字不认识
    // 就地报错、不发送 —— 静默当普通文本发出去,用户会以为点名生效了。
    if (options.agentNames && outgoing.startsWith('@')) {
      const expanded = expandAgentMention(outgoing, options.agentNames);
      if (expanded.kind === 'unknown') {
        say(`
${expanded.message}`);
        return;
      }
      if (expanded.kind === 'mention') outgoing = expanded.text;
    }

    try {
      const result = await session.send(outgoing);

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
    if (answerWaiter) {
      const resolve = answerWaiter;
      answerWaiter = null;
      resolve(line);
      return;
    }

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
  const onInterrupt = (): void => {
    if (!inTurn && pending.length === 0 && !answerWaiter) {
      rl.close();
      return;
    }
    pending.length = 0;
    // 正在等权限回答时按 Ctrl+C,等于回答"不"。否决是安全的方向。
    answerWaiter?.('n');
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

  // readline 关掉之后 stdin 仍然被引用着,进程于是在等一个永远不会来的输入 ——
  // 把 stdin 接成一根不关的管道(编辑器插件、另一个程序拉起 hcode、任何不关写端的
  // 父进程),`/exit` 之后就会挂在那里,父进程等的是一个永远不退出的子进程。
  //
  // 实测(各试一遍,只写 /exit 然后看进程退不退):
  //   什么都不做     → 挂住
  //   pause()        → 挂住      ← 只写 pause 是不够的,我一开始就错在这里
  //   unref()        → 退出码 0
  //   pause()+unref()→ 退出码 0
  //   destroy()      → 退出码 0
  // 用 pause + unref 而不是 destroy:后者会真的关掉 fd 0,在真终端里是多余的动作。
  try {
    process.stdin.pause();
    process.stdin.unref();
  } catch {
    // 已经关掉、或者根本不是一个可以放开输入的流。到这一步已经无关紧要了。
  }
}
