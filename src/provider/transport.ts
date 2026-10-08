/**
 * 适配器与厂商之间的字节通道。
 *
 * 字符串进、字符串出是刻意的:适配器与厂商之间的契约就是那串字节,测试要断言的
 * 也正是它。中间不引入任何对象模型 —— 一旦引入,测试就会去断言我们的对象,
 * 而厂商真正收到的可能已经不是那回事了。
 *
 * **代理是每家的配置,不是全局的。** 用国产模型的人多半不需要代理,而要用 Claude
 * 的人多半必须用 —— 把代理做成全局环境变量,等于逼前者也去配一个,或者更糟:
 * 让他们的国产模型请求也绕一圈到国外的代理上去。所以代理挂在 transport 上,
 * 而 transport 是每个 Provider 各自构造的。
 */
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export type TransportRequest = {
  url: string;
  headers: Record<string, string>;
  body: string;
};

export type TransportResponse = {
  status: number;
  /** 原始响应体,不解析。厂商的报错要靠它原样回传,解析会丢掉原文。 */
  body: string;
};

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export type TransportOptions = {
  /** 形如 `http://127.0.0.1:7890`。留空则直连。 */
  proxy?: string;
  /** 单次请求的整体时限,含建连与读响应。 */
  timeoutMs?: number;
};

export const DEFAULT_TRANSPORT_TIMEOUT_MS = 300_000;

/**
 * 真实实现 —— 也是唯一会发起网络请求的地方。
 *
 * 各适配器把它作为构造参数(默认用它),使适配器的测试可以对着**录制下来的真实
 * 响应**跑:不联网、不消耗额度、结果确定。见规格的 Testing Decisions。
 */
export function createHttpTransport(options: TransportOptions = {}): Transport {
  const proxy = options.proxy ? parseProxy(options.proxy) : undefined;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TRANSPORT_TIMEOUT_MS;

  return async ({ url, headers, body }) => {
    const target = new URL(url);

    // http 目标不必建隧道:直接把完整地址交给代理即可。这一条让本地网关
    // 也能走代理,测试里用它验证代理确实被用上了。
    if (proxy && target.protocol === 'http:') {
      return await perform(httpRequest, {
        hostname: proxy.hostname,
        port: proxy.port,
        path: url,
        method: 'POST',
        headers: { ...headers, host: target.host, ...proxyAuthHeader(proxy) },
      }, body, timeoutMs);
    }

    const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
    const requestOptions: RequestOptions = {
      hostname: target.hostname,
      port: target.port === '' ? undefined : Number(target.port),
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers,
    };

    // https 走代理必须建隧道:目标主机名要在 TLS 握手里,而代理看不见握手内容。
    if (proxy && target.protocol === 'https:') {
      const socket = await openTunnel(proxy, target, timeoutMs);
      requestOptions.createConnection = () =>
        tlsConnect({ socket, servername: target.hostname });
    }

    return await perform(send, requestOptions, body, timeoutMs);
  };
}

function parseProxy(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`代理地址读不出来:${raw}(要形如 http://127.0.0.1:7890)`);
  }

  const port = parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : Number(parsed.port);
  // 凭据要留住 —— 上面的 URL 解析会把 user:pass@ 拆进 username/password,而这里
  // 重建 URL 时如果漏掉,公司内网那种要认证的代理就会静默变成匿名访问。
  const credentials =
    parsed.username === '' && parsed.password === ''
      ? ''
      : `${parsed.username}:${parsed.password}@`;

  return new URL(`${parsed.protocol}//${credentials}${parsed.hostname}:${port}`);
}

/** 代理本身的凭据。带上它,公司内网的代理才用得了。 */
function proxyAuthHeader(proxy: URL): Record<string, string> {
  if (proxy.username === '' && proxy.password === '') return {};
  const raw = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { 'proxy-authorization': `Basic ${Buffer.from(raw).toString('base64')}` };
}

/** http 与 https 两个 request 的公共形状。写成一个类型,是因为它们各自的重载
 * 集合不同,直接用 typeof httpRequest 会让 httpsRequest 对不上。 */
type Send = (
  options: RequestOptions,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

function perform(
  send: Send,
  options: RequestOptions,
  body: string,
  timeoutMs: number,
): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    const request = send(options, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`请求发出后 ${timeoutMs} 毫秒没有收到响应,已放弃。`));
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

/**
 * 在代理上开一条到目标主机的隧道。
 *
 * 只看响应头,隧道通了就把裸 socket 交出去 —— 之后的字节是 TLS 的,我们不该碰。
 */
function openTunnel(proxy: URL, target: URL, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const authority = `${target.hostname}:${target.port === '' ? 443 : target.port}`;
    const socket = netConnect({ host: proxy.hostname, port: Number(proxy.port) });
    socket.setTimeout(timeoutMs);

    const giveUp = (error: Error) => {
      socket.destroy();
      reject(error);
    };

    socket.once('error', giveUp);
    socket.once('timeout', () => giveUp(new Error(`连接代理 ${proxy.host} 超时。`)));

    socket.once('connect', () => {
      let head = '';
      const onData = (chunk: Buffer) => {
        head += chunk.toString('latin1');
        if (!head.includes('\r\n\r\n')) return;
        socket.off('data', onData);
        socket.setTimeout(0);

        const status = Number(head.split(' ')[1]);
        if (status !== 200) {
          giveUp(
            new Error(
              `代理拒绝为 ${authority} 建立隧道:HTTP ${status}。` +
                `(若代理需要认证,请把用户名密码写进代理地址)`,
            ),
          );
          return;
        }
        resolve(socket);
      };

      socket.on('data', onData);
      const auth = proxyAuthHeader(proxy);
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
          Object.entries(auth)
            .map(([name, value]) => `${name}: ${value}\r\n`)
            .join('') +
          '\r\n',
      );
    });
  });
}
