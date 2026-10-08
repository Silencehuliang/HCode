import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
  ThinkingConfig,
} from './types.js';
import { createHttpTransport, type Transport } from './transport.js';
import {
  buildChatCompletionsBody,
  parseChatCompletionsReply,
} from './chat-completions.js';

export type DeepSeekConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  transport?: Transport;
  /**
   * 思维链开关。
   *
   * 注意:这一条**没有**对着 DeepSeek 官方端点验证过。本地网关认这个字段(实测
   * 给 disabled 后 `reasoning_content` 就没了),但 DeepSeek 自己的文档里思维链
   * 是按模型分的——`deepseek-reasoner` 出推理、`deepseek-chat` 不出——并没有一个
   * 请求体里的开关。等有真 key 时对着 api.deepseek.com 复核一遍;在那之前,不给
   * 这个参数就是各家的默认行为,不会出错。
   */
  thinking?: ThinkingConfig;
};

/** DeepSeek 开放平台的默认端点。注意它没有 `/v1` 之外的版本段。 */
export const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com';

function thinkingBody(thinking: ThinkingConfig | undefined): Record<string, unknown> {
  if (!thinking) return {};
  return { thinking: { type: thinking.enabled ? 'enabled' : 'disabled' } };
}

export function createDeepSeekProvider(config: DeepSeekConfig): Provider {
  const transport = config.transport ?? createHttpTransport();
  const baseUrl = (config.baseUrl ?? DEEPSEEK_DEFAULT_BASE_URL).replace(/\/+$/, '');

  return {
    id: 'deepseek',
    model: config.model,

    async send(request: ProviderRequest): Promise<ProviderResponse> {
      const response = await transport({
        url: `${baseUrl}/chat/completions`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: buildChatCompletionsBody(request, {
          model: config.model,
          extraBody: thinkingBody(config.thinking),
        }),
      });

      // 同 glm.ts:厂商的原始错误原样抛出。报错文案里带上厂商名,是因为用户可能
      // 在同一份配置里放了三家,而"是哪家回的话"决定了下一步该去改什么。
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `DeepSeek 接口返回 HTTP ${response.status}(模型 ${config.model}):${response.body}`,
        );
      }

      return parseChatCompletionsReply(JSON.parse(response.body));
    },
  };
}
