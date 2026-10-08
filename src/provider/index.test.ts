import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createProvider } from './index.js';
import { glmText } from './fixtures/glm.js';
import { claudeText } from './fixtures/claude.js';

/**
 * Provider 工厂。
 *
 * 这里对着**真的 socket** 测,不用假 transport —— 工厂唯一多做的事就是"给每家各造
 * 一个 transport,代理挂在自己那个上面",而这件事只有真的发出去一次才看得出来。
 */

/** 起一个本地服务,记下每一次收到的请求路径。 */
async function listen(reply: unknown): Promise<{
  url: string;
  paths: string[];
  close: () => Promise<void>;
}> {
  const paths: string[] = [];
  const server: Server = createServer((request, response) => {
    paths.push(request.url ?? '');
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(reply));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        // 兜底:客户端被 destroy 之后 net.Server 仍可能把连接算在账上,'close'
        // 事件就永远不来 —— 收尾不该成为测试挂起的原因。
        const timer = setTimeout(resolve, 300);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
      }),
  };
}

test('三家都在,而且认得自己的名字', () => {
  const choice = { model: '随便一个模型', apiKey: '测试密钥' };

  assert.equal(createProvider({ ...choice, providerId: 'glm' }).id, 'glm');
  assert.equal(createProvider({ ...choice, providerId: 'deepseek' }).id, 'deepseek');
  assert.equal(createProvider({ ...choice, providerId: 'claude' }).id, 'claude');

  assert.equal(createProvider({ ...choice, providerId: 'glm' }).model, '随便一个模型');
});

test('配置里的 provider 写错了,报错要把能填的列出来', () => {
  assert.throws(
    () => createProvider({ providerId: 'gml', model: 'm', apiKey: 'k' }),
    (error: Error) => {
      assert.match(error.message, /gml/, '回显用户写的那个值,他才知道自己写的是哪个');
      assert.match(error.message, /glm/);
      assert.match(error.message, /deepseek/);
      assert.match(error.message, /claude/);
      return true;
    },
    '只说"不认识的 provider",用户只能去翻源码',
  );
});

test('代理按家生效:给 Claude 配了代理,GLM 的请求不会跟着绕过去', async (t) => {
  const proxy = await listen(claudeText);
  const glmServer = await listen(glmText);
  t.after(async () => {
    await proxy.close();
    await glmServer.close();
  });

  // Claude 的"目标地址"故意指向一个不存在的地方 —— 它一次都不该被真的拨号,
  // 请求只能从代理出去。GLM 那家则直连本地服务。
  // 密钥这里必须是 ASCII。HTTP 头的值只能是 Latin-1,写中文密钥 Node 会在
  // 发请求之前就抛 ERR_INVALID_CHAR —— 而真实密钥本来就是 ASCII,所以这只影响
  // 测试怎么写。另外几个测试用的是假 transport,不经过 Node 的头校验,所以那里
  // 写中文密钥看不出来。
  const claude = createProvider({
    providerId: 'claude',
    model: 'claude-sonnet-5-5',
    apiKey: 'claude-key',
    baseUrl: 'http://10.255.255.1:9/',
    proxy: proxy.url,
  });
  const glm = createProvider({
    providerId: 'glm',
    model: 'glm-5.3',
    apiKey: 'glm-key',
    baseUrl: `${glmServer.url}/v1`,
  });

  const claudeReply = await claude.send({ system: 'sys', messages: [], tools: [] });
  const glmReply = await glm.send({ system: 'sys', messages: [], tools: [] });

  assert.equal(claudeReply.text, '收到');
  assert.equal(glmReply.text, '收到');

  assert.deepEqual(
    proxy.paths,
    ['http://10.255.255.1:9/v1/messages'],
    '走代理时交给代理的是完整地址(http 目标不必建隧道),代理据此自己再去连目标',
  );
  assert.deepEqual(
    glmServer.paths,
    ['/v1/chat/completions'],
    'GLM 这家没配代理,就得直连 —— 用国产模型的人多半没有代理,更不该被迫绕到国外去',
  );
});
