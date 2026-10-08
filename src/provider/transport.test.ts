// 这一行只为测试而设:下面那个 https 服务用的是本仓库自带的**测试用**自签证书
// (src/provider/testing/self-signed.ts),任何一台机器上都签不出一个真能被信任的。除此之外
// 这个进程里没有任何 TLS 连接,所以关掉的校验面是零。
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, connect as netConnect } from 'node:net';
import type { AddressInfo } from 'node:net';

import { createHttpTransport } from './transport.js';
import { SELF_SIGNED_CERT as CERT, SELF_SIGNED_KEY as KEY } from './testing/self-signed.js';

/** http 服务与 net 服务都长这样。写成一个类型,免得在每个调用点各转一次。 */
type Listenable = {
  listen(port: number, host: string, callback: () => void): unknown;
  address(): AddressInfo | string | null;
  close(callback?: (error?: Error) => void): unknown;
};

async function listen(server: Listenable): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('没拿到监听端口');
  return address.port;
}

/**
 * 关掉一个测试服务。
 *
 * 先掐掉还开着的连接:`server.close()` 只停止接受新连接,已经建立的要等它们自己
 * 结束,而隧道那两条连接会一直开着。
 *
 * 再加一道兜底。实测:客户端被 destroy 之后,`net.Server` 仍把那条连接算在账上
 * (`_connections` 不归零),于是 `close` 事件永远不来,整个测试文件挂死在那儿。
 * 收尾不该成为测试挂起的原因,所以最多等 300 毫秒。
 */
async function close(server: Listenable): Promise<void> {
  (server as { closeAllConnections?(): void }).closeAllConnections?.();
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 300);
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 一个本地服务:记下收到的请求,原样回一段 JSON。 */
function createEchoServer(): {
  server: Listenable;
  seen: { path?: string | undefined; headers?: Record<string, unknown> | undefined; body: string };
} {
  const seen: {
    path?: string | undefined;
    headers?: Record<string, unknown> | undefined;
    body: string;
  } = { body: '' };

  const server = createHttpServer((request, response) => {
    seen.path = request.url;
    seen.headers = request.headers as Record<string, unknown>;
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    request.on('end', () => {
      seen.body = body;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"收到":true}');
    });
  });

  return { server, seen };
}

test('直连:地址、请求头与请求体原样送到,响应原样回来', async () => {
  const { server, seen } = createEchoServer();
  const port = await listen(server);
  try {
    const response = await createHttpTransport()({
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test-key' },
      body: '{"model":"glm-5.3"}',
    });

    assert.equal(response.status, 200);
    assert.equal(response.body, '{"收到":true}');
    assert.equal(seen.path, '/v1/chat/completions');
    assert.equal(seen.headers!['authorization'], 'Bearer sk-test-key');
    assert.equal(seen.body, '{"model":"glm-5.3"}');
  } finally {
    await close(server);
  }
});

test('给了代理就走代理 —— 而且是这一家自己的代理,不是全局环境变量', async () => {
  const { server, seen } = createEchoServer();
  const port = await listen(server);

  let sawAbsoluteUri: string | undefined;
  const proxy = createHttpServer((request, response) => {
    sawAbsoluteUri = request.url;
    const upstream = httpRequest(
      request.url!,
      { method: 'POST', headers: { ...request.headers, host: new URL(request.url!).host } },
      (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers);
        reply.pipe(response);
      },
    );
    request.pipe(upstream);
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await createHttpTransport({
      proxy: `http://127.0.0.1:${proxyPort}`,
    })({
      url: `http://127.0.0.1:${port}/v1/chat/completions`,
      headers: { 'content-type': 'application/json' },
      body: '{"走":"代理"}',
    });

    assert.equal(
      sawAbsoluteUri,
      `http://127.0.0.1:${port}/v1/chat/completions`,
      '代理收到的是绝对地址,说明请求确实绕到了它这里',
    );
    assert.equal(response.status, 200);
    assert.equal(response.body, '{"收到":true}');
    assert.equal(seen.body, '{"走":"代理"}', '绕了一圈之后请求体还得是原来那份');
  } finally {
    await close(server);
    await close(proxy);
  }
});

