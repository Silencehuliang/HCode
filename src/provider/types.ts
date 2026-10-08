/** 对话中的一条消息。 */
export type Message =
  | { role: 'user'; text: string }
  | {
      role: 'assistant';
      text: string | null;
      toolCalls?: ToolCallRequest[];
      /**
       * 适配器私有的续接材料:适配器写进去,下一轮由适配器读回来,core 只负责
       * 原样带着它走,从不读它。
       *
       * 需要这么个格子,是因为有的厂商要求"上一轮模型的原话"必须在下一轮里原封
       * 不动地出现 —— Anthropic 开了 extended thinking 之后就是这样,少一块就报
       * 400。core 既不该知道 thinking 这个概念,也不该把它弄丢,于是给它一个不透
       * 明的格子。它是 `unknown`,不是 `Thinking`,这就是"不泄漏"的落地方式。
       */
      vendorState?: unknown;
    }
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
  /** 见 `Message` 里 assistant 的 `vendorState`:本轮产出、下一轮原样送回的续接材料。 */
  vendorState?: unknown;
};

/**
 * 思维链的开与关。在构造 Provider 时给,不在请求里 —— 它不是每轮变化的东西,
 * 而且各家开关方式不同(智谱是请求体里一个 `thinking` 字段,Anthropic 是顶层
 * 参数且要配 `budget_tokens`)。概念只有这一个,形状由各适配器自己决定。
 */
export type ThinkingConfig = {
  enabled: boolean;
  /** 思维链最多花多少 token。不给就由适配器按自己的上限取一个合理值。 */
  budgetTokens?: number;
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
