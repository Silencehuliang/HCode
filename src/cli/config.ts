import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 一家 Provider 的设置。三家可在同一份配置里共存,各有自己的 base URL 与代理。 */
export type ProviderSettings = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
};

/** settings.json 的形状。 */
type SettingsFile = {
  provider?: string;
  providers?: Record<string, ProviderSettings>;
};

export type Session = {
  providerId: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
};

export type ConfigOutcome = { ok: true; session: Session } | { ok: false; message: string };

export type LoadOptions = {
  home?: string;
  env?: Record<string, string | undefined>;
};

/** v1 只实现了 GLM,没配置时按它给引导。 */
export const DEFAULT_PROVIDER = 'glm';

/** 用户级配置的落点。文档要写它,报错要说它,所以它得是一个能被引用的值。 */
export function settingsPath(home: string): string {
  return join(home, '.hcode', 'settings.json');
}

/** 每家的默认模型。用户只填密钥就能跑起来 —— 少一个必填项就少一处卡住的地方。 */
const DEFAULT_MODELS: Record<string, string> = { glm: 'glm-5.3' };

type SettingsRead = { ok: true; settings: SettingsFile } | { ok: false; message: string };

function readSettings(path: string): SettingsRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // 文件不存在是正常情况 —— 第一次跑就是这样,交给引导去告诉用户建它。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, settings: {} };
    return {
      ok: false,
      message: `配置文件读不了:\n\n  ${path}\n\n${(error as Error).message}`,
    };
  }

  try {
    return { ok: true, settings: JSON.parse(text) as SettingsFile };
  } catch (error) {
    // 文件在,但读不动。这里**不能**当成"没有配置":那会把用户已经写好的东西
    // 静默忽略,然后给他看一段"你还没配置"的引导 —— 他会照着再写一遍。
    return {
      ok: false,
      message: `配置文件不是合法的 JSON:\n\n  ${path}\n\n${(error as Error).message}`,
    };
  }
}

/**
 * 第一次跑必然撞上这里,所以它得让人照着做就能过。三条缺一不可:
 * 去哪个文件、直接能抄的内容、以及密钥是明文这个事实。
 */
function firstRunGuidance(home: string, providerId: string): string {
  const defaultModel = DEFAULT_MODELS[providerId];

  return [
    `还不能开始:没有找到 ${providerId} 的密钥。`,
    '',
    '写进这个文件(没有就新建):',
    '',
    `  ${settingsPath(home)}`,
    '',
    '内容照这个填:',
    '',
    '{',
    `  "provider": "${providerId}",`,
    '  "providers": {',
    `    "${providerId}": {`,
    '      "apiKey": "你的密钥"',
    '    }',
    '  }',
    '}',
    '',
    defaultModel
      ? `model 不填就是 ${defaultModel};要用自建中转或本地网关,在同层加一行 "baseUrl"。`
      : `这一版只实现了 ${Object.keys(DEFAULT_MODELS).join('、')},provider 请填其中之一。`,
    '',
    '也可以不动文件,改用环境变量(它会压过文件):',
    '  HCODE_API_KEY / HCODE_MODEL / HCODE_BASE_URL / HCODE_PROVIDER',
    '',
    '注意:密钥以明文存在上面这个文件里,与 GitHub CLI、AWS CLI 一致。',
  ].join('\n');
}

export function loadConfig(options: LoadOptions = {}): ConfigOutcome {
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const read = readSettings(settingsPath(home));
  if (!read.ok) return { ok: false, message: read.message };
  const settings = read.settings;

  // 读取顺序即优先级:文件先,环境变量后。环境变量压过文件,是为了让"这一次跑
  // 用另一份凭据"不需要改动落在盘上的东西 —— CI 与临时切换都依赖这一点。
  const providerId = env['HCODE_PROVIDER'] ?? settings.provider ?? DEFAULT_PROVIDER;
  const entry = settings.providers?.[providerId] ?? {};

  const apiKey = env['HCODE_API_KEY'] ?? entry.apiKey;
  const model = env['HCODE_MODEL'] ?? entry.model ?? DEFAULT_MODELS[providerId];
  const baseUrl = env['HCODE_BASE_URL'] ?? entry.baseUrl;

  if (!apiKey || !model) {
    return { ok: false, message: firstRunGuidance(home, providerId) };
  }

  return {
    ok: true,
    session: {
      providerId,
      model,
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
    },
  };
}
