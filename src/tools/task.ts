import type { Tool, ToolContext } from '../core/tool.js';
import type { LoopEvent } from '../core/loop.js';
import { parseModelBinding, type AgentCatalog, type AgentDef } from '../core/agents.js';
import { runSubagent } from '../core/subagent.js';
import {
  checkOutput,
  contractFailure,
  contractInstruction,
  retryInstruction,
} from '../core/output-contract.js';
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
  /**
   * 并行派发的并发上限。默认 3 —— 刻意保守:Windows 每次 run_command 都要新起
   * PowerShell 子进程,进程创建成本高于 POSIX;国产模型又按量计价,扇得太开
   * 是一次账单教训(oMP 默认 32,那是另一套前提)。
   */
  maxConcurrent?: number;
  /** 用户层的权限规则,子 agent 同样适用(它们不该绕过用户在 settings 里收的权)。 */
  rules?: readonly { pattern: string; verdict: 'allow' | 'ask' | 'deny' }[];
  /** 当前这一层是第几层派发(主对话 = 0)。v2-09 的递归深度用。 */
  depth?: number;
  /** 递归深度上限。默认 2 —— 主对话 → 子 → 孙,到此为止,到顶就不再给 task 工具。 */
  maxDepth?: number;
};

const DEFAULT_MAX_DEPTH = 2;

/**
 * 把角色名册收窄到白名单里 —— 派出去的子 agent 的 task 工具只看得见它被允许
 * 派的那几个。收窄发生在注册表这一层,而不是运行时再拦:模型看不见的名字它
 * 就不会去试,省掉注定被拒的一轮。
 */
function restrictCatalog(catalog: AgentCatalog, allowed: readonly string[]): AgentCatalog {
  const allowedSet = new Set(allowed);
  const visible = catalog.list().filter((def) => allowedSet.has(def.name));
  return {
    list: () => visible.map((def) => ({ ...def })),
    get: (name) => {
      if (!allowedSet.has(name)) return undefined;
      const found = visible.find((candidate) => candidate.name === name);
      return found ? { ...found } : undefined;
    },
    problems: () => [],
  };
}

const DEFAULT_MAX_CONCURRENT = 3;

/** 并发上限下的保序 map:同时最多 limit 个在跑,返回顺序与输入一致。 */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker());
  await Promise.all(workers);
  return results;
}

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

export type TaskSpec = {
  agent?: string;
  description: string;
  prompt: string;
  context?: string;
};

/**
 * 把一次探查委派出去的工具。
 *
 * 不传 `agent` 时是旧行为:派只读探查者。传了则按注册表装配 —— 系统提示、
 * 工具集都来自角色文件,模型绑定见 v2-03。传 `tasks` 数组则并行派多个,
 * 结果按调用序回传。
 *
 * 它返回的是子 agent 最后那段话,**没有别的**。这是这个工具的全部意义:主对话
 * 只多出"派出去"和"结论"两条消息,子 agent 翻了八十个文件也好、一个也没找到也
 * 好,占的位置都一样 —— 并行派多个也一样,回传的是**一条**合并结果,不是 N 条
 * 消息(N 条会破坏压缩器"工具调用与结果成对"的假设)。
 */
