import type { Message, Provider } from '../provider/types.js';
import type { Tool } from './tool.js';

export type LoopDeps = {
  provider: Provider;
  tools: Tool[];
  system: string;
};

/**
 * 跑一轮对话:反复调用模型、执行它要求的工具、把结果回喂,直到模型不再要求工具。
 *
 * 循环属于 Agent,机制属于 Harness —— 这里只有循环。
 */
export async function runTurn(
  deps: LoopDeps,
  messages: Message[],
): Promise<{ text: string | null }> {
  const conversation: Message[] = [...messages];
  const toolSpecs = deps.tools.map((tool) => tool.spec);

  for (;;) {
    const response = await deps.provider.send({
      system: deps.system,
      messages: conversation,
      tools: toolSpecs,
    });

    conversation.push({
      role: 'assistant',
      text: response.text,
      ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
    });

    if (response.toolCalls.length === 0) {
      return { text: response.text };
    }

    const results = [];
    for (const call of response.toolCalls) {
      const tool = deps.tools.find((candidate) => candidate.spec.name === call.name);
      if (!tool) throw new Error(`模型要求了不存在的工具:${call.name}`);
      results.push({ id: call.id, output: await tool.run(call.input) });
    }
    conversation.push({ role: 'tool', results });
  }
}
