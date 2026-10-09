import type { Tool } from '../core/tool.js';
import { parseModelBinding, type AgentCatalog, type AgentDef } from '../core/agents.js';
import { runSubagent } from '../core/subagent.js';
import { createToolset } from '../core/toolset.js';
import { guardToolsetForAgent, isZeroBlastRadius, parseAgentRestriction } from '../core/permission.js';
import type { AgentRestriction } from '../core/permission.js';
import type { Provider } from '../provider/types.js';

function asText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what} 要是一句非空的说明`);
  }
  return value;
}

export type TaskDeps = {
  provider: Provider;
  /**
   * 角色按名换模型(v2-03):给一个 provider id,造出那一家的实例。
   * 不给(或返回 undefined)时,角色一律用主对话的 Provider —— 这也是
   * `model` 字段缺省、或指向配不出密钥那家时的回退行为。
   */
  providerFor?: (id: string) => Provider | undefined;
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
): {
  system: string;
  tools: Tool[];
  def: AgentDef;
  restriction?: AgentRestriction;
  provider?: Provider;
} | { error: string } {
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

  // read-only 在装配层就剥掉写作/执行类工具:模型看不见,比运行时拦干净 ——
  // 它不会一轮轮白试 write_file 再被拒。这不是安全边界(那在 guardToolsetForAgent),
  // 是省掉注定失败的尝试。
  const restriction = parseAgentRestriction(def.permission);
  const visible = restriction === 'read-only'
    ? tools.filter((tool) => isZeroBlastRadius(tool.spec.name))
    : tools;

  // 模型绑定:解析得出就换到那一家的实例;解析不出(缺省)保持主对话的;
  // 指向的家配不出实例(providerFor 返回 undefined)也保持 —— 回退而不是报错,
  // 启动时的 stderr 警告已经说过这件事了。
  const binding = parseModelBinding(def.model);
  const provider =
    (binding ? deps.providerFor?.(binding.providerId) : undefined) ?? deps.provider;

  return {
    system: def.systemPrompt,
    tools: visible,
    def,
    provider,
    ...(restriction ? { restriction } : {}),
  };
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
      let restriction: AgentRestriction | undefined;
      let provider = deps.provider;
      // 统计行上的角色名:点名的用它,没点名就是缺省的探查者(内置 explorer)。
      let statAgent = 'explorer';

      if (typeof agent === 'string' && agent.trim() !== '') {
        const resolved = resolveAgentRun(deps, agent.trim());
        if ('error' in resolved) {
          return resolved.error;
        }
        system = resolved.system;
        tools = resolved.tools;
        restriction = resolved.restriction;
        provider = resolved.provider ?? deps.provider;
        statAgent = resolved.def.name;
      }

      // context 拼在 prompt 前面 —— 委派 prompt 是子 agent 唯一的入向通道,
      // 背景与任务分开传,拼起来给它,让它一眼分清"环境"与"要做的事"。
      const delegated =
        typeof background === 'string' && background.trim() !== ''
          ? `背景:\n${background.trim()}\n\n任务:\n${body}`
          : body;

      // 子 agent 的工具集必须过守门:角色可以继承主对话全量工具,不过这一层
      // 它就是一台没有守门的 Remove-Item 机器。approve 从 ToolContext 递来的
      // 是终端的确认通道;没有它(比如单测里)就一路 ask 下去,不会误放行。
      const guarded = guardToolsetForAgent(createToolset(tools), {
        approve: context?.approve ?? (async () => false),
        ...(restriction !== undefined ? { restriction } : {}),
      });

      const startedAt = Date.now();
      try {
        const result = await runSubagent(
          {
            provider,
            tools: guarded,
            system,
            ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
          },
          delegated,
          context?.signal,
        );

        // 成本回显:多角色最大的隐性代价是 token,先让用户看见。没有 emit 通道
        // (单测、非交互调用)就只是不报 —— 派发本身不受影响。
        context?.emit?.({
          type: 'subagent-done',
          agent: statAgent,
          model: provider.model,
          tokens: result.tokens,
          durationMs: Date.now() - startedAt,
        });

        return result.text;
      } catch (error) {
        // 子任务失败必须回到主对话。否则模型只知道"没有结论",无从判断该重派、
        // 该换个提示,还是该自己来做 —— 它会原地重派一次,然后第二次也失败。
        return `子任务「${label}」失败了,没有拿到结论。错误原文:${(error as Error).message}`;
      }
    },
  };
}
