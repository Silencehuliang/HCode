// 一次性测量台:模型在 PowerShell 5.1 上的语法成功率。
// 不是产品代码。没有测试,没有错误处理以外的抽象。
//
//   node run.mjs --dry-run
//   GLM_API_KEY=... DEEPSEEK_API_KEY=... node run.mjs
//
// 见 README.md。

import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASKS, FIXTURE } from './tasks.mjs';
import { ARMS } from './prompts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '.fixture-PROTOTYPE');
const MAX_TURNS = 6;

// 可选:同级目录下的 .env,省去每次 export。已在环境里的变量优先,不覆盖。
// 文件在 .gitignore 里。
const ENV_FILE = join(HERE, '.env');
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const DRY = flag('dry-run');
const SELFTEST = flag('selftest');
const LIMIT = Number(opt('limit', '0')) || 0;
// clean = 剔除 Git/MSYS,模拟没装 Git 的机器。
// native = 开发者本机原样(装了 Git,于是 git.exe 与 MSYS 的 Unix 工具同时在 PATH 上)。
// 两者都要量:Git for Windows 把 git.exe 和 Unix 工具捆绑安装,不可分割,
// 所以现实里只有这两种环境,而 ADR-0002 还没说清以哪个为设计目标。
const PATH_MODES = opt('path', 'clean').split(',').filter(Boolean);
const ONLY_ARMS = opt('arms', 'minimal,mitigated').split(',').filter(Boolean);
const ONLY_MODELS = opt('models', '').split(',').filter(Boolean);

// ---------------------------------------------------------------- providers

const PROVIDERS = {
  glm: {
    protocol: 'openai',
    base: process.env.GLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
    key: process.env.GLM_API_KEY,
    model: process.env.GLM_MODEL || 'glm-4.6',
  },
  deepseek: {
    protocol: 'openai',
    base: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    key: process.env.DEEPSEEK_API_KEY,
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  },
  claude: {
    protocol: 'anthropic',
    base: process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
    key: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
  },
};

const TOOLS_OPENAI = [{
  type: 'function',
  function: {
    name: 'run_command',
    description: 'Run a command in the shell.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
}];

const TOOLS_ANTHROPIC = [{
  name: 'run_command',
  description: 'Run a command in the shell.',
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string' } },
    required: ['command'],
  },
}];

// ---------------------------------------------------------------- decode

// 机器控制台代码页 936(GBK)。PS 5.1 按 GBK 输出中文,按 UTF-8 读会得到替换字符。
// 这是工具的问题,不是模型的问题 —— 所以这里修掉它,而不是让模型去猜。
const GBK = (() => { try { return new TextDecoder('gbk'); } catch { return null; } })();

function decode(buf) {
  if (!buf || !buf.length) return { text: '', encoding: 'empty' };
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return { text: utf8, encoding: 'utf8' };
  if (GBK) {
    const g = GBK.decode(buf);
    if (!g.includes('�')) return { text: g, encoding: 'gbk' };
  }
  return { text: utf8, encoding: 'broken' };
}

// ---------------------------------------------------------------- shell

// 前导把子进程的输出编码钉成 UTF-8。两臂都加 —— 这是 harness 的职责,
// 不是被测的变量;否则测出来的会是"我们自己的工具没设编码"。
// 注意:若模型写了 PS 解析级错误(如 &&),整串解析失败,前导不生效,
// 此时输出仍是 GBK —— 由上面的解码回退兜住。
const PREAMBLE =
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ';

// 子进程环境。clean 模式问 PowerShell 它自己看到的 PATH,再剔掉 Git 相关条目。
let SHELL_ENV = process.env;

async function resolveShellEnv(mode) {
  if (mode === 'native') return process.env;
  const raw = await new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        "[Environment]::GetEnvironmentVariable('PATH','Machine') + ';' + [Environment]::GetEnvironmentVariable('PATH','User')"],
      { encoding: 'utf8' },
      (e, out) => resolve(out || ''),
    );
  });
  const kept = raw.split(';').map((s) => s.trim()).filter((p) => p && !/\\Git\\/i.test(p));
  return { ...process.env, PATH: kept.join(';') };
}

