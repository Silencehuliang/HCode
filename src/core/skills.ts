import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Skill = {
  name: string;
  description: string;
  /** 正文所在的文件。 */
  path: string;
  /** 来自哪个根目录。同名时前面的根目录优先,这个字段让用户看得出用的是哪一份。 */
  origin: string;
};

export type SkillCatalog = {
  /** 只有名称与一句话说明 —— 正文不在这里,也不该在。 */
  list(): Skill[];
  /** 读出正文。 */
  load(name: string): Promise<string>;
  /** 发现过程中遇到的格式问题。不静默忽略,由调用方显示给用户。 */
  problems(): string[];
};

const SKILL_FILE = 'SKILL.md';

type Frontmatter = { meta: Map<string, string>; body: string };

/**
 * 解析 SKILL.md 开头的 frontmatter。
 *
 * 只认 `键: 值` 这种最简形状,不引 YAML 库:skill 是别的工具也认的格式,而它
 * 实际用到的字段就 name 和 description 两个。为两个字符串引一个 YAML 解析器,
 * 换来的是"它会不会把我的多行字符串解析成别的东西"这种要长期维护的问题。
 *
 * 值两侧的引号会被去掉 —— 很多现成的 SKILL.md 是 `description: "……"` 这样写的。
 */
export function parseFrontmatter(text: string): Frontmatter | null {
  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return null;

  const meta = new Map<string, string>();

  for (const line of match[1]!.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
      if (value.at(-1) === value[0]) value = value.slice(1, -1);
    }

    if (key) meta.set(key, value);
  }

  return { meta, body: text.slice(match[0].length).trim() };
}

async function readSkillFile(file: string, origin: string): Promise<Skill | string> {
  const text = await readFile(file, 'utf8');
  const parsed = parseFrontmatter(text);

  if (!parsed) {
    return `${file}:开头没有 frontmatter。SKILL.md 需要以 --- 开头,并在里面写明 name 与 description。`;
  }

  // name 缺了就退回目录名 —— 很多现成的 skill 只写 description,而目录名本来
  // 就是它的名字。这不是"格式错误",不该拦下来。
  const name = parsed.meta.get('name') ?? origin;
  const description = parsed.meta.get('description');

  if (!description) {
    return `${file}:frontmatter 里没有 description。一句话说明是给模型看的 —— 没有它,模型不知道什么时候该用这个 skill。`;
  }

  return { name, description, path: file, origin };
}

/**
 * 在若干根目录下找 skill。
 *
 * 根目录**按顺序**看,同名的以先出现的为准:把项目级的排在用户级的牵头,项目里
 * 的那份才能盖住全局那份 —— 不然改项目的 skill 会毫无效果,而用户完全查不出
 * 为什么。
 *
 * 目录不存在不是问题(没装过 skill 是最正常的状态),但**文件存在却读不懂**是问题。
 * 前者静默跳过,后者记进 problems 交给调用方显示。
 */
export async function discoverSkills(roots: string[]): Promise<SkillCatalog> {
  const skills: Skill[] = [];
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
      if (!entry.isDirectory()) continue;

      const file = join(root, entry.name, SKILL_FILE);
      let outcome;

      try {
        outcome = await readSkillFile(file, entry.name);
      } catch {
        continue; // 这个目录里没有 SKILL.md —— 它本来就不是一个 skill。
      }

      if (typeof outcome === 'string') {
        problems.push(outcome);
        continue;
      }

      if (seen.has(outcome.name)) continue;
      seen.add(outcome.name);
      skills.push(outcome);
    }
  }

  return {
    list: () => skills.map((skill) => ({ ...skill })),
    problems: () => [...problems],

    async load(name) {
      const skill = skills.find((candidate) => candidate.name === name);
      if (!skill) {
        const available = skills.map((candidate) => candidate.name);
        throw new Error(
          available.length === 0
            ? `没有名为 ${name} 的 skill,而且一个 skill 都没找到。`
            : `没有名为 ${name} 的 skill。可用的是:${available.join('、')}`,
        );
      }

      const text = await readFile(skill.path, 'utf8');
      const parsed = parseFrontmatter(text);
      return parsed ? parsed.body : text.trim();
    },
  };
}

/**
 * 给系统提示用的目录。
 *
 * 只放名称与一句话说明,而且要**明说正文不在上下文里** —— 否则模型会以为它已经
 * 读过了,照着印象编一套做法出来。
 */
export function renderSkillCatalog(skills: Skill[]): string {
  if (skills.length === 0) return '';

  return [
    '可用的 skill:',
    ...skills.map((skill) => `- ${skill.name}:${skill.description}`),
    '',
    '它们的正文**此刻不在你的上下文里**。要用哪个,先用 skill 工具把它读进来,再按它说的做。',
  ].join('\n');
}
