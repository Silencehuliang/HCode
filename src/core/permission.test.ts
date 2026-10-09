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
// v2-14 的 council 同理:议员与记录员的工具集都是空的,它花的是 token,不是用户的文件。
for (const tool of ['todo_write', 'todo_update', 'todo_read', 'task', 'skill', 'task_status', 'task_followup', 'council']) {
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

// ---------- v2-02:角色层单向收紧 ----------

import {
  decideAsAgent,
  isZeroBlastRadius,
  parseAgentRestriction,
  tighten,
  guardToolsetForAgent,
} from './permission.js';

test('tighten:两个判定永远取更严者(组合矩阵)', () => {
  const allow = { kind: 'allow' } as const;
  const ask = { kind: 'ask' } as const;
  const deny = { kind: 'deny', reason: 'r', instead: 'i' } as const;

  // deny 在任何一边都赢 —— 这就是 DANGER_RULES 最终否决权的实现机制。
  assert.equal(tighten(allow, deny).kind, 'deny');
  assert.equal(tighten(deny, allow).kind, 'deny');
  assert.equal(tighten(deny, deny).kind, 'deny');
  assert.equal(tighten(ask, deny).kind, 'deny');
  assert.equal(tighten(deny, ask).kind, 'deny');
  // ask 压得过 allow:用户层的把关不归角色文件点头。
  assert.equal(tighten(allow, ask).kind, 'ask');
  assert.equal(tighten(ask, allow).kind, 'ask');
  assert.equal(tighten(ask, ask).kind, 'ask');
  assert.equal(tighten(allow, allow).kind, 'allow');
});

test('read-only 角色:写盘与执行命令直接 deny,零爆炸半径工具照常放行', () => {
  assert.equal(decideAsAgent(call('write_file', { path: 'a.txt' }), 'read-only').kind, 'deny');
  assert.equal(decideAsAgent(call('edit_file', { path: 'a.ts' }), 'read-only').kind, 'deny');
  assert.equal(decideAsAgent(call('run_command', { command: 'Get-ChildItem' }), 'read-only').kind, 'deny');
  assert.equal(decideAsAgent(call('read_file', { path: 'a.txt' }), 'read-only').kind, 'allow');
  assert.equal(decideAsAgent(call('search_content', {}), 'read-only').kind, 'allow');
});

test('DANGER_RULES 在角色层叠加下仍然是 deny,任何方向都改不动', () => {
  // 危险命令:V1 判定就是 deny;read-only 叠上去还是同一条 deny。
  const verdict = decideAsAgent(
    call('run_command', { command: 'Remove-Item -Recurse -Force .\build' }),
    'read-only',
  );
  assert.equal(verdict.kind, 'deny');
  if (verdict.kind === 'deny') {
    assert.match(verdict.reason, /递归删除/, 'deny 的理由要来自危险清单,不是角色层');
  }
});

test('用户层 ask 不能被任何角色声明放宽(单向)', () => {
  // 用户层对 write_file 是 ask;角色层能给的只有 read-only(更严)。没有"角色 allow"
  // 这种东西可测 —— 语法里就不存在,这是设计而不是实现细节(v2-08 也一样)。
  assert.equal(decideAsAgent(call('write_file', { path: 'a.txt' })).kind, 'ask');
  assert.equal(decideAsAgent(call('write_file', { path: 'a.txt' }), 'read-only').kind, 'deny');
});

test('parseAgentRestriction:只认 read-only,别的值不生效也不报错', () => {
  assert.equal(parseAgentRestriction('read-only'), 'read-only');
  assert.equal(parseAgentRestriction(' read-only '), 'read-only');
  assert.equal(parseAgentRestriction('allow-all'), undefined);
  assert.equal(parseAgentRestriction('god-mode'), undefined);
  assert.equal(parseAgentRestriction(undefined), undefined);
});

test('guardToolsetForAgent:角色层 deny 不问用户,直接拦', async () => {
  let asked = 0;
  const inner = createToolset([
    {
      spec: { name: 'write_file', description: '写', inputSchema: { type: 'object' } },
      async run() { return '写进去了'; },
    },
  ]);
  const guarded = guardToolsetForAgent(inner, {
    approve: async () => { asked += 1; return true; },
    restriction: 'read-only',
  });

  const output = await guarded.run({ id: 'c1', name: 'write_file', input: { path: 'a.txt' } });
  assert.match(output, /read-only/);
  assert.equal(asked, 0, '角色层 deny 是角色作者替用户收的权,不该再问现场用户');
});

test('guardToolsetForAgent:无角色层时 ask 照常走用户确认', async () => {
  let asked = 0;
  const inner = createToolset([
    {
      spec: { name: 'write_file', description: '写', inputSchema: { type: 'object' } },
      async run() { return '写进去了'; },
    },
  ]);
  const guarded = guardToolsetForAgent(inner, {
    approve: async () => { asked += 1; return false; },
  });

  const output = await guarded.run({ id: 'c1', name: 'write_file', input: { path: 'a.txt' } });
  assert.match(output, /没有批准/);
  assert.equal(asked, 1);
});

test('guardToolset(V1 入口)行为不变:ask 拦下、allow 放行', async () => {
  const inner = createToolset([
    {
      spec: { name: 'read_file', description: '读', inputSchema: { type: 'object' } },
      async run() { return '内容'; },
    },
  ]);
  const guarded = guardToolset(inner, { approve: async () => false });
  assert.equal(await guarded.run({ id: 'c1', name: 'read_file', input: {} }), '内容');
});

test('isZeroBlastRadius:判据与装配层共用同一份名单', () => {
  assert.ok(isZeroBlastRadius('read_file'));
  assert.ok(isZeroBlastRadius('todo_write'));
  assert.ok(!isZeroBlastRadius('write_file'));
  assert.ok(!isZeroBlastRadius('run_command'));
  assert.ok(!isZeroBlastRadius('edit_file'));
});

// ---------- v2-08:用户层规则引擎 ----------

import { decideWith, matchRule, parsePermissionRules } from './permission.js';

const rules = (raw: unknown) => {
  const parsed = parsePermissionRules(raw);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed.rules;
};

test('parsePermissionRules:解析、键序、坏值报错', () => {
  const table = rules({ 'write_file': 'ask', 'run_command*': 'deny', '*': 'allow' });
  assert.deepEqual(table.map((r) => [r.pattern, r.verdict]), [
    ['write_file', 'ask'],
    ['run_command*', 'deny'],
    ['*', 'allow'],
  ]);

  assert.deepEqual(parsePermissionRules(undefined), { rules: [] });
  assert.ok('error' in parsePermissionRules('nope'));
  assert.ok('error' in parsePermissionRules({ write_file: 'maybe' }));
  assert.ok('error' in parsePermissionRules({ write_file: true }));
  assert.ok('error' in parsePermissionRules({ '': 'deny' }));
});

test('matchRule:键序即优先级,支持 * 通配,先命中者赢', () => {
  const table = rules({ 'todo_*': 'deny', 'todo_read': 'allow', '*': 'ask' });

  assert.equal(matchRule(table, 'todo_write'), 'deny');
  // todo_read 两条都命中,键序在前的那条赢 —— 即使它更严。
  assert.equal(matchRule(table, 'todo_read'), 'deny');
  assert.equal(matchRule(table, 'write_file'), 'ask');
  assert.equal(matchRule([], 'write_file'), undefined);
});

test('通配符里的正则元字符被转义,不会漏进来', () => {
  const table = rules({ 'a.b': 'deny' });
  assert.equal(matchRule(table, 'a.b'), 'deny');
  assert.equal(matchRule(table, 'axb'), undefined, '. 必须是字面点,不能当正则通配');
});

test('用户层是天花板:显式 allow 可放宽底座的 ask;没配则听底座', () => {
  // 底座:write_file 是 ask。
  assert.equal(decideWith(call('write_file', { path: 'a.txt' })).kind, 'ask');
  // 用户显式放行 —— 他的机器、他的选择。
  assert.equal(
    decideWith(call('write_file', { path: 'a.txt' }), { rules: rules({ write_file: 'allow' }) }).kind,
    'allow',
  );
  // 用户收紧 —— 底座 allow 的命令变成 deny。
  const denied = decideWith(call('run_command', { command: 'Get-ChildItem' }), {
    rules: rules({ 'run_command': 'deny' }),
  });
  assert.equal(denied.kind, 'deny');
  assert.match(denied.kind === 'deny' ? denied.reason : '', /permissions/, '要指出是你的哪条设置拦的');
  assert.match(denied.kind === 'deny' ? denied.instead : '', /删掉|改成/, '要给出怎么改回来');
});

test('DANGER_RULES 在任何规则组合下仍然 deny,且理由来自危险清单', () => {
  const combos = [
    { '*': 'allow' },
    { 'run_command': 'allow' },
    { 'run_command*': 'allow', '*': 'allow' },
  ];
  for (const combo of combos) {
    for (const restriction of [undefined, 'read-only'] as const) {
      const verdict = decideWith(
        call('run_command', { command: 'Remove-Item -Recurse -Force .\build' }),
        { rules: rules(combo), ...(restriction ? { restriction } : {}) },
      );
      assert.equal(verdict.kind, 'deny', `组合 ${JSON.stringify(combo)} 下仍然必须 deny`);
      if (verdict.kind === 'deny') {
        assert.match(verdict.reason, /递归删除/, '理由是这条命令,不是你的配置');
      }
    }
  }
});

test('角色层在天花板之内:用户 allow 也放不过 read-only 角色', () => {
  const verdict = decideWith(call('write_file', { path: 'a.txt' }), {
    rules: rules({ write_file: 'allow' }),
    restriction: 'read-only',
  });
  assert.equal(verdict.kind, 'deny', '角色只能比全局更严 —— 用户放行不等于角色可以写');
});

test('不配规则时行为与 V1 完全一致(向后兼容)', () => {
  for (const request of [
    call('read_file', { path: 'a.txt' }),
    call('todo_write', {}),
    call('write_file', { path: 'a.txt' }),
    call('run_command', { command: 'Get-ChildItem' }),
    call('run_command', { command: 'git reset --hard HEAD~1' }),
    call('某个还不存在的工具'),
  ]) {
    assert.deepEqual(
      decideWith(request),
      decide(request),
      `${request.tool} 在没配规则时必须与 V1 逐字一致`,
    );
  }
});

test('guardToolset 把用户规则带到守门层', async () => {
  let asked = 0;
  const inner = createToolset([
    {
      spec: { name: 'write_file', description: '写', inputSchema: { type: 'object' } },
      async run() { return '写了'; },
    },
  ]);
  const guarded = guardToolset(inner, {
    approve: async () => { asked += 1; return false; },
    rules: rules({ write_file: 'allow' }),
  });

  assert.equal(await guarded.run({ id: 'c1', name: 'write_file', input: { path: 'a' } }), '写了');
  assert.equal(asked, 0, '用户显式 allow 之后不该再问');
});
