import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderChoice } from '../provider/index.js';
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

export type ConfigOutcome =
  | {
      ok: true;
      session: Session;
      /**
       * 实际读到了哪几份配置文件,按优先级排列(压过别人的排前面)。
       *
       * 一个都不存在时是空数组 —— 全靠环境变量跑起来是正常情况,不是异常。
       */
      files: string[];
      /**
       * 每一家**配得出密钥**的 Provider,已按同一套环境变量规则解析成可直接
       * 构造的形状。角色按名换模型(v2-03)从这里取材;选中的那家与 session
       * 字段一致。凑不出密钥的家不出现 —— 出现一个构造不出来的条目,只会把
       * "回退主对话"这个动作变成一次运行时报错。
       */
      providers: Record<string, ProviderChoice>;
    }
  | { ok: false; message: string };

export type LoadOptions = {
  home?: string;
  /** 项目级配置的参照目录。默认取当前工作目录。 */
  cwd?: string;
  env?: Record<string, string | undefined>;
};

/** 没配置时按它给引导。国产模型优先 —— 这是这个项目存在的理由。 */
export const DEFAULT_PROVIDER = 'glm';

/** 用户级配置的落点。文档要写它,报错要说它,所以它得是一个能被引用的值。 */
export function settingsPath(home: string): string {
  return join(home, '.hcode', 'settings.json');
}

/**
 * 项目级配置的落点。给一个仓库单独指定 Provider / 密钥用,压过用户级。
 *
 * 它落在 `.hcode/` 里而不是仓库根目录,是为了一个 `.gitignore` 条目就能挡住 ——
 * 密钥写进项目配置是很容易发生的事,而它绝不能进版本库。
 */
export function projectSettingsPath(cwd: string): string {
  return join(cwd, '.hcode', 'settings.json');
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


/**
 * 每家能直接认出来的第三方环境变量。
 *
 * Claude 那一行是这条兼容的主体:已经配好 Claude Code 的人 `export` 过
 * `ANTHROPIC_API_KEY`,他敲 `hcode` 就该能跑,不需要先写一份 hcode 自己的配置文件。
 * 另外两家没有公认的既有名字(它们的官方 SDK 各用各的),这里按厂商自己的叫法取,
 * 顺带让 `set -a && . .env && set +a` 这种本地网关用法能直接用。
 */
const PROVIDER_ENV: Record<string, { apiKey: string[]; baseUrl: string[]; model: string[] }> = {
  glm: { apiKey: ['GLM_API_KEY'], baseUrl: ['GLM_BASE_URL'], model: ['GLM_MODEL'] },
  deepseek: {
    apiKey: ['DEEPSEEK_API_KEY'],
    baseUrl: ['DEEPSEEK_BASE_URL'],
    model: ['DEEPSEEK_MODEL'],
  },
  claude: {
    apiKey: ['ANTHROPIC_API_KEY'],
    baseUrl: ['ANTHROPIC_BASE_URL'],
    model: ['ANTHROPIC_MODEL'],
  },
};

/**
 * 按顺序取第一个**有值**的环境变量。
 *
 * 空串当作没设:`.env` 里留一行空的 `HCODE_PROVIDER=`(把某一行注释掉一半、
 * 或让用户自己填)是最常见的写法之一。把它当成一个真的值,会得到一个空字符串的
 * "provider",然后拿着一份空配置去引导用户 —— 而他明明配好了。
 */
function firstEnv(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

/** 这一家的密钥:通用变量 > 它自己的变量 > 配置文件。 */
function apiKeyFor(
  providerId: string,
  entry: ProviderSettings,
  env: Record<string, string | undefined>,
): string | undefined {
  return (
    firstEnv(env, ['HCODE_API_KEY']) ?? firstEnv(env, PROVIDER_ENV[providerId]?.apiKey ?? []) ?? entry.apiKey
  );
}

/**
 * 没人明说用哪家时,看手上真有哪家的钥匙。
 *
 * 按 `KNOWN_PROVIDERS` 的顺序(国产在前)取第一家。这个顺序是刻意的:顺手
 * `export` 过一个 `ANTHROPIC_API_KEY` 的人(跑 Claude Code 的人几乎都有)
 * 不该因此被带到国外模型上去,而他手上真要是有国产模型的钥匙,那才是他想用的。
 *
 * 返回 undefined 表示一家都凑不出钥匙 —— 那就退回默认那家,由引导去告诉他要配什么。
 */
function detectProvider(
  entries: Record<string, ProviderSettings>,
  env: Record<string, string | undefined>,
): string | undefined {
  for (const providerId of KNOWN_PROVIDERS) {
    if (apiKeyFor(providerId, entries[providerId] ?? {}, env)) return providerId;
  }
  return undefined;
}

type SettingsRead =
  | { ok: true; settings: SettingsFile; found: boolean }
  | { ok: false; message: string };

function readSettings(path: string): SettingsRead {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // 文件不存在是正常情况 —— 第一次跑就是这样,交给引导去告诉用户建它。
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, settings: {}, found: false };
    }
    return {
      ok: false,
      message: `配置文件读不了:\n\n  ${path}\n\n${(error as Error).message}`,
    };
  }

  try {
    // 去掉 UTF-8 BOM。PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写它,
    // 记事本也会 —— 而 Windows 用户按教程用 PowerShell 写配置,撞上的就是这个。
    // JSON.parse 对 BOM 是直接抛错,消息还是"意外的记号",没法自己看出来。
    return { ok: true, settings: JSON.parse(text.replace(/^﻿/, '')) as SettingsFile, found: true };
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
    '已经配好 Claude Code 的人不用建上面这个文件:',
    '  你有 ANTHROPIC_API_KEY,这个变量会被直接认出来,敲 hcode 就能跑。',
    '',
    '要给某一个项目单独配(不改全局),在那个项目的根目录建同名文件:',
    `  ${projectSettingsPath('<项目目录>')}  —— 它压过全局那一份。`,
    '',
    '注意:密钥以明文存在上面这个文件里,与 GitHub CLI、AWS CLI 一致。',
    '这个目录别提交进版本库(如果它在你负责的仓库里)。',
  ].join('\n');
}

