/**
 * preset:把"整队用哪家的哪个模型"从角色文件里抽出来,收到配置文件里。
 *
 * 起因是一个很具体的用法:探查活儿用便宜的档,审查活儿用强的档 —— 而"哪家便宜"
 * 这件事会变(换了套餐、换了网关、试了另一家)。写在角色文件的 model 字段里,换一次
 * 就要改一遍每个角色的文件;写成一个 preset,改一处。
 *
 * 两层名字:
 *   - **槽位**(slot)是角色文件里写的,说的是**用途**:`model: preset:scout`
 *     —— "我要扮演 scout 这个用途",不提具体哪家。
 *   - **preset** 在 settings.json 里,说的是**这一次跑这个用途用谁**:
 *     `{"cheap": {"scout": "glm:glm-4.5-air"}, "strong": {"extends": "cheap", ...}}`
 *
 * 于是"整队换模型" = 改 settings.json 里那一行 `"preset": "strong"`(或者这一次跑
 * `HCODE_PRESET=strong hcode`),角色文件一个字不动。
 *
 * 解析在**启动时**做完:角色走到派发那一步时,它的 model 已经是具体的 `glm:glm-4.5-air`
 * 了 —— 派发路径上不需要知道 preset 存在过。接不上的引用(槽位不存在、没选 preset、
 * extends 断了)一律**回退主对话的模型并说一声**,不静默、也不拦下整场会话。
 */

import type { AgentCatalog, AgentDef } from './agents.js';

/** 槽位名 → `provider[:模型]`,与角色 model 字段同一套写法。 */
export type PresetSlots = Readonly<Record<string, string>>;

export type PresetEntry = {
  /** 继承自哪一队(先铺它的槽位,再铺自己的)。 */
  extends?: string;
  slots: PresetSlots;
};

export type Presets = Readonly<Record<string, PresetEntry>>;

/** 角色 model 里指向槽位的前缀。加前缀是必须的:不加就与 provider 名字分不开。 */
export const PRESET_PREFIX = 'preset:';

/**
 * 角色 model 字段是不是在引用一个槽位;是的话返回槽位名(可能是空串,那算写漏了)。
 *
 * 只看前缀。`preset:` 之后整体是槽位名,槽位名里允许有冒号(有人会写 `scout:cheap`)。
 */
export function parseSlotRef(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const trimmed = model.trim();
  if (!trimmed.startsWith(PRESET_PREFIX)) return undefined;
  return trimmed.slice(PRESET_PREFIX.length).trim();
}

/**
 * 校验 settings.json 里 presets 那一块。
 *
 * 结构写坏要报错,不能降级成"没有 presets" —— 那会让用户以为自己的队伍生效了,
 * 而每个角色其实都在用主对话的模型,还查不出原因。
 */
export function parsePresets(raw: unknown): { presets: Presets } | { error: string } {
  if (raw === undefined || raw === null) return { presets: {} };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'presets 得是一个对象,形如 {"队伍名": {"槽位名": "provider[:模型]"}}。' };
  }

  const presets: Record<string, PresetEntry> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (name.trim() === '') return { error: 'presets 里有一个队伍名是空的。' };
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { error: `presets.${name} 得是一个对象,形如 {"槽位名": "provider[:模型]"}(可以用 "extends" 继承另一队)。` };
    }

    const slots: Record<string, string> = {};
    let base: string | undefined;
    for (const [key, slot] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'extends') {
        if (typeof slot !== 'string' || slot.trim() === '') {
          return { error: `presets.${name}.extends 得是另一队的名字。` };
        }
        base = slot.trim();
        continue;
      }
      if (key.trim() === '') return { error: `presets.${name} 里有一个槽位名是空的。` };
      if (typeof slot !== 'string' || slot.trim() === '') {
        return {
          error: `presets.${name}.${key} 得是字符串 "provider" 或 "provider:模型",现在是 ${JSON.stringify(slot)}。`,
        };
      }
      const value2 = slot.trim();
      // 槽位指向另一个 preset 会让解析变成猜谜(哪一队的?按谁选的?),不如直说不行。
      if (value2.startsWith(PRESET_PREFIX)) {
        return { error: `presets.${name}.${key} 指向了另一个 preset(${value2})—— 槽位只能指向 provider,要改队伍就改 extends。` };
      }
      slots[key] = value2;
    }

    presets[name] = base === undefined ? { slots } : { extends: base, slots };
  }

  return { presets };
}