// 当前环境下某个外部程序是否可用。用来跳过物理上无法完成的任务。
async function hasProgram(name) {
  const r = await runShell(
    `if (Get-Command ${name} -ErrorAction SilentlyContinue) { 'YES' } else { 'NO' }`, FIXTURE_DIR);
  return r.stdout.includes('YES');
}

// 返回 { command, exitCode, stdout, stderr, stdoutEncoding, mojibake }
function runShell(command, cwd) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', PREAMBLE + command],
      { cwd, timeout: 60000, maxBuffer: 8 * 1024 * 1024, encoding: 'buffer', env: SHELL_ENV },
      (err, stdoutBuf, stderrBuf) => {
        const out = decode(stdoutBuf);
        const errOut = decode(stderrBuf);
        resolve({
          command,
          exitCode: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout: out.text,
          stderr: errOut.text,
          stdoutEncoding: out.encoding,
          stderrEncoding: errOut.encoding,
          mojibake: out.encoding === 'broken' || errOut.encoding === 'broken',
        });
      },
    );
  });
}

// ---------------------------------------------------------------- classify

const UNIX_ATTEMPT = /(^|[;&|]\s*)(grep|sed|awk|find|head|tail|wc|xargs|which|export|rm\s+-rf)\b/;
const PS_HARD_FAIL = /(不是有效|not a valid|无法将.*识别|is not recognized|ParameterBinding|CommandNotFoundException|术语.*无法识别)/i;
// 引号/转义错误:与 Unix 语法错误是不同的失败模式。反斜杠转义在 PowerShell 里不是转义。
const PS_QUOTING_FAIL = /(TerminatorExpectedAtEndOfString|missing the terminator|MissingEndCurlyBrace|MissingEndParenthesis|UnexpectedToken|缺少终止符|未终止)/i;

function classifyCall(call) {
  const hay = `${call.stdout}\n${call.stderr}`;
  const unixAttempt = UNIX_ATTEMPT.test(call.command) || /&&|\|\|/.test(call.command);
  if (call.exitCode === 0) {
    return { outcome: call.mojibake ? 'mojibake' : 'ok', unixAttempt, hardFail: false };
  }
  if (PS_QUOTING_FAIL.test(hay)) return { outcome: 'quoting-fail', unixAttempt, hardFail: true };
  return {
    outcome: PS_HARD_FAIL.test(hay) ? 'hard-fail' : 'error',
    unixAttempt,
    hardFail: PS_HARD_FAIL.test(hay),
  };
}

// ---------------------------------------------------------------- model io

async function callOpenAI(cfg, system, messages) {
  const res = await fetch(`${cfg.base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'system', content: system }, ...toOpenAI(messages)],
      tools: TOOLS_OPENAI,
      max_tokens: 1500,
    }),
  });
  if (!res.ok) throw new Error(`${cfg.model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const msg = (await res.json()).choices[0].message;
  return {
    text: msg.content || null,
    toolCalls: (msg.tool_calls || []).map((t) => ({
      id: t.id,
      name: t.function.name,
      input: safeParse(t.function.arguments),
    })),
  };
}

async function callAnthropic(cfg, system, messages) {
  const res = await fetch(`${cfg.base.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      system,
      messages: toAnthropic(messages),
      tools: TOOLS_ANTHROPIC,
      max_tokens: 1500,
    }),
  });
  if (!res.ok) throw new Error(`${cfg.model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return {
    text: body.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') || null,
    toolCalls: body.content.filter((b) => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input })),
  };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return {}; } }

// 免费额度会 429。带指数退避重试,否则一次限流就让整轮作废。
async function callModel(provider, cfg, system, messages) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try {
      return provider === 'claude'
        ? await callAnthropic(cfg, system, messages)
        : await callOpenAI(cfg, system, messages);
    } catch (e) {
      lastErr = e;
      const code = Number(/HTTP (\d+)/.exec(e.message || '')?.[1] || 0);
      if (code !== 429 && !(code >= 500 && code <= 599)) throw e;
      const wait = 3000 * 2 ** i;
      process.stdout.write(`(HTTP ${code}, ${wait / 1000}s 后重试) `);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

// 内部消息: {role:'user'|'assistant', text, toolCalls} | {role:'tool', results:[{id,output}]}

function toOpenAI(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.results[0].id, content: m.results[0].output };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      return {
        role: 'assistant',
        content: m.text || null,
        tool_calls: m.toolCalls.map((t) => ({
          id: t.id, type: 'function',
          function: { name: t.name, arguments: JSON.stringify(t.input) },
        })),
      };
    }
    return { role: m.role, content: m.text || '' };
  });
}

