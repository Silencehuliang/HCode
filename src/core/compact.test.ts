import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compact } from './compact.js';
import type { Message } from '../provider/types.js';

/** 粗略按 4 字符 1 token 估。测试里用它把预算卡到确定的点上,不需要真分词器。 */
function estimate(messages: Message[]): number {
  let chars = 0;
  for (const message of messages) {
    if (message.role === 'user') chars += message.text.length;
    else if (message.role === 'assistant') chars += message.text?.length ?? 0;
    else for (const result of message.results) chars += result.output.length;
  }
  return Math.ceil(chars / 4);
}

function deps(budget: number, summarize: (prompt: string) => Promise<string>) {
  return { estimate, budget, summarize };
}

const noSummary = async (): Promise<string> => {
  throw new Error('不该走到生成摘要这一步');
};

/** 一轮"用户提问 → 模型调工具 → 工具返回一坨输出"。 */
function exchange(tag: string, outputChars: number): Message[] {
  return [
    { role: 'user', text: `${tag} 的提问` },
    {
      role: 'assistant',
      text: null,
      toolCalls: [{ id: `call-${tag}`, name: 'read_file', input: { path: `${tag}.ts` } }],
    },
    { role: 'tool', results: [{ id: `call-${tag}`, output: 'x'.repeat(outputChars) }] },
  ];
}

test('没超预算时原样返回,不去打扰模型', async () => {
  const messages = exchange('a', 40);

  const result = await compact(messages, deps(10_000, noSummary));

  assert.equal(result.did, 'none');
  assert.deepEqual(result.messages, messages, '没超限就动它,只会白白损失保真度');
});

test('超预算时先裁旧的工具输出 —— 而不是直接丢最近的对话', async () => {
  const messages = [
    ...exchange('a', 4_000),
    ...exchange('b', 4_000),
    ...exchange('c', 4_000),
    ...exchange('d', 4_000),
  ];

  const result = await compact(messages, deps(1_500, noSummary));

  assert.equal(result.did, 'trimmed');
  assert.equal(result.messages.length, messages.length, '丢消息是最后手段,不是第一步');
});

test('裁剪保留最近几次工具输出原样,只动更早的', async () => {
  const messages = [
    ...exchange('a', 4_000),
    ...exchange('b', 4_000),
    ...exchange('c', 4_000),
    ...exchange('d', 4_000),
  ];

  const result = await compact(messages, deps(1_500, noSummary));

  const outputs = result.messages
    .filter((message) => message.role === 'tool')
    .map((message) => (message.role === 'tool' ? message.results[0]!.output : ''));

  assert.ok(
    outputs[3]!.length > 1_000,
    `最近一次的工具输出要原样留着 —— 那多半正是模型此刻在用的。实际长度:${outputs[3]!.length}`,
  );
  assert.ok(
    outputs[0]!.length < 200,
    `最早那次要能压下去,否则根本省不出空间。实际长度:${outputs[0]!.length}`,
  );
});

test('裁掉的内容说得清自己是什么,而不是变成空串', async () => {
  const messages = [...exchange('a', 4_000), ...exchange('b', 4_000), ...exchange('c', 4_000)];

  const result = await compact(messages, deps(1_200, noSummary));
  const first = result.messages.find((message) => message.role === 'tool');

  assert.ok(first?.role === 'tool');
  assert.match(
    first.results[0]!.output,
    /省略|压缩|已裁/,
    `要留一句话说明这里原本有东西,否则模型会以为工具什么都没返回。实际:${first.results[0]!.output}`,
  );
  assert.match(first.results[0]!.output, /4000/, '要说明省略了多少,它才知道该不该重跑一次');
});

