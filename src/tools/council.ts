import type { SubagentDoneEvent, Tool, ToolContext } from '../core/tool.js';
import { runSubagent } from '../core/subagent.js';
import { createToolset } from '../core/toolset.js';
import { checkOutput, retryInstruction } from '../core/output-contract.js';
import {
  COUNCIL_OUTPUT_FIELDS,
  COUNCIL_SYSTEM_PROMPT,
  MIN_COUNCILORS,
  SYNTHESIS_SYSTEM_PROMPT,
  renderCouncilReport,
  synthesisFailure,
  synthesisPrompt,
  type CouncilVote,
} from '../core/council.js';
import { mapWithLimit } from './task.js';
import type { Provider } from '../provider/types.js';

/**
 * 多模型共识:同一个问题并行问几家,再合成一份"哪里一致、哪里分歧"的报告。
 *
 * 只在**主对话**手上(和 task_status / task_followup 一样不进角色的白名单取材
 * 范围):议员是纯问答,不需要工具;让子 agent 也能开评审团会变成一层看不见的
 * 开销,而这一层开出去每家都是钱。
 *
 * 三家的适配器早就现成(V1 起就有),所以这个工具的**全部新东西**是编排:并行、
 * 保序、一家失败不拖垮全局、合成报告要有骨架。钱的部分交给成本行 —— 每问一家都
 * 发一条 subagent-done,用户看得见"这一趟问了几家、各花了多少"。
 */

/** 一家可选来当议员的模型。id 是配置里的家名(glm / deepseek / claude)。 */
export type Councilor = { id: string; provider: Provider };

export type CouncilDeps = {
  /** 能问的家 —— 由 main.ts 按"配得出密钥的那些"传进来。 */
  councilors: readonly Councilor[];
  /** 记录员用哪一家:主对话这一家(它手里有工具、也最清楚上下文)。 */
  synthesizer: Provider;
  /** 并发上限。默认 3,与并行派发同一个数量级 —— 一次问的家本来就不多。 */
  maxConcurrent?: number;
};

const DEFAULT_COUNCIL_CONCURRENT = 3;

/**
 * 议员的工具集:**空的**。
 *
 * 这不是省事,是 v2-14 的验收条款(「议员角色的工具集为空」)。议员拿不到工具,
 * 就不会去翻用户的工作区 —— 因此也就不会出现"三家各自改了一点东西"这种没人能
 * 收拾的场面。代价是它们只看得到 question 里的字,这一点写在工具说明里了。
 */
const NO_TOOLS = createToolset([]);