/**
 * 找出第一个不能进 HTTP 头的字符。
 *
 * 头字段的值只能是 Latin-1。不在这里拦,Node 会在**发请求之前**抛
 * `Invalid character in header content ["x-api-key"]` —— 那句话里既没有"密钥"
 * 也没有位置,用户根本猜不到原因(常见来源:从网页或文档里粘密钥时带进一个全角
 * 字符或全角空格)。
 *
 * 检查放在读配置这里,是因为只有这里手上才有密钥,也才说得清是哪一个字符。
 */
function findNonLatin1(value: string): { at: number; char: string } | undefined {
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) > 0xff) return { at: i + 1, char: value[i] ?? '' };
  }
  return undefined;
}

/**
 * 密钥是从哪儿读来的。报错时说清出处,用户才知道该去改哪一份 ——
 * 否则他会在配置文件里翻半天,而密钥其实来自一个很久以前 export 过的变量。
 */
function describeKeySource(
  providerId: string,
  entry: ProviderSettings,
  env: Record<string, string | undefined>,
  files: readonly string[],
): string {
  if (firstEnv(env, ['HCODE_API_KEY'])) return '环境变量 HCODE_API_KEY';
  const names = PROVIDER_ENV[providerId]?.apiKey ?? [];
  if (firstEnv(env, names)) return `环境变量 ${names.join(' / ')}`;
  if (entry.apiKey) return files.join('  →  ');
  return '(来路不明,请检查 HCODE_API_KEY 与配置文件)';
}

