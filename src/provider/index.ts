import type { Provider } from './types.js';
import { createHttpTransport } from './transport.js';
import { createGlmProvider } from './glm.js';
import { createDeepSeekProvider } from './deepseek.js';
import { createClaudeProvider } from './claude.js';

/**
 * 从配置里挑一家,造出对应的适配器。
 *
 * 形状与 `cli/config.ts` 的 `Session` 一致,但**不 import 它** —— 依赖方向是
 * cli 依赖 provider,反过来就成了环。这里要的只是几个字符串,没必要为此把两层
 * 焊在一起。
 */
export type ProviderChoice = {
  providerId: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
  proxy?: string;
  thinking?: boolean;
};

const KNOWN = ['glm', 'deepseek', 'claude'] as const;

export function createProvider(choice: ProviderChoice): Provider {
  // 每家各造一个 transport,代理就挂在上面。这不是省事,是刻意的:代理是**这一家**
  // 的属性,不是进程的属性。见 cli/config.ts 里 proxy 那条注释。
  const transport = choice.proxy ? createHttpTransport({ proxy: choice.proxy }) : undefined;

  const shared = {
    apiKey: choice.apiKey,
    model: choice.model,
    ...(choice.baseUrl ? { baseUrl: choice.baseUrl } : {}),
    ...(transport ? { transport } : {}),
  };

  const thinking = choice.thinking !== undefined ? { enabled: choice.thinking } : undefined;

  switch (choice.providerId) {
    case 'glm':
      return createGlmProvider({ ...shared, ...(thinking ? { thinking } : {}) });
    case 'deepseek':
      return createDeepSeekProvider({ ...shared, ...(thinking ? { thinking } : {}) });
    case 'claude':
      return createClaudeProvider({ ...shared, ...(thinking ? { thinking } : {}) });
    default:
      // 走到这里说明配置里的 provider 是不认识的值。报错要把认得的名字列出来,
      // 否则用户只能猜。
      throw new Error(
        `不认识的 provider:${choice.providerId}。可填的有:${KNOWN.join('、')}。`,
      );
  }
}
