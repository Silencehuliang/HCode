import type { SubagentDoneEvent, Tool, ToolContext } from '../core/tool.js';
import type { LoopEvent } from '../core/loop.js';
import { parseModelBinding, type AgentCatalog, type AgentDef } from '../core/agents.js';
import { continueSubagent } from '../core/subagent.js';
import { createTaskRegistry, renderTaskLine, type TaskRegistry } from '../core/task-registry.js';
import {
  checkOutput,
  contractFailure,
  contractInstruction,
  retryInstruction,
} from '../core/output-contract.js';
import { createToolset, type Toolset } from '../core/toolset.js';
import { guardToolsetForAgent, isZeroBlastRadius, parseAgentRestriction } from '../core/permission.js';
import type { AgentRestriction } from '../core/permission.js';
import type { Message, Provider } from '../provider/types.js';

function asText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${what} 要是一句非空的说明`);
  }
  return value;
}

export type TaskDeps = {
  provider: Provider;
  /**
   * 会话内的任务表(v2-11)。给了才支持后台派发与追问 —— 它是**会话级**的对象:
   * 一个会话一张,进程走表走(见 core/task-registry.ts 的说明)。
   */
  registry?: TaskRegistry;
  /**
   * 角色按名换模型(v2-03):给一个 provider id,造出那一家的实例。
   * 不给(或返回 undefined)时,角色一律用主对话的 Provider —— 这也是
   * `model` 字段缺省、或指向配不出密钥那家时的回退行为。
   */
  providerFor?: (id: string, model?: string) => Provider | undefined;
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
  //
  // `provider:模型` 里的模型要一起传下去(v2-12 才补上:此前只换了家,模型那半
  // 被丢掉了 —— preset 里 `glm:glm-4.5-air` 与 `glm:glm-5.3` 这种"同一家两个档"
  // 的用法正是靠它)。providerFor 缺省(单测里常见)时忽略模型,行为照旧。
  const binding = parseModelBinding(def.model);
  const provider =
    (binding ? deps.providerFor?.(binding.providerId, binding.model) : undefined) ?? deps.provider;

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
  /** 后台派发(v2-11):立刻返回任务 id,活儿挂在任务表上继续跑。 */
  background?: boolean;
};

/** 装配好的一趟派发 —— 角色解析、工具守门、prompt 组装都已经做完。 */
type RunPlan = {
  statAgent: string;
  provider: Provider;
  system: string;
  guarded: Toolset;
  /** 委派 prompt(还没拼输出约定 —— 那一步在 executeRun 里,续跑要拼同一份)。 */
  delegated: string;
  outputFields?: readonly string[];
};

const BACKGROUND_NO_APPROVAL =
  '这是后台派出去的任务,没有确认通道 —— 需要用户点头的操作一律拒绝,**没有执行**。要它做这类事,请在前台重新派一次。';

/**
 * 装配一次派发。放在模块层而不是 createTaskTool 里,是因为**续跑**要用同一套
 * 装配:followup 只该换起点(消息数组),不该顺便换一套角色解析规则。
 */
function prepareRun(
  deps: TaskDeps,
  spec: TaskSpec,
  options: { approve?: ToolContext['approve']; background?: boolean },
): { plan: RunPlan } | { error: string } {
  const agents = deps.agents;
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
      return { error: resolved.error };
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
  //
  // 没有 context 时,委派 prompt 就是**原样的 body** —— v1 起就是逐字如此,
  // 不能因为多加了几个可选功能就给所有派发套一层前缀。
  const contextText =
    spec.context !== undefined && spec.context.trim() !== '' ? spec.context.trim() : undefined;
  const delegated =
    contextText !== undefined ? `背景:
${contextText}

任务:
${spec.prompt}` : spec.prompt;

  // 子 agent 的工具集必须过守门:角色可以继承主对话全量工具,不过这一层
  // 它就是一台没有守门的 Remove-Item 机器。approve 从 ToolContext 递来的
  // 是终端的确认通道;没有它(比如单测里、后台派发)就一路 ask 下去,
  // 不会误放行。
  const guarded = guardToolsetForAgent(createToolset(tools), {
    approve: options.approve ?? (async () => false),
    ...(options.background === true ? { unapprovedNote: BACKGROUND_NO_APPROVAL } : {}),
    ...(restriction !== undefined ? { restriction } : {}),
    ...(deps.rules !== undefined ? { rules: deps.rules } : {}),
  });

  return {
    plan: {
      statAgent,
      provider,
      system,
      guarded,
      delegated,
      ...(outputFields !== undefined ? { outputFields } : {}),
    },
  };
}

/** 把输出约定拼到一段委派话后面(v2-10)。续跑也走这里,不能两处各写一遍。 */
function withContract(plan: RunPlan, body: string): string {
  const fields = plan.outputFields;
  return fields !== undefined && fields.length > 0
    ? `${body}

