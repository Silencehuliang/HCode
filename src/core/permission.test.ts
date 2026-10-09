import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DANGER_RULES, decide, guardToolset } from './permission.js';
import { createToolset } from './toolset.js';
import type { Tool } from './tool.js';

function call(tool: string, input: unknown = {}): { tool: string; input: unknown } {
  return { tool, input };
}

// —— 纯规则:零爆炸半径放行 / 写文件问 / 命令按显式危险清单拦截 ——

for (const tool of ['read_file', 'search_content', 'find_files']) {
  test(`只读工具 ${tool} 直接放行,不打扰用户`, () => {
    const verdict = decide(call(tool, { path: 'a.txt', pattern: 'x' }));

    assert.equal(
      verdict.kind,
      'allow',
      `只读操作弹窗问一次,用户就会学会闭着眼按回车 —— 那比不问更糟。实际:${JSON.stringify(verdict)}`,
    );
  });
}

// 实测抓到过的缺陷:todo 只动会话内存里的清单、task 派的子 agent 拿的是只读工具、
// skill 读的是本地 Markdown 正文 —— 全都碰不到用户磁盘上的一字节,却落进了"一律要问"
// 的兜底分支。给这类零爆炸半径的工具逐次弹窗,训练出来的就是闭眼按回车。
for (const tool of ['todo_write', 'todo_update', 'todo_read', 'task', 'skill']) {
  test(`零爆炸半径工具 ${tool} 直接放行,不打扰用户`, () => {
    const verdict = decide(call(tool, {}));

    assert.equal(
      verdict.kind,
      'allow',
      `todo/task/skill 最坏也碰不到用户的一个字节,弹窗问只会把用户训练成盲按回车。实际:${JSON.stringify(verdict)}`,
    );
  });
}

for (const tool of ['write_file', 'edit_file']) {
  test(`写操作 ${tool} 要问过才做`, () => {
    const verdict = decide(call(tool, { path: 'a.txt' }));

    assert.equal(verdict.kind, 'ask');
  });
}

test('普通命令直接放行 —— 逐条确认会把用户训练成盲按回车', () => {
  const verdict = decide(call('run_command', { command: 'Get-ChildItem -Recurse' }));

  assert.equal(verdict.kind, 'allow');
});

test('危险命令被拦,并说明为什么', () => {
  const verdict = decide(call('run_command', { command: 'Remove-Item -Recurse -Force .\\build' }));

  assert.equal(verdict.kind, 'deny');
  if (verdict.kind !== 'deny') return;

  assert.ok(
    verdict.reason.length > 0,
    '不能只说"不允许" —— 用户和模型都需要知道理由,否则无从判断该不该绕',
  );
  assert.ok(
    /删除|递归/.test(verdict.reason),
    `理由要说得具体。实际:${verdict.reason}`,
  );
});

test('被拦时给出替代做法,否则模型只会原地重试同一条命令', () => {
  const verdict = decide(call('run_command', { command: 'git push --force origin main' }));

  assert.equal(verdict.kind, 'deny');
  if (verdict.kind !== 'deny') return;

  assert.ok(
    verdict.instead.length > 0,
    `只拦不指路,模型下一轮多半会换个写法再推一次。实际:${JSON.stringify(verdict)}`,
  );
  assert.match(verdict.instead, /force-with-lease|--force-with-lease/, '要给出真正可行的替代');
});

test('危险清单是显式可读的:每条都带原因与替代做法', () => {
  for (const rule of DANGER_RULES) {
    assert.ok(rule.pattern instanceof RegExp, `规则要是一个能读的正则:%${String(rule)}`);
    assert.ok(rule.reason.length > 0, `每条规则必须写清为什么危险:${rule.pattern}`);
    assert.ok(rule.instead.length > 0, `每条规则必须给出替代做法:${rule.pattern}`);
  }
});

test('不认识的工具按最保守的处理 —— 问,而不是放行', () => {
  const verdict = decide(call('某个还不存在的工具'));

  assert.equal(verdict.kind, 'ask', '新工具默认放行等于每次新增都悄悄开了个口子');
});

test('规则匹配是纯函数:同样的输入给同样的判定,不碰模型也不碰文件系统', () => {
  const once = decide(call('run_command', { command: 'git reset --hard HEAD~3' }));
  const twice = decide(call('run_command', { command: 'git reset --hard HEAD~3' }));

  assert.deepEqual(once, twice);
  assert.equal(once.kind, 'deny');
});

// —— 守门:判定落到实际执行上 ——

function probeTool(name: string, ran: string[]): Tool {
  return {
    spec: { name, description: `${name} 的测试替身`, inputSchema: { type: 'object' } },
    async run() {
      ran.push(name);
      return `${name} 跑了`;
    },
  };
}

const INPUT = { command: 'Remove-Item -Recurse -Force .\\build' };

test('放行的调用照常执行', async () => {
  const ran: string[] = [];
  const guarded = guardToolset(createToolset([probeTool('read_file', ran)]), {
    approve: async () => true,
  });

  await guarded.run({ id: 'c1', name: 'read_file', input: {} });

  assert.deepEqual(ran, ['read_file']);
});

test('用户拒绝时工具根本不执行,并且把这件事告诉模型', async () => {
  const ran: string[] = [];
  const guarded = guardToolset(createToolset([probeTool('write_file', ran)]), {
    approve: async () => false,
  });

  const output = await guarded.run({ id: 'c1', name: 'write_file', input: { path: 'a.txt' } });

  assert.deepEqual(ran, [], '被拒绝就不能执行 —— 问过却没拦住比不问更糟');
  assert.ok(
    /没有执行|已被拒绝|未执行/.test(output),
    `要说清"没执行",否则模型会以为写成功了。实际:${output}`,
  );
});

test('危险命令被拦下,工具不执行,原因与替代做法一起回给模型', async () => {
  const ran: string[] = [];
  const guarded = guardToolset(createToolset([probeTool('run_command', ran)]), {
    approve: async () => true, // 用户就算点了同意,危险清单也该先拦住
  });

  const output = await guarded.run({ id: 'c1', name: 'run_command', input: INPUT });

  assert.deepEqual(ran, []);
  assert.ok(output.includes('拦'), `要说清是被拦下的。实际:${output}`);
  assert.match(output, /删除|递归/, '原因要一起回传');
  assert.ok(output.length > 40, `还要带上替代做法,否则模型只会原地重试。实际:${output}`);
});
