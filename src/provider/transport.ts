/**
 * 适配器与厂商之间的字节通道。
 *
 * 字符串进、字符串出是刻意的:适配器与厂商之间的契约就是那串字节,测试要断言的
 * 也正是它。中间不引入任何对象模型 —— 一旦引入,测试就会去断言我们的对象,
 * 而厂商真正收到的可能已经不是那回事了。
 */
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

/**
 * 真实实现 —— 也是唯一会发起网络请求的地方。
 *
 * 各适配器把它作为构造参数(默认用它),使适配器的测试可以对着**录制下来的真实
 * 响应**跑:不联网、不消耗额度、结果确定。见规格的 Testing Decisions。
 */
export const fetchTransport: Transport = async ({ url, headers, body }) => {
  const response = await fetch(url, { method: 'POST', headers, body });
  return { status: response.status, body: await response.text() };
};
