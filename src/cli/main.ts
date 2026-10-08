#!/usr/bin/env node
import { SUBAGENT_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../core/system-prompt.js';
import { createGlmProvider } from '../provider/glm.js';
import type { Provider } from '../provider/types.js';
import { createExplorerTools, createTools } from '../tools/index.js';
import { createTaskTool } from '../tools/task.js';
import { createTodoStore } from '../core/todos.js';
import { startRepl } from '../tui/repl.js';
import { loadConfig, type Session } from './config.js';

/** 上下文预算的默认值。留出余量给模型这一轮的回答。 */
const DEFAULT_CONTEXT_BUDGET = 96_000;

/** 子 agent 的轮次上限。比主对话紧一些 —— 派出去的是探查,不是长跑。 */
const SUBAGENT_MAX_TURNS = 20;

/**
 * 按配置造出对应的 Provider。v1 只实现了 GLM,其余两家在票 #10 —— 那时这里
 * 会长成一个 switch,而不是现在就该有的一个表。
 */
function createProvider(session: Session): Provider {
  switch (session.providerId) {
    case 'glm':
      return createGlmProvider({
        apiKey: session.apiKey,
        model: session.model,
        ...(session.baseUrl ? { baseUrl: session.baseUrl } : {}),
      });
    default:
      throw new Error(`没有 ${session.providerId} 的适配器`);
  }
}

/**
 * 会话横幅。当前用的是哪家 Provider、哪个模型必须一眼看得到 —— 用户不该在
 * 以为用的是 GLM 时实际跑在别的地方。接口地址也亮出来:自建中转与本地网关
 * 看地址才知道生效没有。
 *
 * 密钥不在这里,也不在任何输出里。
 */
function banner(session: Session): string {
  return [
    '',
    `hcode · ${session.providerId} / ${session.model}`,
    `接口:${session.baseUrl ?? '(厂商默认)'}`,
    '',
    '/exit 退出,Ctrl+C 中断正在跑的命令。',
    '',
  ].join('\n');
}

async function main(): Promise<number> {
  // 读配置必须走 loadConfig —— 它同时负责"没配好时给出能照着做的引导"。
  const outcome = loadConfig();

  if (!outcome.ok) {
    process.stderr.write(`${outcome.message}\n`);
    return 1;
  }

  const { session } = outcome;
  process.stdout.write(banner(session));

  const todos = createTodoStore();
  const provider = createProvider(session);

  // 子 agent 拿的是只读工具(createExplorerTools),不是主对话那一整套 ——
  // 它被派出去的用途是帮我查清楚,不是帮我改掉。
  const task = createTaskTool({
    provider,
    tools: createExplorerTools(),
    system: SUBAGENT_SYSTEM_PROMPT,
    maxTurns: SUBAGENT_MAX_TURNS,
  });

  await startRepl({
    provider,
    tools: [...createTools({ todos }), task],
    system: SYSTEM_PROMPT,
    budget: DEFAULT_CONTEXT_BUDGET,
  });

  return 0;
}

process.exitCode = await main();
