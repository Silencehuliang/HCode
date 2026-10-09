import test from 'node:test';
import assert from 'node:assert/strict';
import type { AgentCatalog, AgentDef } from './agents.js';
import { activeSlots, applyPresets, parsePresets, parseSlotRef, type Presets } from './presets.js';

function def(name: string, model?: string): AgentDef {
  const base: AgentDef = {
    name,
    description: `${name} 的说明`,
    systemPrompt: `${name} 的提示`,
    path: `/tmp/${name}.md`,
    origin: '(测试)',
  };
  return model === undefined ? base : { ...base, model };
}

function catalog(defs: AgentDef[]): AgentCatalog {
  const byName = new Map(defs.map((d) => [d.name, d]));
  return {
    list: () => defs,
    get: (name: string) => byName.get(name),
    problems: () => ['(测试用的假问题)'],
  };
}

function presetsOrThrow(raw: unknown): Presets {
  const parsed = parsePresets(raw);
  if ('error' in parsed) throw new Error(`本该解析成功,却报错:${parsed.error}`);
  return parsed.presets;
}

function slotsOrThrow(presets: Presets, name: string | undefined): Record<string, string> {
  const resolved = activeSlots(presets, name);
  if ('error' in resolved) throw new Error(`本该解析成功,却报错:${resolved.error}`);
  return resolved.slots;
}

function errorOf(result: unknown): string {
  assert.ok(result !== null && typeof result === 'object' && 'error' in result, '本该报错,却没报');
  return (result as { error: string }).error;
}

test('parseSlotRef 只认 preset: 前缀', () => {
  assert.strictEqual(parseSlotRef('preset:scout'), 'scout');
  assert.strictEqual(parseSlotRef('  preset:scout  '), 'scout');
  // 槽位名里可以有冒号 —— 只看前缀,不切冒号。
  assert.strictEqual(parseSlotRef('preset:scout:cheap'), 'scout:cheap');
  assert.strictEqual(parseSlotRef('glm'), undefined);
  assert.strictEqual(parseSlotRef('glm:glm-5.3'), undefined);
  assert.strictEqual(parseSlotRef(undefined), undefined);
  // 写漏了槽位名:是引用,但名字是空的。
  assert.strictEqual(parseSlotRef('preset:'), '');
});

test('没配 presets 得到空表', () => {
  assert.deepStrictEqual(parsePresets(undefined), { presets: {} });
  assert.deepStrictEqual(parsePresets(null), { presets: {} });
});

test('正常解析,并认出 extends', () => {
  const presets = presetsOrThrow({
    cheap: { scout: 'glm:glm-4.5-air' },
    strong: { extends: 'cheap', review: 'deepseek:deepseek-v4.1' },
  });
  assert.deepStrictEqual(presets['cheap'], { slots: { scout: 'glm:glm-4.5-air' } });
  assert.deepStrictEqual(presets['strong'], {
    extends: 'cheap',
    slots: { review: 'deepseek:deepseek-v4.1' },
  });
});

test('结构写坏一律报错,不降级成"没有 presets"', () => {
  for (const bad of [
    [],
    'cheap',
    { cheap: 'glm' },
    { cheap: { scout: 3 } },
    { cheap: { scout: '  ' } },
    { cheap: { extends: '' } },
    { '': { scout: 'glm' } },
  ]) {
    const parsed = parsePresets(bad);
    assert.ok('error' in parsed, `${JSON.stringify(bad)} 本该报错`);
  }
});

test('槽位不许指向另一个 preset —— 那会变成猜哪一队', () => {
  const parsed = parsePresets({ cheap: { scout: 'preset:other' } });
  assert.ok(errorOf(parsed).includes('extends'));
});

test('没选 preset 时是空表', () => {
  const presets = presetsOrThrow({ cheap: { scout: 'glm' } });
  assert.deepStrictEqual(slotsOrThrow(presets, undefined), {});
  assert.deepStrictEqual(slotsOrThrow(presets, '   '), {});
});

test('extends 先铺底、自己的盖住继承来的(三层)', () => {
  const presets = presetsOrThrow({
    cheap: { scout: 'glm:glm-4.5-air', review: 'glm' },
    mid: { extends: 'cheap', review: 'deepseek' },
    strong: { extends: 'mid', scout: 'glm:glm-5.3' },
  });
  assert.deepStrictEqual(slotsOrThrow(presets, 'cheap'), {
    scout: 'glm:glm-4.5-air',
    review: 'glm',
  });
  assert.deepStrictEqual(slotsOrThrow(presets, 'mid'), {
    scout: 'glm:glm-4.5-air',
    review: 'deepseek',
  });
  // strong → mid → cheap。strong 只改了 scout,review 从 mid 继承来。
  assert.deepStrictEqual(slotsOrThrow(presets, 'strong'), {
    scout: 'glm:glm-5.3',
    review: 'deepseek',
  });
});

test('选了不存在的队:说清有哪些队', () => {
  const presets = presetsOrThrow({
    cheap: { scout: 'glm' },
    mid: { scout: 'glm' },
    strong: { scout: 'glm' },
  });
  const error = errorOf(activeSlots(presets, 'stong'));
  assert.ok(error.includes('cheap、mid、strong'), error);
});

