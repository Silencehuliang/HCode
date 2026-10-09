import { homedir } from 'node:os';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseFrontmatter } from './skills.js';
import { BUILTIN_AGENT_DEFS, BUILTIN_AGENT_ORIGIN } from './builtin-agents.js';

/**
 * 一个角色 = 一份 md 文件。
 *
 * frontmatter 只收 5 个字段 —— name / description / tools / model / permission。
 * 每加一个字段都要过一遍"没有它角色还能不能用"的拷问(见 ADR-0007):
 * 这 5 个是"能不能派出去、派成什么样"的最小完备集,再多的都属于调优,
 * 调优可以等,复杂度闸门先守住。
 */
export type AgentDef = {
  name: string;
  /** 一句话说明,给主对话的花名册用。 ≤ 一行,超长截断发生在渲染层。 */
  description: string;
  /** 正文即系统提示词。 */
  systemPrompt: string;
  /** 工具白名单,逗号分隔。缺省 = 继承主对话工具集。 */
  tools?: string[];
  /** 模型指向,如 `deepseek` 或 `glm:glm-5.3`。缺省 = 继承主对话。原始值存这里,解析归 v2-03。 */
  model?: string;
  /** 权限声明,只允许收紧。原始值存这里,叠加语义归 v2-02/v2-08。 */
  permission?: string;
  /** 定义文件。 */
  path: string;
  /** 来自哪个根目录 —— 项目赢还是用户赢,要让用户看得出来。 */
  origin: string;
};

/** 角色的 model 字段解析结果:指向哪一家、要不要覆盖模型名。 */
export type ModelBinding = {
  providerId: string;
  model?: string;
};

/**
 * 解析角色 frontmatter 的 model 值:`deepseek` 或 `glm:glm-5.3`。
 *
 * 只按**第一个**冒号切 —— 有的模型名自己带冒号(如 `glm-4.5:air`),后半段
 * 整体都是模型名。冒号后为空视为没写覆盖。空串/全空白返回 undefined(= 继承
 * 主对话),这是"没写"而不是"写错了"。
 */
export function parseModelBinding(raw: string | undefined): ModelBinding | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;

  const colon = trimmed.indexOf(':');
  if (colon < 0) return { providerId: trimmed };
  const providerId = trimmed.slice(0, colon).trim();
  const model = trimmed.slice(colon + 1).trim();
  if (providerId === '') return undefined;
  return model === '' ? { providerId } : { providerId, model };
}

/**
 * 启动时的角色绑定体检:哪些角色的 model 指向了配不出实例的家。
 *
 * 返回警告文案(空数组 = 全部健康),显示与否归调用方 —— core 不碰 stderr。
 */
export function agentModelWarnings(agents: AgentDef[], availableProviderIds: readonly string[]): string[] {
  const warnings: string[] = [];
  for (const def of agents) {
    const binding = parseModelBinding(def.model);
    if (!binding) continue;
    if (availableProviderIds.includes(binding.providerId)) continue;
    warnings.push(
      `角色 ${def.name} 的 model 指向 ${binding.providerId},但配置里凑不出这一家的密钥 —— 派发它时会回退主对话的模型。`,
    );
  }
  return warnings;
}

export type AgentCatalog = {
  list(): AgentDef[];
  get(name: string): AgentDef | undefined;
  /** 发现过程中的格式问题。不静默,由调用方显示。 */
  problems(): string[];
};

/**
 * 角色的搜索根目录,按优先级排列:项目 > 用户。
 *
 * 刻意**不**包含 `.claude/agents` —— 各家 frontmatter 的语法契约不同,
 * 一份为别家写的角色文件里,`tools` 的取值域和语义都可能是另一套;读它等于
 * 承诺兼容一个我们控制不了的方言。skill 读 `.claude/skills` 是因为那边的
 * 契约只有 name/description 两个字符串,没有语义可错位(见 ADR-0007)。
 */
export function agentRoots(): string[] {
  // 放在这里而不是 config.ts,是因为这份顺序就是角色语义的一部分:
  // 改顺序 = 改"谁覆盖谁",不该和配置读取的杂事混在一起。
  const cwd = process.cwd();
  return [join(cwd, '.hcode', 'agents'), join(homedir(), '.hcode', 'agents')];
}