${contractInstruction(fields)}`
    : body;
}

/**
 * 跑一趟装配好的派发,带回结论、花费与**结束时的消息数组**。
 *
 * history 是起点:空数组 = 冷启动;非空 = 在原对话上续跑(v2-11 的 followup)。
 * 这两件事的差别只有"有没有把历史带上",所以是同一个函数。
 */
async function executeRun(
  deps: TaskDeps,
  plan: RunPlan,
  channel: { signal?: AbortSignal; emit?: (event: SubagentDoneEvent) => void },
  prompt: string,
  history: Message[] = [],
): Promise<{ text: string; tokens: number; messages: Message[] }> {
  const startedAt = Date.now();
  const first = withContract(plan, prompt);

  const runOnce = (text: string) =>
    continueSubagent(
      {
        provider: plan.provider,
        tools: plan.guarded,
        system: plan.system,
        ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
        // 只往上转成本行:子 agent 的工具调用过程刻意不上屏(隔离是它存在的
        // 理由)。但**再派一层**的成本必须浮上来 —— 那笔钱是主对话付的。
        ...(channel.emit !== undefined
          ? {
              onEvent: (event: LoopEvent) => {
                if (event.type === 'subagent-done') channel.emit!(event);
              },
            }
          : {}),
      },
      history,
      text,
      channel.signal,
    );

  let result = await runOnce(first);
  let totalTokens = result.tokens;

  // v2-10:声明了输出约定的角色,结论要过一遍宽松校验。不合格**只给一次**
  // 重试 —— 再拉长就成了反复讨要;而模型反复给不出来的那件事,人自己看原文
  // 更有用。校验本身只看键在不在,不看类型(见 output-contract.ts)。
  const fields = plan.outputFields;
  if (fields !== undefined && fields.length > 0) {
    let check = checkOutput(result.text, fields);
    if (!check.ok) {
      result = await runOnce(`${first}

${retryInstruction(check.missing)}`);
      totalTokens += result.tokens;
      check = checkOutput(result.text, fields);
      if (!check.ok) {
        result = { ...result, text: contractFailure(plan.statAgent, check.missing, result.text) };
      }
    }
  }

  // 成本回显:多角色最大的隐性代价是 token,先让用户看见。没有 emit 通道
  // (单测、非交互调用、后台任务)就只是不报 —— 派发本身不受影响。
  // 计的是**这一趟**的总账:重试那一次也付了钱,不能只报第一次。
  channel.emit?.({
    type: 'subagent-done',
    agent: plan.statAgent,
    model: plan.provider.model,
    tokens: totalTokens,
    durationMs: Date.now() - startedAt,
  });

  return { text: result.text, tokens: totalTokens, messages: result.messages };
}

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
    const prepared = prepareRun(deps, spec, {
      ...(context?.approve !== undefined ? { approve: context.approve } : {}),
    });
    if ('error' in prepared) {
      return prepared.error;
    }

    try {
      const result = await executeRun(
        deps,
        prepared.plan,
        {
          ...(context?.signal !== undefined ? { signal: context.signal } : {}),
          ...(context?.emit !== undefined ? { emit: context.emit } : {}),
        },
        prepared.plan.delegated,
      );
      return result.text;
    } catch (error) {
      // 子任务失败必须回到主对话。否则模型只知道"没有结论",无从判断该重派、
      // 该换个提示,还是该自己来做 —— 它会原地重派一次,然后第二次也失败。
      return `子任务「${spec.description}」失败了,没有拿到结论。错误原文:${(error as Error).message}`;
    }
  }

  /**
   * 后台派发:开一条任务表记录,把活儿挂上去,立刻回来交一个 id。
   *
   * 三条刻意的选择:
   * - **不继承这一轮的 signal** —— "后台"的意思就是要活过这一轮。用户按了中断,
   *   该停的是等着它的这次对话,不是它。
   * - **不给确认通道**(approve 一律拒绝):后台任务在跑到一半要用户点头,就会
   *   和主对话抢同一行输入。所以它在装配时就按"问不到人"来(见 prepareRun 的
   *   background 分支),而不是运行时才发现问不到。
   * - **不报成本行**,也不往主对话注入任何消息:后台任务的结论停在任务表里,由
   *   `task_status` 主动去取。往对话里注消息会破坏压缩器"工具调用与结果成对"的
   *   假设 —— 那条假设一旦破,压缩后的历史就会缺一半。
   */
  function startBackground(spec: TaskSpec, registry: TaskRegistry): string {
    const prepared = prepareRun(deps, spec, { background: true });
    if ('error' in prepared) {
      return prepared.error;
    }

    const entry = registry.start({
      agent: prepared.plan.statAgent,
      description: spec.description,
      spec: { ...spec },
    });

    // 不 await —— 这就是"后台"。失败也不许抛出来(没人接),记进任务表。
    void executeRun(deps, prepared.plan, {}, prepared.plan.delegated).then(
      (result) => registry.finish(entry.id, result),
      (error: unknown) => registry.fail(entry.id, (error as Error).message),
    );

    return `已经派出去了:任务 ${entry.id}(${prepared.plan.statAgent} · ${spec.description}),在后台跑,不占这条对话。用 task_status 查它完没完 —— 完了再决定要不要 task_followup 追问。`;
  }

  /** 一次扇出多个。结果按**调用序**回传,并合成一条文本 —— 主对话只多一条结果。 */
  async function runBatch(items: unknown[], context: ToolContext | undefined): Promise<string> {
    if (items.length === 0) {
      return 'tasks 是空的,没有可派发的子任务。';
    }

    const specs: TaskSpec[] = [];
    for (const [index, raw] of items.entries()) {
      const entry = (raw ?? {}) as Record<string, unknown>;
      // 批量与后台不搭:批量本来就是并发跑的,再套一层"后台的后台"只会让人
      // 分不清哪个 id 对应哪一项。要逐个跟踪,分开调用。
      if (entry.background === true) {
        return `批量派发不支持 background(tasks[${index}] 里写了)。批量本来就是并发跑的;要逐个跟踪就分几次单独调用。`;
      }
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
      ...specs.map((spec, index) => `
