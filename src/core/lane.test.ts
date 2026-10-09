import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  closeLane,
  laneBranch,
  laneFooter,
  laneNote,
  lanePath,
  laneSlug,
  openLane,
  relocateTools,
  runGit,
  WORKTREE_DIR,
  type GitOutcome,
  type GitRunner,
  type Lane,
} from './lane.js';
import type { Tool } from './tool.js';

const NOON = new Date(2026, 9, 9, 15, 4, 5); // 20261009-150405

const OK: GitOutcome = { code: 0, stdout: '', stderr: '' };

/** 一个记下每次调用的假 git。按前两个参数查表回话,查不到就当成功。 */
function fakeGit(
  responses: Record<string, GitOutcome> = {},
): { git: GitRunner; calls: string[][]; cwds: string[] } {
  const calls: string[][] = [];
  const cwds: string[] = [];
  const git: GitRunner = async (args, cwd) => {
    calls.push([...args]);
    cwds.push(cwd);
    const key = args.slice(0, 2).join(' ');
    return responses[key] ?? OK;
  };
  return { git, calls, cwds };
}

const REPO = join(tmpdir(), 'fake-repo');

function laneFixture(overrides: Partial<Lane> = {}): Lane {
  const branch = laneBranch('writer', NOON);
  return {
    repoRoot: REPO,
    path: lanePath(REPO, branch),
    branch,
    agent: 'writer',
    description: '改配置',
    ...overrides,
  };
}

// ---------- 命名与路径 ----------

test('车道分支名:角色名 + 时间戳,只留 ASCII 安全字符', () => {
  assert.equal(laneBranch('writer', NOON), 'hcode/writer-20261009-150405');
  assert.equal(laneBranch('Code Reviewer', NOON), 'hcode/code-reviewer-20261009-150405');
  assert.equal(
    laneBranch('审查员', NOON),
    'hcode/agent-20261009-150405',
    '中文角色名不该变成分支名里的乱码 —— 唯一性靠时间戳,不靠名字',
  );
});

test('车道开在仓库旁边的 .hcode-worktrees 里,不在仓库里面', () => {
  const branch = laneBranch('writer', NOON);
  const path = lanePath(REPO, branch);

  assert.equal(path, join(tmpdir(), WORKTREE_DIR, `fake-repo-hcode-writer-20261009-150405`));
  assert.ok(
    !path.startsWith(REPO),
    '放进仓库里面的话,主对话的 find_files / search_content 会连副本一起翻',
  );
});

// ---------- 开车道 ----------

test('不在 git 仓库里开车道:给一句能照着做的话,而不是抛出去', async () => {
  const { git } = fakeGit({
    'rev-parse --show-toplevel': {
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
    },
  });

  const result = await openLane({ agent: 'writer', description: '改配置', cwd: '/nowhere', git });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /不在一个 git 仓库里/);
  assert.match(result.message, /fatal: not a git repository/, 'git 的原话要带上 —— 那是唯一的线索');
  assert.match(result.message, /删掉/, '要给出路:要么换目录跑,要么去掉这一行');
});

test('开车道成功:一条 worktree add -b,在仓库根上跑', async () => {
  const { git, calls, cwds } = fakeGit({
    'rev-parse --show-toplevel': { code: 0, stdout: `${REPO}\n`, stderr: '' },
  });

  const result = await openLane({ agent: 'writer', description: '改配置', cwd: REPO, git, now: NOON });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.lane.branch, 'hcode/writer-20261009-150405');
  assert.equal(result.lane.path, lanePath(REPO, result.lane.branch));
  assert.deepEqual(calls[1], ['worktree', 'add', '-b', result.lane.branch, result.lane.path]);
  assert.equal(cwds[1], REPO, 'worktree 要从仓库根开,不能在别处的相对路径上开');
});

test('worktree add 失败(比如分支名撞了):把 git 的话原样带回,并指路', async () => {
  const { git } = fakeGit({
    'rev-parse --show-toplevel': { code: 0, stdout: `${REPO}\n`, stderr: '' },
    'worktree add': { code: 128, stdout: '', stderr: "fatal: a branch named 'x' already exists\n" },
  });

  const result = await openLane({ agent: 'writer', description: '改配置', cwd: REPO, git, now: NOON });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.message, /already exists/);
  assert.match(result.message, /git worktree list/);
});

// ---------- 收尾 ----------

