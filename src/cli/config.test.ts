import { after, test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, settingsPath } from './config.js';

/**
 * 项目级配置是看 `cwd` 的。绝大多数测试验的是用户级与全局行为,所以项目级目录
 * 一律指向一个空目录 —— 否则跑测试的目录里恰好有一份 `.hcode/settings.json` 时
 * 结果就会变。测试不该依赖它是在哪儿跑的。
 */
const noProject = mkdtempSync(join(tmpdir(), 'hcode-noproject-'));
after(() => rmSync(noProject, { recursive: true, force: true }));

/**
 * 每个测试一个全新的 home。配置读取对着**真实文件系统**测 —— 路径解析
 * (`~/.hcode/settings.json`)正是它要做的事之一,用假的读文件函数把它绕开,
 * 恰恰把最该验的那部分排除掉了。home 是参数,所以不需要碰真实的家目录。
 */
function makeHome(t: TestContext, settings?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'hcode-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  writeSettings(join(home, '.hcode'), settings);
  return home;
}

/** 项目级配置的落点:`<cwd>/.hcode/settings.json`。 */
function makeProjectDir(t: TestContext, settings?: unknown): string {
  const cwd = mkdtempSync(join(tmpdir(), 'hcode-project-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  writeSettings(join(cwd, '.hcode'), settings);
  return cwd;
}

function writeSettings(dir: string, settings: unknown): void {
  if (settings === undefined) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'settings.json'),
    typeof settings === 'string' ? settings : JSON.stringify(settings),
  );
}

test('从用户级 settings.json 读出选中的 Provider', (t) => {
  const home = makeHome(t, {
    provider: 'glm',
    providers: {
      glm: { apiKey: 'key-1', model: 'glm-5.3', baseUrl: 'http://127.0.0.1:7863/v1' },
    },
  });

  const outcome = loadConfig({ cwd: noProject, home, env: {} });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.session, {
    providerId: 'glm',
    model: 'glm-5.3',
    apiKey: 'key-1',
    baseUrl: 'http://127.0.0.1:7863/v1',
  });
  // v2-03:配得出密钥的每一家都要在 providers 里,选中那家与 session 一致。
  assert.deepEqual(outcome.providers.glm, {
    providerId: 'glm',
    model: 'glm-5.3',
    apiKey: 'key-1',
    baseUrl: 'http://127.0.0.1:7863/v1',
  });
  assert.equal(outcome.providers.deepseek, undefined);
});

