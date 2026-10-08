import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  INSTRUCTION_FILENAMES,
  loadInstructions,
  renderInstructionNote,
  renderInstructionsForModel,
} from './instructions.js';

/** 每个测试一个全新的项目目录。指令文件是按**目录**找的,所以目录就是参数。 */
function makeProject(t: TestContext, files: Record<string, string> = {}): string {
  const cwd = mkdtempSync(join(tmpdir(), 'hcode-instructions-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(cwd, name), text);
  }
  return cwd;
}

test('一份指令文件都没有时,不算错', (t) => {
  const cwd = makeProject(t);

  const outcome = loadInstructions(cwd);

  assert.deepEqual(outcome, { cwd, file: undefined, problems: [] });
});

test('只有 CLAUDE.md 时,直接用它 —— 已有 Claude Code 项目零改动', (t) => {
  const cwd = makeProject(t, { 'CLAUDE.md': '# 项目约定\n\n缩进用两个空格。\n' });

  const outcome = loadInstructions(cwd);

  assert.equal(outcome.file?.name, 'CLAUDE.md');
  assert.equal(
    outcome.file?.text,
    '# 项目约定\n\n缩进用两个空格。\n',
    '内容要原样交给模型,不做裁剪也不做改写',
  );
  assert.equal(outcome.file?.path, join(cwd, 'CLAUDE.md'));
});

test('HCODE.md 压过 CLAUDE.md', (t) => {
  const cwd = makeProject(t, {
    'HCODE.md': 'hcode 自己的约定',
    'CLAUDE.md': 'Claude Code 的约定',
  });

  const outcome = loadInstructions(cwd);

  assert.equal(outcome.file?.name, 'HCODE.md');
  assert.equal(outcome.file?.text, 'hcode 自己的约定');
});

test('CLAUDE.md 压过 AGENTS.md', (t) => {
  const cwd = makeProject(t, {
    'CLAUDE.md': 'Claude Code 的约定',
    'AGENTS.md': '别的工具的约定',
  });

  assert.equal(loadInstructions(cwd).file?.name, 'CLAUDE.md');
});

test('顺序写死成 HCODE.md → CLAUDE.md → AGENTS.md', () => {
  assert.deepEqual(INSTRUCTION_FILENAMES, ['HCODE.md', 'CLAUDE.md', 'AGENTS.md']);
});

test('指令文件读不出来时说出来,不当成"这个项目没有约定"', (t) => {
  // 用一个同名的目录制造读不动的情况。权限位在 Windows 上不可靠,这个可靠。
  const cwd = makeProject(t);
  mkdirSync(join(cwd, 'CLAUDE.md'));

  const outcome = loadInstructions(cwd);

  assert.equal(outcome.file, undefined);
  assert.equal(outcome.problems.length, 1);
  assert.match(outcome.problems[0] ?? '', /CLAUDE\.md/);
});

test('生效的是哪个文件要说出来,不静默解决优先级', (t) => {
  const cwd = makeProject(t, { 'HCODE.md': 'x' });

  const note = renderInstructionNote(loadInstructions(cwd));

  assert.match(note, /HCODE\.md/);
  assert.match(note, new RegExp(cwd.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
});

test('生效的是 CLAUDE.md 时,明说 hcode 不会改它', (t) => {
  const cwd = makeProject(t, { 'CLAUDE.md': 'x' });

  const note = renderInstructionNote(loadInstructions(cwd));

  assert.match(note, /不会改/);
});

test('一份都没有时,建议新建的是 HCODE.md 而不是 CLAUDE.md', (t) => {
  const note = renderInstructionNote(loadInstructions(makeProject(t)));

  assert.match(note, /HCODE\.md/);
  assert.doesNotMatch(
    note,
    /新建.{0,12}CLAUDE\.md/,
    '我们要建议用户建的永远是 HCODE.md —— 把约定写进别人的文件是越界',
  );
});

test('读指令文件不会碰它:内容与时间戳都不变', (t) => {
  const cwd = makeProject(t, { 'CLAUDE.md': '原样不动' });
  const path = join(cwd, 'CLAUDE.md');
  const before = statSync(path).mtimeMs;

  loadInstructions(cwd);
  renderInstructionNote(loadInstructions(cwd));

  assert.equal(readFileSync(path, 'utf8'), '原样不动');
  assert.equal(statSync(path).mtimeMs, before);
});

test('指令文件带 UTF-8 BOM 时,BOM 不进模型上下文', (t) => {
  // BOM 用 String.fromCharCode 造,不写字面量 —— 字面量可能被编辑器或工具链
  // 悄悄吃掉,那样这条测试就变成了断言"两串相同的字符串相等",永远绿,什么也没验。
  const bom = String.fromCharCode(0xfeff);
  const cwd = makeProject(t, { 'HCODE.md': bom + '# 约定\n' });

  const outcome = loadInstructions(cwd);

  assert.equal(
    outcome.file?.text,
    '# 约定\n',
    'BOM 是文件编码的产物,不是约定的一部分。它混进上下文对模型没有意义,还占一个 token。',
  );
});

test('交给模型的那一份带上出处,模型答得出自己在按什么做', (t) => {
  const cwd = makeProject(t, { 'CLAUDE.md': '缩进用两个空格。' });

  const text = renderInstructionsForModel(loadInstructions(cwd));

  assert.match(text ?? '', /CLAUDE\.md/);
  assert.match(text ?? '', /缩进用两个空格。/);
});

test('一份指令文件都没有时,不往系统提示里塞一个空标题', (t) => {
  assert.equal(renderInstructionsForModel(loadInstructions(makeProject(t))), undefined);
});
