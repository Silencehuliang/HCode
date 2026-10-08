import { test } from 'node:test';
import assert from 'node:assert/strict';

import { banner, platformRefusal, redactProxy } from './startup.js';
import type { Session } from './config.js';

const base: Session = {
  providerId: 'glm',
  model: 'glm-5.3',
  apiKey: 'sk-secret-key',
};

test('横幅写明当前用的是哪一家、哪个模型', () => {
  const text = banner({ ...base, baseUrl: 'http://127.0.0.1:7863/v1' }, []);

  assert.match(text, /glm \/ glm-5\.3/);
  assert.match(text, /http:\/\/127\.0\.0\.1:7863\/v1/);
});

test('横幅里没有密钥', () => {
  const text = banner(base, []);

  assert.doesNotMatch(
    text,
    /sk-secret-key/,
    '横幅会留在终端回滚缓冲里,也会被截图贴进 issue —— 密钥不能进去',
  );
});

test('没配代理和思维链时不占两行', () => {
  const text = banner(base, []);

  assert.doesNotMatch(text, /代理/);
  assert.doesNotMatch(text, /思维链/);
});

test('配了代理就显示,但凭据换成星号', () => {
  const text = banner({ ...base, proxy: 'http://someone:hunter2@127.0.0.1:7890' }, []);

  assert.match(text, /代理:/);
  assert.match(text, /127\.0\.0\.1:7890/, '主机端口要留着 —— 用户得看得出连的是哪个代理');
  assert.doesNotMatch(text, /hunter2/);
  assert.doesNotMatch(text, /someone/);
});

test('代理地址写坏时原样显示,不装作没有', () => {
  // 解析不了说明地址本身有问题。藏起来的话,用户会以为代理配上了。
  assert.equal(redactProxy('这不是一个地址'), '这不是一个地址');
});

test('代理地址没凭据时一个字都不改', () => {
  assert.match(redactProxy('http://127.0.0.1:7890'), /127\.0\.0\.1:7890/);
});

test('Windows 上不拦', () => {
  assert.equal(platformRefusal('win32'), undefined);
});

test('别的平台上给出能读懂的理由,而不是让模型去撞 ENOENT', () => {
  const refusal = platformRefusal('linux');

  assert.equal(typeof refusal, 'string');
  assert.match(refusal ?? '', /linux/, '要说清当前是什么平台');
  assert.match(refusal ?? '', /powershell\.exe/i, '要说清缺的是什么');
});