/** tools 字段的合法形状:逗号分隔,空白宽容。 */
function parseTools(raw: string): string[] {
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

/** 解析一份角色文本(文件读出来或内置嵌入的,同一套契约)。 */
export function parseAgentText(text: string, fallbackName: string, origin: string, path: string): AgentDef | string {
  const parsed = parseFrontmatter(text);

  if (!parsed) {
    return `${path}:开头没有 frontmatter。角色文件需要以 --- 开头,并在里面写明 name 与 description。`;
  }

  const name = parsed.meta.get('name') ?? fallbackName;
  const description = parsed.meta.get('description');

  if (!description) {
    return `${path}:frontmatter 里没有 description。一句话说明是花名册派发的依据 —— 没有它,主对话不知道什么时候该派这个角色。`;
  }

  // 5 字段之外一律忽略:不报错(它可能是为别家 harness 写的),但也不生效。
  // 报错会把"顺手多写了个 temperature"变成拦路虎,而那不过是无关紧要的噪音。
  const toolsRaw = parsed.meta.get('tools');
  const model = parsed.meta.get('model');
  const permission = parsed.meta.get('permission');

  return {
    name,
    description,
    systemPrompt: parsed.body,
    ...(toolsRaw !== undefined ? { tools: parseTools(toolsRaw) } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(permission !== undefined ? { permission } : {}),
    path,
    origin,
  };
}

async function readAgentFile(file: string, fallbackName: string, origin: string): Promise<AgentDef | string> {
  // 去 BOM,同一套读法:PowerShell 5.1 与记事本都会写它,Windows 用户按教程写
  // 配置文件,撞上的就是它。不去掉的话 /^---/ 匹配不上,整份文件被判成"没有 frontmatter"。
  const text = (await readFile(file, 'utf8')).replace(/^﻿/, '');
  return parseAgentText(text, fallbackName, origin, file);
}

/** 花名册里一条 description 的上限:超过就按字符截断。 */
const ROSTER_DESCRIPTION_LIMIT = 40;

/**
 * 给系统提示用的角色花名册。
 *
 * 与 skill 目录同一套做法:只放名称与一句话说明,并**明说正文不在上下文里** ——
 * 否则模型会以为它已经知道这个角色怎么做事了。description 截断到一行:条目的
 * 长度是每轮都在付的税,角色一多,不立规矩就会失控。
 */
export function renderAgentRoster(agents: AgentDef[]): string {
  if (agents.length === 0) return '';

  const lines = agents.map((agent) => {
    const desc =
      agent.description.length > ROSTER_DESCRIPTION_LIMIT
        ? `${agent.description.slice(0, ROSTER_DESCRIPTION_LIMIT - 1)}…`
        : agent.description;
    return `- ${agent.name}:${desc}`;
  });

  return [
    '可派发的角色(用 task 工具按名派出去):',
    ...lines,
    '',
    '什么时候派:这件事要翻很多地方、而你只需要结论时 —— 派出去,过程不占你的上下文。',
    '派谁:按上面的说明挑最贴的那个;只读角色改不了文件,要动手的活别派给他们。',
    '没把握该不该派、或只是顺手看一眼,自己做就行 —— 多派一次多花一次成本。',
  ].join('\n');
}

/**
 * 展开用户输入里的 `@角色名` 前缀。
 *
 * 纯函数,终端只负责把结果交给会话。名字不认识就报错并列出可用的 —— 静默
 * 当成普通文本发出去,用户会以为点名生效了,而它其实只是一句闲聊。
 */
export function expandAgentMention(
  line: string,
  knownNames: readonly string[],
): { kind: 'plain' } | { kind: 'mention'; text: string } | { kind: 'unknown'; message: string } {
  const match = /^@([^\s@]+)\s*([\s\S]*)$/.exec(line.trim());
  if (!match) return { kind: 'plain' };

  const name = match[1]!;
  const rest = match[2]!.trim();

  if (!knownNames.includes(name)) {
    return {
      kind: 'unknown',
      message:
        knownNames.length === 0
          ? `没有名为 ${name} 的角色 —— 一个角色都没有。放一个 .hcode/agents/<名>.md 就能定义。`
          : `没有名为 ${name} 的角色。可用的是:${knownNames.join('、')}`,
    };
  }

  return {
    kind: 'mention',
    text: rest === ''
      ? `用 ${name} 角色处理下面的任务。`
      : `用 ${name} 角色处理:${rest}`,
  };
}

/**
 * 在根目录下发现角色。文件名(去 .md)即角色名来源;frontmatter 里的 name 优先。
 *
 * 根目录按顺序看,同名先出现者赢 —— 项目里的那份盖住全局那份,与 skills 相同。
 * 目录不存在是正常状态,静默跳过;文件存在却读不懂是问题,记进 problems。
 */
export async function discoverAgents(roots: string[]): Promise<AgentCatalog> {
  const agents: AgentDef[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // 根目录不存在 —— 正常。
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const file = join(root, entry.name);
      let outcome;

      try {
        outcome = await readAgentFile(file, basename(entry.name, '.md'), root);
      } catch (err) {
        problems.push(`${file}:读取失败 —— ${(err as Error).message}`);
        continue;
      }

      if (typeof outcome === 'string') {
        problems.push(outcome);
        continue;
      }

      if (seen.has(outcome.name)) continue;
      seen.add(outcome.name);
      agents.push(outcome);
    }
  }

  // 内置角色垫底:项目/用户目录里有同名的,前面已经收进来,这里自然被跳过。
  // 它们走的是和文件角色**同一个解析器** —— 内置那份解析出错会是内置的错,
  // 在测试里当场暴露,而不是留到运行时成一个哑掉的角色。
  for (const [index, raw] of BUILTIN_AGENT_DEFS.entries()) {
    const builtin = parseAgentText(raw, `(内置 ${index})`, BUILTIN_AGENT_ORIGIN, `${BUILTIN_AGENT_ORIGIN}#${index}`);
    if (typeof builtin === 'string') {
      // 内置定义是我们自己写的,出错说明发布包坏了。记进 problems 让它可见,
      // 但它是内置的错,不该让用户以为是自己配错了。
      problems.push(`内置角色定义有问题 —— ${builtin}`);
      continue;
    }
    if (seen.has(builtin.name)) continue;
    seen.add(builtin.name);
    agents.push(builtin);
  }

  return {
    list: () => agents.map((agent) => ({ ...agent })),
    get: (name) => {
      const found = agents.find((candidate) => candidate.name === name);
      return found ? { ...found } : undefined;
    },
    problems: () => [...problems],
  };
}
