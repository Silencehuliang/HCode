import type { Toolset } from './toolset.js';

export type PermissionRequest = { tool: string; input: unknown };

export type Verdict =
  | { kind: 'allow' }
  | { kind: 'ask' }
  | { kind: 'deny'; reason: string; instead: string };

/**
 * 角色文件的 permission 声明。v2-02 的语法就这一个词 —— allow/deny/规则引擎是
 * v2-08 的事,到时在这上面扩,别另起炉灶。
 */
export type AgentRestriction = 'read-only';

/**
 * 解析角色 frontmatter 的 permission 原始值。不认识的值不报错也不生效 ——
 * 角色文件可能是照着别家 harness 的教程写的,把它当 read-only 生效等于
 * 悄悄替用户改了主意。
 */
export function parseAgentRestriction(raw: string | undefined): AgentRestriction | undefined {
  return raw?.trim() === 'read-only' ? 'read-only' : undefined;
}

/**
 * 单向收紧的原子操作:两个判定取更严者。
 *
 * 严的次序是 deny > ask > allow。deny 语义上就是最严,任何东西叠上去都
 * 改不动它 —— DANGER_RULES 的最终否决权就是这样来的:角色层(乃至
 * v2-08 的用户规则层)无论声明什么,先到的 deny 原样穿过。
 */
export function tighten(user: Verdict, role: Verdict): Verdict {
  if (user.kind === 'deny') return user;
  if (role.kind === 'deny') return role;
  if (user.kind === 'ask') return user;
  if (role.kind === 'ask') return role;
  return user; // 两边都是 allow
}

/** read-only 角色的判定:对写得动磁盘、跑得了命令的工具直接 deny。 */
function readOnlyVerdict(request: PermissionRequest): Verdict {
  if (NO_BLAST_RADIUS.has(request.tool)) return { kind: 'allow' };
  return {
    kind: 'deny',
    reason: '这个角色声明了自己是 read-only,写盘与执行命令不在它的权限之内。',
    instead: '读到这里就够了 —— 把结论带回去,需要动手的活派给主对话或可写角色。',
  };
}

/**
 * 带角色层的判定。V1 的 `decide` 是用户层(全局),这里把它与角色层收紧
 * 后给出最终判定。**纯函数**,与 `decide` 同样的承诺。
 */
export function decideAsAgent(
  request: PermissionRequest,
  restriction?: AgentRestriction,
): Verdict {
  const base = decide(request);
  if (restriction === 'read-only') {
    return tighten(base, readOnlyVerdict(request));
  }
  return base;
}

export type DangerRule = {
  /** 直接对着命令原文匹配,能一眼读出来它拦的是什么。 */
  pattern: RegExp;
  /** 为什么危险。说给人听,也回传给模型。 */
  reason: string;
  /** 该怎么做。没有它,模型下一轮多半会换个写法再做同一件事。 */
  instead: string;
};

/**
 * 显式危险清单。
 *
 * 刻意保持"正则 + 两句话"的形状,而不是一个规则引擎:清单要能被人一眼读完、一眼
 * 看懂某条命令为什么被拦。完整的 allow/deny/ask 规则引擎是 v2 的事(见规格)。
 *
 * 已知的代价:这是**文本匹配**,命令里带引号的字符串也可能命中(比如拿
 * `search_content` 去搜 `del /s` 这几个字)。方向是刻意保守的 —— 多拦一次只是
 * 麻烦,漏拦一次是不可逆的。
 */
export const DANGER_RULES: DangerRule[] = [
  {
    pattern: /\bRemove-Item\b[^|;]*\s-(Recurse|r)\b/i,
    reason: '递归删除会删掉整棵目录树,而且不进回收站,删了找不回来。',
    instead:
      '删具体文件就把它一条条列清楚(不带 -Recurse);确实要删整棵目录,请你确认过目标路径后自己在终端里执行。',
  },
  {
    pattern: /\b(rm|rmdir|rd)\b[^|;]*\s(-[rR]|--recursive|\/s)\b/i,
    reason: '递归删除的 Unix 写法,同样不进回收站。',
    instead: '同上:列清楚要删的文件,或者你自己来删目录。',
  },
  {
    pattern: /\bdel\b[^|;]*\/[sq]\b/i,
    reason: '`del /s` 会递归删除,而且不经过回收站。',
    instead: '删单个文件用 `Remove-Item <具体路径>`。',
  },
  {
    pattern: /\bgit\s+push\b[^|;]*(--force\b|\s-f\b)/i,
    reason: '强制推送会覆盖远端历史,别人已经推上去的提交可能就此消失。',
    instead:
      '用 `--force-with-lease`:它在远端被别人更新过时会拒绝推送,而不是默默覆盖。',
  },
  {
    pattern: /\bgit\s+reset\s+--hard\b/i,
    reason: '`git reset --hard` 会丢掉所有未提交的改动,丢掉的找不回来。',
    instead: '先用 `git stash` 把改动收起来,确认不需要了再丢。',
  },
  {
    pattern: /\b(Format-Volume|Clear-Disk|Initialize-Disk|diskpart|mkfs(\.\w+)?)\b/i,
    reason: '格式化或初始化磁盘会抹掉整个分区的数据,包括与这个项目无关的东西。',
    instead: '这一步不该由 agent 代做。请你确认目标盘符后自己执行。',
  },
  {
    pattern: /\b(Set-ExecutionPolicy|bcdedit|Stop-Computer|Restart-Computer)\b/i,
    reason: '这是改这台机器的系统级配置或重启,影响范围远超这个项目。',
    instead: '需要改系统设置时请你自己在终端里执行,agent 继续做项目内的改动。',
  },
  {
    pattern: /\breg\s+delete\b/i,
    reason: '删注册表项会影响这台机器上的其它软件,而且同样没有回收站。',
    instead: '先 `reg export` 备份那一项,再由你自己执行删除。',
  },
  {
    pattern:
      /\b(Invoke-Expression|iex)\b[^|;]*\b(Invoke-WebRequest|iwr|DownloadString|curl|wget)\b/i,
    reason: '把下载来的内容直接执行,等于让远端代码在这台机器上跑,而你没有任何机会先看一眼。',
    instead: '先下载到文件,自己看过内容,再决定是否执行。',
  },
  {
    pattern: /\bStart-Process\b[^|;]*-Verb\s+RunAs\b/i,
    reason: '提权运行会绕过当前账号的权限边界。',
    instead: '需要管理员权限的步骤请你自己在提权后的终端里执行。',
  },
];

