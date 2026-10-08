// 探第三方 provider 是否真的支持 tool calling。
// 实验全部建立在"模型能返回 tool_use"之上,不先验这一条就开跑等于赌。
//
//   node probe-providers.mjs
//
// 直接读 ~/.config/opencode/opencode.json 里的 provider 配置。密钥不打印。

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG = join(homedir(), '.config', 'opencode', 'opencode.json');

// 递归找出所有带 options.apiKey + baseURL 的节点 —— 配置里嵌套结构不统一。
function extractProviders(node, out = [], inherited = {}) {
  if (!node || typeof node !== 'object') return out;
  const opts = node.options || {};
  const baseURL = opts.baseURL || inherited.baseURL;
  const apiKey = opts.apiKey || inherited.apiKey;
  if (node.npm?.includes('openai-compatible') || (baseURL && apiKey && node.models)) {
    out.push({ baseURL, apiKey, models: Object.keys(node.models || {}) });
  }
  for (const v of Object.values(node)) extractProviders(v, out, { baseURL, apiKey });
  return out;
}

const cfg = JSON.parse(readFileSync(CONFIG, 'utf8'));
const seen = new Set();
const providers = [];
for (const [name, node] of Object.entries(cfg.provider || {})) {
  for (const p of extractProviders(node)) {
    if (!p.baseURL || !p.apiKey || !p.models.length) continue;
    const id = `${name}|${p.baseURL}|${p.models.join(',')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    // 顶层 provider 名优先;嵌套的用其 provider 名
    providers.push({ name, ...p });
  }
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get the weather for a city.',
    parameters: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
}];

async function probe(baseURL, apiKey, model) {
  const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'What is the weather in Shanghai? Use the get_weather tool.' }],
        tools: TOOLS,
        max_tokens: 300,
      }),
      signal: AbortSignal.timeout(90000),
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200).replace(/\s+/g, ' ');
      return { ok: false, ms, note: `HTTP ${res.status} ${body}` };
    }
    const json = await res.json();
    const msg = json.choices?.[0]?.message;
    if (!msg) return { ok: false, ms, note: `无 choices: ${JSON.stringify(json).slice(0, 160)}` };
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      return { ok: false, ms, note: `未返回 tool_call,文本回复: ${String(msg.content).slice(0, 90)}` };
    }
    const args = calls[0].function?.arguments ?? '';
    let parsed = null; try { parsed = JSON.parse(args); } catch { /* 保留原样 */ }
    return {
      ok: true, ms,
      note: `tool=${calls[0].function?.name} args=${parsed ? JSON.stringify(parsed) : args.slice(0, 40)}`,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, note: `${e.name}: ${e.message}`.slice(0, 160) };
  }
}

console.log(`配置: ${CONFIG}\n`);
for (const p of providers) {
  console.log(`### ${p.name}  ${p.baseURL}  (key 前缀 ${String(p.apiKey).slice(0, 3)}…)`);
  for (const model of p.models) {
    process.stdout.write(`  ${model.padEnd(34)} `);
    const r = await probe(p.baseURL, p.apiKey, model);
    console.log(`${r.ok ? '✓ 支持' : '✗ 不支持'}  ${String(r.ms).padStart(6)}ms  ${r.note}`);
  }
  console.log('');
}
