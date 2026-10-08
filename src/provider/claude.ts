import type {
  Message,
  Provider,
  ProviderRequest,
  ProviderResponse,
  ThinkingConfig,
} from './types.js';
import { createHttpTransport, type Transport } from './transport.js';

export type ClaudeConfig = {
  apiKey: string;
  model: string;
  baseUrl?: string;
  transport?: Transport;
  /**
   * 单次回复的 token 上限。Anthropic 的 `max_tokens` 是**必填**的 —— 别家不填
   * 有厂商默认值,它不填直接 400。所以这里必须有一个默认,不能留空。
   */
  maxTokens?: number;
  /**
   * 关掉 prompt caching。默认开。
   *
   * 系统提示与工具声明每一轮都一模一样,而它们在 Anthropic 那边是计费的输入
   * token。缓存下来省的是真金白银,代价是首次写入按 1.25 倍计费 —— 对"一句话就
   * 退出"的用法会略亏,对真正的编码会话是大赚。
   */
  cache?: boolean;
  /**
   * Extended thinking。默认关。
   *
   * 开它和别家不一样:Anthropic 要求上一轮模型产出的 thinking 块必须在下一轮里
   * 原封不动地送回去,少一块就 400。这就是 `vendorState` 存在的理由 —— 适配器
   * 把整条原始 content 数组存进去,下一轮原样拿出来用。
   */
  thinking?: ThinkingConfig;
};

/** Anthropic 的默认端点。 */
export const CLAUDE_DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** 必须带,否则接口直接拒绝。 */
export const CLAUDE_API_VERSION = '2023-06-01';

/** Anthropic 不给默认值,得我们给一个。 */
export const CLAUDE_DEFAULT_MAX_TOKENS = 8_192;

/** 思维链预算至少留这么多,否则模型还没想完就被 max_tokens 截断。 */
const MIN_THINKING_BUDGET = 1_024;

type CacheControl = { type: 'ephemeral' };

type WireBlock =
  | { type: 'text'; text: string; cache_control?: CacheControl }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

type WireMessage = { role: 'user' | 'assistant'; content: WireBlock[] };

const CACHE: CacheControl = { type: 'ephemeral' };

/**
 * 把一条内部消息翻成 Anthropic 的形状。
 *
 * 三处与 chat completions 不同,全在这一段里:
 * - assistant 的工具调用是 content 里的一种**块**,不是消息上的一个字段;
 * - 工具结果是装在 **user 消息**里的 `tool_result` 块 —— 不是独立的 tool 角色;
 * - 一次 tool 消息里的多个结果合成**同一条** user 消息(并行调用要一次答完)。
 */
function toWireMessage(message: Message): WireMessage | null {
  switch (message.role) {
    case 'user':
      return { role: 'user', content: [{ type: 'text', text: message.text }] };

    case 'assistant': {
      // 开了 thinking 之后,厂商要求上一轮的原话原封不动地回去 —— 连我们自己写
      // 的 text 都不如它给的那一份准。所以有续接材料就直接用它。
      if (Array.isArray(message.vendorState)) {
        return { role: 'assistant', content: message.vendorState as WireBlock[] };
      }

      const content: WireBlock[] = [];
      if (message.text) content.push({ type: 'text', text: message.text });
      for (const call of message.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
      }
      // 空 content 数组是接口错误。真出现(既没文本也没工具)就整条丢掉,
      // 比发过去被 400 顶回来强。
      return content.length > 0 ? { role: 'assistant', content } : null;
    }

    case 'tool':
      return {
        role: 'user',
        content: message.results.map((result) => ({
          type: 'tool_result' as const,
          tool_use_id: result.id,
          content: result.output,
        })),
      };
  }
}

/**
 * 相邻的同角色消息合成一条。
 *
 * 不合并会踩两个坑:一次 assistant 只发了文本、紧接着又有一轮工具调用,就会连着
 * 两条 assistant;而 Anthropic 对消息角色的要求比 chat completions 严。
 */
