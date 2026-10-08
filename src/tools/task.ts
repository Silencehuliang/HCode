import type { Tool } from '../core/tool.js';
import { runSubagent } from '../core/subagent.js';
import { createToolset } from '../core/toolset.js';
import type { Provider } from '../provider/types.js';

function asText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what} 要是一句非空的说明`);
  }
  return value;
}

/**
 * 把一次探查委派出去的工具。
 *
 * 它返回的是子 agent 最后那段话,**没有别的**。这是这个工具的全部意义:主对话
 * 只多出"派出去"和"结论"两条消息,子 agent 翻了八十个文件也好、一个也没找到也
 * 好,占的位置都一样。
 */
export function createTaskTool(deps: {
  provider: Provider;
  /** 子 agent 手上的工具。由调用方决定它能做什么 —— 通常只给只读的那几个。 */
  tools: Tool[];
  system: string;
  maxTurns?: number;
}): Tool {
  return {
    spec: {
      name: 'task',
      description: [
        '把一次需要翻很多地方的探查委派给一个只读的子 agent,只拿回它的结论。',
        '什么时候用它:当你要做的事会读进大量原文,而你只需要其中的结论 —— ',
        '比如"这个功能在哪些地方被用到"、"这个报错是从哪冒出来的"。',
        '什么时候别用:你知道确切位置(直接 read_file)、你要改文件(子 agent 只能读)、',
        '或者你本来就需要那些原文(那把它读进主对话才对)。',
        '子 agent 看不到这段对话。要把它需要的东西在 prompt 里说全。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: '三五个字说明这次派出去做什么,给用户看的' },
          prompt: {
            type: 'string',
            description: '交给子 agent 的完整交代:要查什么、查到什么程度算完、结论要包含哪些东西',
          },
        },
        required: ['description', 'prompt'],
      },
    },

    async run(input, context) {
      const { description, prompt } = (input ?? {}) as Record<string, unknown>;
      const label = asText(description, 'description');
      const body = asText(prompt, 'prompt');

      try {
        return await runSubagent(
          {
            provider: deps.provider,
            tools: createToolset(deps.tools),
            system: deps.system,
            ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
          },
          body,
          context?.signal,
        );
      } catch (error) {
        // 子任务失败必须回到主对话。否则模型只知道"没有结论",无从判断该重派、
        // 该换个提示,还是该自己来做 —— 它会原地重派一次,然后第二次也失败。
        return `子任务「${label}」失败了,没有拿到结论。错误原文:${(error as Error).message}`;
      }
    },
  };
}
