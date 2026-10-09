import type { Tool } from '../core/tool.js';
import type { AgentCatalog, AgentDef } from '../core/agents.js';
import { runSubagent } from '../core/subagent.js';
import { createToolset } from '../core/toolset.js';
import type { Provider } from '../provider/types.js';

function asText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what} 要是一句非空的说明`);
  }
  return value;
}

export type TaskDeps = {
  provider: Provider;
  /** 缺省(不指定角色)时子 agent 手上的工具 —— 只读探查那几个。 */
  tools: Tool[];
  /** 缺省角色使用的系统提示。 */
  system: string;
  maxTurns?: number;
  /** 角色注册表。给了才支持按名派发;不给则 task 只有旧行为。 */
  agents?: AgentCatalog;
  /** 角色工具白名单的取材范围(主对话全量工具,含 todo 等)。 */
  allTools?: Tool[];
};

/**
 * 按角色定义解析出装配材料。
 *
 * 导出来是因为它是"角色文件 → 子 agent"这条路的全部语义所在,值得独立测;
 * 里面每一条选择(白名单缺省继承、剥 task、找不到角色怎么报)都是行为,不是实现细节。
 */
export function resolveAgentRun(
  deps: TaskDeps,
  name: string,
): { system: string; tools: Tool[]; def: AgentDef } | { error: string } {
  if (!deps.agents) {
    return { error: `没有名为 ${name} 的角色:这个会话没有启用角色目录。` };
  }

  const def = deps.agents.get(name);
  if (!def) {
    const available = deps.agents.list().map((agent) => agent.name);
    return {
      error:
        available.length === 0
          ? `没有名为 ${name} 的角色,而且一个角色都没找到。把角色文件放在 .hcode/agents/<名>.md。`
          : `没有名为 ${name} 的角色。可用的是:${available.join('、')}`,
    };
  }

  let tools: Tool[];
  if (def.tools) {
    // 白名单里写了主对话不认识的工具名 —— 过滤掉,但不能静默:角色作者写的名字
    // 没生效,派出去的 agent 会缺胳膊少腿,用户查不出来是哪份文件的问题。
    const byName = new Map((deps.allTools ?? deps.tools).map((tool) => [tool.spec.name, tool]));
    const unknown = def.tools.filter((name) => !byName.has(name));
    if (unknown.length > 0) {
      return {
        error: `角色 ${name} 的 tools 里有些工具不存在:${unknown.join('、')}。可用工具:${[...byName.keys()].join('、')}`,
      };
    }
    tools = def.tools.map((toolName) => byName.get(toolName)!);
  } else {
    // 缺省 = 继承主对话工具集,但剥掉 task 自己 —— 递归派发是 v2-09 的议题,
    // 在那之前子 agent 能再派子 agent 就是无限套娃,每一层的轮次上限都拦不住。
    tools = (deps.allTools ?? deps.tools).filter((tool) => tool.spec.name !== 'task');
  }

  return { system: def.systemPrompt, tools, def };
}

/**
 * 把一次探查委派出去的工具。
 *
 * 不传 `agent` 时是旧行为:派只读探查者。传了则按注册表装配 —— 系统提示、
 * 工具集都来自角色文件(模型绑定归 v2-03,现在一律用主对话的 Provider)。
 *
 * 它返回的是子 agent 最后那段话,**没有别的**。这是这个工具的全部意义:主对话
 * 只多出"派出去"和"结论"两条消息,子 agent 翻了八十个文件也好、一个也没找到也
 * 好,占的位置都一样。
 */
export function createTaskTool(deps: TaskDeps): Tool {
  const agentHint = deps.agents
    ? `可用角色:${deps.agents.list().map((agent) => `${agent.name}(${agent.description})`).join(';')}。`
    : '';

  return {
    spec: {
      name: 'task',
      description: [
        '把一次需要翻很多地方的探查委派给一个子 agent,只拿回它的结论。',
        '什么时候用它:当你要做的事会读进大量原文,而你只需要其中的结论 —— ',
        '比如"这个功能在哪些地方被用到"、"这个报错是从哪冒出来的"。',
        '什么时候别用:你知道确切位置(直接 read_file)、你本来就需要那些原文(那把它读进主对话才对)。',
        '子 agent 看不到这段对话,你交代的上下文是它唯一的信息来源。',
        ...(agentHint ? [agentHint] : []),
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description: '派哪个角色(按名)。不传则派只读探查者。',
          },
          description: { type: 'string', description: '三五个字说明这次派出去做什么,给用户看的' },
          prompt: {
            type: 'string',
            description: '交给子 agent 的完整交代:要查什么、查到什么程度算完、结论要包含哪些东西',
          },
          context: {
            type: 'string',
            description:
              '子 agent 需要的背景(它在哪个仓库干活、相关约定、已经知道的事实)。子 agent 冷启动,这段背景写薄了它会乱翻。',
          },
        },
        required: ['description', 'prompt'],
      },
    },

    async run(input, context) {
      const { agent, description, prompt, context: background } = (input ?? {}) as Record<string, unknown>;
      const label = asText(description, 'description');
      const body = asText(prompt, 'prompt');

      let system = deps.system;
      let tools = deps.tools;

      if (typeof agent === 'string' && agent.trim() !== '') {
        const resolved = resolveAgentRun(deps, agent.trim());
        if ('error' in resolved) {
          return resolved.error;
        }
        system = resolved.system;
        tools = resolved.tools;
      }

      // context 拼在 prompt 前面 —— 委派 prompt 是子 agent 唯一的入向通道,
      // 背景与任务分开传,拼起来给它,让它一眼分清"环境"与"要做的事"。
      const delegated =
        typeof background === 'string' && background.trim() !== ''
          ? `背景:\n${background.trim()}\n\n任务:\n${body}`
          : body;

      try {
        return await runSubagent(
          {
            provider: deps.provider,
            tools: createToolset(tools),
            system,
            ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
          },
          delegated,
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
