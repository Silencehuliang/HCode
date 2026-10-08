import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSearchContentTool } from './search-content.js';
import { createFindFilesTool } from './find-files.js';

/**
 * 搭一个小仓库:两个源码目录、一个噪音目录、一个二进制文件。
 * 搜索工具对着**真实文件系统**测 —— 跳过哪些目录、怎么处理二进制,正是它最容易
 * 出错的地方,用假文件系统会把这些全抹平。
 */
function makeRepo(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), 'hcode-search-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(join(root, 'src', 'core'), { recursive: true });
  mkdirSync(join(root, 'node_modules', '垃圾'), { recursive: true });

  writeFileSync(
    join(root, 'src', 'core', 'loop.ts'),
    ['const a = fetchData();', 'const b = 2;', ''].join('\n'),
  );
  writeFileSync(
    join(root, 'src', 'app.tsx'),
    ['const client = axios.create();', ''].join('\n'),
  );
  writeFileSync(join(root, 'node_modules', '垃圾', 'index.js'), 'fetchData();\n');
  writeFileSync(join(root, '图片.bin'), Buffer.from([0x00, 0x01, 0x66, 0x00]));

  return root;
}

test('按内容搜索,输出带路径与行号', async (t) => {
  const root = makeRepo(t);

  const output = await createSearchContentTool().run({ pattern: 'fetchData', path: root });

  assert.match(output, /src\/core\/loop\.ts:1:/, `要给出路径与行号,否则模型还得再定位一次。实际:${output}`);
  assert.ok(output.includes('const a = fetchData();'), '要把命中的那一行原样带出来');
});

test('正则能表达"概念",而不只是字面', async (t) => {
  const root = makeRepo(t);

  const output = await createSearchContentTool().run({
    pattern: 'fetchData\\(|axios',
    path: root,
  });

  assert.ok(output.includes('loop.ts'), `要能一次找出所有发请求的地方。实际:${output}`);
  assert.ok(output.includes('app.tsx'), `另一端也要命中。实际:${output}`);
});

test('跳过 node_modules 之类的噪音目录', async (t) => {
  const root = makeRepo(t);

  const output = await createSearchContentTool().run({ pattern: 'fetchData', path: root });

  assert.ok(
    !output.includes('node_modules'),
    `进去了就是几万文件的噪音,而它永远不会是用户要找的。实际:${output}`,
  );
});

test('没有命中时说清楚,而不是返回空', async (t) => {
  const root = makeRepo(t);

  const output = await createSearchContentTool().run({ pattern: '绝不存在的字符串', path: root });

  assert.ok(output.trim().length > 0, '返回空白会被模型读成"工具没工作"');
  assert.ok(output.includes('没有匹配'), `要说清是零命中。实际:${output}`);
});

test('正则不合法时抛出原始错误', async (t) => {
  const root = makeRepo(t);

  await assert.rejects(
    () => createSearchContentTool().run({ pattern: '没有闭合的(', path: root }),
    (error: Error) => {
      assert.match(error.message, /Unterminated|Invalid|group/i, `Node 的原文最准确。实际:${error.message}`);
      return true;
    },
  );
});

test('按文件名模式查找,`**` 跨目录', async (t) => {
  const root = makeRepo(t);

  const output = await createFindFilesTool().run({ pattern: '**/*.ts', path: root });

  assert.ok(output.includes('src/core/loop.ts'), `** 要能跨目录。实际:${output}`);
  assert.ok(!output.includes('app.tsx'), '*.ts 不该匹配 .tsx');
  assert.ok(!output.includes('node_modules'), '噪音目录同样要跳过');
});

test('没有通配符时按子串查找', async (t) => {
  const root = makeRepo(t);

  const output = await createFindFilesTool().run({ pattern: 'loop', path: root });

  assert.ok(
    output.includes('src/core/loop.ts'),
    `\`loop\` 是人的自然写法,拿它做整路径精确匹配会零命中 —— 那种"明明有却找不到"最难用。实际:${output}`,
  );
});