export function createTaskTool(deps: TaskDeps): Tool {
  const agents = deps.agents;
  const agentHint = agents
    ? `可用角色:${agents.list().map((agent) => `${agent.name}(${agent.description})`).join(';')}。`
    : '';

  /** 派一个子 agent,带回它的结论。批量与单发共用这一条路径。 */
  async function runOne(spec: TaskSpec, context: ToolContext | undefined): Promise<string> {
    const label = spec.description;
    const body = spec.prompt;

    let system = deps.system;
    let tools = deps.tools;
    let restriction: AgentRestriction | undefined;
    let provider = deps.provider;
    // 统计行上的角色名:点名的用它,没点名就是缺省的探查者(内置 explorer)。
    let statAgent = 'explorer';
    /** 角色声明的输出约定(v2-10)。没声明就是 undefined,行为与从前一致。 */
    let outputFields: readonly string[] | undefined;

    if (spec.agent !== undefined && spec.agent.trim() !== '') {
      const resolved = resolveAgentRun(deps, spec.agent.trim());
      if ('error' in resolved) {
        return resolved.error;
      }
      system = resolved.system;
      tools = resolved.tools;
      restriction = resolved.restriction;
      provider = resolved.provider ?? deps.provider;
      statAgent = resolved.def.name;
      outputFields = resolved.def.output;

      // v2-09 受限递归:角色用 spawns 显式声明"我还能派谁",而且只在深度
      // 没到顶时才给它 task 工具。到顶就剥掉 —— 这是防无限套娃的最后一道。
      const depth = deps.depth ?? 0;
      const maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
      const spawns = resolved.def.spawns ?? [];
      if (spawns.length > 0 && depth < maxDepth && agents) {
        const child = createTaskTool({
          ...deps,
          agents: restrictCatalog(agents, spawns),
          depth: depth + 1,
          maxDepth,
        });
        tools = [...tools, child];
      }
    }

    // context 拼在 prompt 前面 —— 委派 prompt 是子 agent 唯一的入向通道,
    // 背景与任务分开传,拼起来给它,让它一眼分清"环境"与"要做的事"。
    // 输出约定(v2-10)也拼在这里:它是这一趟派发的规矩,不是角色一辈子的话术。
    //
    // 没有 context、也没有约定时,委派 prompt 就是**原样的 body** —— v1 起
    // 就是逐字如此,不能因为多加了两个可选功能就给所有派发套一层前缀。
    const contextText =
      spec.context !== undefined && spec.context.trim() !== '' ? spec.context.trim() : undefined;
    const parts: string[] =
      contextText !== undefined ? [`背景:\n${contextText}`, `任务:\n${body}`] : [body];
    if (outputFields !== undefined && outputFields.length > 0) {
      parts.push(contractInstruction(outputFields));
    }
    const delegated = parts.join('\n\n');

    // 子 agent 的工具集必须过守门:角色可以继承主对话全量工具,不过这一层
    // 它就是一台没有守门的 Remove-Item 机器。approve 从 ToolContext 递来的
    // 是终端的确认通道;没有它(比如单测里)就一路 ask 下去,不会误放行。
    const guarded = guardToolsetForAgent(createToolset(tools), {
      approve: context?.approve ?? (async () => false),
      ...(restriction !== undefined ? { restriction } : {}),
      ...(deps.rules !== undefined ? { rules: deps.rules } : {}),
    });

    const startedAt = Date.now();
    try {
      const runOnce = (prompt: string) =>
        runSubagent(
          {
            provider,
            tools: guarded,
            system,
            ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
            // 只往上转成本行:子 agent 的工具调用过程刻意不上屏(隔离是它存在的
            // 理由)。但**再派一层**的成本必须浮上来 —— 那笔钱是主对话付的。
            ...(context?.emit !== undefined
              ? {
                  onEvent: (event: LoopEvent) => {
                    if (event.type === 'subagent-done') context.emit!(event);
                  },
                }
              : {}),
          },
          prompt,
          context?.signal,
        );

      let result = await runOnce(delegated);
      let totalTokens = result.tokens;

      // v2-10:声明了输出约定的角色,结论要过一遍宽松校验。不合格**只给一次**
      // 重试 —— 再拉长就成了反复讨要;而模型反复给不出来的那件事,人自己看原文
      // 更有用。校验本身只看键在不在,不看类型(见 output-contract.ts)。
      if (outputFields !== undefined && outputFields.length > 0) {
        let check = checkOutput(result.text, outputFields);
        if (!check.ok) {
          result = await runOnce(`${delegated}\n\n${retryInstruction(check.missing)}`);
          totalTokens += result.tokens;
          check = checkOutput(result.text, outputFields);
          if (!check.ok) {
            result = { ...result, text: contractFailure(statAgent, check.missing, result.text) };
          }
        }
      }

      // 成本回显:多角色最大的隐性代价是 token,先让用户看见。没有 emit 通道
      // (单测、非交互调用)就只是不报 —— 派发本身不受影响。
      // 计的是**这一趟**的总账:重试那一次也付了钱,不能只报第一次。
      context?.emit?.({
        type: 'subagent-done',
        agent: statAgent,
        model: provider.model,
        tokens: totalTokens,
        durationMs: Date.now() - startedAt,
      });

      return result.text;
    } catch (error) {
      // 子任务失败必须回到主对话。否则模型只知道"没有结论",无从判断该重派、
      // 该换个提示,还是该自己来做 —— 它会原地重派一次,然后第二次也失败。
      return `子任务「${label}」失败了,没有拿到结论。错误原文:${(error as Error).message}`;
    }
  }

  /** 一次扇出多个。结果按**调用序**回传,并合成一条文本 —— 主对话只多一条结果。 */
  async function runBatch(items: unknown[], context: ToolContext | undefined): Promise<string> {
    if (items.length === 0) {
      return 'tasks 是空的,没有可派发的子任务。';
    }

    const specs: TaskSpec[] = [];
    for (const [index, raw] of items.entries()) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      try {
        specs.push({
          ...(typeof entry.agent === 'string' ? { agent: entry.agent } : {}),
          description: asText(entry.description, `tasks[${index}].description`),
          prompt: asText(entry.prompt, `tasks[${index}].prompt`),
          ...(typeof entry.context === 'string' ? { context: entry.context } : {}),
        });
      } catch (error) {
        // 一条坏项不该毁掉整批:明确指出第几项坏了,让模型改对再来。
        return `批量派发没发起:${(error as Error).message}`;
      }
    }

    const limit = deps.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    const results = await mapWithLimit(specs, limit, (spec) => runOne(spec, context));

    return [
      `派发 ${specs.length} 个角色(并发上限 ${limit}),按调用序回传:`,
      ...specs.map((spec, index) => `\n【${index + 1}】${spec.agent ?? 'explorer'} — ${spec.description}\n${results[index]}`),
    ].join('');
  }

  return {
    spec: {
      name: 'task',
      description: [
        '把一次需要翻很多地方的探查委派给一个子 agent,只拿回它的结论。',
        '什么时候用它:当你要做的事会读进大量原文,而你只需要其中的结论 —— ',
        '比如"这个功能在哪些地方被用到"、"这个报错是从哪冒出来的"。',
        '什么时候别用:你知道确切位置(直接 read_file)、你本来就需要那些原文(那把它读进主对话才对)。',
        '子 agent 看不到这段对话,你交代的上下文是它唯一的信息来源。',
        '一次要查几件互不相干的事时,用 tasks 数组一次派出去(会并行跑,结果按顺序回)。',
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
          tasks: {
            type: 'array',
            description:
              '一次派多个角色时用这个,别用单数那几个字段。互相独立、能同时查的才放进来;有先后依赖的仍要走单数形态。',
            items: {
              type: 'object',
              properties: {
                agent: { type: 'string', description: '派哪个角色(按名),不传则派缺省探查者' },
                description: { type: 'string', description: '三五个字说明这一项做什么' },
                prompt: { type: 'string', description: '这一项交给子 agent 的完整交代' },
                context: { type: 'string', description: '这一项需要的背景' },
              },
              required: ['description', 'prompt'],
            },
          },
        },
        required: [],
      },
    },

    async run(input, context) {
      const raw = (input ?? {}) as Record<string, unknown>;

      // 批量形态优先:给了 tasks 就一次扇出去。单数那几个字段这时不读 ——
      // 两套形态混着用,行为没有唯一解释,不如让 tasks 完全接管。
      if (Array.isArray(raw.tasks)) {
        return runBatch(raw.tasks, context);
      }

      return runOne(
        {
          ...(typeof raw.agent === 'string' ? { agent: raw.agent } : {}),
          description: asText(raw.description, 'description'),
          prompt: asText(raw.prompt, 'prompt'),
          ...(typeof raw.context === 'string' ? { context: raw.context } : {}),
        },
        context,
      );
    },
  };
}
