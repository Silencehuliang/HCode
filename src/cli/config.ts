import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_DEFAULT_BASE_URL } from '../provider/claude.js';
import { DEEPSEEK_DEFAULT_BASE_URL } from '../provider/deepseek.js';
import { GLM_DEFAULT_BASE_URL } from '../provider/glm.js';

/** 一家 Provider 的设置。三家可在同一份配置里共存,各有自己的 base URL 与代理。 */
export type ProviderSettings = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /**
   * 这一家专用的代理。
   *
   * 放在**每家**里面而不是全局,是这份配置存在的理由:用国产模型的人多半不需要
   * 代理,要用 Claude 的人多半必须用。做成全局的话,要么逼前者也配一个,要么更糟
   * —— 让国产模型的请求也绕一圈到国外代理去。
   */
  proxy?: string;
  /** 开思维链。不填就是厂商默认(智谱实测默认开)。 */
  thinking?: boolean;
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
  proxy?: string;
  thinking?: boolean;
};

export type ConfigOutcome = { ok: true; session: Session } | { ok: false; message: string };

export type LoadOptions = {
  home?: string;
  env?: Record<string, string | undefined>;
};

/** 没配置时按它给引导。国产模型优先 —— 这是这个项目存在的理由。 */
export const DEFAULT_PROVIDER = 'glm';

/** 用户级配置的落点。文档要写它,报错要说它,所以它得是一个能被引用的值。 */
export function settingsPath(home: string): string {
  return join(home, '.hcode', 'settings.json');
}

/** 每家的默认模型。用户只填密钥就能跑起来 —— 少一个必填项就少一处卡住的地方。 */
const DEFAULT_MODELS: Record<string, string> = {
  glm: 'glm-5.3',
  deepseek: 'deepseek-chat',
  claude: 'claude-sonnet-5-5',
};

/** 每家的官方端点。适配器自己拿着这个值,这里只是复述,免得两处各写一份。 */
const DEFAULT_BASE_URLS: Record<string, string> = {
  glm: GLM_DEFAULT_BASE_URL,
  deepseek: DEEPSEEK_DEFAULT_BASE_URL,
  claude: CLAUDE_DEFAULT_BASE_URL,
};

export const KNOWN_PROVIDERS = Object.keys(DEFAULT_MODELS);

/** `HCODE_THINKING=1|true|on` 之类的写法。认不出来就不表达意见。 */
function parseBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  return undefined;
}


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
    // 去掉 UTF-8 BOM。PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写它,
    // 记事本也会 —— 而 Windows 用户按教程用 PowerShell 写配置,撞上的就是这个。
    // JSON.parse 对 BOM 是直接抛错,消息还是"意外的记号",没法自己看出来。
    return { ok: true, settings: JSON.parse(text.replace(/^﻿/, '')) as SettingsFile };
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
 * 第一次跑必然撞上这里,所以它得让人照着做就能过。四条缺一不可:
 * 去哪个文件、直接能抄的内容、有哪些家可选、以及密钥是明文这个事实。
 */
function firstRunGuidance(home: string, providerId: string): string {
  const defaultModel = DEFAULT_MODELS[providerId];
  const known = KNOWN_PROVIDERS.includes(providerId);

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
    ...(defaultModel
      ? [
          `model 不填就是 ${defaultModel},接口地址不填就是 ${DEFAULT_BASE_URLS[providerId]}。`,
          '要用自建中转或本地网关,在同层加一行 "baseUrl"。',
          '',
          `每家可以各配各的代理(国产模型多半不需要,Claude 多半必须有),` +
            '在同层加一行 "proxy",写法 http://主机:端口。',
        ]
      : [`provider 只认 ${KNOWN_PROVIDERS.join('、')},请填其中之一。`]),
    '',
    '三家可以在同一份配置里共存,切换只改最上面那一行 "provider":',
    `  ${known ? KNOWN_PROVIDERS.filter((id) => id !== providerId).join(' / ') : KNOWN_PROVIDERS.join(' / ')}`,
    '',
    '也可以不动文件,改用环境变量(它会压过文件):',
    '  HCODE_PROVIDER / HCODE_API_KEY / HCODE_MODEL / HCODE_BASE_URL / HCODE_PROXY / HCODE_THINKING',
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
  const proxy = env['HCODE_PROXY'] ?? entry.proxy;
  const thinking = parseBoolean(env['HCODE_THINKING']) ?? entry.thinking;

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
      ...(proxy ? { proxy } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
    },
  };
}


/**
 * skill 的搜索根目录,按优先级排列。
 *
 * 项目级排在用户级前面,`.claude` 排在 `.hcode` 后面 —— 两个顺序都是刻意的:
 * 前者让项目里的 skill 能盖住全局那份,后者让 hcode 自己的目录压过兼容目录。
 * 从别的工具迁过来的 skill 放在 `.claude/skills` 下就能直接用,不必改写。
 */
export function skillRoots(): string[] {
  const home = homedir();
  const cwd = process.cwd();

  return [
    join(cwd, '.hcode', 'skills'),
    join(cwd, '.claude', 'skills'),
    join(home, '.hcode', 'skills'),
    join(home, '.claude', 'skills'),
  ];
}
