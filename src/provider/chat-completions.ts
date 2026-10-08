import type { Message, ProviderRequest, ProviderResponse } from './types.js';

/**
 * OpenAI 形状的 chat completions 线格式。
 *
 * 智谱与 DeepSeek 的原生接口**各自**都是这个形状 —— 这是它们恰好相同,不是我们
 * 把两家归一化到了这里。ADR-0004 禁掉的是"把 OpenAI 线格式当成我们的内部模型、
 * 前面再挂一个转换网关";这里没有网关,线格式仍然是各适配器自己的事。
 *
 * 抽出来是因为两份实现除了厂商名和地址之外逐字相同,而两份逐字相同的代码放在
 * 两个文件里,改一处忘一处是迟早的事。厂商特有的字段走 `extraBody` 原样并进请
 * 求体,所以 ADR-0004 要的"厂商特性必须可达"没有被这一层挡住。
 *
 * 真正形状不同的是 Anthropic(claude.ts):system 在顶层、工具结果装在 user 消息
 * 里、max_tokens 必填。它一行都不共用这里的代码,这本身就是对"这层没有变成最小
 * 公约数"的检验。
 */

/** 线格式里的一条消息。厂商的形状,不是我们的类型 —— 不往 core 泄漏。 */
type WireMessage = Record<string, unknown>;

/**
 * 我们的一条消息可能展开成多条线格式消息:一次 `tool` 消息里装着的多个工具结果,
 * 到了线格式上必须是各自独立的一条。
 */
export function toWireMessages(message: Message): WireMessage[] {
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

export type BuildBodyOptions = {
  model: string;
  /**
   * 厂商特有的顶层字段,原样并进请求体。智谱的 `thinking` 就走这里。它是这一层
   * 对"厂商特性可达"的让步 —— 新字段不必先改这个共享模块才能用上。
   */
  extraBody?: Record<string, unknown>;
};

export function buildChatCompletionsBody(
  request: ProviderRequest,
  options: BuildBodyOptions,
): string {
  const body: Record<string, unknown> = {
    model: options.model,
    messages: [
      { role: 'system', content: request.system },
      ...request.messages.flatMap(toWireMessages),
    ],
    ...options.extraBody,
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
 * 厂商回给我们的形状。这里是**唯一**允许把 JSON 当成已知类型的地方 —— 它是与厂
 * 商的边界,形状由 fixtures/ 里录制下来的真实响应印证,编译器无从验证。
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

export function parseChatCompletionsReply(parsed: unknown): ProviderResponse {
  const reply = parsed as WireReply;
  const message = reply.choices?.[0]?.message;

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
