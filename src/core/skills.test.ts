import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverSkills, parseFrontmatter, renderSkillCatalog } from './skills.js';

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'hcode-skills-'));
}

async function put(root: string, dir: string, content: string): Promise<void> {
  await mkdir(join(root, dir), { recursive: true });
  await writeFile(join(root, dir, 'SKILL.md'), content, 'utf8');
}

function skill(name: string, description: string, body = '照这几步做。'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

test('发现目录里的 skill,带名称与一句话说明', async () => {
  const root = await scratch();
  try {
    await put(root, 'explore-code', skill('explore-code', '在仓库里找某个东西在哪被用到'));

    const catalog = await discoverSkills([root]);

    assert.equal(catalog.list().length, 1);
    assert.equal(catalog.list()[0]!.name, 'explore-code');
    assert.equal(catalog.list()[0]!.description, '在仓库里找某个东西在哪被用到');
    assert.deepEqual(catalog.problems(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('目录里只有名称与说明,正文不在里面 —— 这是"按需"这个词的全部意思', async () => {
  const root = await scratch();
  try {
    await put(root, 'a', skill('a', '说明', '这是一大段只有用的时候才该出现的方法'));

    const catalog = await discoverSkills([root]);
    const listed = JSON.stringify(catalog.list());

    assert.ok(
      !listed.includes('这是一大段只有用的时候才该出现的方法'),
      '正文进了目录,就等于每次会话都全量塞进去,按需加载也就不存在了',
    );

    assert.match(await catalog.load('a'), /这是一大段只有用的时候才该出现的方法/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('读出来的正文不含 frontmatter', async () => {
  const root = await scratch();
  try {
    await put(root, 'a', skill('a', '说明', '正文在此'));

    const body = await (await discoverSkills([root])).load('a');

    assert.equal(body, '正文在此');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('同名时,排在前面的根目录优先', async () => {
  const project = await scratch();
  const user = await scratch();
  try {
    await put(project, 'fmt', skill('fmt', '项目里的那一份'));
    await put(user, 'fmt', skill('fmt', '全局的那一份'));

    const catalog = await discoverSkills([project, user]);

    assert.equal(catalog.list().length, 1, '同名的只应该留一份');
    assert.equal(
      catalog.list()[0]!.description,
      '项目里的那一份',
      '项目级盖不住全局级的话,改项目的 skill 会毫无效果,而用户完全查不出为什么',
    );
    assert.equal(catalog.list()[0]!.origin, 'fmt');
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(user, { recursive: true, force: true });
  }
});

test('读一个不存在的 skill 会报错,并列出可用的', async () => {
  const root = await scratch();
  try {
    await put(root, 'a', skill('a', '说明 A'));
    await put(root, 'b', skill('b', '说明 B'));

    const catalog = await discoverSkills([root]);

    await assert.rejects(
      () => catalog.load('c'),
      (error: Error) => {
        assert.match(error.message, /c\b/, '要说清是哪个名字没找到');
        assert.match(error.message, /a/, '要列出可用的 —— 模型据此能自己改对');
        assert.match(error.message, /b/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('前端格式写错时记进 problems,不静默跳过', async () => {
  const root = await scratch();
  try {
    await put(root, 'no-desc', '---\nname: no-desc\n---\n\n正文\n');
    await put(root, 'no-front', '这里直接就是正文,没有 frontmatter。\n');

    const catalog = await discoverSkills([root]);

    assert.equal(catalog.list().length, 0);
    assert.equal(catalog.problems().length, 2, `实际:${JSON.stringify(catalog.problems())}`);
    assert.ok(catalog.problems().some((problem) => /description/.test(problem)));
    assert.ok(catalog.problems().some((problem) => /frontmatter/.test(problem)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('没写 name 就退回目录名 —— 那不是格式错误', async () => {
  const root = await scratch();
  try {
    await put(root, 'legacy', '---\ndescription: 只有一句话说明\n---\n\n正文\n');

    const catalog = await discoverSkills([root]);

    assert.equal(catalog.list()[0]!.name, 'legacy');
    assert.deepEqual(catalog.problems(), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('根目录不存在不是问题 —— 没装过 skill 是最正常的状态', async () => {
  const catalog = await discoverSkills([join(tmpdir(), 'hcode-绝对不存在的目录-9f3a')]);

  assert.deepEqual(catalog.list(), []);
  assert.deepEqual(catalog.problems(), []);
});

test('不是 skill 的目录被跳过,不当成格式错误', async () => {
  const root = await scratch();
  try {
    await mkdir(join(root, 'just-a-folder'), { recursive: true });
    await put(root, 'real', skill('real', '说明'));

    const catalog = await discoverSkills([root]);

    assert.equal(catalog.list().length, 1);
    assert.deepEqual(catalog.problems(), [], '没有 SKILL.md 的目录只是别的目录,不是写坏的 skill');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('frontmatter 的值带引号也能读出来', async () => {
  const root = await scratch();
  try {
    await put(root, 'q', '---\nname: "q"\ndescription: "带引号的说明"\n---\n\n正文\n');

    const skill0 = (await discoverSkills([root])).list()[0]!;

    assert.equal(skill0.name, 'q');
    assert.equal(skill0.description, '带引号的说明');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('目录里明说正文不在上下文里,否则模型会照印象编一套', async () => {
  const root = await scratch();
  try {
    await put(root, 'a', skill('a', '说明 A'));

    const text = renderSkillCatalog((await discoverSkills([root])).list());

    assert.match(text, /a:说明 A/);
    assert.match(text, /不在你的上下文里|不在上下文/);
    assert.match(text, /skill/, '要告诉它用哪个工具去取');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('一个 skill 都没有时,目录那一节是空的', () => {
  assert.equal(renderSkillCatalog([]), '');
});

test('frontmatter 缺失或没闭合都算没有', () => {
  assert.equal(parseFrontmatter('正文'), null);
  assert.equal(parseFrontmatter('---\nname: a\n'), null, '没有闭合的 --- 不算');
});