test('裁剪不碰消息结构 —— 工具调用和它的结果不能被拆开', async () => {
  const messages = [...exchange('a', 4_000), ...exchange('b', 4_000), ...exchange('c', 4_000)];

  const result = await compact(messages, deps(1_200, noSummary));

  assert.deepEqual(
    result.messages.map((message) => message.role),
    messages.map((message) => message.role),
    '少一条或多一条,厂商接口就会因为 tool_call 找不到配对而报错',
  );

  for (const message of result.messages) {
    if (message.role !== 'assistant') continue;
    const call = message.toolCalls?.[0];
    if (!call) continue;
    const paired = result.messages.some(
      (candidate) =>
        candidate.role === 'tool' && candidate.results.some((entry) => entry.id === call.id),
    );
    assert.ok(paired, `工具调用 ${call.id} 的结果不在了`);
  }
});

test('裁完仍然超限时,才去生成历史摘要', async () => {
  const messages = [
    ...exchange('a', 4_000),
    ...exchange('b', 4_000),
    ...exchange('c', 4_000),
    ...exchange('d', 4_000),
  ];

  let prompts: string[] = [];
  const result = await compact(
    messages,
    deps(300, async (prompt) => {
      prompts.push(prompt);
      return '之前查过 a.ts 和 b.ts,结论是配置读不出来是因为 BOM。';
    }),
  );

  assert.equal(result.did, 'summarized');
  assert.equal(prompts.length, 1, '摘要最多生成一次');
  assert.match(prompts[0]!, /a\.ts|read_file/, '要给模型真正的对话原文,不能只给个"请总结"');
});

test('摘要有明确的保留要求 —— 关键结论不能在压缩里丢掉', async () => {
  const messages = [...exchange('a', 4_000), ...exchange('b', 4_000), ...exchange('c', 4_000)];

  let prompt = '';
  await compact(
    messages,
    deps(200, async (text) => {
      prompt = text;
      return '摘要';
    }),
  );

  for (const must of ['结论', '文件', '要求']) {
    assert.match(
      prompt,
      new RegExp(must),
      `摘要提示必须点名要保留"${must}" —— 这正是验收里"压缩后仍能引用之前的结论"所依赖的`,
    );
  }
});

test('摘要落地后,最近几轮原样保留,旧对话换成那一条摘要', async () => {
  const messages = [
    ...exchange('a', 4_000),
    ...exchange('b', 4_000),
    ...exchange('c', 4_000),
    ...exchange('d', 4_000),
  ];

  const result = await compact(
    messages,
    deps(200, async () => '之前的结论:配置读取要先剥掉 BOM。'),
  );

  const text = result.messages.map((message) => JSON.stringify(message)).join('\n');

  assert.match(text, /BOM/, '摘要本身要真的进到对话里');
  assert.match(text, /d 的提问/, '最近一轮要原样留着 —— 模型得接着它继续干活');
  assert.ok(
    result.messages.length < messages.length,
    '摘要这一步的目的是真的把消息条数降下来',
  );
});

test('摘要的切割点落在用户消息上 —— 不会把一次工具调用和它的结果劈开', async () => {
  const messages = [
    ...exchange('a', 4_000),
    ...exchange('b', 4_000),
    ...exchange('c', 4_000),
    ...exchange('d', 4_000),
    ...exchange('e', 4_000),
  ];

  const result = await compact(messages, deps(200, async () => '摘要'));

  // 第 0 条是摘要本身;保留段从它之后开始。
  const kept = result.messages.slice(1);
  assert.ok(kept.length > 0, '保留段不能是空的,否则压缩把最近的活儿也一起吃了');
  assert.equal(
    kept[0]!.role,
    'user',
    `保留段从 ${kept[0]!.role} 开始 —— 一次工具调用和它的结果被劈开了,接口会直接报错`,
  );

  // 而且保留段内部仍然自洽:每个 tool 结果都能在它前面找到对应的 tool_call。
  const seen = new Set<string>();
  for (const message of result.messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) seen.add(call.id);
    }
    if (message.role === 'tool') {
      for (const entry of message.results) {
        assert.ok(seen.has(entry.id), `保留段里出现了没有对应 tool_call 的结果:${entry.id}`);
      }
    }
  }
});