function mergeAdjacent(messages: WireMessage[]): WireMessage[] {
  const merged: WireMessage[] = [];
  for (const message of messages) {
    const last = merged[merged.length - 1];
    if (last && last.role === message.role) last.content.push(...message.content);
    else merged.push({ ...message, content: [...message.content] });
  }
  return merged;
}

function thinkingBody(
  thinking: ThinkingConfig | undefined,
  maxTokens: number,
): Record<string, unknown> {
  if (!thinking?.enabled) return {};

  // budget 必须小于 max_tokens,否则接口报错。留出至少 MIN_THINKING_BUDGET 给
  // 正式回答,不然模型想完了却没额度说话,回一个空消息。
  const requested = thinking.budgetTokens ?? Math.floor(maxTokens / 2);
  const ceiling = maxTokens - MIN_THINKING_BUDGET;
  return {
    thinking: {
      type: 'enabled',
      budget_tokens: Math.max(MIN_THINKING_BUDGET, Math.min(requested, ceiling)),
    },
  };
}

function buildBody(config: ClaudeConfig, request: ProviderRequest): string {
  const maxTokens = config.maxTokens ?? CLAUDE_DEFAULT_MAX_TOKENS;
  const useCache = config.cache !== false;

  const body: Record<string, unknown> = {
    model: config.model,
    // 必填,而且和别家的默认值不是一回事。
    max_tokens: maxTokens,
    // system 在 Anthropic 这里是**顶层参数**,不是消息数组里的第一条。
    system: useCache
      ? [{ type: 'text', text: request.system, cache_control: CACHE }]
      : request.system,
    messages: mergeAdjacent(
      request.messages.map(toWireMessage).filter((m): m is WireMessage => m !== null),
    ),
    ...thinkingBody(config.thinking, maxTokens),
  };

  if (request.tools.length > 0) {
    body['tools'] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      // 名字也不同:这边叫 input_schema,不是 parameters。
      input_schema: tool.inputSchema,
    }));
  }

  if (useCache) {
    // 缓存断点打在最后一条消息的最后一个块上。Anthropic 的缓存是"从头到断点"的
    // 前缀,所以这一处就把整段对话都盖住了;每轮新增的尾巴会在下一轮命中。
    // 加上 system 那一处,一共两个断点 —— 上限是四个,够用且不浪费。
    const last = body['messages'] as WireMessage[] | undefined;
    const lastBlock = last?.[last.length - 1]?.content.at(-1);
    if (lastBlock) (lastBlock as { cache_control?: CacheControl }).cache_control = CACHE;
  }

  return JSON.stringify(body);
}

/** 厂商回给我们的形状。与厂商的边界,由 fixtures/ 里的录制印证。 */
type WireReply = {
  content?: WireBlock[];
  stop_reason?: string | null;
};

function parseReply(parsed: unknown): ProviderResponse {
  const reply = parsed as WireReply;
  const content = reply.content ?? [];

  const text = content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('');

  const toolCalls = content
    .filter(
      (block): block is { type: 'tool_use'; id: string; name: string; input: unknown } =>
        block.type === 'tool_use',
    )
    .map((block) => ({ id: block.id, name: block.name, input: block.input }));

  return {
    text: text.length > 0 ? text : null,
    toolCalls,
    // 原样存下整条 content —— 里面可能有 thinking 块,下一轮必须一字不差地回去。
    vendorState: content,
  };
}

export function createClaudeProvider(config: ClaudeConfig): Provider {
  const transport = config.transport ?? createHttpTransport();
  const baseUrl = (config.baseUrl ?? CLAUDE_DEFAULT_BASE_URL).replace(/\/+$/, '');

  return {
    id: 'claude',
    model: config.model,

    async send(request: ProviderRequest): Promise<ProviderResponse> {
      const response = await transport({
        url: `${baseUrl}/v1/messages`,
        headers: {
          'content-type': 'application/json',
          // 这边是 x-api-key,不是 Authorization: Bearer。
          'x-api-key': config.apiKey,
          'anthropic-version': CLAUDE_API_VERSION,
        },
        body: buildBody(config, request),
      });

      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `Anthropic 接口返回 HTTP ${response.status}(模型 ${config.model}):${response.body}`,
        );
      }

      return parseReply(JSON.parse(response.body));
    },
  };
}
