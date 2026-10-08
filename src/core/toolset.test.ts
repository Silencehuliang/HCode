import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createToolset } from './toolset.js';
import type { Tool } from './tool.js';
import type { ToolCallRequest } from '../provider/types.js';

function fakeTool(name: string, run: Tool['run']): Tool {
  return { spec: { name, description: `${name} 的测试替身`, inputSchema: { type: 'object' } }, run };
}

function call(name: string, input: unknown = {}): ToolCallRequest {
  return { id: `call-${name}`, name, input };
}

test('按名字把调用路由到对应的 handler', async () => {
  const seen: unknown[] = [];
  const toolset = createToolset([
    fakeTool('甲', async (input) => {
      seen.push(input);
      return '甲的结果';
    }),
    fakeTool('乙', async () => '乙的结果'),
  ]);

  assert.deepEqual(toolset.specs.map((spec) => spec.name), ['甲', '乙'], '工具清单要原样交给模型');

  const output = await toolset.run(call('甲', { value: 7 }));

  assert.equal(output, '甲的结果');
  assert.deepEqual(seen, [{ value: 7 }], '入参应当原样到达被选中的那个 handler');
});

test('调用不存在的工具时,把可用工具列回去,而不是炸掉整轮', async () => {
  const toolset = createToolset([fakeTool('run_command', async () => 'ok')]);

  const output = await toolset.run(call('run_powershell'));

  assert.ok(
    output.includes('run_powershell'),
    '要说出它要的那个名字,否则模型不知道自己错在哪',
  );
  assert.ok(
    output.includes('run_command'),
    '要列出真正可用的工具 —— 只说"没有这个工具",模型只能瞎猜',
  );
});

test('工具抛错时把原始错误交回模型,而不是吞成一句"执行失败"', async () => {
  const toolset = createToolset([
    fakeTool('read_file', async () => {
      throw new Error("ENOENT: no such file or directory, open 'E:\\不存在.txt'");
    }),
  ]);

  const output = await toolset.run(call('read_file'));

  assert.ok(
    output.includes("ENOENT: no such file or directory, open 'E:\\不存在.txt'"),
    `错误的原文必须完整回传 —— 吞成一句"执行失败",模型就分不清"文件不存在"与"没有权限",而这两者的下一步完全不同。\n实际回传:${output}`,
  );
});
