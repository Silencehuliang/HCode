// 录制自真实接口的响应。请勿手改 —— 用 scripts/record-provider-response.mjs 重录。
//
// 来源:http://127.0.0.1:7863/v1/chat/completions
// 模型:deepseek-v4.1-flash
// 时间:2026-10-08
//
// 内容逐字来自响应体。缩进是重新排版的结果(原始响应是单行),空白之外没有任何改动。

/** HTTP 200 —— 模型只回文本,没有工具调用 */
export const deepseekText = {
  "choices": [
    {
      "finish_reason": "stop",
      "index": 0,
      "message": {
        "content": "收到",
        "reasoning_content": "We need answer only two characters: 收到. Need comply. Final only.",
        "role": "assistant"
      }
    }
  ],
  "created": 1791473009,
  "id": "3861ab4d922128ad9513b3d1c28e503b",
  "model": "deepseek-v4.1-flash",
  "object": "chat.completion",
  "usage": {
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "cached_tokens": 0,
    "completion_thinking_tokens": 16,
    "completion_tokens": 18,
    "completion_tokens_details": {
      "accepted_prediction_tokens": 0,
      "audio_tokens": 0,
      "cached_tokens": 0,
      "reasoning_tokens": 16,
      "rejected_prediction_tokens": 0
    },
    "credit": 0,
    "prompt_cache_hit_tokens": 0,
    "prompt_cache_miss_tokens": 35,
    "prompt_cache_write_tokens": 0,
    "prompt_tokens": 35,
    "prompt_tokens_details": {
      "accepted_prediction_tokens": 0,
      "audio_tokens": 0,
      "cached_tokens": 0,
      "reasoning_tokens": 0,
      "rejected_prediction_tokens": 0
    },
    "total_tokens": 53
  }
};

/** HTTP 200 —— 模型要求执行 run_command */
export const deepseekToolCall = {
  "choices": [
    {
      "finish_reason": "tool_calls",
      "index": 0,
      "message": {
        "content": "",
        "reasoning_content": "The user asks what the current directory is, using a tool.",
        "role": "assistant",
        "tool_calls": [
          {
            "function": {
              "arguments": "{\"command\": \"Get-Location\"}",
              "name": "run_command"
            },
            "id": "call_00_7boGWIjHzZONKFNLcJSl3257",
            "index": 0,
            "type": "function"
          }
        ]
      }
    }
  ],
  "created": 1791473010,
  "id": "27000f7656290c6f71b75dfe40df9cea",
  "model": "deepseek-v4.1-flash",
  "object": "chat.completion",
  "usage": {
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "cached_tokens": 0,
    "completion_thinking_tokens": 13,
    "completion_tokens": 53,
    "completion_tokens_details": {
      "accepted_prediction_tokens": 0,
      "audio_tokens": 0,
      "cached_tokens": 0,
      "reasoning_tokens": 13,
      "rejected_prediction_tokens": 0
    },
    "credit": 0.01,
    "prompt_cache_hit_tokens": 0,
    "prompt_cache_miss_tokens": 308,
    "prompt_cache_write_tokens": 0,
    "prompt_tokens": 308,
    "prompt_tokens_details": {
      "accepted_prediction_tokens": 0,
      "audio_tokens": 0,
      "cached_tokens": 0,
      "reasoning_tokens": 0,
      "rejected_prediction_tokens": 0
    },
    "total_tokens": 361
  }
};

/** HTTP 400 —— 模型名不存在时厂商的报错 */
export const deepseekError = {
  "error": {
    "code": "model_unavailable",
    "gateway_hint": "model_blocked: 5 account(s) cooling down this model; earliest unblock at 2026-10-09T02:15:03+08:00; upstream: 11102 model not available",
    "message": "model is unavailable on every account (per-model cooldown), try another model",
    "type": "api_error"
  }
};