test('extends 断了 / 绕成环,都要说出来', () => {
  const broken = presetsOrThrow({ a: { extends: 'nope', scout: 'glm' } });
  assert.ok(errorOf(activeSlots(broken, 'a')).includes('nope'));

  const cyclic = presetsOrThrow({
    a: { extends: 'b', scout: 'glm' },
    b: { extends: 'a', review: 'glm' },
  });
  assert.ok(errorOf(activeSlots(cyclic, 'a')).includes('环'));
});

test('没有任何角色引用槽位时,原样返回同一个 catalog', () => {
  // 这条断言看着刁:它锁的是"没引用槽位时连对象都不换" —— 于是"不配 presets 时
  // 行为完全一致"是结构上成立的,不靠逐项对比来保证。
  const plain = catalog([def('explorer', 'glm')]);
  const applied = applyPresets(plain, { scout: 'glm:glm-4.5-air' });
  assert.strictEqual(applied.agents, plain);
  assert.deepStrictEqual(applied.warnings, []);
});

test('角色引用槽位 → 换成这一队的具体 provider[:模型]', () => {
  const agents = catalog([def('explorer', 'preset:scout'), def('reviewer', 'preset:review')]);
  const applied = applyPresets(agents, {
    scout: 'glm:glm-4.5-air',
    review: 'deepseek:deepseek-v4.1',
  });

  assert.deepStrictEqual(applied.warnings, []);
  assert.strictEqual(applied.agents.get('explorer')?.model, 'glm:glm-4.5-air');
  assert.strictEqual(applied.agents.get('reviewer')?.model, 'deepseek:deepseek-v4.1');
  // 其余字段原样带过来,发现阶段的问题照旧透传。
  assert.strictEqual(applied.agents.get('explorer')?.systemPrompt, 'explorer 的提示');
  assert.strictEqual(applied.agents.get('explorer')?.path, '/tmp/explorer.md');
  assert.deepStrictEqual(applied.agents.problems(), ['(测试用的假问题)']);
  assert.strictEqual(applied.agents.list().length, 2);
});

test('写死 provider 的角色不受 preset 影响', () => {
  const agents = catalog([def('writer', 'glm:glm-5.3'), def('plain')]);
  const applied = applyPresets(agents, { scout: 'glm:glm-4.5-air' });
  assert.deepStrictEqual(applied.warnings, []);
  assert.strictEqual(applied.agents.get('writer')?.model, 'glm:glm-5.3');
  assert.strictEqual(applied.agents.get('plain')?.model, undefined);
});

test('槽位在这一队里没有 → 警告 + 回退主对话(字段真的没了)', () => {
  const agents = catalog([def('auditor', 'preset:audit')]);
  const applied = applyPresets(agents, { scout: 'glm', review: 'deepseek' });

  assert.strictEqual(applied.warnings.length, 1);
  assert.ok(applied.warnings[0]?.includes('auditor'));
  assert.ok(applied.warnings[0]?.includes('audit'));
  assert.ok(applied.warnings[0]?.includes('scout、review'));

  const resolved = applied.agents.get('auditor');
  assert.strictEqual(resolved?.model, undefined);
  // "没写这个字段"必须是这个字段不存在,而不是存在且是 undefined。
  assert.ok(resolved !== undefined && !('model' in resolved));
});

test('没选 preset 却引用了槽位 → 警告里教怎么选', () => {
  const agents = catalog([def('explorer', 'preset:scout')]);
  const applied = applyPresets(agents, undefined);
  assert.strictEqual(applied.warnings.length, 1);
  assert.ok(applied.warnings[0]?.includes('HCODE_PRESET'));
  assert.ok(applied.warnings[0]?.includes('explorer'));
});

test('"preset:" 后面什么都没写 → 当成漏写,说清楚', () => {
  const agents = catalog([def('explorer', 'preset:')]);
  const applied = applyPresets(agents, { scout: 'glm' });
  assert.ok(applied.warnings[0]?.includes('没写槽位名'));
  assert.strictEqual(applied.agents.get('explorer')?.model, undefined);
});

test('整队换模型:同一批角色文件,换一个 preset 就换一整队', () => {
  const agents = catalog([def('explorer', 'preset:scout'), def('reviewer', 'preset:review')]);
  const presets = presetsOrThrow({
    cheap: { scout: 'glm:glm-4.5-air', review: 'glm' },
    strong: { extends: 'cheap', scout: 'glm:glm-5.3', review: 'deepseek:deepseek-v4.1' },
  });

  const onCheap = applyPresets(agents, slotsOrThrow(presets, 'cheap')).agents;
  const onStrong = applyPresets(agents, slotsOrThrow(presets, 'strong')).agents;

  assert.strictEqual(onCheap.get('explorer')?.model, 'glm:glm-4.5-air');
  assert.strictEqual(onCheap.get('reviewer')?.model, 'glm');
  assert.strictEqual(onStrong.get('explorer')?.model, 'glm:glm-5.3');
  assert.strictEqual(onStrong.get('reviewer')?.model, 'deepseek:deepseek-v4.1');
});
