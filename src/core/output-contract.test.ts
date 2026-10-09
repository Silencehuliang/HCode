import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkOutput,
  contractFailure,
  contractInstruction,
  extractJsonObject,
  retryInstruction,
} from './output-contract.js';

test('extractJsonObject:裸 JSON / 围栏 / 前后夹散文 / 根本不是 JSON', () => {
  assert.deepEqual(extractJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('```\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJsonObject('这是我的结论:\n{"a":1}\n希望有帮助。'), { a: 1 });

  assert.equal(extractJsonObject('没有 JSON'), undefined);
  assert.equal(extractJsonObject('{坏掉的'), undefined);
  // 数组不算 —— 约定说的是"一个对象"。
  assert.equal(extractJsonObject('[1,2]'), undefined);
  assert.equal(extractJsonObject('"就一个字符串"'), undefined);
});

test('checkOutput:只看键在不在,不看类型/值', () => {
  const ok = checkOutput('{"结论":"在 a.ts","风险":null}', ['结论', '风险']);
  assert.equal(ok.ok, true);

  // 空串 / null / 类型不对 —— 都算键在。空串是模型在说"这一项没有"。
  assert.equal(checkOutput('{"结论":""}', ['结论']).ok, true);
  assert.equal(checkOutput('{"结论":42}', ['结论']).ok, true);
  assert.equal(checkOutput('{"结论":{},"风险":[]}', ['结论', '风险']).ok, true);

  const missing = checkOutput('{"结论":"在 a.ts"}', ['结论', '风险', '下一步']);
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.deepEqual(missing.missing, ['风险', '下一步']);
  assert.match(missing.reason, /风险/);
});

test('checkOutput:没有 JSON 时,缺的是全部字段(而不是空数组)', () => {
  const check = checkOutput('我觉得应该在 a.ts 里。', ['结论', '风险']);
  assert.equal(check.ok, false);
  if (check.ok) return;
  assert.deepEqual(check.missing, ['结论', '风险'], '缺的是全部 —— 不然重试的话会漏掉字段');
  assert.match(check.reason, /JSON/);
});

test('约定与重试的话都把字段点名列清', () => {
  const instruction = contractInstruction(['结论', '风险']);
  assert.match(instruction, /结论/);
  assert.match(instruction, /风险/);
  assert.match(instruction, /JSON/);

  const retry = retryInstruction(['风险']);
  assert.match(retry, /风险/);
  assert.match(retry, /JSON/);
});

test('两次都没交货:回给主对话的话带上原文,不吞掉', () => {
  const text = contractFailure('reviewer', ['风险'], '我觉得还行吧。');
  assert.match(text, /reviewer/);
  assert.match(text, /风险/);
  assert.match(text, /我觉得还行吧。/);
});
