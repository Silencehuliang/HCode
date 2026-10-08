import type { Message, Provider, ProviderRequest, ProviderResponse } from './types.js';
import { fetchTransport, type Transport } from './transport.js';

export type GlmConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  transport?: Transport;
};

/** 智谱开放平台的默认端点。 */
export const GLM_DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';

/** 线格式里的一条消息。厂商的形状,不是我们的类型 —— 不往 core 泄漏。 */
type WireMessage = Record<string, unknown>;

/**
 * 我们的一条消息可能展开成多条线格式消息:一次 `tool` 消息里装着的多个工具结果,
 * 到了线格式上必须是各自独立的一条。
 */
function toWireMessages(message: Message): WireMessage[] {
  switch (message.role) {
    case 'user':
      return [{ role: 'user', content: message.text }];

    case 'assistant': {
      const wire: WireMessage = { role: 'assistant', content: message.text ?? '' };
      if (message.toolCalls && message.toolCalls.length > 0) {
        wire['tool_calls'] = message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        }));
      }
      return [wire];
    }

    case 'tool':
      return message.results.map((result) => ({
        role: 'tool',
        tool_call_id: result.id,
        content: result.output,
      }));
  }
}

function buildRequestBody(config: GlmConfig, request: ProviderRequest): string {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: 'system', content: request.system },
      ...request.messages.flatMap(toWireMessages),
    ],
  };

  // 空数组不发给厂商 —— 有的接口会把它当成"声明了工具但一个都没有"而报错。
  if (request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  return JSON.stringify(body);
}

/**
 * 厂商回给我们的形状。这里是**唯一**允许把 JSON 当成已知类型的地方 —— 它是与
 * 厂商的边界,形状由 fixtures/ 里录制下来的真实响应印证,编译器无从验证。
 */
type WireReply = {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: {
        id: string;
        function: { name: string; arguments: string };
      }[];
    };
  }[];
};

function parseReply(parsed: WireReply): ProviderResponse {
  const message = parsed.choices?.[0]?.message;

  return {
    // 空串与"没有文本"是同一件事。留着空串会让对话里多出一条无意义的
    // assistant 文本,而它下一轮还要被原样发回厂商。
    text: message?.content ? message.content : null,

    // arguments 在线上是 JSON 字符串。工具拿到字符串而不是对象,就不得不自己
    // 再解析一次 —— 那属于线格式的处置,不该外泄给工具。
    toolCalls: (message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      input: JSON.parse(call.function.arguments) as unknown,
    })),
  };
}

export function createGlmProvider(config: GlmConfig): Provider {
  const transport = config.transport ?? fetchTransport;
  const baseUrl = (config.baseUrl ?? GLM_DEFAULT_BASE_URL).replace(/\/+$/, '');

  return {
    id: 'glm',
    model: config.model,

    async send(request: ProviderRequest): Promise<ProviderResponse> {
      const response = await transport({
        url: `${baseUrl}/chat/completions`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: buildRequestBody(config, request),
      });

      // 厂商的报错原样抛出,不归一成通用错误。"模型不存在"、"余额不足"、
      // "参数不支持"对用户是三种不同的下一步,压成一句就全丢了。
      // 见 ADR-0004 与规格第 38 条用户故事。
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `GLM 接口返回 HTTP ${response.status}(模型 ${config.model}):${response.body}`,
        );
      }

      return parseReply(JSON.parse(response.body) as WireReply);
    },
  };
}