test('收尾:有改动就提交到分支,再拆目录', async () => {
  const lane = laneFixture();
  const { git, calls } = fakeGit({ 'status --porcelain': { code: 0, stdout: ' M a.ts\n?? b.ts\n', stderr: '' } });

  const closed = await closeLane({ lane, git });

  assert.equal(closed.committed, true);
  assert.equal(closed.files, 2);
  assert.equal(closed.note, undefined);
  assert.deepEqual(
    calls,
    [
      ['status', '--porcelain'],
      ['add', '-A'],
      ['commit', '-m', 'writer: 改配置'],
      ['worktree', 'remove', '--force', lane.path],
    ],
    '顺序不能变:先看清楚有什么、再提交、最后才拆目录 —— 先拆就等于把改动删了',
  );
});

test('收尾:一点改动都没有,连分支一起删掉(留着只是攒垃圾)', async () => {
  const lane = laneFixture();
  const { git, calls } = fakeGit();

  const closed = await closeLane({ lane, git });

  assert.equal(closed.committed, false);
  assert.equal(closed.files, 0);
  assert.deepEqual(calls.at(-1), ['branch', '-D', lane.branch]);
});

test('清理失败(Win 上文件被占用)留痕不中断 —— 结论照回,人自己去删', async () => {
  const lane = laneFixture();
  const { git, calls } = fakeGit({
    'status --porcelain': { code: 0, stdout: ' M a.ts\n', stderr: '' },
    // Windows 上编辑器、杀软、索引器都可能正攥着车道里的文件,remove 于是失败。
    'worktree remove': {
      code: 1,
      stdout: '',
      stderr: "error: failed to delete 'X': Permission denied\n",
    },
  });

  const closed = await closeLane({ lane, git });

  assert.equal(closed.committed, true, '提交那一步是好的,不能因为清理失败就当成没提交');
  assert.match(closed.note ?? '', /车道目录没能清掉/);
  assert.match(closed.note ?? '', /Permission denied/, 'git 的原话要留痕');
  assert.match(closed.note ?? '', /worktree remove --force/, '要给出人自己能跑的那条命令');
  assert.match(closed.note ?? '', /分支 .* 和改动都在/, '要说清东西没丢');
  assert.ok(
    !calls.some((call) => call[0] === 'branch'),
    '目录还攥着的时候绝不能删分支 —— 那才是真的把改动弄丢',
  );
});

test('提交失败(比如没配 user.email):留痕并说手动怎么做,不乱删', async () => {
  const lane = laneFixture();
  const { git, calls } = fakeGit({
    'status --porcelain': { code: 0, stdout: '?? a.ts\n', stderr: '' },
    'commit -m': { code: 128, stdout: '', stderr: 'fatal: unable to auto-detect email address\n' },
  });

  const closed = await closeLane({ lane, git });

  assert.equal(closed.committed, false);
  assert.match(closed.note ?? '', /没能提交/);
  assert.match(closed.note ?? '', /unable to auto-detect email/);
  assert.match(closed.note ?? '', /git add -A && git commit/);
  assert.ok(!calls.some((call) => call[0] === 'branch'), '有未提交的改动时不许删分支');
});

test('车道收尾的说明里写清:改了几项、分支叫什么、怎么合', () => {
  const lane = laneFixture();
  const text = laneFooter(lane, { committed: true, files: 3 });

  assert.match(text, /分支 hcode\/writer-20261009-150405/);
  assert.match(text, /3 项/);
  assert.match(text, /git merge hcode\/writer-20261009-150405/);
  assert.match(text, /主工作区没被动过/);
  assert.match(text, /别自己合进来/, '合不合是用户的决定 —— 这句话是写给会读它的主对话模型看的');
});

test('车道收尾的说明:没有改动时如实说没有,不摆一个空分支给用户', () => {
  const text = laneFooter(laneFixture(), { committed: false, files: 0 });
  assert.match(text, /没有产生改动/);
});

test('车道系统提示:相对路径、别 cd 出去、别自己动 git —— 三件真会出错的事', () => {
  const lane = laneFixture();
  const note = laneNote(lane);

  assert.match(note, new RegExp(lane.path.replace(/\\/g, '\\\\')));
  assert.match(note, /相对路径/);
  assert.match(note, /cd 出去/);
  assert.match(note, /不要自己执行 git 命令/);
  assert.match(note, /上一个提交/, '车道是从 HEAD 开的 —— 主工作区没提交的改动不在里面,得说明白');
});

// ---------- 相对路径钉在车道上 ----------