test('环境变量覆盖配置文件 —— 文件先读,环境后读', (t) => {
  const home = makeHome(t, {
    provider: 'glm',
    providers: { glm: { apiKey: 'file-key', model: 'glm-5.3' } },
  });

  const outcome = loadConfig({
    cwd: noProject,
    home,
    env: {
      HCODE_API_KEY: 'env-key',
      HCODE_MODEL: 'glm-5.3-flash',
      HCODE_BASE_URL: 'http://127.0.0.1:9999/v1',
    },
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.session, {
    providerId: 'glm',
    model: 'glm-5.3-flash',
    apiKey: 'env-key',
    baseUrl: 'http://127.0.0.1:9999/v1',
  });
});

test('完全没有配置时,给出能照着做的首次运行引导', (t) => {
  const home = makeHome(t);

  const outcome = loadConfig({ cwd: noProject, home, env: {} });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;

  assert.ok(
    outcome.message.includes(settingsPath(home)),
    `要写清楚去哪个文件里填,而不是只说"没有配置"。实际给出:\n${outcome.message}`,
  );
  assert.ok(
    outcome.message.includes('"apiKey"'),
    `要给一段能直接抄进文件的配置 —— 只描述格式,用户还得自己拼。实际给出:\n${outcome.message}`,
  );
  assert.ok(
    outcome.message.includes('明文'),
    `密钥以明文落盘必须明说,不做暗示(规格的 User Story 第 10 条)。实际给出:\n${outcome.message}`,
  );
});

test('settings.json 格式坏了时,指出是哪个文件和什么问题', (t) => {
  const home = makeHome(t, '{ 这不是 JSON');

  const outcome = loadConfig({ cwd: noProject, home, env: {} });

  assert.equal(outcome.ok, false, '格式坏了不能当成"读不到文件",否则用户的配置被静默忽略');
  if (outcome.ok) return;

  assert.ok(outcome.message.includes(settingsPath(home)), `要说清是哪个文件坏了。实际给出:\n${outcome.message}`);
  assert.match(outcome.message, /JSON/, `要指出是格式问题,而不是笼统的"没有配置"。实际给出:\n${outcome.message}`);
});

test('settings.json 带 UTF-8 BOM 时照样读得出来', (t) => {
  // PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写入 BOM,记事本也会。
  // JSON.parse 遇到 BOM 直接抛 —— 而 Windows 用户按教程用 PowerShell 写配置,
  // 撞上的就是这个。这不是边角情况,是这条路径上最常见的一种。
  const home = makeHome(
    t,
    '\uFEFF' + JSON.stringify({ provider: 'glm', providers: { glm: { apiKey: 'key-1' } } }),
  );

  const outcome = loadConfig({ cwd: noProject, home, env: {} });

  assert.equal(
    outcome.ok,
    true,
    `带 BOM 的配置读不出来,用户会看到"你的配置不是合法 JSON",而他什么都没写错。实际:${JSON.stringify(outcome)}`,
  );
});

test('代理与思维链是每家的设置,不是全进程的', (t) => {
  const home = makeHome(t, {
    provider: 'glm',
    providers: {
      glm: { apiKey: 'glm-key', model: 'glm-5.3' },
      claude: {
        apiKey: 'claude-key',
        model: 'claude-sonnet-5-5',
        proxy: 'http://127.0.0.1:7890',
        thinking: true,
      },
    },
  });

  const withClaude = loadConfig({ cwd: noProject, home, env: { HCODE_PROVIDER: 'claude' } });
  assert.equal(withClaude.ok, true);
  if (!withClaude.ok) return;
  assert.equal(withClaude.session.proxy, 'http://127.0.0.1:7890');
  assert.equal(withClaude.session.thinking, true);

  const withGlm = loadConfig({ cwd: noProject, home, env: { HCODE_PROVIDER: 'glm' } });
  assert.equal(withGlm.ok, true);
  if (!withGlm.ok) return;

  assert.deepEqual(
    withGlm.session,
    { providerId: 'glm', model: 'glm-5.3', apiKey: 'glm-key' },
    '切到 GLM 不该把 Claude 那家的代理带过来 —— 用国产模型的人多半没代理,更不该被迫绕到国外',
  );
});

test('HCODE_PROXY 与 HCODE_THINKING 压过文件里的设置', (t) => {
  const home = makeHome(t, {
    provider: 'glm',
    providers: {
      glm: {
        apiKey: 'key-1',
        model: 'glm-5.3',
        proxy: 'http://文件里的代理:1080',
        thinking: true,
      },
    },
  });

  const outcome = loadConfig({
    cwd: noProject,
    home,
    env: { HCODE_PROXY: 'http://环境里的代理:7890', HCODE_THINKING: 'off' },
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.session.proxy, 'http://环境里的代理:7890');
  assert.equal(outcome.session.thinking, false, 'off / no / 0 / false 都要认');
});

test('思维链写了个认不出来的值,不算"关"', (t) => {
  const home = makeHome(t, {
    provider: 'glm',
    providers: { glm: { apiKey: 'key-1', model: 'glm-5.3', thinking: true } },
  });

  const outcome = loadConfig({ cwd: noProject, home, env: { HCODE_THINKING: '也许吧' } });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(
    outcome.session.thinking,
    true,
    '认不出来的值要退回文件里的设置,不能悄悄解析成 false —— 用户会以为自己在用的思维链开着',
  );
});

test('项目级 settings.json 压过用户级,并按字段补齐', (t) => {
  const home = makeHome(t, {
    provider: 'glm',
    providers: { glm: { apiKey: 'user-key', model: 'glm-5.3' } },
  });
  const cwd = makeProjectDir(t, {
    provider: 'glm',
    providers: { glm: { apiKey: 'project-key' } },
  });

  const outcome = loadConfig({ cwd, home, env: {} });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.session.apiKey, 'project-key');
  assert.equal(
    outcome.session.model,
    'glm-5.3',
    '项目级只写了密钥,其余字段从用户级补齐 —— 分层是逐字段的,不是整份替换',
  );
});

test('两个配置文件都在时都列出来,让"改了没生效"看得出原因', (t) => {
  const home = makeHome(t, { providers: { glm: { apiKey: 'k' } } });
  const cwd = makeProjectDir(t, { providers: { glm: { apiKey: 'k' } } });

  const outcome = loadConfig({ cwd, home, env: {} });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.files, [join(cwd, '.hcode', 'settings.json'), settingsPath(home)]);
});

