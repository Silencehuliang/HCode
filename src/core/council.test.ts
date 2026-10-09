import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COUNCIL_OUTPUT_FIELDS,
  MIN_COUNCILORS,
  expandCouncilMention,
  renderCouncilNote,
  renderCouncilReport,
  synthesisFailure,
  synthesisPrompt,
  type CouncilVote,
} from './council.js';

const VOTE_A: CouncilVote = { id: 'glm', model: 'glm-5.3', text: '结论:能跑,但要把重试上限写死。', tokens: 1200 };
const VOTE_B: CouncilVote = { id: 'deepseek', model: 'deepseek-chat', text: '结论:不要重试,改成快速失败。', tokens: 800 };

test('两家都问到的报告里,各家的回答是原样的一段', () => {
  const report = renderCouncilReport('这个重试策略有没有问题?', [VOTE_A, VOTE_B], {
    ok: true,
    value: { 共识: '重试要有上限', 分歧: ['glm 认为要重试,deepseek 认为要快速失败'] },
  }, 3000);

  assert.match(report, /同时问了 2 家/);
  assert.match(report, /问题:这个重试策略有没有问题\?/);

  // 各家原话逐字在报告里 —— 不是摘要。用户得能自己复核合成本身有没有歪。
  assert.ok(report.includes(VOTE_A.text));
  assert.ok(report.includes(VOTE_B.text));
  assert.match(report, /【glm · glm-5\.3】/);
  assert.match(report, /【deepseek · deepseek-chat】/);
});

test('合成报告的两节按约定渲染,数组按条目排', () => {
  const report = renderCouncilReport('问一句', [VOTE_A, VOTE_B], {
    ok: true,
    value: { 共识: ['重试要有上限', '都要能观测'], 分歧: 'glm 主张重试、deepseek 主张快速失败' },
  }, 2600);

  assert.match(report, /合成报告:/);
  assert.match(report, /共识:\n- 重试要有上限\n- 都要能观测/);
  assert.match(report, /分歧:glm 主张重试、deepseek 主张快速失败/);
  assert.match(report, /合计 ~2\.6k token/);
});

test('某一节是空的时候如实说它空,不替模型编', () => {
  const report = renderCouncilReport('问一句', [VOTE_A, VOTE_B], { ok: true, value: { 共识: '  ', 分歧: [] } }, 10);

  assert.match(report, /共识:\(这一节是空的\)/);
  assert.match(report, /分歧:\(这一节是空的\)/);
  // 不足 1000 就不折算成 k —— 小数额折算了反而看不清是几位数。
  assert.match(report, /合计 ~10 token/);
});

test('合成没按约定交时,报告里放的是原文,不是一句"失败了"', () => {
  const failure = synthesisFailure(['分歧'], '我觉得大家都说得有道理。');
  const report = renderCouncilReport('问一句', [VOTE_A, VOTE_B], { ok: false, text: failure }, 900);

  assert.match(report, /记录员两次都没有按约定给报告\(缺 分歧\)/);
  assert.ok(report.includes('我觉得大家都说得有道理。'));
  // 各家的原话仍然在 —— 合成没交不代表这一趟白跑。
  assert.ok(report.includes(VOTE_A.text));
});

test('交给记录员的 prompt 里:问题、各家原话、输出约定都在', () => {
  const prompt = synthesisPrompt('要不要拆成两个包?', [VOTE_A, VOTE_B]);

  assert.ok(prompt.includes('要不要拆成两个包?'));
  assert.ok(prompt.includes('【glm · glm-5.3】\n结论:能跑,但要把重试上限写死。'));
  for (const field of COUNCIL_OUTPUT_FIELDS) assert.ok(prompt.includes(`- ${field}`), `约定里要点到 ${field}`);
  assert.match(prompt, /这个 JSON 之外不要再写别的/);
  // 实测抓到过:只说"字段是 共识/分歧",记录员会把每一节写成对象数组,报告里就是
  // 一坨 {"点":"…","说明":"…"} 的原始 JSON。所以约定里必须点名"短句的列表"。
  assert.match(prompt, /两节都写成短句的列表/);
});

test('没答上来的那家,在交给记录员的 prompt 里被标明过', () => {
  const failed: CouncilVote = { id: 'claude', model: 'claude-sonnet-5-5', text: '这一家没答上来 —— 余额不足', tokens: 0, failed: true };
  const prompt = synthesisPrompt('问一句', [VOTE_A, failed]);

  assert.match(prompt, /【claude · claude-sonnet-5-5】\(这一家没答上来\)/);
  assert.ok(prompt.includes('这一家没答上来 —— 余额不足'));
});

test('能把哪几家告诉模型 —— 少于两家什么也不说', () => {
  assert.equal(renderCouncilNote(['glm']), '', '一家谈不上共识:提了只会让模型去试一个注定没意义的工具');
  assert.equal(renderCouncilNote([]), '');

  const note = renderCouncilNote(['glm', 'deepseek', 'claude']);
  assert.match(note, /council 工具/);
  assert.match(note, /现在能问:glm、deepseek、claude/);
  // "议员没有工具"这条必须写在提醒里:这是这个功能最容易被用错的地方。
  assert.match(note, /看不到你的工作区/);
  assert.match(note, /@council/);
});

test('@council 展开成"让主对话去调工具",并带上问题', () => {
  const expanded = expandCouncilMention('@council 这个重试策略有没有并发上的坑');

  assert.equal(expanded.kind, 'mention');
  assert.ok(expanded.kind === 'mention');
  assert.match(expanded.text, /council 工具/);
  assert.match(expanded.text, /这个重试策略有没有并发上的坑/);
  assert.match(expanded.text, /没有工具/);
});

test('@council 不带问题就地报错,不发给模型', () => {
  for (const line of ['@council', '@council   ', '@COUNCIL']) {
    const expanded = expandCouncilMention(line);
    assert.equal(expanded.kind, 'empty', `${line} 应当被认出来并要一个问题`);
    assert.ok(expanded.kind === 'empty');
    assert.match(expanded.message, /后面要带上问题/);
  }
});

test('不是 @council 的行一律原样放过', () => {
  for (const line of ['@reviewer 看一下', 'council 是什么', '@councilx 问题', '随便说点什么']) {
    assert.equal(expandCouncilMention(line).kind, 'plain', `${line} 不该被当成 @council`);
  }

  // @council 夹在句中不算点名 —— 只有行首才是。
  assert.equal(expandCouncilMention('我说 @council 这个工具挺好').kind, 'plain');
});

test('至少两家才叫共识 —— 这个阈值只有一个来源', () => {
  assert.equal(MIN_COUNCILORS, 2);
});
