/**
 * 角色的输出约定(v2-10):子 agent 的结论要长什么样。
 *
 * 只做**宽松校验** —— 检查声明的键还在不在,不看类型、不看值合不合法。理由:
 * 结构化输出的失败几乎都发生在"模型压根没给那个字段"或"它给了段散文",而
 * "给了但类型不对"极罕见,代价却是引一套 schema 库 + 一套类型校验规则;而国产
 * 模型对 JSON schema 的遵循度参差,严格的类型校验会把大量可用结论判死。
 *
 * 所以这里的判据只有一条:**键在不在**。键在但值是空串/null,算过 —— 那是模型
 * 在说"这一项没有",不是格式错。
 *
 * 本模块全是纯函数,不认识 Provider、不认识角色文件:调用方(装配层)负责
 * 把 contractInstruction 交给子 agent、把拿回来的话喂给 checkOutput。
 */

/** 从一段自由文本里抠出那个 JSON 对象。抠不出来 = undefined。 */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const candidates: string[] = [];

  const trimmed = text.trim();
  candidates.push(trimmed);

  // ```json ... ``` / ``` ... ```
  const fenced = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(text);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1].trim());

  // 头一个 { 到最后一个 } —— 兜住"JSON 前面还寒暄了一句"的情况。
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 换下一个候选
    }
  }
  return undefined;
}

export type OutputCheck =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; missing: string[]; reason: string };

/** 按约定的字段清单宽松校验一段结论。 */
export function checkOutput(text: string, fields: readonly string[]): OutputCheck {
  const value = extractJsonObject(text);
  if (value === undefined) {
    return {
      ok: false,
      missing: [...fields],
      reason: '结论里没有能找到的 JSON 对象',
    };
  }
  // 存在性:own property。原型链上的不算(模型不可能不小心继承出一个字段)。
  const missing = fields.filter((field) => !Object.prototype.hasOwnProperty.call(value, field));
  if (missing.length > 0) {
    return { ok: false, missing, reason: `缺少字段:${missing.join('、')}` };
  }
  return { ok: true, value };
}

/** 交给子 agent 的约定说明 —— 拼在委派 prompt 里(唯一入向通道)。 */
export function contractInstruction(fields: readonly string[]): string {
  return [
    '输出约定:你的最终结论必须是一个 JSON 对象,含这些键 ——',
    fields.map((field) => `- ${field}`).join(','.length ? '\n' : '\n'),
    '这个 JSON 之外不要再写别的:你的话会被上一步直接读取,寒暄和解释都进不去。',
  ].join('\n');
}

/** 重试时追加的话 —— 把它上一次缺什么点名说清,别让它猜。 */
export function retryInstruction(missing: readonly string[]): string {
  return [
    `你上一次的结论不合格:缺 ${missing.join('、')}。`,
    '请重来一次,**只回一个 JSON 对象**,把上面这些键都带上。',
  ].join('\n');
}

/** 两次都没交货时,回给主对话的那段话(带上原文,人还能自己看)。 */
export function contractFailure(agent: string, missing: readonly string[], text: string): string {
  return [
    `角色 ${agent} 没按输出约定交付:两次都缺 ${missing.join('、')}。`,
    '它最后说的是(原文照传):',
    '',
    text,
  ].join('\n');
}