test('项目级配置文件坏了就直说,不悄悄退回用户级', (t) => {
  const home = makeHome(t, { provider: 'glm', providers: { glm: { apiKey: 'user-key' } } });
  const cwd = makeProjectDir(t, '{ 这不是 JSON');

  const outcome = loadConfig({ cwd, home, env: {} });

  assert.equal(
    outcome.ok,
    false,
    '项目级文件坏了却拿用户级跑起来,用户会以为自己改的项目级配置正在生效',
  );
  if (outcome.ok) return;
  assert.match(outcome.message, new RegExp(join(cwd, '.hcode').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
});

test('环境变量压过项目级文件', (t) => {
  const home = makeHome(t, {});
  const cwd = makeProjectDir(t, {
    provider: 'glm',
    providers: { glm: { apiKey: 'project-key', model: 'glm-5.3' } },
  });

  const outcome = loadConfig({
    cwd,
    home,
    env: { HCODE_API_KEY: 'env-key', HCODE_MODEL: 'glm-5.3-flash' },
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.session.apiKey, 'env-key');
  assert.equal(outcome.session.model, 'glm-5.3-flash');
});

test('只导出过 ANTHROPIC_API_KEY 的人,零改动就能跑起来', (t) => {
  // 这是这份兼容存在的理由:已经配好 Claude Code 的人 export 过这个变量,
  // 他敲 `hcode` 就应该能直接用,不需要先写一份 hcode 自己的配置文件。
  const outcome = loadConfig({
    cwd: makeProjectDir(t),
    home: makeHome(t),
    env: { ANTHROPIC_API_KEY: 'sk-ant-xxx' },
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.session.providerId, 'claude');
  assert.equal(outcome.session.apiKey, 'sk-ant-xxx');
});

test('自动挑家时国产优先,不会因为顺手 export 过一个 Anthropic 的钥匙就跑国外模型', (t) => {
  const pick = (env: Record<string, string>) => {
    const outcome = loadConfig({ cwd: noProject, home: makeHome(t), env });
    assert.equal(outcome.ok, true);
    return outcome.ok ? outcome.session.providerId : '';
  };

  assert.equal(pick({ ANTHROPIC_API_KEY: 'a' }), 'claude');
  assert.equal(pick({ ANTHROPIC_API_KEY: 'a', DEEPSEEK_API_KEY: 'd' }), 'deepseek');
  assert.equal(
    pick({ ANTHROPIC_API_KEY: 'a', DEEPSEEK_API_KEY: 'd', GLM_API_KEY: 'g' }),
    'glm',
  );
});

test('显式选了一家,就不再自动探测', (t) => {
  const outcome = loadConfig({
    cwd: noProject,
    home: makeHome(t, { provider: 'glm' }),
    env: { ANTHROPIC_API_KEY: 'a' },
  });

  assert.equal(
    outcome.ok,
    false,
    '用户写明了用 glm 却没配 glm 的钥匙 —— 要照实说,不能自作聪明换一家跑',
  );
  if (outcome.ok) return;
  assert.match(outcome.message, /glm/);
});

test('GLM_API_KEY 这类按家命名的环境变量直接可用', (t) => {
  // 与 `set -a && . .env && set +a` 配合,这是本地网关 / 中转最省事的用法。
  const outcome = loadConfig({
    cwd: noProject,
    home: makeHome(t),
    env: {
      GLM_API_KEY: 'g',
      GLM_BASE_URL: 'http://127.0.0.1:7863/v1',
      GLM_MODEL: 'glm-5.3',
    },
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.session, {
    providerId: 'glm',
    model: 'glm-5.3',
    apiKey: 'g',
    baseUrl: 'http://127.0.0.1:7863/v1',
  });
});

test('别家的环境变量不会被当成这一家的', (t) => {
  const outcome = loadConfig({
    cwd: noProject,
    home: makeHome(t),
    env: {
      HCODE_PROVIDER: 'claude',
      ANTHROPIC_API_KEY: 'a',
      GLM_BASE_URL: 'http://127.0.0.1:7863/v1',
    },
  });

  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.session.providerId, 'claude');
  assert.equal(
    outcome.session.baseUrl,
    undefined,
    'GLM 的网关地址不能落到 Claude 头上 —— 那会把请求发去一个说不了 Anthropic 话的端点',
  );
});

test('环境变量是空串时当作没设', (t) => {
  const home = makeHome(t, {
    provider: 'glm',
    providers: { glm: { apiKey: 'file-key', model: 'glm-5.3' } },
  });

  const outcome = loadConfig({
    cwd: noProject,
    home,
    env: { HCODE_PROVIDER: '', HCODE_API_KEY: '', HCODE_MODEL: '' },
  });

  assert.equal(
    outcome.ok,
    true,
    '`.env` 里留一行空的 HCODE_PROVIDER= 很常见,它不该把已经配好的设置顶掉',
  );
  if (!outcome.ok) return;
  assert.equal(outcome.session.providerId, 'glm');
  assert.equal(outcome.session.apiKey, 'file-key');
  assert.equal(outcome.session.model, 'glm-5.3');
});

test('密钥里混进非 ASCII 字符时,说清是第几个字', (t) => {
  // 从网页或文档里复制密钥时带进一个全角字符是很常见的事。不在这里拦,
  // Node 会在发请求之前抛 `Invalid character in header content ["authorization"]`
  // —— 那句话里没有"密钥",也没有位置,用户只会去怀疑网络。
  const home = makeHome(t, {
    provider: 'glm',
    providers: { glm: { apiKey: `sk-abc${String.fromCharCode(0xff0c)}def` } },
  });

  const outcome = loadConfig({ cwd: noProject, home, env: {} });

  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.match(outcome.message, /第 7 个字符/);
  assert.match(
    outcome.message,
    new RegExp(settingsPath(home).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')),
    '要说清密钥是从哪一份文件里读出来的',
  );
  assert.doesNotMatch(outcome.message, /sk-abc/, '报错里不能带出密钥本身');
});

// ---------- v2-08:用户层权限规则 ----------

test('settings.json 的 permissions 被解析进 outcome.rules,键序保留', (t) => {
  const home = makeHome(t, {
    provider: 'glm',
    providers: { glm: { apiKey: 'k' } },
    permissions: { 'write_file': 'ask', 'run_command*': 'deny' },
  } as never);

  const outcome = loadConfig({ cwd: noProject, home, env: {} });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.rules, [
    { pattern: 'write_file', verdict: 'ask' },
    { pattern: 'run_command*', verdict: 'deny' },
  ]);
});

test('项目级 permissions 排在用户级前面(同名项目赢)', (t) => {
  const home = makeHome(t, {
    provider: 'glm',
    providers: { glm: { apiKey: 'k' } },
    permissions: { write_file: 'deny', todo_write: 'deny' },
  } as never);

  const cwd = mkdtempSync(join(tmpdir(), 'hcode-proj-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.hcode'), { recursive: true });
  writeFileSync(
    join(cwd, '.hcode', 'settings.json'),
    JSON.stringify({ permissions: { write_file: 'allow' } }),
  );

  const outcome = loadConfig({ cwd, home, env: {} });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // 项目级写在最前 → 它是先命中的那条。
  assert.equal(outcome.rules[0]?.pattern, 'write_file');
  assert.equal(outcome.rules[0]?.verdict, 'allow');
  // 用户级里项目没覆盖的键仍然在(不再重复 write_file)。
  assert.deepEqual(
    outcome.rules.map((r) => r.pattern),
    ['write_file', 'todo_write'],
  );
});

test('permissions 值写坏 → 直接报错,不静默降级', (t) => {
  const home = makeHome(t, {
    provider: 'glm',
    providers: { glm: { apiKey: 'k' } },
    permissions: { write_file: 'maybe' },
  } as never);

  const outcome = loadConfig({ cwd: noProject, home, env: {} });
  assert.equal(outcome.ok, false, '权限是安全设置,坏值不能被当成"没配"');
  if (outcome.ok) return;
  assert.match(outcome.message, /权限规则/);
  assert.match(outcome.message, /write_file/);
});

test('没有 permissions 字段 → rules 为空,行为与 V1 一致', (t) => {
  const home = makeHome(t, { provider: 'glm', providers: { glm: { apiKey: 'k' } } });
  const outcome = loadConfig({ cwd: noProject, home, env: {} });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.rules, []);
});