function toAnthropic(messages) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: m.results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.output })),
      };
    }
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const content = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const t of m.toolCalls) content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input });
      return { role: 'assistant', content };
    }
    return { role: m.role, content: m.text || '' };
  });
}

// ---------------------------------------------------------------- one conversation

async function runTask(provider, cfg, armName, arm, task) {
  const system = arm.system(FIXTURE_DIR);
  const messages = [{ role: 'user', text: task.prompt }];
  const calls = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const reply = await callModel(provider, cfg, system, messages);

    if (!reply.toolCalls?.length) {
      messages.push({ role: 'assistant', text: reply.text });
      break;
    }

    messages.push({ role: 'assistant', text: reply.text, toolCalls: reply.toolCalls });

    const results = [];
    for (const tc of reply.toolCalls) {
      const call = await runShell(String(tc.input.command ?? ''), FIXTURE_DIR);
      const verdict = classifyCall(call);
      calls.push({ ...call, ...verdict });
      results.push({ id: tc.id, output: `${call.stdout}\n${call.stderr}`.slice(0, 4000) });
    }
    messages.push({ role: 'tool', results });
  }

  const first = calls[0];
  return {
    task: task.id, arm: armName, model: cfg.model,
    calls,
    commandCount: calls.length,
    firstCommandOk: first ? first.outcome === 'ok' : false,
    anyHardFail: calls.some((c) => c.outcome === 'hard-fail'),
    anyFailure: calls.some((c) => c.outcome !== 'ok'),
    anyMojibake: calls.some((c) => c.mojibake),
    anyUnixAttempt: calls.some((c) => c.unixAttempt),
  };
}

// ---------------------------------------------------------------- fixture

function buildFixture() {
  if (existsSync(FIXTURE_DIR)) rmSync(FIXTURE_DIR, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(FIXTURE)) {
    const abs = join(FIXTURE_DIR, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  // 让 git-log 任务在 native 环境下有意义 —— 否则它测的是"夹具不是仓库",不是模型。
  const g = (args) => { try { execFileSync('git', args, { cwd: FIXTURE_DIR, stdio: 'ignore' }); } catch { /* 无 git 时忽略 */ } };
  g(['init', '-q']);
  g(['config', 'user.email', 'prototype@local']);
  g(['config', 'user.name', 'prototype']);
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'feat: 初始化夹具']);
  writeFileSync(join(FIXTURE_DIR, 'CHANGELOG.md'), '# changelog\n', 'utf8');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'docs: 添加 changelog']);
  writeFileSync(join(FIXTURE_DIR, 'src', 'config.js'), `${FIXTURE['src/config.js']}\n// touched by refactor\n`, 'utf8');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'refactor: 重整 parseConfig']);
}

// ---------------------------------------------------------------- main

// ---------------------------------------------------------------- selftest