function probeTool(name: string, schema: Record<string, unknown>): { tool: Tool; seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    seen,
    tool: {
      spec: { name, description: name, inputSchema: schema },
      async run(input) {
        seen.push(input);
        return 'ok';
      },
    },
  };
}

test('相对路径拼到车道上 —— 子 agent 说"读 a.js",读的必须是车道里的那个', async () => {
  const { tool, seen } = probeTool('read_file', {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  });

  await relocateTools([tool], 'C:\\lane')[0]!.run({ path: 'src/a.js' });

  assert.deepEqual(seen, [{ path: join('C:\\lane', 'src/a.js') }]);
});

test('压根没给路径的可选参数填成车道 —— 不然工具会退到主工作区', async () => {
  const search = probeTool('search_content', {
    type: 'object',
    properties: { pattern: { type: 'string' }, path: { type: 'string' } },
    required: ['pattern'],
  });
  const command = probeTool('run_command', {
    type: 'object',
    properties: { command: { type: 'string' }, cwd: { type: 'string' } },
    required: ['command'],
  });

  await relocateTools([search.tool, command.tool], 'C:\\lane')[0]!.run({ pattern: 'foo' });
  await relocateTools([search.tool, command.tool], 'C:\\lane')[1]!.run({ command: 'ls' });

  assert.deepEqual(search.seen, [{ pattern: 'foo', path: 'C:\\lane' }]);
  assert.deepEqual(command.seen, [{ command: 'ls', cwd: 'C:\\lane' }]);
});

test('必填的 path 没给就不填 —— 那是模型写错了,填一个目录进去只会让它更糊涂', async () => {
  const { tool, seen } = probeTool('read_file', {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  });

  await relocateTools([tool], 'C:\\lane')[0]!.run({});

  assert.deepEqual(seen, [{}]);
});

test('绝对路径不动它 —— 模型从上一轮结果里抄回来的绝对路径是它自己的意思', async () => {
  const { tool, seen } = probeTool('read_file', {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
  });

  await relocateTools([tool], 'C:\\lane')[0]!.run({ path: 'D:\\other\\x.ts' });

  assert.deepEqual(seen, [{ path: 'D:\\other\\x.ts' }]);
});

test('不是路径的东西一个都不碰(命令文本、搜索词、数字参数)', async () => {
  const { tool, seen } = probeTool('run_command', {
    type: 'object',
    properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } },
    required: ['command'],
  });

  await relocateTools([tool], 'C:\\lane')[0]!.run({ command: 'Get-ChildItem', timeout_ms: 5000 });

  assert.deepEqual(seen, [{ command: 'Get-ChildItem', timeout_ms: 5000 }]);
});

test('没声明 path/cwd 的工具原样过 —— 以后加工具不必回来改这里', async () => {
  const { tool, seen } = probeTool('todo_write', {
    type: 'object',
    properties: { items: { type: 'array' } },
    required: ['items'],
  });
  const rewritten = relocateTools([tool], 'C:\\lane')[0]!;

  assert.equal(rewritten.spec, tool.spec, 'spec 原样透传 —— 模型看到的还是原来那个工具');
  await rewritten.run({ items: ['a'] });
  assert.deepEqual(seen, [{ items: ['a'] }]);
});

// ---------- 真 git 集成:跑一遍真的 worktree ----------

