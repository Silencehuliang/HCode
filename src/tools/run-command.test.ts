import { test } from 'node:test';
import assert from 'node:assert/strict';

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
