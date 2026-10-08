// Anthropic Messages API 的响应夹具。
//
// **这不是录制下来的。** 手上没有 Anthropic 的密钥,拿不到真响应,所以下面这三段
// 是按官方文档手写的,形状对、字段名对,但字节序列没有经过真实接口印证。等有了
// 密钥,用 scripts/record-provider-response.mjs 重录一遍替换掉,并把这个抬头改掉。
//
// 与另外两份夹具的区别值得记一笔:glm.ts / deepseek.ts 是录制的,但录的是**本地
// 网关**而不是厂商自己的端点 —— 它们证明的是"网关这么回",不是"智谱/DeepSeek 这么
// 回"。三家夹具的可信度分三档,这里是最低的一档。

/** HTTP 200 —— 模型只回文本,没有工具调用 */
export const claudeText = {
  "id": "msg_01XFDUDYJgAACzvnptvVoYEL",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-5-5",
  "content": [
    {
      "type": "text",
      "text": "收到"
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 12,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "output_tokens": 5
  }
};

/** HTTP 200 —— 模型要求执行 run_command。注意工具参数在 input 里已经是对象,不是 JSON 字符串 */
export const claudeToolCall = {
  "id": "msg_01B2c3D4e5F6g7H8i9J0k1L2",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-5-5",
  "content": [
    {
      "type": "text",
      "text": "我看一下当前目录。"
    },
    {
      "type": "tool_use",
      "id": "toolu_01A09q90qw90lq917835lq9",
      "name": "run_command",
      "input": { "command": "Get-Location" }
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 384,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 1024,
    "output_tokens": 68
  }
};

/** HTTP 200 —— 开了 extended thinking 时的形状:content 里多一块 thinking */
export const claudeThinkingToolCall = {
  "id": "msg_01Tk1n2k3n4k5n6k7n8k9n0k",
  "type": "message",
  "role": "assistant",
  "model": "claude-sonnet-5-5",
  "content": [
    {
      "type": "thinking",
      "thinking": "用户想知道当前目录。用 run_command 跑 Get-Location 就行。",
      "signature": "ErUBCkYIBRgCIkAxNzY0NzE5NTQ3"
    },
    {
      "type": "tool_use",
      "id": "toolu_01Th1nk1ngth1nk1ngth1nk",
      "name": "run_command",
      "input": { "command": "Get-Location" }
    }
  ],
  "stop_reason": "tool_use",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 384,
    "output_tokens": 96
  }
};

/** HTTP 400 —— 参数不合法时厂商的报错。形状是 {type:'error', error:{type, message}} */
export const claudeError = {
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "max_tokens: Field required"
  }
};

/** HTTP 429 —— 限流 */
export const claudeRateLimited = {
  "type": "error",
  "error": {
    "type": "rate_limit_error",
    "message": "Number of request tokens has exceeded your per-minute rate limit"
  }
};