test('https 目标经代理时建隧道,响应原样回来', async () => {
  const target = createHttpsServer({ key: KEY, cert: CERT }, (_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"来自":"隧道那头"}');
  });
  const targetPort = await listen(target);

  const connectLines: string[] = [];
  const proxy = createNetServer((client) => {
    let head = '';
    const onData = (chunk: Buffer) => {
      head += chunk.toString('latin1');
      if (!head.includes('\r\n\r\n')) return;
      client.off('data', onData);

      const requestLine = head.split('\r\n')[0]!;
      connectLines.push(requestLine);
      const authority = requestLine.split(' ')[1]!;
      const separator = authority.lastIndexOf(':');
      const upstream = netConnect(
        Number(authority.slice(separator + 1)),
        authority.slice(0, separator),
        () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          client.pipe(upstream);
          upstream.pipe(client);
        },
      );
      upstream.on('error', () => client.destroy());
    };
    client.on('data', onData);
  });
  const proxyPort = await listen(proxy);

  try {
    const response = await createHttpTransport({
      proxy: `http://127.0.0.1:${proxyPort}`,
    })({
      url: `https://127.0.0.1:${targetPort}/v1/messages`,
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-test' },
      body: '{"model":"claude-opus-5-5"}',
    });

    assert.deepEqual(connectLines, [`CONNECT 127.0.0.1:${targetPort} HTTP/1.1`]);
    assert.equal(response.status, 200);
    assert.equal(
      response.body,
      '{"来自":"隧道那头"}',
      '隧道建成之后 TLS 必须是通的 —— 只断言 CONNECT 通过了不算数',
    );
  } finally {
    await close(target);
    await close(proxy);
  }
});

test('代理拒绝建隧道时,报错说清是代理拒绝的,而不是"连接失败"', async () => {
  const proxy = createNetServer((client) => {
    client.once('data', () => {
      client.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      client.end();
    });
  });
  const proxyPort = await listen(proxy);

  try {
    await assert.rejects(
      () =>
        createHttpTransport({ proxy: `http://127.0.0.1:${proxyPort}` })({
          url: 'https://api.anthropic.com/v1/messages',
          headers: {},
          body: '{}',
        }),
      (error: Error) => {
        assert.match(error.message, /代理拒绝/);
        assert.match(error.message, /403/);
        assert.match(error.message, /api\.anthropic\.com:443/, '要说清是给谁建隧道被拒的');
        return true;
      },
    );
  } finally {
    await close(proxy);
  }
});

test('代理地址里带用户名密码时,认证头会带上', async () => {
  let authorization: string | undefined;
  const proxy = createHttpServer((request, response) => {
    authorization = request.headers['proxy-authorization'] as string | undefined;
    response.writeHead(200);
    response.end('ok');
  });
  const proxyPort = await listen(proxy);

  try {
    await createHttpTransport({
      proxy: `http://张三:p%40ss@127.0.0.1:${proxyPort}`,
    })({
      url: 'http://example.invalid/v1/chat/completions',
      headers: {},
      body: '{}',
    });

    assert.equal(
      authorization,
      `Basic ${Buffer.from('张三:p@ss').toString('base64')}`,
      '密码里的转义字符要还原 —— 否则谁都认证不过,而报错只会说 407',
    );
  } finally {
    await close(proxy);
  }
});

test('代理地址写错时,报错指出该怎么写', () => {
  assert.throws(
    () => createHttpTransport({ proxy: '127.0.0.1:7890' }),
    /代理地址读不出来.*http:\/\/127\.0\.0\.1:7890/s,
  );
});

test('目标不响应时按超时结束,不无限等下去', async () => {
  const server = createNetServer(() => {
    // 连接建立之后一声不吭 —— 模拟那些"连得上但不回话"的网关。
  });
  const port = await listen(server);

  try {
    await assert.rejects(
      () =>
        createHttpTransport({ timeoutMs: 300 })({
          url: `http://127.0.0.1:${port}/v1/chat/completions`,
          headers: {},
          body: '{}',
        }),
      /300 毫秒没有收到响应/,
    );
  } finally {
    await close(server);
  }
});
