import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, settingsPath } from './config.js';

/**
 * 每个测试一个全新的 home。配置读取对着**真实文件系统**测 —— 路径解析
 * (`~/.hcode/settings.json`)正是它要做的事之一,用假的读文件函数把它绕开,
 * 恰恰把最该验的那部分排除掉了。home 是参数,所以不需要碰真实的家目录。
 */
function makeHome(t: TestContext, settings?: unknown): string {
  const home = mkdtempSync(join(tmpdir(), 'hcode-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  if (settings !== undefined) {
    mkdirSync(join(home, '.hcode'), { recursive: true });
    writeFileSync(
      join(home, '.hcode', 'settings.json'),
      typeof settings === 'string' ? settings : JSON.stringify(settings),
    );
  }
  return home;
}

test('从用户级 settings.json 读出选中的 Provider', (t) => {
  const home = makeHome(t, {
    provider: 'glm',
    providers: {
      glm: { apiKey: '密钥-1', model: 'glm-5.3', baseUrl: 'http://127.0.0.1:7863/v1' },
    },
  });

  const outcome = loadConfig({ home, env: {} });

  assert.deepEqual(outcome, {
    ok: true,
    session: {
      providerId: 'glm',
      model: 'glm-5.3',
      apiKey: '密钥-1',
      baseUrl: 'http://127.0.0.1:7863/v1',
    },
  });
});

test('环境变量覆盖配置文件 —— 文件先读,环境后读', (t) => {
  const home = makeHome(t, {
    provider: 'glm',
    providers: { glm: { apiKey: '文件里的密钥', model: 'glm-5.3' } },
  });

  const outcome = loadConfig({
    home,
    env: {
      HCODE_API_KEY: '环境里的密钥',
      HCODE_MODEL: 'glm-5.3-flash',
      HCODE_BASE_URL: 'http://127.0.0.1:9999/v1',
    },
  });

  assert.deepEqual(outcome, {
    ok: true,
    session: {
      providerId: 'glm',
      model: 'glm-5.3-flash',
      apiKey: '环境里的密钥',
      baseUrl: 'http://127.0.0.1:9999/v1',
    },
  });
});

test('完全没有配置时,给出能照着做的首次运行引导', (t) => {
  const home = makeHome(t);

  const outcome = loadConfig({ home, env: {} });

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

  const outcome = loadConfig({ home, env: {} });

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
    '\uFEFF' + JSON.stringify({ provider: 'glm', providers: { glm: { apiKey: '密钥-1' } } }),
  );

  const outcome = loadConfig({ home, env: {} });

  assert.equal(
    outcome.ok,
    true,
    `带 BOM 的配置读不出来,用户会看到"你的配置不是合法 JSON",而他什么都没写错。实际:${JSON.stringify(outcome)}`,
  );
});
