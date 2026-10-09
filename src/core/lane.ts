import { spawn } from 'node:child_process';
import { rmdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { Tool } from './tool.js';
import type { ToolSpec } from '../provider/types.js';

/**
 * 车道 = 把这个角色放进一间独立的 git worktree 里干活。
 *
 * 为什么要有它:让一个会写文件的角色直接在你的工作区里动手,你回到编辑器前才
 * 发现它顺手重排了三个文件 —— 那时候"哪一处是它改的"已经说不清了。车道把它的
 * 改动收进一条独立分支:主线一直是你熟悉的那份,合不合由你决定。
 *
 * 为什么不用 overlay(ProjFS 那类):它要驱动一个 Windows 组件、要管理员权限、
 * 要处理"哪些层可见"的一堆边角,而 git worktree 是用户本来就有的东西,出了事
 * 也看得懂。见 ADR-0010。
 *
 * 这个文件刻意不 import 界面相关的东西,也不打印任何东西:git 说不行就把 git
 * 的话原样带回去,由调用方决定怎么给人看。
 */

export type GitOutcome = { code: number; stdout: string; stderr: string };

/** 跑一条 git 命令。抽成参数是为了让单测不必在真的仓库里开车道。 */
export type GitRunner = (args: string[], cwd: string) => Promise<GitOutcome>;

/** 真的去跑 git。git 不在 PATH 上时不抛,而是当成一条失败的命令报回去。 */
export const runGit: GitRunner = (args, cwd) =>
  new Promise<GitOutcome>((done) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error: Error) => {
      done({ code: 127, stdout, stderr: stderr === '' ? error.message : stderr });
    });
    child.on('close', (code) => {
      done({ code: code ?? 1, stdout, stderr });
    });
  });

export type Lane = {
  /** 仓库根(车道就是从它开出来的)。 */
  repoRoot: string;
  /** 车道目录本身 —— 子 agent 的一切相对路径都从这里算。 */
  path: string;
  /** 车道的分支。改动提交到这里,合不合由人决定。 */
  branch: string;
  /** 开这条车道的角色名(写进提交信息,回看时知道是谁干的)。 */
  agent: string;
  /** 这一次派出去要做什么(同上)。 */
  description: string;
};

/** 车道目录放在仓库**旁边**的那个目录名。 */
export const WORKTREE_DIR = '.hcode-worktrees';

export const LANE_BRANCH_PREFIX = 'hcode/';

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** 本地时间的 yyyyMMdd-HHmmss。用本地时间是因为看的人在当地。 */
function stamp(now: Date): string {
  return (
    `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}` +
    `-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`
  );
}

/**
 * 角色名 → 分支名里能用的那段。
 *
 * 角色名可以是中文(文件名就是名字),而 git 虽然允许非 ASCII 分支名,一路
 * 传到别处(CI、别的工具、别人的终端)就开始出乱码。这里只留 ASCII 安全字符;
 * 全被滤掉(纯中文名)时退回 `agent` —— 分支唯一性靠后面的时间戳,不靠名字。
 */
export function laneSlug(agent: string): string {
  const slug = agent
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug === '' ? 'agent' : slug;
}

export function laneBranch(agent: string, now: Date = new Date()): string {
  return `${LANE_BRANCH_PREFIX}${laneSlug(agent)}-${stamp(now)}`;
}

/**
 * 车道目录:仓库的**兄弟目录**里 —— `<父目录>/.hcode-worktrees/<仓库名>-<分支>`。
 *
 * 不放进仓库里面(比如 .hcode/worktrees):那样主对话的 find_files、search_content
 * 会连副本一起翻,git status 也多一坨未跟踪目录 —— 为了一个偶尔用的功能,让
 * 每天都用的搜索变吵,不划算。
 */