// 验证仪器本身,不发任何 model call。测量的是编码与归类,所以仪器错了
// 读数就全错 —— 这一步不能省。
if (SELFTEST) {
  buildFixture();
  SHELL_ENV = await resolveShellEnv(PATH_MODES[0]);
  const probes = [
    ['grep 是否可见',          "if (Get-Command grep -ErrorAction SilentlyContinue) { 'FOUND ' + (Get-Command grep).Source } else { 'ABSENT' }"],
    ['git 是否可见',           "if (Get-Command git -ErrorAction SilentlyContinue) { 'FOUND ' + (Get-Command git).Source } else { 'ABSENT' }"],
    ['原生 PS,正确写法',      'Get-ChildItem . | Select-Object -First 2 -ExpandProperty Name'],
    ['中文输出',              "Write-Output '中文测试：目录 说明.md'"],
    ['alias 参数错(ls -la)',  'ls -la'],
    ['PS 5.1 解析错(&&)',     "Write-Output 'x' && Write-Output 'y'"],
    ['引号转义错(\\")',        'Select-String -Pattern "require\\(|from \\""'],
    ['运行时错误(文件不存在)', 'Get-Content -Path .\\nope.json'],
    ['Unix 工具(grep)',        'grep -r parseConfig src'],
    ['读中文名文件',           'Get-Content -Path ".\\文档\\说明.md" -Encoding UTF8'],
    ['git log',                'git log --oneline -3'],
  ];
  console.log(`=== 仪器自检(不发 model call)===\nPATH 模式: ${PATH_MODES.join(', ')}\n`);
  for (const [label, cmd] of probes) {
    const r = await runShell(cmd, FIXTURE_DIR);
    const v = classifyCall(r);
    const sample = (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 70);
    console.log(`${label.padEnd(22)} exit=${String(r.exitCode).padStart(2)} ` +
      `enc=${(r.stdoutEncoding + '/' + r.stderrEncoding).padEnd(11)} ` +
      `${(v.outcome + (v.unixAttempt ? '+unix' : '')).padEnd(16)} ${sample}`);
  }
  console.log('\n判读:enc 应为 utf8;clean 下 grep/git 应 ABSENT;引号那条应为 quoting-fail。');
  process.exit(0);
}

const models = ONLY_MODELS.length
  ? ONLY_MODELS
  : Object.keys(PROVIDERS).filter((p) => PROVIDERS[p].key);

const tasks = LIMIT ? TASKS.slice(0, LIMIT) : TASKS;

if (DRY) {
  console.log('=== 计划(未发起任何 model call)===\n');
  console.log(`模型 (${models.length}): ${models.join(', ')}`);
  console.log(`臂   (${ONLY_ARMS.length}): ${ONLY_ARMS.join(', ')}`);
  console.log(`任务 (${tasks.length}): ${tasks.map((t) => t.id).join(', ')}\n`);
  console.log(`环境 (${PATH_MODES.length}): ${PATH_MODES.join(', ')}`);
  const conv = models.length * ONLY_ARMS.length * tasks.length * PATH_MODES.length;
  console.log(`对话数: ${conv}`);
  console.log(`上限调用数: ${conv * MAX_TURNS}(每段对话最多 ${MAX_TURNS} 轮)`);
  console.log(`夹具目录: ${FIXTURE_DIR}`);
  console.log(`\n结果将写入: ${join(HERE, 'results', '<时间戳>.json')}`);
  if (!models.length) {
    console.log('\n注意:没有检测到任何 API key(GLM_API_KEY / DEEPSEEK_API_KEY / ANTHROPIC_API_KEY)。');
    console.log('实跑前请先设置至少一个。');
  }
  process.exit(0);
}

if (!models.length) {
  console.error('错误:没有可用的 API key。设置 GLM_API_KEY 或 DEEPSEEK_API_KEY 后重试。');
  console.error('先跑 --dry-run 看计划。');
  process.exit(1);
}

buildFixture();
console.log(`夹具已生成: ${FIXTURE_DIR}\n`);

const results = [];

