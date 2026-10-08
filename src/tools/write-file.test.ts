import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWriteFileTool } from './write-file.js';

function makeDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'hcode-write-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('新建文件,父目录不存在时一并建出来', async (t) => {
  const dir = makeDir(t);
  const file = join(dir, '还是新的', '嵌套', 'a.ts');

  const output = await createWriteFileTool().run({ path: file, content: 'export const a = 1;\n' });

  assert.ok(
    existsSync(file),
    '父目录不存在就让写入失败,模型还得先跑一条 mkdir —— 那是无谓的一步',
  );
  assert.equal(readFileSync(file, 'utf8'), 'export const a = 1;\n');
  assert.ok(output.includes('新建'), `要说清是新建还是覆写,这是两种不同的风险。实际:${output}`);
});

test('覆写已有文件,并在返回里说清是覆写', async (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'a.ts');
  writeFileSync(file, '旧的\n');

  const output = await createWriteFileTool().run({ path: file, content: '新的\n' });

  assert.equal(readFileSync(file, 'utf8'), '新的\n');
  assert.ok(
    output.includes('覆写') || output.includes('覆盖'),
    `覆写会丢掉原有内容,必须说出来。实际:${output}`,
  );
});

test('返回里给出写了多少行', async (t) => {
  const dir = makeDir(t);
  const file = join(dir, 'a.txt');

  const output = await createWriteFileTool().run({ path: file, content: '一\n二\n三\n' });

  assert.ok(output.includes('3'), `要给出规模,人才能判断这次写入是否合理。实际:${output}`);
});
