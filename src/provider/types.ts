/** 对话中的一条消息。 */
export type Message =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string | null; toolCalls?: ToolCallRequest[] }
  | { role: 'tool'; results: ToolResult[] };

/** 模型要求执行一次工具调用。 */
export type ToolCallRequest = {
  id: string;
  name: string;
  input: unknown;
};

/** 一次工具调用的执行结果,回喂给模型。 */
export type ToolResult = {
  id: string;
  output: string;
};

/** 一个工具对模型呈现的样子。 */
export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ProviderRequest = {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
};

export type ProviderResponse = {
  text: string | null;
  toolCalls: ToolCallRequest[];
};

/**
 * Harness 借以触达某一家模型 API 的缝。一个厂商一个实现。
 *
 * caching 与 thinking 是**构造时**的配置,不在请求里。它们是模型配置而非每轮
 * 变化的东西;而且各家做法不同(Anthropic 要给内容块打 cache_control 标记),
 * 那属于实现,不该让调用方知道。见 ADR-0004。
 *
 * 错误模式:厂商的原始错误直接抛出,不归一成通用错误 —— 调用方需要看到
 * "余额不足"与"参数不支持"的区别。
 */
export interface Provider {
  readonly id: string;
  readonly model: string;
  send(request: ProviderRequest): Promise<ProviderResponse>;
}