export function lanePath(repoRoot: string, branch: string): string {
  const dir = `${basename(repoRoot)}-${branch.replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
  return join(dirname(repoRoot), WORKTREE_DIR, dir);
}

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((each) => each.trim())
    .find((each) => each !== '');
  return line ?? '(git 没说为什么)';
}

/**
 * 开一条车道。失败**不抛** —— 派发的路径上,失败就是一句能读懂的话。
 */
export async function openLane(options: {
  agent: string;
  description: string;
  cwd: string;
  now?: Date;
  git?: GitRunner;
}): Promise<{ ok: true; lane: Lane } | { ok: false; message: string }> {
  const git = options.git ?? runGit;

  const top = await git(['rev-parse', '--show-toplevel'], options.cwd);
  if (top.code !== 0) {
    return {
      ok: false,
      message:
        `角色 ${options.agent} 声明了 worktree 车道,但 ${options.cwd} 不在一个 git 仓库里 —— ` +
        `git 说:${firstLine(top.stderr)}。车道要在 git 里开:要么到仓库目录下跑 hcode,` +
        `要么把这个角色文件里的 worktree 那一行删掉。`,
    };
  }

  const repoRoot = top.stdout.trim();
  const branch = laneBranch(options.agent, options.now ?? new Date());
  const path = lanePath(repoRoot, branch);

  // -b:从**当前 HEAD** 开一条新分支。没提交过的工作区改动不会带过去 ——
  // 车道是"从上一个提交长出来的",这一点得让用户知道(写进 laneNote)。
  const added = await git(['worktree', 'add', '-b', branch, path], repoRoot);
  if (added.code !== 0) {
    return {
      ok: false,
      message:
        `角色 ${options.agent} 的车道没开起来 —— git 说:${firstLine(added.stderr)}。` +
        `可以自己清一下再看:git worktree list。`,
    };
  }

  return {
    ok: true,
    lane: { repoRoot, path, branch, agent: options.agent, description: options.description },
  };
}

export type LaneClose = {
  /** 车道里真的产生了改动并提交成功。 */
  committed: boolean;
  /** 改动项数(按 git status 的行数)。 */
  files: number;
  /** 收尾时出的岔子(提交失败、目录清不掉)。有它就要让人看见,但不中断。 */
  note?: string;
};

/**
 * 收尾一条车道:有改动就提交到分支,然后拆掉目录。
 *
 * **清理失败不中断**:Windows 上编辑器、杀软、索引器都可能正攥着车道里的文件,
 * `git worktree remove` 于是失败。这时候把一个已经跑完的结论丢掉,换成一句
 * "收尾失败"是最差的选择 —— 改动已经提交在分支上了,人完全可以第二天自己删。
 * 所以这里把 git 的原话留成一句 note,让调用方回给用户。
 */
export async function closeLane(options: { lane: Lane; git?: GitRunner }): Promise<LaneClose> {
  const git = options.git ?? runGit;
  const { lane } = options;
  const notes: string[] = [];

  const dirty = await git(['status', '--porcelain'], lane.path);
  const changed = dirty.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  let committed = false;

  if (changed.length > 0) {
    const staged = await git(['add', '-A'], lane.path);
    if (staged.code !== 0) {
      notes.push(`车道里的改动没能加进暂存区 —— git 说:${firstLine(staged.stderr)}。`);
    } else {
      // 提交信息里带角色名:回看分支时不用猜这条是哪个角色干的。
      const commit = await git(['commit', '-m', laneCommitMessage(lane)], lane.path);
      if (commit.code !== 0) {
        notes.push(
          `车道里的改动没能提交 —— git 说:${firstLine(commit.stderr)}。` +
            `改动还在 ${lane.path} 里,手动处理:cd 过去然后 git add -A && git commit。`,
        );
      } else {
        committed = true;
      }
    }
  }

  const removed = await git(['worktree', 'remove', '--force', lane.path], lane.repoRoot);
  const cleaned = removed.code === 0;
  if (!cleaned) {
    notes.push(
      `车道目录没能清掉 —— git 说:${firstLine(removed.stderr)}。` +
        `分支 ${lane.branch} 和改动都在,不影响下面这份结论;要自己清:git worktree remove --force "${lane.path}"。`,
    );
  } else {
    // worktree remove 只拆车道自己那一格,外面那层 .hcode-worktrees 会留在原地。
    // 空着就顺手收掉 —— 那是我们开在用户仓库旁边的目录,不该永远杵在那儿。
    // 同时还有别的车道开着时这里会失败(目录非空),忽略:那不是错误。
    try {
      rmdirSync(dirname(lane.path));
    } catch {
      /* 还有别的车道在用,或者权限不允许 —— 无关紧要 */
    }
  }

  // 一点改动都没有、目录也拆干净了:这条分支留着只会攒垃圾(它和 HEAD 一模一样),
  // 顺手删掉。有任何一步没走顺就一律不删 —— 那还是现场。
  if (changed.length === 0 && cleaned) {
    const deleted = await git(['branch', '-D', lane.branch], lane.repoRoot);
    if (deleted.code !== 0) {
      notes.push(`车道分支 ${lane.branch} 没有改动,但没能删掉 —— git 说:${firstLine(deleted.stderr)}。`);
    }
  }

  return {
    committed,
    files: changed.length,
    ...(notes.length > 0 ? { note: notes.join('\n') } : {}),
  };
}

/**
 * 车道里那份系统提示。
 *
 * 三句话对应三件真会出错的事:相对路径(否则它写文件写到主工作区)、别 cd 出去、
 * 别自己动 git(收尾是 harness 的事,它自己提交会把分支弄乱)。
 */
export function laneNote(lane: Lane): string {
  return [
    '## 你在一间独立的车道里干活',
    `你的工作目录是 ${lane.path}(仓库的一份独立检出,分支 ${lane.branch})。`,
    '它是从**上一个提交**长出来的:主工作区里还没提交的改动不在你这里,你也不该指望它们。',
    '你的改动碰不到主线 —— 做完由 harness 提交到上面那条分支,人再来决定合不合。',
    '',
    `- 用**相对路径**写文件和命令(工作目录已经在车道里了),别写绝对路径,也别 cd 出去。`,
    '- 不要自己执行 git 命令(提交、切分支、动 stash 都别动)—— 收尾由 harness 来做,你插手只会把分支弄乱。',
    '- 你改的东西在收尾时才落成一次提交;中途每改一版都直接写文件就行。',
  ].join('\n');
}

const LANE_FOOTER_TITLE = '[车道]';

/** 结论后面挂的车道收尾说明 —— 人不在旁边,决定与岔子都得写在这里。 */
export function laneFooter(lane: Lane, close: LaneClose): string {
  const lines = [
    `${LANE_FOOTER_TITLE} 这一趟在独立车道里做完了(分支 ${lane.branch}),主工作区没被动过。`,
  ];
  if (close.committed) {
    lines.push(
      `改动已提交:${close.files} 项,都在分支 ${lane.branch} 上。合不合由用户决定 —— ` +
        `把分支名报给他,别自己合进来(他要看得:git diff HEAD..${lane.branch};要合得:git merge ${lane.branch};不要了:git branch -D ${lane.branch})。`,
    );
  } else {
    lines.push('这一趟没有产生改动,分支上没有新提交。');
  }
  if (close.note !== undefined) {
    lines.push(close.note);
  }
  return lines.join('\n');
}

/** 车道里要收尾成一次提交 —— 提交信息的写法只有这一处。 */
export function laneCommitMessage(lane: Lane): string {
  return `${lane.agent}: ${lane.description}`;
}

/**
 * 把一组工具的相对路径钉在一个根目录上。
 *
 * 这是车道能成立的另一半:子 agent 手上还是那几个工具,但它说"读 a.js"时,
 * 读的必须是车道里的 a.js。做法按工具**对模型呈现的 schema** 来 —— schema 里
 * 声明了 `path` / `cwd` 的才改写,所以以后加工具不必回来改这里。
 *
 * 两条规则:
 * - 给了相对路径 → 拼到根上。
 * - **压根没给**(而那些字段是可选的,比如 find_files 的 path、run_command 的
 *   cwd)→ 填成根。不然工具会退到 `process.cwd()` —— 那是主工作区,车道就白开了。
 *
 * 绝对路径不动:模型偶尔会从上一轮的工具结果里抄一条绝对路径回来,那是它自己的
 * 意思,不该被我们改写。想改也改不对 —— 主工作区的绝对路径在车道里没有对应物。
 */
export function relocateTools(tools: readonly Tool[], root: string): Tool[] {
  return tools.map((tool) => ({
    spec: tool.spec,
    run: (input, context) => tool.run(rewritePaths(tool.spec, input, root), context),
  }));
}

function schemaOf(spec: ToolSpec): { properties: Record<string, unknown>; required: string[] } {
  const schema = spec.inputSchema as { properties?: Record<string, unknown>; required?: unknown };
  return {
    properties: schema.properties ?? {},
    required: Array.isArray(schema.required) ? schema.required.filter((each): each is string => typeof each === 'string') : [],
  };
}

function rewritePaths(spec: ToolSpec, input: unknown, root: string): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;

  const { properties, required } = schemaOf(spec);
  const record = { ...(input as Record<string, unknown>) };
  let touched = false;

  for (const key of ['path', 'cwd'] as const) {
    const declared = properties[key] as { type?: unknown } | undefined;
    if (declared?.type !== 'string') continue;

    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const rewritten = isAbsolute(value) ? value : resolve(root, value);
      if (rewritten !== value) touched = true;
      record[key] = rewritten;
    } else if (value === undefined && !required.includes(key)) {
      record[key] = root;
      touched = true;
    }
  }

  return touched ? record : input;
}