【${index + 1}】${spec.agent ?? 'explorer'} — ${spec.description}
${results[index]}`),
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
        '如果你还要接着做别的事、不想在这里干等,加 background: true —— 它立刻给你一个任务 id,你用 task_status 回头取结论。',
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
          background: {
            type: 'boolean',
            description:
              '在后台跑:立刻拿到任务 id,不占这条对话。结论停在任务表里,之后用 task_status 取、用 task_followup 追问。只有不需要用户确认的角色适合它(后台任务问不到人)。',
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

      const spec: TaskSpec = {
        ...(typeof raw.agent === 'string' ? { agent: raw.agent } : {}),
        description: asText(raw.description, 'description'),
        prompt: asText(raw.prompt, 'prompt'),
        ...(typeof raw.context === 'string' ? { context: raw.context } : {}),
      };

      if (raw.background === true) {
        const registry = deps.registry;
        if (!registry) {
          return '这个会话没有任务表,后台派发不可用 —— 去掉 background 直接派,就会等它跑完再回来。';
        }
        return startBackground(spec, registry);
      }

      return runOne(spec, context);
    },
  };
}


/**
 * 查后台任务的状态(v2-11)。不传 id 就列全部。
 *
 * 它是后台任务的**唯一出口**:后台跑完不往主对话注消息(那会破坏压缩器"工具调用
 * 与结果成对"的假设),所以结论只停在这里,由模型主动来取。
 */
export function createTaskStatusTool(deps: TaskDeps): Tool {
  return {
    spec: {
      name: 'task_status',
      description: [
        '查后台任务(用 background: true 派出去的)现在怎么样了。',
        '不传 id 列出全部;传了就给出那一条,已经跑完的连结论一起给你。',
        '什么时候用它:你派了个后台任务、手上这件事做完了,回头收账。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id,比如 t1。不传就列出全部。' },
        },
        required: [],
      },
    },

    async run(input) {
      const raw = (input ?? {}) as Record<string, unknown>;
      const registry = deps.registry;
      if (!registry) {
        return '这个会话没有任务表。';
      }

      const asked = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : undefined;
      if (asked === undefined) {
        const all = registry.list();
        if (all.length === 0) {
          return '这个会话还没有派发过任务。';
        }
        return ['任务表(最早的在上):', ...all.map((entry) => renderTaskLine(entry))].join('\n');
      }

      const entry = registry.get(asked);
      if (!entry) {
        const known = registry.list().map((each) => each.id);
        return known.length === 0
          ? `没有这个任务:${asked}。这个会话还没派发过任务。`
          : `没有这个任务:${asked}。现有的是:${known.join('、')}`;
      }

      const lines = [renderTaskLine(entry)];
      if (entry.state === 'done') {
        lines.push('', '结论:', entry.text ?? '(空)');
      } else if (entry.state === 'failed') {
        lines.push('', '错误原文:', entry.error ?? '(没有错误信息)');
      }
      return lines.join('\n');
    },
  };
}

/**
 * 给一个已经跑完的任务补一句指令,让它在**原来的消息数组**上接着跑(v2-11)。
 *
 * 为什么要有它:子 agent 花了半分钟翻了二十个文件,回头看结论时想问的那句
 * "那 X 呢" —— 重新派一次要从零再翻一遍,钱和时间都白花,还可能得到互相矛盾
 * 的结论。续跑用的是它自己的历史,所以这句追问是**接着说的**。
 *
 * 装配是重新来的一遍(角色文件是唯一事实来源):改过角色文件再续跑,它用的是
 * 新版;别把续跑当成"同一个 agent 的延续"去指望。
 */
export function createTaskFollowupTool(deps: TaskDeps): Tool {
  return {
    spec: {
      name: 'task_followup',
      description: [
        '给一个跑完的后台任务补一句话,让它在自己上一趟的对话上接着干。',
        '什么时候用它:task_status 拿到结论,只差一点 —— 比如它说"不确定 X 在哪",你想让它顺手确认。',
        '别用它换方向查:它带着上一趟的全部历史,越跑越贵。要另起一摊就重新派一次。',
      ].join(''),
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 id,从派发结果或 task_status 里拿' },
          prompt: {
            type: 'string',
            description: '补的这句指令。它看得见自己前面说过什么、查过什么,不用重复交代背景。',
          },
        },
        required: ['id', 'prompt'],
      },
    },

    async run(input, context) {
      const raw = (input ?? {}) as Record<string, unknown>;
      const registry = deps.registry;
      if (!registry) {
        return '这个会话没有任务表,没法追问。';
      }

      const id = typeof raw.id === 'string' ? raw.id.trim() : '';
      if (id === '') {
        return 'task_followup 要一个任务 id,例如 t1。';
      }

      const entry = registry.get(id);
      if (!entry) {
        const known = registry.list().map((each) => each.id);
        return known.length === 0
          ? `没有这个任务:${id}。这个会话还没派发过任务。`
          : `没有这个任务:${id}。现有的是:${known.join('、')}`;
      }

      // 只有跑完的能追问:还在跑的插话会把它自己的对话搅乱;失败的那趟没有可续的历史。
      if (entry.state === 'running') {
        return `任务 ${id} 还在跑。先用 task_status 看它完没完 —— 现在插话会让它两件事都说不清。`;
      }
      if (entry.state === 'failed') {
        return `任务 ${id} 失败了,没有可以接着跑的历史。错误原文:${entry.error ?? '(没有错误信息)'}。要重来就重新派一次。`;
      }

      const prepared = prepareRun(deps, entry.spec, {
        ...(context?.approve !== undefined ? { approve: context.approve } : {}),
      });
      if ('error' in prepared) {
        return prepared.error;
      }

      try {
        const result = await executeRun(
          deps,
          prepared.plan,
          {
            ...(context?.signal !== undefined ? { signal: context.signal } : {}),
            ...(context?.emit !== undefined ? { emit: context.emit } : {}),
          },
          typeof raw.prompt === 'string' ? raw.prompt : '',
          entry.messages ?? [],
        );
        // 累加:任务表里的 tokens 是这一摊活儿的总账,不是最后一趟的。
        registry.finish(entry.id, result);
        const total =
          entry.tokens >= 1000 ? `${(entry.tokens / 1000).toFixed(1)}k` : String(entry.tokens);
        return `任务 ${id} 接着跑完了(累计 ~${total} token):\n\n${result.text}`;
      } catch (error) {
        // 追问失败不改任务状态:上一条结论还在、也还有效,只是这一句没跑成。
        return `追问没有跑成:${(error as Error).message}。任务 ${id} 的结论还是原来那条。`;
      }
    },
  };
}

/**
 * 派发三件套:派、查、追问。三者共用**同一张**任务表 —— 分开建表的话,
 * `task` 派出去的任务 `task_status` 就查不到。
 */
export function createTaskTools(deps: TaskDeps): Tool[] {
  const withRegistry: TaskDeps = deps.registry ? deps : { ...deps, registry: createTaskRegistry() };
  return [
    createTaskTool(withRegistry),
    createTaskStatusTool(withRegistry),
    createTaskFollowupTool(withRegistry),
  ];
}
