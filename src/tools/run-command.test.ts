import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createRunCommandTool } from './run-command.js';

test('命令成功时,结果里带退出码 0 与 stdout 内容', async () => {
  const tool = createRunCommandTool();

  const output = await tool.run({ command: "Write-Output 'hello from powershell'" });

  assert.equal(
    output,
    [
      'exit code: 0',
      '--- stdout ---',
      'hello from powershell',
      '--- stderr ---',
      '',
    ].join('\n'),
  );
});

test('中文输出不乱码', async () => {
  const tool = createRunCommandTool();

  const output = await tool.run({ command: "Write-Output '中文测试:目录 说明.md'" });

  assert.match(output, /中文测试:目录 说明\.md/);
  assert.ok(
    !output.includes('�'),
    '出现了替换字符 —— 说明输出按 UTF-8 解码失败,模型将无法读懂它',
  );
});

test('输出超长时保留头尾,并在中间标注省略量', async () => {
  const tool = createRunCommandTool();

  const output = await tool.run({
    command: "Write-Output ('HEAD-MARKER' + ('x' * 30000) + 'TAIL-MARKER')",
  });

  assert.ok(output.includes('HEAD-MARKER'), '头部内容应当保留 —— 命令的上下文在那里');
  assert.ok(output.includes('TAIL-MARKER'), '尾部内容应当保留 —— 失败原因常常在那里');
  assert.match(output, /省略 \d+ 字符/, '截断必须是显式标记,不能静默丢失');
  assert.ok(output.length < 20_000, `截断后仍有 ${output.length} 字符,没有真正生效`);
});

test('命令超时时终止进程,并给出明确的超时标记而不是空输出', async () => {
  const tool = createRunCommandTool();

  const output = await tool.run({ command: 'Start-Sleep -Seconds 30', timeout: 500 });

  assert.match(output, /超时/, '超时必须显式标注');
  assert.ok(
    output.trim().length > 0,
    '超时不能返回空输出 —— 那会被模型误读成"命令成功但没有结果"',
  );
});

test('cwd 决定命令在哪个目录下执行', async () => {
  const tool = createRunCommandTool();
  const target = resolve('src');

  const output = await tool.run({
    command: 'Get-Location | Select-Object -ExpandProperty Path',
    cwd: target,
  });

  assert.ok(
    output.includes(target),
    `命令应当在 ${target} 下执行。实际输出:${JSON.stringify(output)}`,
  );
});

test('命令返回非零退出码时原样透传,工具不判定为失败', async () => {
  const tool = createRunCommandTool();

  const output = await tool.run({ command: 'exit 42' });

  assert.match(
    output,
    /^exit code: 42\n/,
    '退出码必须原样交给模型 —— 工具替它判定"失败"会掩盖"命令正确但没有结果"这类情况',
  );
});

test('被中断时杀掉进程,并标明是中断而不是超时', async () => {
  const tool = createRunCommandTool();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 500);

  const output = await tool.run(
    { command: 'Start-Sleep -Seconds 30' },
    { signal: controller.signal },
  );

  assert.match(output, /中断/, '中断必须显式标注 —— 静默或留空会让模型以为命令跑完了');
  assert.ok(
    !output.includes('超时'),
    `被中断不是超时。谎报成超时,模型会以为是自己给的时间不够,于是调大 timeout 重跑一次。\n实际输出:${output}`,
  );
});

test('解析级错误让前导失效时,靠 GBK 回退把中文报错救回来', async () => {
  const tool = createRunCommandTool();

  // `&&` 在 PowerShell 5.1 里不合法。整串无法**解析**,前导因此根本不会执行,
  // 输出仍是控制台的 936 代码页。这是双路解码存在的唯一理由。
  const output = await tool.run({ command: "Write-Output '甲' && Write-Output '乙'" });

  assert.ok(
    !output.includes('\uFFFD'),
    `出现了替换字符 —— 模型拿到的是乱码报错,而乱码的报错它无法自我纠正。\n实际输出:${output}`,
  );
  assert.ok(
    output.includes('甲'),
    `报错会回显出错的那行源码,里面的中文应当原样保留。实际输出:${output}`,
  );
});

test('截断边界:恰好等于上限时不截,多一个字符才截', async () => {
  const tool = createRunCommandTool();

  // 8000 + 4000 来自 docs/shell-tool-contract.md。
  const exact = await tool.run({ command: "Write-Output ('x' * 12000)" });
  assert.ok(
    !exact.includes('省略'),
    '恰好等于上限时不该截 —— 边界上多切一刀,切掉的就是模型本该看到的内容',
  );

  const over = await tool.run({ command: "Write-Output ('x' * 12001)" });
  assert.match(over, /省略 1 字符/, '多一个字符就该截,且省略量要报准');
});

test('Windows 路径:盘符、反斜杠、空格与中文目录名都走得通', async (t) => {
  const tool = createRunCommandTool();
  const base = mkdtempSync(join(tmpdir(), 'hcode-路径 '));
  const dir = join(base, '中文 目录');
  mkdirSync(dir, { recursive: true });
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const output = await tool.run({
    command: 'Get-Location | Select-Object -ExpandProperty Path',
    cwd: dir,
  });

  assert.ok(
    output.includes(dir),
    `命令应当在 ${dir} 下执行 —— 空格与中文路径是 Windows 上最容易出问题的一类。实际输出:${JSON.stringify(output)}`,
  );
});
