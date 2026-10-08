/**
 * 启动时要显示的几段文字,以及"这个平台能不能跑"的判断。
 *
 * 单独放一个模块,是因为 `main.ts` 在模块顶层就跑 `await main()` —— 任何
 * `import` 它的测试都会把整个 CLI 启动一遍。这几段文字是纯函数,值得直接测;
 * 而它们在 main.ts 里时,一个测试都写不了。
 */
import type { Session } from './config.js';

/**
 * 会话横幅。当前用的是哪家 Provider、哪个模型必须一眼看得到 —— 用户不该在
 * 以为用的是 GLM 时实际跑在别的地方。接口地址也亮出来:自建中转与本地网关
 * 看地址才知道生效没有。
 *
 * 代理只说"有没有、连哪",不说凭据 —— 代理地址里带的用户名密码是要保密的,
 * 而 `http://用户:密码@主机:端口` 这种写法很常见。见 transport.ts 的 parseProxy。
 *
 * 密钥不在这里,也不在任何输出里。
 */
export function banner(session: Session, extra: readonly string[]): string {
  return [
    '',
    `hcode · ${session.providerId} / ${session.model}`,
    `接口:${session.baseUrl ?? '(厂商默认)'}`,
    ...(session.proxy ? [`代理:${redactProxy(session.proxy)}`] : []),
    ...(session.thinking !== undefined ? [`思维链:${session.thinking ? '开' : '关'}`] : []),
    ...extra,
    '',
    '/exit 退出,Ctrl+C 中断正在跑的命令。',
    '',
  ].join('\n');
}

/** 把代理地址里的凭据换成 `***`。它出现在屏幕上,而屏幕会被截图、会被贴进 issue。 */
export function redactProxy(proxy: string): string {
  try {
    const url = new URL(proxy);
    if (url.username || url.password) {
      url.username = '***';
      url.password = '';
    }
    return url.toString();
  } catch {
    // 地址本来就写坏了 —— 原样显示,让用户自己看出问题在哪,总比藏起来好。
    return proxy;
  }
}

/**
 * 非 Windows 平台上的说明。返回 undefined 表示可以继续。
 *
 * v1 的 `run_command` 交给 `powershell.exe`,而这个程序只有 Windows 才有。
 * 不说这一句的话,用户会看到会话正常启动,然后每次让模型干活都得到一条
 * "spawn powershell.exe ENOENT",而模型会拿着这句话一遍遍换写法重试。
 *
 * 另有一道 `package.json` 的 `os: ["win32"]`,让 `npm i -g` 直接在非 Windows
 * 上就拒绝。这道是给"从源码跑"和"装了包再换平台"的情形兜底的。
 */
export function platformRefusal(platform: string): string | undefined {
  if (platform === 'win32') return undefined;
  return [
    `hcode 目前只能在 Windows 上运行(当前平台:${platform})。`,
    '',
    '它执行的命令交给 Windows PowerShell(powershell.exe),别处没有这个程序。',
    '在别的平台上,会话能启动,但每一次命令调用都会失败。',
  ].join('\n');
}
