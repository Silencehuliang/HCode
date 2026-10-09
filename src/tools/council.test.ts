import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createCouncilTool } from './council.js';
import type { SubagentDoneEvent } from '../core/tool.js';
import type { Provider, ProviderRequest, ProviderResponse } from '../provider/types.js';

/** 一个按脚本回答的适配器。脚本用完就抛 —— 静默返回空话会让"少问了一家"看不出来。 */
function scripted(
  id: string,
  model: string,
  responses: (ProviderResponse | Error)[],
  delayMs = 0,
): { provider: Provider; requests: ProviderRequest[] } {
  const queue = [...responses];
  const requests: ProviderRequest[] = [];

  return {
    requests,
    provider: {
      id,
      model,
      async send(request) {
        requests.push({ ...request, messages: structuredClone(request.messages) });
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        const next = queue.shift();
        if (!next) throw new Error(`脚本用完了(${id})`);
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
}

function answer(text: string): ProviderResponse {
  return { text, toolCalls: [] };
}

function objection(共识: string, 分歧: string): ProviderResponse {
  return answer(JSON.stringify({ 共识, 分歧 }));
}

function question(request: ProviderRequest): string {
  const first = request.messages[0];
  return first?.role === 'user' ? first.text : '(第一条不是用户消息)';
}

test('几家并行问、拿到的是逐字同一份问题、都没有工具', async () => {
  // glm 慢、deepseek 快 —— 报告里的次序仍按配置里的家序,不按谁先回来。
  const glm = scripted('glm', 'glm-5.3', [answer('glm 的结论')], 25);
  const deepseek = scripted('deepseek', 'deepseek-chat', [answer('deepseek 的结论')]);
  const synth = scripted('main', 'glm-5.3', [objection('都同意要先量一下', 'glm 主张重试、deepseek 主张快速失败')]);

  const tool = createCouncilTool({
    councilors: [
      { id: 'glm', provider: glm.provider },
      { id: 'deepseek', provider: deepseek.provider },
    ],
    synthesizer: synth.provider,
  });

  const out = await tool.run({ question: '这个重试策略有没有并发上的坑?' });

  assert.ok(out.includes('【glm · glm-5.3】\nglm 的结论'), 'glm 的结论要在报告里');
  assert.ok(out.includes('【deepseek · deepseek-chat】\ndeepseek 的结论'));
  assert.ok(out.indexOf('【glm') < out.indexOf('【deepseek'), '次序该是配置里的家序,不是跑完的先后');

  assert.equal(question(glm.requests[0]!), '这个重试策略有没有并发上的坑?');
  assert.equal(question(deepseek.requests[0]!), '这个重试策略有没有并发上的坑?', '两家必须拿到逐字同一份问题');

  assert.equal(glm.requests[0]!.tools.length, 0, '议员没有工具 —— 这是他们的隔离');
  assert.equal(synth.requests[0]!.tools.length, 0, '记录员也没有工具');
  assert.match(glm.requests[0]!.system, /你没有工具/);
});

test('几家确实是同时问的,不是排队问的', async () => {
  let inFlight = 0;
  let peak = 0;

  const company = (id: string): Provider => ({
    id,
    model: id,
    async send() {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight--;
      return answer(`${id} 的结论`);
    },
  });

  const synth = scripted('main', 'glm-5.3', [objection('a', 'b')]);
  const tool = createCouncilTool({
    councilors: [
      { id: 'glm', provider: company('glm') },
      { id: 'deepseek', provider: company('deepseek') },
      { id: 'claude', provider: company('claude') },
    ],
    synthesizer: synth.provider,
  });

  await tool.run({ question: '问一句' });

  assert.equal(peak, 3, '三家该是同时在飞的 —— 串行问三家只是花三倍时间,没有任何好处');
});

test('合成报告标出各家一致与分歧,并把总数点出来', async () => {
  const glm = scripted('glm', 'glm-5.3', [answer('结论:能跑。')]);
  const deepseek = scripted('deepseek', 'deepseek-chat', [answer('结论:别这么干。')]);
  const synth = scripted('main', 'glm-5.3', [answer('```json\n{"共识":"都要有上限","分歧":["一个主张能跑,一个主张别干"]}\n```')]);

  const tool = createCouncilTool({
    councilors: [
      { id: 'glm', provider: glm.provider },
      { id: 'deepseek', provider: deepseek.provider },
    ],
    synthesizer: synth.provider,
  });

  const out = await tool.run({ question: '问一句' });

  // 围栏里抠出来的 JSON 也算交差(extractJsonObject 的三层兜底)。
  assert.match(out, /共识:都要有上限/);
  assert.match(out, /分歧:\n- 一个主张能跑,一个主张别干/);
  assert.match(out, /合计 ~\d+ token/);
});

test('合成本身有输出约定:缺字段重试一次,再不合格就把原文放回来', async () => {
  const glm = scripted('glm', 'glm-5.3', [answer('glm 的结论')]);
  const deepseek = scripted('deepseek', 'deepseek-chat', [answer('deepseek 的结论')]);
  const synth = scripted('main', 'glm-5.3', [
    answer('我觉得大家都说得有道理,不过要分情况看。'),
    answer('还是不给 JSON,我就是想说大家都有道理。'),
  ]);

  const tool = createCouncilTool({
    councilors: [
      { id: 'glm', provider: glm.provider },
      { id: 'deepseek', provider: deepseek.provider },
    ],
    synthesizer: synth.provider,
  });

  const out = await tool.run({ question: '问一句' });

  assert.equal(synth.requests.length, 2, '只重试一次 —— 再拉长就成了反复讨要');
  assert.match(question(synth.requests[1]!), /只回一个 JSON 对象/);
  assert.match(out, /记录员两次都没有按约定给报告\(缺 共识、分歧\)/);
  assert.ok(out.includes('还是不给 JSON,我就是想说大家都有道理。'), '原文照传,人还能自己看');
  assert.ok(out.includes('glm 的结论'), '合成没交不代表这一趟白跑:各家的原话照旧在报告里');
});

test('一家没答上来,别家照常,报告里如实标出那一家', async () => {
  const glm = scripted('glm', 'glm-5.3', [new Error('余额不足')]);
  const deepseek = scripted('deepseek', 'deepseek-chat', [answer('deepseek 的结论')]);
  const synth = scripted('main', 'glm-5.3', [objection('a', 'b')]);

  const tool = createCouncilTool({
    councilors: [
      { id: 'glm', provider: glm.provider },
      { id: 'deepseek', provider: deepseek.provider },
    ],
    synthesizer: synth.provider,
  });

  const out = await tool.run({ question: '问一句' });

  assert.ok(out.includes('这一家没答上来 —— 余额不足'));
  assert.ok(out.includes('deepseek 的结论'));
  assert.equal(synth.requests.length, 1, '一家挂了不该让整场垮掉:剩下的照旧合成');
  // 厂商原话进 prompt 时标了"这一家没答上来",不然记录员会把它当成一份观点。
  assert.match(question(synth.requests[0]!), /\(这一家没答上来\)/);
});

test('全部没答上来就说没跑成,不去合成', async () => {
  const glm = scripted('glm', 'glm-5.3', [new Error('余额不足')]);
  const deepseek = scripted('deepseek', 'deepseek-chat', [new Error('连不上')]);
  const synth = scripted('main', 'glm-5.3', [objection('a', 'b')]);

  const tool = createCouncilTool({
    councilors: [
      { id: 'glm', provider: glm.provider },
      { id: 'deepseek', provider: deepseek.provider },
    ],
    synthesizer: synth.provider,
  });

  const out = await tool.run({ question: '问一句' });

  assert.match(out, /多模型共识没跑成 —— 2 家都没答上来/);
  assert.match(out, /【glm】这一家没答上来 —— 余额不足/);
  assert.match(out, /【deepseek】这一家没答上来 —— 连不上/);
  assert.equal(synth.requests.length, 0, '没有一份回答可合成时,别拿空料去问记录员');
});

test('每家(含合成)各报一条成本行,谁花了多少看得见', async () => {
  const glm = scripted('glm', 'glm-5.3', [answer('glm 的结论')]);
  const deepseek = scripted('deepseek', 'deepseek-chat', [answer('deepseek 的结论')]);
  const synth = scripted('main', 'glm-5.3', [objection('a', 'b')]);

  const tool = createCouncilTool({
    councilors: [
      { id: 'glm', provider: glm.provider },
      { id: 'deepseek', provider: deepseek.provider },
    ],
    synthesizer: synth.provider,
  });

  const events: SubagentDoneEvent[] = [];
  await tool.run({ question: '问一句' }, { emit: (event) => events.push(event) });

  assert.deepEqual(
    events.map((event) => event.agent),
    ['council:glm', 'council:deepseek', '合成'],
  );
  assert.equal(events[0]!.model, 'glm-5.3');
  assert.ok(events[0]!.tokens > 0, 'token 数是估算,但不能是 0 —— 那是"没花钱"的意思');
});

test('只点一家时当场拒绝,并说清怎么再加一家', async () => {
  const glm = scripted('glm', 'glm-5.3', [answer('glm 的结论')]);
  const deepseek = scripted('deepseek', 'deepseek-chat', [answer('deepseek 的结论')]);
  const synth = scripted('main', 'glm-5.3', [objection('a', 'b')]);

  const tool = createCouncilTool({
    councilors: [
      { id: 'glm', provider: glm.provider },
      { id: 'deepseek', provider: deepseek.provider },
    ],
    synthesizer: synth.provider,
  });

  const out = await tool.run({ question: '问一句', providers: ['glm'] });

  assert.match(out, /至少要问 2 家/);
  assert.match(out, /settings\.json/);
  assert.equal(glm.requests.length, 0, '拒的时候一次都不该问出去');
});

test('点了没配密钥的家,报错并列出能问的', async () => {
  const glm = scripted('glm', 'glm-5.3', [answer('glm 的结论')]);
  const deepseek = scripted('deepseek', 'deepseek-chat', [answer('deepseek 的结论')]);
  const synth = scripted('main', 'glm-5.3', [objection('a', 'b')]);

  const tool = createCouncilTool({
    councilors: [
      { id: 'glm', provider: glm.provider },
      { id: 'deepseek', provider: deepseek.provider },
    ],
    synthesizer: synth.provider,
  });

  const out = await tool.run({ question: '问一句', providers: ['glm', 'kimi'] });

  assert.match(out, /没有配 kimi 这一家的密钥/);
  assert.match(out, /现在能问的是:glm、deepseek/);
  assert.equal(glm.requests.length, 0, '参数有错就别发起一半再报错');
});

test('providers 写坏了(不是数组)也当场说清', async () => {
  const glm = scripted('glm', 'glm-5.3', [answer('glm 的结论')]);
  const synth = scripted('main', 'glm-5.3', [objection('a', 'b')]);

  const tool = createCouncilTool({ councilors: [{ id: 'glm', provider: glm.provider }], synthesizer: synth.provider });

  const out = await tool.run({ question: '问一句', providers: 'glm' });
  assert.match(out, /providers 要是一个家名的数组/);

  const empty = await tool.run({ question: '  ' });
  assert.match(empty, /question 要是一句非空的问题/);
});

test('工具说明里写明了两件最容易用错的事', () => {
  const glm = scripted('glm', 'glm-5.3', [answer('x')]);
  const deepseek = scripted('deepseek', 'deepseek-chat', [answer('y')]);
  const synth = scripted('main', 'glm-5.3', [objection('a', 'b')]);

  const tool = createCouncilTool({
    councilors: [
      { id: 'glm', provider: glm.provider },
      { id: 'deepseek', provider: deepseek.provider },
    ],
    synthesizer: synth.provider,
  });

  assert.equal(tool.spec.name, 'council');
  assert.match(tool.spec.description, /没有工具/, '"议员看不到工作区、材料要自己贴"是必须写进说明的一条');
  assert.match(tool.spec.description, /glm、deepseek/);

  const schema = tool.spec.inputSchema as { required?: string[]; properties?: Record<string, unknown> };
  assert.deepEqual(schema.required, ['question']);
  assert.ok(schema.properties?.['providers'], 'providers 是可选参数,得在 schema 里');
});