const HAS_GIT = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test(
  '真仓库里跑一遍:车道里改的文件进了分支,主工作区一个字没动',
  { skip: HAS_GIT ? false : '这个环境里没有 git' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'hcode-lane-'));
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

    try {
      git('init', '--quiet');
      git('config', 'user.email', 'hcode@example.com');
      git('config', 'user.name', 'hcode test');
      git('config', 'commit.gpgsign', 'false');
      writeFileSync(join(repo, 'app.ts'), 'export const a = 1;\n');
      git('add', '-A');
      git('commit', '--quiet', '-m', 'init');

      const opened = await openLane({
        agent: 'writer',
        description: '加一行',
        cwd: repo,
        now: NOON,
        git: runGit,
      });
      assert.equal(opened.ok, true, opened.ok ? '' : opened.message);
      if (!opened.ok) return;
      const { lane } = opened;

      assert.ok(existsSync(join(lane.path, 'app.ts')), '车道是仓库的一份检出,原有文件都在');

      // 子 agent 干的事:在车道的相对路径上写一个新文件、改一个老文件。
      writeFileSync(join(lane.path, 'new.ts'), 'export const b = 2;\n');
      writeFileSync(join(lane.path, 'app.ts'), 'export const a = 1;\nexport const c = 3;\n');

      const closed = await closeLane({ lane, git: runGit });

      assert.equal(closed.committed, true, closed.note ?? '');
      assert.equal(closed.files, 2);
      assert.equal(closed.note, undefined);

      const branches = execFileSync('git', ['branch', '--list', lane.branch], {
        cwd: repo,
        encoding: 'utf8',
      });
      assert.match(branches, new RegExp(lane.branch.replace('/', '\\/')), '分支要真的存在');

      const shown = execFileSync('git', ['show', `${lane.branch}:new.ts`], {
        cwd: repo,
        encoding: 'utf8',
      });
      assert.equal(shown, 'export const b = 2;\n', '改动要在分支里 —— 这是"产分支"的全部意义');

      const log = execFileSync('git', ['log', '-1', '--pretty=%s', lane.branch], {
        cwd: repo,
        encoding: 'utf8',
      });
      assert.equal(log.trim(), 'writer: 加一行', '提交信息里带角色名,回看时不用猜是谁干的');

      // 主工作区:HEAD 没动、文件没动、目录干净。
      assert.equal(
        readFileSync(join(repo, 'app.ts'), 'utf8'),
        'export const a = 1;\n',
        '主线一直是用户熟悉的那份 —— 这是车道存在的全部理由',
      );
      assert.ok(!existsSync(join(repo, 'new.ts')));
      assert.equal(git('status', '--porcelain'), '');
      assert.ok(!existsSync(lane.path), '收尾之后车道目录要消失');
      assert.ok(
        !existsSync(join(root, WORKTREE_DIR)),
        '只剩一格车道时,外面那层 .hcode-worktrees 也该收掉 —— 那是我们开在用户目录旁边的',
      );
      assert.equal(git('worktree', 'list').trim().split('\n').length, 1, '只该剩主工作区那一条');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  '真仓库里跑一遍:没有改动就不留分支',
  { skip: HAS_GIT ? false : '这个环境里没有 git' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'hcode-lane-'));
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

    try {
      git('init', '--quiet');
      git('config', 'user.email', 'hcode@example.com');
      git('config', 'user.name', 'hcode test');
      writeFileSync(join(repo, 'app.ts'), 'export const a = 1;\n');
      git('add', '-A');
      git('commit', '--quiet', '-m', 'init');

      const opened = await openLane({ agent: 'writer', description: '看一眼', cwd: repo, now: NOON, git: runGit });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;

      const closed = await closeLane({ lane: opened.lane, git: runGit });

      assert.equal(closed.committed, false);
      assert.equal(git('branch', '--list', opened.lane.branch).trim(), '');
      assert.ok(!existsSync(opened.lane.path));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  '真仓库里跑一遍:文件被占住时收尾仍然给回结论(把车道目录换成一个删不掉的东西)',
  { skip: HAS_GIT ? false : '这个环境里没有 git' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'hcode-lane-'));
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]): string =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8' });

    try {
      git('init', '--quiet');
      git('config', 'user.email', 'hcode@example.com');
      git('config', 'user.name', 'hcode test');
      writeFileSync(join(repo, 'app.ts'), 'export const a = 1;\n');
      git('add', '-A');
      git('commit', '--quiet', '-m', 'init');

      const opened = await openLane({ agent: 'writer', description: '加一行', cwd: repo, now: NOON, git: runGit });
      assert.equal(opened.ok, true);
      if (!opened.ok) return;

      writeFileSync(join(opened.lane.path, 'new.ts'), 'x\n');

      // 拿一个假 git 只把 remove 那一步弄失败 —— 真去复现 Windows 的文件锁
      // 得赌上杀软和索引器的时机,那是测不出来的东西;这里测的是**遇到它之后
      // 的行为**:留痕、不抛、不删分支。
      const flaky: GitRunner = async (args, cwd) =>
        args[0] === 'worktree' && args[1] === 'remove'
          ? { code: 1, stdout: '', stderr: 'error: failed to delete lane: Permission denied\n' }
          : runGit(args, cwd);

      const closed = await closeLane({ lane: opened.lane, git: flaky });

      assert.equal(closed.committed, true, '改动照样提交了');
      assert.match(closed.note ?? '', /Permission denied/);
      assert.match(laneFooter(opened.lane, closed), /worktree remove --force/);
      assert.notEqual(git('branch', '--list', opened.lane.branch).trim(), '', '分支还在,改动没丢');
      assert.ok(existsSync(opened.lane.path), '目录还在原地 —— 所以留痕里那条手动命令是能用的');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