export function loadConfig(options: LoadOptions = {}): ConfigOutcome {
  const home = options.home ?? homedir();
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;

  // 按优先级从高到低列出要读的文件。项目级在前 —— 一个仓库可以覆盖全局设置。
  // 按路径去重:home 恰好就是 cwd 时(有人喜欢在项目里开一个 home)别读两遍。
  const paths = [...new Set([projectSettingsPath(cwd), settingsPath(home)])];

  const layers: { settings: SettingsFile }[] = [];
  const files: string[] = [];
  for (const path of paths) {
    const read = readSettings(path);
    // 任何一层坏了都直接报错。悄悄跳过坏掉的那一层,用户会看到自己写的设置
    // 一部分生效一部分不生效,而没有任何线索说明为什么。
    if (!read.ok) return { ok: false, message: read.message };
    if (read.found) files.push(path);
    layers.push({ settings: read.settings });
  }

  // 合并顺序与优先级相反:从最低的一层往上铺,高的盖住低的。
  // 逐字段铺,不是整份替换 —— 项目级只想改密钥时,不必把 model 也抄一遍。
  const entries: Record<string, ProviderSettings> = {};
  for (const layer of [...layers].reverse()) {
    for (const [id, entry] of Object.entries(layer.settings.providers ?? {})) {
      entries[id] = { ...entries[id], ...entry };
    }
  }

  // 明说的排前面:环境变量 > 项目级 > 用户级 > 自动探测 > 默认。
  // 环境变量压过文件,是为了让"这一次跑用另一份凭据"不需要改动落在盘上的东西 ——
  // CI 与临时切换都依赖这一点。
  const chosen =
    firstEnv(env, ['HCODE_PROVIDER']) ??
    layers.find((layer) => layer.settings.provider)?.settings.provider ??
    detectProvider(entries, env) ??
    DEFAULT_PROVIDER;

  const entry = entries[chosen] ?? {};
  const apiKey = apiKeyFor(chosen, entry, env);
  const model =
    firstEnv(env, ['HCODE_MODEL']) ?? firstEnv(env, PROVIDER_ENV[chosen]?.model ?? []) ?? entry.model ?? DEFAULT_MODELS[chosen];
  const baseUrl =
    firstEnv(env, ['HCODE_BASE_URL']) ?? firstEnv(env, PROVIDER_ENV[chosen]?.baseUrl ?? []) ?? entry.baseUrl;
  const proxy = firstEnv(env, ['HCODE_PROXY']) ?? entry.proxy;
  const thinking = parseBoolean(env['HCODE_THINKING']) ?? entry.thinking;

  if (!apiKey || !model) {
    return { ok: false, message: firstRunGuidance(home, chosen) };
  }

  const bad = findNonLatin1(apiKey);
  if (bad) {
    return {
      ok: false,
      message: [
        `密钥里第 ${bad.at} 个字符是「${bad.char}」,它不是 ASCII 字符。`,
        '',
        '密钥要放进 HTTP 请求头,而请求头只装得下 ASCII —— 这一条过不去,',
        '连请求都发不出去。多半是从网页或文档里复制时带进了全角字符或全角空格,',
        '把它删掉、或者重新复制一遍纯文本的密钥。',
        '',
        `密钥来自:${describeKeySource(chosen, entry, env, files)}`,
      ].join('\n'),
    };
  }

  // 每一家都按与选中那家相同的规则解析(通用的 HCODE_* 只作用于选中的那家 ——
  // 它们说的是"这一次跑用哪家",不是"这一家永远用什么")。凑不出密钥的跳过。
  const providers: Record<string, ProviderChoice> = {};
  for (const id of KNOWN_PROVIDERS) {
    const entry = entries[id] ?? {};
    const key = apiKeyFor(id, entry, env);
    if (!key) continue;
    const m = firstEnv(env, PROVIDER_ENV[id]?.model ?? []) ?? entry.model ?? DEFAULT_MODELS[id] ?? 'unknown';
    const bu = firstEnv(env, PROVIDER_ENV[id]?.baseUrl ?? []) ?? entry.baseUrl;
    const px = entry.proxy;
    const th = entry.thinking;
    providers[id] = {
      providerId: id,
      model: m,
      apiKey: key,
      ...(bu ? { baseUrl: bu } : {}),
      ...(px ? { proxy: px } : {}),
      ...(th !== undefined ? { thinking: th } : {}),
    };
  }

  // 选中的那家以 session 的解析结果为准 —— 它多吃了一层通用 HCODE_* 覆盖,
  // 直接用循环里的那份会出现"主对话一个模型、角色引用同名家却是另一个模型"。
  providers[chosen] = {
    providerId: chosen,
    model,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(proxy ? { proxy } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };

  return {
    ok: true,
    files,
    providers,
    session: {
      providerId: chosen,
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