for (const mode of PATH_MODES) {
  SHELL_ENV = await resolveShellEnv(mode);
  console.log(`########## 环境: ${mode} ##########`);

  // 缺程序的任务在当前环境下物理上做不到,跳过而不是记成模型失败 ——
  // 否则测的是环境,不是模型。
  const needs = [...new Set(tasks.map((t) => t.needs).filter(Boolean))];
  const avail = {};
  for (const n of needs) avail[n] = await hasProgram(n);
  const runnable = tasks.filter((t) => !t.needs || avail[t.needs]);
  const dropped = tasks.filter((t) => t.needs && !avail[t.needs]);
  if (dropped.length) {
    console.log(`跳过(环境缺程序): ${dropped.map((t) => `${t.id}(需 ${t.needs})`).join(', ')}`);
  }

  for (const m of models) {
    const cfg = PROVIDERS[m];
    if (!cfg.key) { console.log(`跳过 ${m}(无 key)`); continue; }
    for (const armName of ONLY_ARMS) {
      for (const task of runnable) {
        process.stdout.write(`${m} / ${armName} / ${task.id} ... `);
        try {
          const r = await runTask(m, cfg, armName, ARMS[armName], task);
          r.path = mode;
          results.push(r);
          console.log(
            `${r.commandCount} cmds, first=${r.firstCommandOk ? 'ok' : 'FAIL'}` +
            `${r.anyHardFail ? ' [hard-fail]' : ''}${r.anyMojibake ? ' [mojibake]' : ''}`,
          );
        } catch (e) {
          console.log(`ERROR ${e.message}`);
          results.push({ task: task.id, arm: armName, model: cfg.model, path: mode, error: e.message });
        }
      }
    }
  }
  console.log('');
}

// ---------------------------------------------------------------- report

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(0)}%` : 'n/a');
const ok = results.filter((r) => !r.error);

console.log('\n================ 结果 ================\n');
for (const mode of PATH_MODES) {
  let any = false;
  for (const m of models) {
    for (const armName of ONLY_ARMS) {
      const rows = ok.filter((r) => r.model === PROVIDERS[m].model && r.arm === armName && r.path === mode);
      if (!rows.length) continue;
      any = true;
      console.log(
        `${mode.padEnd(7)} ${`${m}/${armName}`.padEnd(22)} ` +
        `任务 ${String(rows.length).padStart(2)}  ` +
        `首次成功 ${pct(rows.filter((r) => r.firstCommandOk).length, rows.length).padStart(4)}  ` +
        `有硬失败 ${pct(rows.filter((r) => r.anyHardFail).length, rows.length).padStart(4)}  ` +
        `有乱码 ${pct(rows.filter((r) => r.anyMojibake).length, rows.length).padStart(4)}  ` +
        `试过 Unix 语法 ${pct(rows.filter((r) => r.anyUnixAttempt).length, rows.length).padStart(4)}`,
      );
    }
  }
  if (!any) console.log(`${mode.padEnd(7)} (无有效数据)`);
  console.log('');
}

const errored = results.filter((r) => r.error);
if (errored.length) {
  console.log(`另有 ${errored.length} 段对话因 API 错误未完成:`);
  const kinds = {};
  for (const e of errored) {
    const k = /HTTP (\d+)/.exec(e.error)?.[1] || 'other';
    kinds[k] = (kinds[k] || 0) + 1;
  }
  for (const [k, v] of Object.entries(kinds)) console.log(`  HTTP ${k}: ${v} 段`);
  console.log('');
}

// 最常被误用的 Unix 惯用法
const badPatterns = {};
for (const r of ok) {
  for (const c of r.calls || []) {
    if (c.outcome === 'ok') continue;
    const m = (c.command || '').match(UNIX_ATTEMPT);
    const key = m ? m[2] : (/&&|\|\|/.test(c.command) ? '&& / ||' : 'other');
    badPatterns[key] = (badPatterns[key] || 0) + 1;
  }
}
const top = Object.entries(badPatterns).sort((a, b) => b[1] - a[1]).slice(0, 10);
if (top.length) {
  console.log('\n失败命令里的惯用法分布:');
  for (const [k, v] of top) console.log(`  ${String(v).padStart(3)}  ${k}`);
}

const outDir = join(HERE, 'results');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2), 'utf8');
console.log(`\n明细: ${outFile}`);
