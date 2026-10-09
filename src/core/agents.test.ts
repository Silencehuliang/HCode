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
    assert.strictEqual(catalog.list().length, 1);
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
    assert.deepStrictEqual(catalog.list(), []);
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
