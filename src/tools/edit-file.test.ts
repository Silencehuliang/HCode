import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEditFileTool } from './edit-file.js';

function makeFile(t: TestContext, name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hcode-edit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, name);
  writeFileSync(file, content);
  return file;
}

test('替换唯一一处,文件里只剩这一处变了', async (t) => {
  const file = makeFile(
    t,
    'a.ts',
    ['const a = 1;', 'const b = 2;', 'const c = 3;', ''].join('\n'),
  );

  const output = await createEditFileTool().run({
    path: file,
    old_string: 'const b = 2;',
    new_string: 'const b = 22;\nconst d = 4;',
  });

  assert.equal(
    readFileSync(file, 'utf8'),
    ['const a = 1;', 'const b = 22;', 'const d = 4;', 'const c = 3;', ''].join('\n'),
    '必须是精确替换 —— 整份重写会让 diff 无法审查,而那正是这个工具存在的理由',
  );
  assert.ok(output.includes('2'), `要报出改在第几行,人才能去核对。实际:${output}`);
});

test('找不到时指出最接近的位置,并要求重新读文件', async (t) => {
  const file = makeFile(t, 'a.ts', ['const a = 1;', 'const b = 2;', ''].join('\n'));
  const before = readFileSync(file, 'utf8');

  const output = await createEditFileTool().run({
    path: file,
    old_string: 'const b = 3;',
    new_string: 'const b = 22;',
  });

  assert.equal(readFileSync(file, 'utf8'), before, '没找到就不该动文件');
  assert.ok(output.includes('const b'), `要把它给的那段回显出来。实际:${output}`);
  assert.ok(
    /第 2 行|2\t/.test(output),
    `首行在半途出现时应当给出它的行号 —— 光说"没找到",模型只能把整份文件重读一遍。实际:${output}`,
  );
});

test('同一段出现多次时拒绝改动,并要求给更长的上下文', async (t) => {
  const file = makeFile(t, 'a.ts', ['same();', 'other();', 'same();', ''].join('\n'));
  const before = readFileSync(file, 'utf8');

  const output = await createEditFileTool().run({
    path: file,
    old_string: 'same();',
    new_string: 'same(1);',
  });

  assert.equal(readFileSync(file, 'utf8'), before, '有歧义就不许猜 —— 猜错会静默改错地方');
  assert.ok(
    /2 处|两次|多处/.test(output),
    `要说清命中了多少处。实际:${output}`,
  );
});

test('CRLF 文件:模型给 LF 的片段也能命中,且写完仍是 CRLF', async (t) => {
  const file = makeFile(t, 'a.ts', ['第一行', '第二行', '第三行', ''].join('\r\n'));

  await createEditFileTool().run({
    path: file,
    old_string: '第二行',
    new_string: '改过的第二行',
  });

  assert.equal(
    readFileSync(file, 'utf8'),
    ['第一行', '改过的第二行', '第三行', ''].join('\r\n'),
    'read_file 把行尾归一成了 LF,模型拿到的片段自然是 LF —— 直接拿它去 CRLF 文件里找会全部落空。而写入时若混进 LF,整个文件的 diff 会变成"每一行都改了"',
  );
});

test('文件不存在时抛出原始错误', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'hcode-edit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    () =>
      createEditFileTool().run({
        path: join(dir, '没有这个.txt'),
        old_string: 'a',
        new_string: 'b',
      }),
    (error: Error) => error.message.includes('ENOENT'),
  );
});
