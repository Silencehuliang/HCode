#!/usr/bin/env node
import { SUBAGENT_SYSTEM_PROMPT, SYSTEM_PROMPT } from '../core/system-prompt.js';
import { createProvider } from '../provider/index.js';
import { createTools, createExplorerTools } from '../tools/index.js';
import { createTaskTool } from '../tools/task.js';
import { createTodoStore } from '../core/todos.js';
import { startRepl } from '../tui/repl.js';
import { discoverSkills, renderSkillCatalog } from '../core/skills.js';
import { createSkillTool } from '../tools/skill.js';
import { agentRoots, discoverAgents } from '../core/agents.js';
import { loadConfig, skillRoots } from './config.js';
import { loadInstructions, renderInstructionNote, renderInstructionsForModel } from './instructions.js';
import { banner, platformRefusal } from './startup.js';

/** 上下文预算的默认值。留出余量给模型这一轮的回答。 */
const DEFAULT_CONTEXT_BUDGET = 96_000;

/** 子 agent 的轮次上限。比主对话紧一些 —— 派出去的是探查,不是长跑。 */
const SUBAGENT_MAX_TURNS = 20;

async function main(): Promise<number> {
  const refusal = platformRefusal(process.platform);
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    return 1;
  }

  const cwd = process.cwd();

  // 读配置必须走 loadConfig —— 它同时负责"没配好时给出能照着做的引导"。
  const outcome = loadConfig({ cwd });

  if (!outcome.ok) {
    process.stderr.write(`${outcome.message}\n`);
    return 1;
  }

  const { session } = outcome;

  // 项目约定:按 HCODE.md → CLAUDE.md → AGENTS.md 取第一个存在的。
  // 读不动的情形要说出来 —— 静默当成"这个项目没有约定",用户会照着一份没生效的文件干活。
  const instructions = loadInstructions(cwd);
  for (const problem of instructions.problems) {
    process.stderr.write(`指令文件读不出来 —— ${problem}\n`);
  }

  process.stdout.write(
    banner(session, [
      renderInstructionNote(instructions),
      // 只有一份配置文件时没有歧义,不必占地方。两份以上才说得上"改了哪份生效"。
      ...(outcome.files.length > 1 ? [`配置:${outcome.files.join('  →  ')}`] : []),
    ]),
  );

  const todos = createTodoStore();
  const provider = createProvider(session);

  // 格式写坏的 skill 要说出来。静默跳过的话,用户会一直以为它在生效。
  const skills = await discoverSkills(skillRoots());
  for (const problem of skills.problems()) {
    process.stderr.write(`skill 读不出来 —— ${problem}\n`);
  }

  // 角色与 skill 同一待遇:目录不存在是正常,文件读不懂必须说。
  const agents = await discoverAgents(agentRoots());
  for (const problem of agents.problems()) {
    process.stderr.write(`角色文件读不出来 —— ${problem}\n`);
  }

  // task 不传 agent 参数时的缺省行为:派只读探查者(V1 行为,向后兼容)。
  // 主对话全量工具传给 task 作白名单取材范围;白名单缺省(角色没写 tools)
  // 时继承它但剥掉 task 自己。
  const mainTools = [...createTools({ todos }), createSkillTool(skills)];
  const task = createTaskTool({
    provider,
    tools: createExplorerTools(),
    system: SUBAGENT_SYSTEM_PROMPT,
    maxTurns: SUBAGENT_MAX_TURNS,
    agents,
    allTools: mainTools,
  });

  await startRepl({
    provider,
    tools: [...mainTools, task],
    system: [
      SYSTEM_PROMPT,
      renderInstructionsForModel(instructions),
      renderSkillCatalog(skills.list()),
    ]
      .filter(Boolean)
      .join('\n\n'),
    budget: DEFAULT_CONTEXT_BUDGET,
  });

  return 0;
}

process.exitCode = await main();
