import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverAgents } from './agents.js';

async function makeRoots(): Promise<{ project: string; user: string; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'hcode-agents-test-'));
  const project = join(base, 'project', '.hcode', 'agents');
  const user = join(base, 'user', '.hcode', 'agents');
  await mkdir(project, { recursive: true });
  await mkdir(user, { recursive: true });
  return { project, user, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function agentFile(frontmatter: string, body = '正文即系统提示词。'): string {
  return `---\n${frontmatter}\n---\n\n${body}\n`;
}

test('发现两个目录下的角色,字段解析齐全', async () => {
  const { project, user, cleanup } = await makeRoots();

  try {
    await writeFile(
      join(project, 'reviewer.md'),
      agentFile('name: reviewer\ndescription: 只读代码审查\n\ntools: read_file, search_content\nmodel: deepseek\npermission: read-only', '你是审查员。'),
    );
    await writeFile(join(user, 'planner.md'), agentFile('description: 只读规划', '你是规划者。'));

    const catalog = await discoverAgents([project, user]);
    assert.deepStrictEqual(catalog.problems(), []);

    const reviewer = catalog.get('reviewer');
    assert.ok(reviewer);
    assert.strictEqual(reviewer.description, '只读代码审查');
    assert.strictEqual(reviewer.systemPrompt, '你是审查员。');
    assert.deepStrictEqual(reviewer.tools, ['read_file', 'search_content']);
    assert.strictEqual(reviewer.model, 'deepseek');
    assert.strictEqual(reviewer.permission, 'read-only');
    assert.strictEqual(reviewer.origin, project);

    // name 缺失退回文件名,不算格式错误。
    const planner = catalog.get('planner');
    assert.ok(planner);
    assert.strictEqual(planner.description, '只读规划');
    assert.strictEqual(planner.systemPrompt, '你是规划者。');
    assert.strictEqual(planner.model, undefined);
  } finally {
    await cleanup();
  }
});

test('同名角色项目覆盖用户 —— first-wins', async () => {
  const { project, user, cleanup } = await makeRoots();

  try {
    await writeFile(join(project, 'explorer.md'), agentFile('description: 项目版', '项目正文'));
    await writeFile(join(user, 'explorer.md'), agentFile('description: 用户版', '用户正文'));

    const catalog = await discoverAgents([project, user]);
    const explorer = catalog.get('explorer');
    assert.ok(explorer);
    assert.strictEqual(explorer.description, '项目版');
    assert.strictEqual(explorer.systemPrompt, '项目正文');
    assert.strictEqual(explorer.origin, project);
    // 项目那份盖住用户那份与内置那份 —— 同名只留一个。
    assert.strictEqual(catalog.list().filter((a) => a.name === 'explorer').length, 1);
  } finally {
    await cleanup();
  }
});

test('5 字段之外的 frontmatter 键被忽略,不报错', async () => {
  const { project, cleanup } = await makeRoots();

  try {
    await writeFile(
      join(project, 'x.md'),
      agentFile('name: x\ndescription: 说明\ntemperature: 0.7\nspawns: explorer\nmax-turns: 40', '正文'),
    );

    const catalog = await discoverAgents([project]);
    assert.deepStrictEqual(catalog.problems(), []);
    const agent = catalog.get('x');
    assert.ok(agent);
    assert.strictEqual(agent.tools, undefined);
    assert.strictEqual(agent.model, undefined);
    assert.strictEqual(agent.permission, undefined);
  } finally {
    await cleanup();
  }
});

test('没有 frontmatter → 记进 problems', async () => {
  const { project, cleanup } = await makeRoots();

  try {
    await writeFile(join(project, 'bad.md'), '没有 frontmatter 的正文。');
    await writeFile(join(project, 'good.md'), agentFile('description: 说明'));

    const catalog = await discoverAgents([project]);
    const problems = catalog.problems();
    assert.strictEqual(problems.length, 1);
    assert.ok(problems[0]!.includes('bad.md'));
    assert.ok(problems[0]!.includes('frontmatter'));
    // 坏文件不拦住好文件。
    assert.ok(catalog.get('good'));
  } finally {
    await cleanup();
  }
});

test('没有 description → 记进 problems', async () => {
  const { project, cleanup } = await makeRoots();

  try {
    await writeFile(join(project, 'nodesc.md'), agentFile('name: nodesc'));

    const catalog = await discoverAgents([project]);
    const problems = catalog.problems();
    assert.strictEqual(problems.length, 1);
    assert.ok(problems[0]!.includes('nodesc.md'));
    assert.ok(problems[0]!.includes('description'));
  } finally {
    await cleanup();
  }
});

test('根目录不存在 → 静默跳过,目录里有非 md 文件 → 跳过', async () => {
  const { project, cleanup } = await makeRoots();

  try {
    await writeFile(join(project, 'notes.txt'), '不是角色');
    await writeFile(join(project, 'sub.txt'), '也不是');

    const catalog = await discoverAgents([project, join(project, '..', 'no-such-dir')]);
    assert.deepStrictEqual(catalog.problems(), []);
    // 没有任何用户/项目角色时,目录里剩下的就是三个内置角色 —— 非 md 文件不进名录。
    assert.deepStrictEqual(
      catalog.list().map((a) => a.name).sort(),
      ['explorer', 'planner', 'reviewer'],
    );
  } finally {
    await cleanup();
  }
});

test('description 两侧的引号被去掉(兼容现成写法)', async () => {
  const { project, cleanup } = await makeRoots();

  try {
    await writeFile(join(project, 'q.md'), agentFile('name: q\ndescription: "带引号的说明"'));

    const catalog = await discoverAgents([project]);
    const agent = catalog.get('q');
    assert.ok(agent);
    assert.strictEqual(agent.description, '带引号的说明');
  } finally {
    await cleanup();
  }
});

test('带 BOM 的角色文件正常解析', async () => {
  const { project, cleanup } = await makeRoots();

  try {
    // 用户手写的 md 带 BOM 不罕见;V1 配置读取处理过同一问题,这里沿用同一套读法。
    await writeFile(join(project, 'bom.md'), '﻿' + agentFile('name: bom\ndescription: 说明'));

    const catalog = await discoverAgents([project]);
    assert.deepStrictEqual(catalog.problems(), []);
    assert.ok(catalog.get('bom'));
  } finally {
    await cleanup();
  }
});

test('frontmatter 里 name 与文件名不同 → name 优先', async () => {
  const { project, cleanup } = await makeRoots();

  try {
    await writeFile(join(project, 'file-name.md'), agentFile('name: declared-name\ndescription: 说明'));

    const catalog = await discoverAgents([project]);
    assert.ok(catalog.get('declared-name'));
    assert.strictEqual(catalog.get('file-name'), undefined);
  } finally {
    await cleanup();
  }
});

// ---------- v2-03:model 字段绑定 ----------

import { agentModelWarnings, parseModelBinding } from './agents.js';

test('parseModelBinding:只指家 / 家:模型 / 空 = 继承', () => {
  assert.deepEqual(parseModelBinding('deepseek'), { providerId: 'deepseek' });
  assert.deepEqual(parseModelBinding('glm:glm-5.3'), { providerId: 'glm', model: 'glm-5.3' });
  assert.deepEqual(parseModelBinding(' glm : glm-5.3 '), { providerId: 'glm', model: 'glm-5.3' });
  // 模型名自己带冒号:只按第一个冒号切,后半段整体是模型名。
  assert.deepEqual(parseModelBinding('glm:glm-4.5:air'), { providerId: 'glm', model: 'glm-4.5:air' });
  assert.deepEqual(parseModelBinding(':model-only'), undefined);
  assert.deepEqual(parseModelBinding('glm:'), { providerId: 'glm' }); // 冒号后空 = 只指家
  assert.equal(parseModelBinding(undefined), undefined);
  assert.equal(parseModelBinding('  '), undefined);
});

test('agentModelWarnings:指向配不出密钥的家才警告', () => {
  const defs = [
    { name: 'a', description: 'd', systemPrompt: 's', path: 'p', origin: 'o', model: 'deepseek' },
    { name: 'b', description: 'd', systemPrompt: 's', path: 'p', origin: 'o', model: 'qwen:qwen-max' },
    { name: 'c', description: 'd', systemPrompt: 's', path: 'p', origin: 'o' },
  ];
  const warnings = agentModelWarnings(defs, ['glm', 'deepseek']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /角色 b/);
  assert.match(warnings[0]!, /qwen/);
  assert.match(warnings[0]!, /回退/);
});

// ---------- v2-04:内置角色 ----------

test('三个内置角色在没有用户/项目文件时可用,且都是只读', async () => {
  const { project, cleanup } = await makeRoots();

  try {
    const catalog = await discoverAgents([project]);
    assert.deepStrictEqual(catalog.problems(), []);

    for (const name of ['explorer', 'reviewer', 'planner']) {
      const def = catalog.get(name);
      assert.ok(def, `内置角色 ${name} 必须在(开箱即用)`);
      assert.equal(def.origin, '(内置)');
      assert.ok(def.description.length > 0);
      assert.equal(def.permission, 'read-only');
      assert.deepStrictEqual(
        def.tools,
        ['read_file', 'search_content', 'find_files'],
        `${name} 的声明工具集要与其只读定位一致`,
      );
    }

    // explorer 的正文就是 V1 的子 agent 系统提示 —— 正名化迁移,不是另起一份。
    assert.match(catalog.get('explorer')!.systemPrompt, /只读探查者/);
  } finally {
    await cleanup();
  }
});

test('项目里的同名文件覆盖内置角色', async () => {
  const { project, cleanup } = await makeRoots();

  try {
    await writeFile(join(project, 'planner.md'), agentFile('description: 我的规划师', '改过的正文'));

    const catalog = await discoverAgents([project]);
    const planner = catalog.get('planner');
    assert.ok(planner);
    assert.equal(planner.description, '我的规划师');
    assert.equal(planner.systemPrompt, '改过的正文');
    assert.notEqual(planner.origin, '(内置)');
    // 盖掉之后仍然只有一个 planner。
    assert.strictEqual(catalog.list().filter((a) => a.name === 'planner').length, 1);
  } finally {
    await cleanup();
  }
});

test('用户目录的同名文件同样能盖内置', async () => {
  const { project, user, cleanup } = await makeRoots();

  try {
    await writeFile(join(user, 'reviewer.md'), agentFile('description: 用户版审查员', '用户正文'));

    const catalog = await discoverAgents([project, user]);
    const reviewer = catalog.get('reviewer');
    assert.ok(reviewer);
    assert.equal(reviewer.description, '用户版审查员');
    assert.equal(reviewer.origin, user);
  } finally {
    await cleanup();
  }
});

// ---------- v2-05:花名册与 @点名 ----------

import { expandAgentMention, renderAgentRoster } from './agents.js';

test('花名册:一角色一行,带"何时派谁"的指引', () => {
  const roster = renderAgentRoster([
    { name: 'explorer', description: '只读探查', systemPrompt: 's', path: 'p', origin: 'o' },
    { name: 'reviewer', description: '只读审查', systemPrompt: 's', path: 'p', origin: 'o' },
  ]);

  assert.match(roster, /- explorer:/);
  assert.match(roster, /- reviewer:/);
  assert.match(roster, /什么时候派/);
  assert.match(roster, /派谁/);
  // 一行一角色:条目行数 === 角色数(不含指引与空行)。
  const entryLines = roster.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(entryLines.length, 2);
});

test('花名册:过长的 description 截断到一行', () => {
  const long = '很长的说明'.repeat(20);
  const roster = renderAgentRoster([
    { name: 'x', description: long, systemPrompt: 's', path: 'p', origin: 'o' },
  ]);
  const entry = roster.split('\n').find((l) => l.startsWith('- x:'))!;
  assert.ok(entry.length < 60, `条目不能失控地长。实际 ${entry.length} 字`);
  assert.match(entry, /…$/);
});

test('花名册 token 增量有上限(≤ 30 字/角色)', () => {
  const roster = renderAgentRoster([
    { name: 'explorer', description: '只读探查,翻很多地方只带回结论', systemPrompt: 's', path: 'p', origin: 'o' },
    { name: 'reviewer', description: '只读代码审查,给结论与关键文件路径', systemPrompt: 's', path: 'p', origin: 'o' },
    { name: 'planner', description: '只读规划,产出步骤而不动任何文件', systemPrompt: 's', path: 'p', origin: 'o' },
  ]);
  const entryLines = roster.split('\n').filter((l) => l.startsWith('- '));
  const avg = entryLines.reduce((sum, l) => sum + l.length, 0) / entryLines.length;
  assert.ok(avg <= 30, `每条平均 ${avg.toFixed(1)} 字,超过 30 的规矩`);
});

test('expandAgentMention:@名 + 任务 → 明确指令', () => {
  const out = expandAgentMention('@reviewer 帮我看看这段代码', ['reviewer', 'planner']);
  assert.equal(out.kind, 'mention');
  if (out.kind !== 'mention') return;
  assert.match(out.text, /reviewer/);
  assert.match(out.text, /帮我看看这段代码/);
});

test('expandAgentMention:光点名不带任务 → 仍然是指令', () => {
  const out = expandAgentMention('@planner', ['planner']);
  assert.equal(out.kind, 'mention');
});

test('expandAgentMention:不是 @ 开头 → 原样', () => {
  assert.equal(expandAgentMention('普通一句话', ['reviewer']).kind, 'plain');
  assert.equal(expandAgentMention('邮件 @ 我', ['reviewer']).kind, 'plain');
});

test('expandAgentMention:未知角色 → 报错并列出可用的', () => {
  const out = expandAgentMention('@nobody 做点什么', ['reviewer', 'planner']);
  assert.equal(out.kind, 'unknown');
  if (out.kind !== 'unknown') return;
  assert.match(out.message, /nobody/);
  assert.match(out.message, /reviewer/);
  assert.match(out.message, /planner/);
});

test('worktree 字段:true/yes/on/1 是开,false/no/off/0 是关,不写就是不开', async () => {
  const { project, cleanup } = await makeRoots();

  try {
    await writeFile(join(project, 'writer.md'), agentFile('name: writer\ndescription: 会改文件\nworktree: true'));
    await writeFile(join(project, 'quiet.md'), agentFile('name: quiet\ndescription: 不掺和\nworktree: off'));
    await writeFile(join(project, 'plain.md'), agentFile('name: plain\ndescription: 没写这一行'));

    const catalog = await discoverAgents([project]);
    assert.deepStrictEqual(catalog.problems(), []);

    assert.equal(catalog.get('writer')!.worktree, true);
    assert.equal(catalog.get('quiet')!.worktree, false);
    assert.equal('worktree' in catalog.get('plain')!, false, '没写这一行就不该有这个键');
  } finally {
    await cleanup();
  }
});

test('worktree 的值看不懂 → 报错,而不是当成"没开"', async () => {
  const { project, cleanup } = await makeRoots();

  try {
    await writeFile(join(project, 'maybe.md'), agentFile('name: maybe\ndescription: 含糊\nworktree: 也许吧'));

    const catalog = await discoverAgents([project]);

    const problems = catalog.problems();
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /maybe\.md/);
    assert.match(problems[0]!, /worktree 的值看不懂/);
    assert.match(problems[0]!, /也许吧/, '要把原文抄回去,不然人不知道自己写了什么');
    assert.match(problems[0]!, /worktree: true/, '要给出写法');
    assert.equal(catalog.get('maybe'), undefined, '写错了就当这个角色不存在 —— 看着像在车道上比不在车道上危险得多');
  } finally {
    await cleanup();
  }
});
