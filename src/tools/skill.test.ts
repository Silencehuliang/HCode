import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createSkillTool } from './skill.js';
import type { SkillCatalog } from '../core/skills.js';

function catalogOf(skills: Record<string, string>): SkillCatalog {
  const names = Object.keys(skills);
  return {
    list: () =>
      names.map((name) => ({ name, description: `${name} 的说明`, path: `${name}.md`, origin: name })),
    problems: () => [],
    async load(name) {
      const body = skills[name];
      if (body === undefined) {
        throw new Error(`没有名为 ${name} 的 skill。可用的是:${names.join('、')}`);
      }
      return body;
    },
  };
}

test('把 skill 的正文取回给模型', async () => {
  const tool = createSkillTool(catalogOf({ fmt: '第一步:跑 prettier。' }));

  const output = await tool.run({ name: 'fmt' });

  assert.equal(output, '第一步:跑 prettier。');
});

test('名字不存在时,报错里列出可用的', async () => {
  const tool = createSkillTool(catalogOf({ fmt: '内容', lint: '内容' }));

  await assert.rejects(
    () => tool.run({ name: '不存在' }),
    (error: Error) => {
      assert.match(error.message, /不存在/);
      assert.match(error.message, /fmt/);
      assert.match(error.message, /lint/);
      return true;
    },
  );
});

test('没给名字时给出能照着改的说明', async () => {
  const tool = createSkillTool(catalogOf({ fmt: '内容' }));

  await assert.rejects(() => tool.run({}), /name/);
  await assert.rejects(() => tool.run({ name: '   ' }), /name/);
});
