import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createReadFileTool } from './read-file.js';

/** 文件工具对着**真实文件系统**测 —— 与 run_command 打真实 PowerShell 同一立场。 */
function makeDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'hcode-file-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('读出文件内容,并带上行号', async (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'a.ts');
  writeFileSync(file, ['第一行', '第二行', '第三行', ''].join('\n'));

  const output = await createReadFileTool().run({ path: file });

  assert.equal(
    output,
    ['1\t第一行', '2\t第二行', '3\t第三行'].join('\n'),
    '行号是为了让模型能引用位置;末尾那个空行不算一行,否则每份以换行结尾的文件都会多出一条幽灵行',
  );
});

test('文件不存在时抛出原始错误,不自己编一句', async (t) => {
  const dir = makeDir(t);
  const missing = join(dir, '没有这个文件.txt');

  await assert.rejects(
    () => createReadFileTool().run({ path: missing }),
    (error: Error) => {
      assert.ok(
        error.message.includes('ENOENT'),
        `Node 给的原文最准确,自己编一句"读取失败"只会丢掉信息。实际:${error.message}`,
      );
      assert.ok(error.message.includes('没有这个文件.txt'), '要说清是哪个路径');
      return true;
    },
  );
});

test('超过 limit 时截断,并说明还剩多少行、怎么接着读', async (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'big.txt');
  writeFileSync(file, Array.from({ length: 500 }, (_unused, index) => `第 ${index + 1} 行`).join('\n'));

  const output = await createReadFileTool().run({ path: file, limit: 10 });

  assert.ok(output.startsWith('1\t第 1 行'), '从头开始');
  assert.ok(output.includes('10\t第 10 行'), '读到第 10 行');
  assert.ok(!output.includes('11\t第 11 行'), '第 11 行不该出现');
  assert.ok(
    output.includes('490'),
    `要说出还剩多少行 —— 不说的话模型不知道自己看到的不是全文。实际:${output.slice(-120)}`,
  );
  assert.ok(
    output.includes('offset=11'),
    `要给出接着读的确切参数,而不是让它自己算。实际:${output.slice(-120)}`,
  );
});

test('二进制文件如实拒绝,不吐一堆乱码', async (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'binary.bin');
  writeFileSync(file, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x41, 0x42]));

  const output = await createReadFileTool().run({ path: file });

  assert.ok(
    !output.includes('�'),
    `二进制内容不能当文本吐出来。实际:${output}`,
  );
  assert.ok(output.includes('二进制'), `要说清是什么情况。实际:${output}`);
});

test('offset 从指定行开始读', async (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'a.txt');
  writeFileSync(file, ['一', '二', '三', '四'].join('\n'));

  const output = await createReadFileTool().run({ path: file, offset: 3 });

  assert.equal(output, ['3\t三', '4\t四'].join('\n'));
});

test('offset 超出文件行数时说清楚,而不是返回空白', async (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'a.txt');
  writeFileSync(file, ['一', '二'].join('\n'));

  const output = await createReadFileTool().run({ path: file, offset: 99 });

  assert.ok(
    output.trim().length > 0,
    '返回空白会被模型读成"文件是空的",而事实是它给的 offset 越界了',
  );
  assert.ok(output.includes('2'), `要说清文件实际有多少行。实际:${output}`);
});