/**
 * 零爆炸半径的工具,不问就执行。
 *
 * 判据不是"读不读文件",是"最坏能坏到哪":读文件的工具最多读错东西;todo 三件套只动
 * 会话内存里的清单;task 派出去的子 agent 拿什么工具由装配处决定(main.ts 里只给只读
 * 那几个);skill 读的是本地 Markdown 正文。哪一个都碰不到用户磁盘上的一字节。
 *
 * 不在这个名单里的一律要问 —— 默认放行等于每加一个工具就悄悄开个口子。新工具进来时
 * 必须在这里做出裁决,写进对应测试。
 */
const NO_BLAST_RADIUS = new Set([
  'read_file',
  'search_content',
  'find_files',
  'todo_write',
  'todo_update',
  'todo_read',
  'task',
  'skill',
]);

/** 一个工具是否零爆炸半径。给装配处用 —— 只读角色在装配时就该看不到写工具。 */
export function isZeroBlastRadius(tool: string): boolean {
  return NO_BLAST_RADIUS.has(tool);
}

function commandOf(input: unknown): string {
  const { command } = (input ?? {}) as { command?: unknown };
  return typeof command === 'string' ? command : '';
}

/**
 * 判定一次工具调用该不该执行。**纯函数** —— 不看模型、不碰文件系统、不读配置,
 * 同样的输入永远给同样的判定。
 */
export function decide(request: PermissionRequest): Verdict {
  if (NO_BLAST_RADIUS.has(request.tool)) return { kind: 'allow' };

  if (request.tool === 'run_command') {
    const command = commandOf(request.input);
    const rule = DANGER_RULES.find((candidate) => candidate.pattern.test(command));
    // 普通命令直接跑。逐条确认会把用户训练成闭着眼按回车,那比不问更糟。
    return rule ? { kind: 'deny', reason: rule.reason, instead: rule.instead } : { kind: 'allow' };
  }

  // 写文件、改文件,以及任何还不认识的工具。保守方向一律是"问"。
  return { kind: 'ask' };
}

function refusalLines(reason: string, instead: string): string {
  return [
    '这条操作被拦下了,**没有执行**。',
    `原因:${reason}`,
    `可以这样做:${instead}`,
    '换一条路继续;原样再试一次会被同样拦下。',
  ].join('\n');
}

/**
 * 给工具集加一层守门。
 *
 * 判定到执行的这一步必须真的拦住 —— 问过用户却没拦住,比不问更糟:用户以为自己的
 * 拒绝起了作用,而改动已经落盘。
 */
export function guardToolset(
  inner: Toolset,
  deps: { approve: (request: PermissionRequest) => Promise<boolean> },
): Toolset {
  return guardToolsetForAgent(inner, { approve: deps.approve });
}

/**
 * 带角色层的守门。子 agent 的工具集**必须**从这里出 —— v2-01 让角色可以继承
 * 主对话全量工具,如果不过这一层,继承出来的子 agent 就是一台没有守门的
 * `Remove-Item -Recurse` 机器(实测抓到的洞)。判定用 `decideAsAgent`,
 * 角色层 deny 不问用户、不给批准的机会 —— 它是角色作者替用户收的权,不归
 * 现场用户的 y/n 管。
 */
export function guardToolsetForAgent(
  inner: Toolset,
  deps: { approve: (request: PermissionRequest) => Promise<boolean>; restriction?: AgentRestriction },
): Toolset {
  return {
    specs: inner.specs,

    async run(call, context) {
      const request: PermissionRequest = { tool: call.name, input: call.input };
      const verdict = decideAsAgent(request, deps.restriction);

      if (verdict.kind === 'allow') {
        // 把确认通道递进去:task 这类工具在内部还要跑子 agent,子 agent 的
        // 权限门要能找到终端。其余工具不读它,原样路过。
        return inner.run(call, { ...(context ?? {}), approve: deps.approve });
      }

      // 危险清单优先于用户同意:自己点了头也不该放它过去。
      if (verdict.kind === 'deny') {
        return refusalLines(verdict.reason, verdict.instead);
      }

      const approved = await deps.approve(request);
      if (!approved) {
        return `用户没有批准这次 ${call.name} 操作,**没有执行**。先问清楚他想要什么,再换一个方式。`;
      }

      return inner.run(call, { ...(context ?? {}), approve: deps.approve });
    },
  };
}