export function createCouncilTool(deps: CouncilDeps): Tool {
  const names = deps.councilors.map((councilor) => councilor.id);
  const limit = deps.maxConcurrent ?? DEFAULT_COUNCIL_CONCURRENT;

  function pick(input: unknown): Councilor[] | string {
    if (input === undefined) return [...deps.councilors];

    if (!Array.isArray(input) || input.some((item) => typeof item !== 'string')) {
      return `council 的 providers 要是一个家名的数组,比如 ["${names[0] ?? 'glm'}"]。`;
    }

    const unknown = input.filter((id) => !names.includes(id));
    if (unknown.length > 0) {
      return `没有配 ${unknown.join('、')} 这一家的密钥,问不了。现在能问的是:${names.join('、')}。`;
    }

    // 顺序按用户写的来,不按配置里的顺序 —— 回传的报告里家名的次序该是他心里的次序。
    return input.map((id) => deps.councilors.find((councilor) => councilor.id === id)!);
  }

  /** 问一家。它失败**不**让整场垮掉:别家的回答还有用,这一家如实写"没答上来"。 */
  async function ask(
    councilor: Councilor,
    question: string,
    context: ToolContext | undefined,
  ): Promise<CouncilVote> {
    const startedAt = Date.now();
    try {
      const result = await runSubagent(
        {
          provider: councilor.provider,
          tools: NO_TOOLS,
          system: COUNCIL_SYSTEM_PROMPT,
          // 没有工具,一轮就该结束。给 1 是兜底:万一它硬要调工具,也别让它空转。
          maxTurns: 1,
        },
        question,
        context?.signal,
      );

      context?.emit?.({
        type: 'subagent-done',
        agent: `council:${councilor.id}`,
        model: councilor.provider.model,
        tokens: result.tokens,
        durationMs: Date.now() - startedAt,
      });

      return { id: councilor.id, model: councilor.provider.model, text: result.text, tokens: result.tokens };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);

      // 失败也报一声:那一趟可能挂了几十秒,不上屏的话用户只看到"少了一家",
      // 会以为是配置漏了。tokens 记 0 —— 没拿到回答就谈不上花费,不虚报。
      context?.emit?.({
        type: 'subagent-done',
        agent: `council:${councilor.id}`,
        model: councilor.provider.model,
        tokens: 0,
        durationMs: Date.now() - startedAt,
      });

      return {
        id: councilor.id,
        model: councilor.provider.model,
        text: `这一家没答上来 —— ${detail}`,
        tokens: 0,
        failed: true,
      };
    }
  }

  /** 记录员那一趟。约定、校验、一次性重试都照 v2-10 那套走。 */
  async function synthesize(
    question: string,
    votes: readonly CouncilVote[],
    context: ToolContext | undefined,
  ): Promise<{ tokens: number; result: { ok: true; value: Record<string, unknown> } | { ok: false; text: string } }> {
    const startedAt = Date.now();
    const first = synthesisPrompt(question, votes);

    const runOnce = (prompt: string) =>
      runSubagent(
        {
          provider: deps.synthesizer,
          tools: NO_TOOLS,
          system: SYNTHESIS_SYSTEM_PROMPT,
          maxTurns: 1,
        },
        prompt,
        context?.signal,
      );

    let outcome = await runOnce(first);
    let tokens = outcome.tokens;
    let check = checkOutput(outcome.text, COUNCIL_OUTPUT_FIELDS);

    if (!check.ok) {
      // 只重试一次 —— 与角色派发同一个尺度:再拉长就成了反复讨要。
      outcome = await runOnce(`${first}\n\n${retryInstruction(check.missing)}`);
      tokens += outcome.tokens;
      check = checkOutput(outcome.text, COUNCIL_OUTPUT_FIELDS);
    }

    context?.emit?.({
      type: 'subagent-done',
      agent: '合成',
      model: deps.synthesizer.model,
      tokens,
      durationMs: Date.now() - startedAt,
    });

    return {
      tokens,
      result: check.ok ? { ok: true, value: check.value } : { ok: false, text: synthesisFailure(check.missing, outcome.text) },
    };
  }

  return {
    spec: {
      name: 'council',
      description: [
        `把同一个问题同时问给 ${names.join('、')} 这几家模型,再由主对话这一家把回答合成一份报告:哪里一致、哪里分歧,分歧处各方立的什么理由。`,
        '议员**没有工具**,看不到你的工作区 —— 相关代码、报错原文、已经得出来的结论都要你贴在 question 里,不然拿回来的是几段聪明的空话。',
        '什么时候值得用:一个判断想交叉验证、或者你拿不准某家的说法靠不靠得住。它一次会花掉几家的钱,别拿它问随手一试就知道的事。',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: '要问的问题。自带材料 —— 议员看不到工作区。',
          },
          providers: {
            type: 'array',
            items: { type: 'string' },
            description: `只问其中几家,缺省全问。可写:${names.join('、')}`,
          },
        },
        required: ['question'],
      },
    },

    async run(input, context) {
      const raw = (input ?? {}) as Record<string, unknown>;

      if (typeof raw.question !== 'string' || raw.question.trim() === '') {
        return 'council 的 question 要是一句非空的问题。';
      }
      const question = raw.question.trim();

      const chosen = pick(raw.providers);
      if (typeof chosen === 'string') return chosen;

      if (chosen.length < MIN_COUNCILORS) {
        return [
          `多模型共识至少要问 ${MIN_COUNCILORS} 家,你只点了 ${chosen.length} 家(${chosen.map((c) => c.id).join('、')})。`,
          '要几家都问就别写 providers;想加一家就问用户要另一家的密钥,配进 settings.json(见 docs/configuration.md)。',
        ].join('\n');
      }

      const votes = await mapWithLimit(chosen, limit, (councilor) => ask(councilor, question, context));

      if (votes.every((vote) => vote.failed === true)) {
        return [
          `多模型共识没跑成 —— ${votes.length} 家都没答上来:`,
          '',
          ...votes.map((vote) => `【${vote.id}】${vote.text}`),
        ].join('\n');
      }

      const synthesis = await synthesize(question, votes, context);
      const totalTokens = votes.reduce((sum, vote) => sum + vote.tokens, 0) + synthesis.tokens;

      return renderCouncilReport(question, votes, synthesis.result, totalTokens);
    },
  };
}
