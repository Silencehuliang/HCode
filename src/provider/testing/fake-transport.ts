import assert from 'node:assert/strict';

import type { Transport, TransportRequest, TransportResponse } from '../transport.js';

/**
 * 假传输层 —— Provider 主缝上的替身。不做网络,只记录"我们要发什么",并回放
 * "厂商会回什么"。
 *
 * 回放的内容来自 src/provider/fixtures/,那是真实接口录制下来的(Anthropic 那份
 * 除外,见 fixtures/claude.ts 的抬头)。不 mock 的是厂商的线格式本身:它才是适配器
 * 真正要对上的东西。
 *
 * 三个适配器的测试都用它,所以它待在 testing/ 里而不是某个 *.test.ts 里 —— 一份
 * 复制三份,改一处忘一处是迟早的事。
 */
export function fakeTransport(responses: TransportResponse[]) {
  const requests: TransportRequest[] = [];
  let next = 0;

  const transport: Transport = async (request) => {
    requests.push(request);
    const response = responses[next++];
    if (!response) throw new Error(`假传输层的回应已用尽(第 ${next} 次调用)`);
    return response;
  };

  return Object.assign(transport, {
    requests,

    /** 第 index 次请求的请求体,已解析。 */
    sentBody(index = 0): unknown {
      const request = requests[index];
      assert.ok(request, `第 ${index + 1} 次请求还没发生`);
      return JSON.parse(request.body);
    },

    /** 第 index 次请求的请求头。 */
    sentHeaders(index = 0): Record<string, string> {
      const request = requests[index];
      assert.ok(request, `第 ${index + 1} 次请求还没发生`);
      return request.headers;
    },

    /** 第 index 次请求的落点。 */
    sentUrl(index = 0): string {
      const request = requests[index];
      assert.ok(request, `第 ${index + 1} 次请求还没发生`);
      return request.url;
    },
  });
}

/** 一个 HTTP 200 的回应,body 由对象序列化而来。 */
export function ok(body: unknown): TransportResponse {
  return { status: 200, body: JSON.stringify(body) };
}

/** 一个非 2xx 的回应。厂商的报错原文照装。 */
export function failed(status: number, body: unknown): TransportResponse {
  return { status, body: JSON.stringify(body) };
}
