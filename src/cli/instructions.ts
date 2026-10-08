import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 指令文件的查找顺序,取第一个存在的。
 *
 * `HCODE.md` 排在最前,是为了让想写 hcode 专属约定的人有个不被别的工具读到的位置;
 * 另外两个名字排在后面,是为了让**已经有** CLAUDE.md 或 AGENTS.md 的项目零改动
 * 就能用 —— 迁移的代价必须小于重新写一遍。
 *
 * 只看当前目录,不往上级目录走。往上找会引入第二根优先级轴(近的压远的?远的当默认?),
 * 而"到底是哪一份生效"要让用户一眼看得明白,不然他会改半天改到一份没生效的文件上。
 */
export const INSTRUCTION_FILENAMES = ['HCODE.md', 'CLAUDE.md', 'AGENTS.md'];

export type InstructionFile = {
  /** 文件名本身(`HCODE.md`),横幅里直接显示它。 */
  readonly name: string;
  /** 绝对路径,让用户知道该去哪里改。 */
  readonly path: string;
  /** 原样读出,一个字不改 —— 这是项目自己的约定,不是我们的数据。 */
  readonly text: string;
};

export type Instructions = {
  /** 在哪个目录下找的。横幅要拿它拼"该去哪建文件"的完整路径。 */
  readonly cwd: string;
  /** 生效的那一份;三份都不存在时是 undefined。 */
  readonly file: InstructionFile | undefined;
  /** 有文件但读不出来的情况。**不当成**"这个项目没有约定"。 */
  readonly problems: readonly string[];
};

export function loadInstructions(cwd: string): Instructions {
  const problems: string[] = [];

  for (const name of INSTRUCTION_FILENAMES) {
    const path = join(cwd, name);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (error) {
      // 文件不存在是绝大多数情况(三个名字都试一遍,通常一个都没有),静默继续。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // 文件在,但读不动。这时候说"没有约定"就是在骗用户 —— 他会去写一份新的,
      // 而原来那份的约定一条都没生效。
      problems.push(`${path}:${(error as Error).message}`);
      continue;
    }

    // 去掉 UTF-8 BOM。PowerShell 5.1 与记事本都会写它,而这两个在 Windows 上
    // 是写项目文档的常见路径。见 config.ts 里同一个坑。
    return { cwd, file: { name, path, text: text.replace(/^﻿/, '') }, problems };
  }

  return { cwd, file: undefined, problems };
}

/**
 * 启动时说清生效的是哪一份。
 *
 * 这段是刻意的:三个文件名摆在一起,用户很容易以为是"合并生效"或者"就近生效"。
 * 说清楚是哪一个,他才知道改哪个文件有用。
 */
export function renderInstructionNote(instructions: Instructions): string {
  const { file } = instructions;

  if (!file) {
    return `指令文件:没有。想让 hcode 记住这个项目的约定,写 ${join(instructions.cwd, 'HCODE.md')}。`;
  }

  // HCODE.md 是我们自己的文件,怎么改都行;另外两个名字属于别的工具,
  // 用户拿它们跟 Claude Code / 别的 agent 共用,我们要明说自己不碰。
  const ownership = file.name === 'HCODE.md' ? '' : '(hcode 只读它,不会改它)';
  return `指令文件:${file.name}${ownership}\n          ${file.path}`;
}

/**
 * 交给模型的那一份。**带上出处**是刻意的:
 *
 * - 模型知道这条约定来自项目的哪个文件,用户在对话里问"你在按什么做"时它答得上来;
 * - 这也标出了权威等级 —— 项目约定压过这里的通用偏好,而用户这一轮的具体要求
 *   压过项目约定。不给出来处的话,它只是一段没有来源的正文。
 */
export function renderInstructionsForModel(instructions: Instructions): string | undefined {
  const { file } = instructions;
  if (!file) return undefined;

  return [
    `# 这个项目自己的约定(来自 ${file.name})`,
    '',
    '下面是这个项目的人写下来的约定,按它做。用户这一轮的具体要求可以推翻它。',
    '',
    file.text.trim(),
  ].join('\n');
}