/**
 * 把选中的那一队摊平成一张槽位表(顺着 extends 从底往上铺,自己的盖住继承来的)。
 *
 * 接不上就返回一句话说明,由调用方显示 —— 这里不写 stderr(core 层不碰终端)。
 */
export function activeSlots(
  presets: Presets,
  name: string | undefined,
): { slots: PresetSlots } | { error: string } {
  if (name === undefined || name.trim() === '') return { slots: {} };
  const wanted = name.trim();

  const chain: string[] = [];
  let current: string | undefined = wanted;
  while (current !== undefined) {
    if (chain.includes(current)) {
      return { error: `presets 的 extends 绕成了环:${[...chain, current].join(' → ')}。` };
    }
    const entry: PresetEntry | undefined = presets[current];
    if (!entry) {
      if (chain.length === 0) {
        const known = Object.keys(presets);
        return {
          error:
            known.length === 0
              ? `选中了 preset「${wanted}」,但配置里一个 preset 都没有。`
              : `选中了 preset「${wanted}」,但配置里没有这一队 —— 有的是:${known.join('、')}。`,
        };
      }
      return { error: `presets.${chain[chain.length - 1] ?? wanted} 继承的「${current}」不存在。` };
    }
    chain.push(current);
    current = entry.extends;
  }

  const slots: Record<string, string> = {};
  for (const layer of [...chain].reverse()) {
    Object.assign(slots, presets[layer]?.slots ?? {});
  }
  return { slots };
}

/**
 * 把一个角色的 model 字段去掉(回退成"继承主对话")。
 *
 * 用 `delete` 而不是 `{...def, model: undefined}`:后者在 exactOptionalPropertyTypes
 * 下是"显式给了一个 undefined",与"这个字段没写"不是同一回事,类型上也通不过。
 */
function inheritMainConversation(def: AgentDef): AgentDef {
  const copy: AgentDef = { ...def };
  delete copy.model;
  return copy;
}

/**
 * 把角色文件里的槽位引用换成本次跑的具体模型。
 *
 * 没有任何角色引用槽位时**原样返回同一个 catalog**(而不是复制一份)—— 这样
 * "不配 presets 时行为与之前完全一致"是结构上成立的,不靠测试逐项盯着。
 */
export function applyPresets(
  agents: AgentCatalog,
  slots: PresetSlots | undefined,
): { agents: AgentCatalog; warnings: string[] } {
  const list = agents.list();
  if (!list.some((def) => parseSlotRef(def.model) !== undefined)) {
    return { agents, warnings: [] };
  }

  const warnings: string[] = [];
  const resolved: AgentDef[] = list.map((def) => {
    const slot = parseSlotRef(def.model);
    if (slot === undefined) return def;

    if (slot === '') {
      warnings.push(`角色 ${def.name} 的 model 写的是 "preset:" 却没写槽位名 —— 它改用主对话的模型。`);
      return inheritMainConversation(def);
    }
    if (slots === undefined) {
      warnings.push(
        `角色 ${def.name} 的 model 引用了 preset 槽位「${slot}」,但这次跑没有能用的 preset` +
          `(没选,或选的那个接不上)—— 它改用主对话的模型。选一队:settings.json 里写一行 "preset",` +
          `或设 HCODE_PRESET。`,
      );
      return inheritMainConversation(def);
    }
    const bound = slots[slot];
    if (bound === undefined) {
      const available = Object.keys(slots);
      warnings.push(
        `角色 ${def.name} 的 model 引用的槽位「${slot}」在这一队里没有` +
          (available.length > 0 ? ` —— 这一队有的是:${available.join('、')}` : ' —— 这一队是空的') +
          '。它改用主对话的模型。',
      );
      return inheritMainConversation(def);
    }
    return { ...def, model: bound };
  });

  const byName = new Map(resolved.map((def) => [def.name, def]));
  return {
    agents: {
      list: () => resolved,
      get: (name: string) => byName.get(name),
      problems: () => agents.problems(),
    },
    warnings,
  };
}
