// 录制自真实接口的响应。请勿手改 —— 用 scripts/record-provider-response.mjs 重录。
//
// 来源:http://127.0.0.1:7863/v1/chat/completions
// 模型:glm-5.3
// 时间:2026-10-08
//
// 内容逐字来自响应体。缩进是重新排版的结果(原始响应是单行),空白之外没有任何改动。

/** HTTP 200 —— 模型只回文本,没有工具调用 */
export const glmText = {
  "choices": [
    {
      "finish_reason": "stop",
      "index": 0,
      "message": {
        "content": "收到",
        "reasoning_content": "The user is asking me to respond with only two characters (两个字 means \"two characters\" in Chinese). They want me to say \"收到\"  which means \"Received\" or \"Got it.\"\n\nThis is a simple, harmless request. The user is asking me to respond with just \"收到\" (two Chinese characters meaning \"received/acknowledged\").\n\nThere's nothing problematic here - it's just a request for a brief acknowledgment. The user wants a two-character response: 收到.\n\nI should just respond with \"收到\" as requested.",
        "role": "assistant"
      }
    }
  ],
  "created": 1791461815,
  "id": "083f39f6f5d687f9cd7e43cce5bba357",
  "model": "glm-5.3",
  "object": "chat.completion",
  "usage": {
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 0,
    "cached_tokens": 0,
    "completion_thinking_tokens": 110,
    "completion_tokens": 113,
    "completion_tokens_details": {
      "accepted_prediction_tokens": 0,
      "audio_tokens": 0,
      "cached_tokens": 0,
      "reasoning_tokens": 110,
      "rejected_prediction_tokens": 0
    },
    "credit": 0.07,
    "prompt_cache_hit_tokens": 0,
    "prompt_cache_miss_tokens": 17,
    "prompt_cache_write_tokens": 0,
    "prompt_tokens": 17,
    "prompt_tokens_details": {
      "accepted_prediction_tokens": 0,
      "audio_tokens": 0,
      "cached_tokens": 0,
      "reasoning_tokens": 0,
      "rejected_prediction_tokens": 0
    },
    "total_tokens": 130
  }
};

/** HTTP 200 —— 模型要求执行 run_command */
export const glmToolCall = {
  "choices": [
    {
      "finish_reason": "tool_calls",
      "index": 0,
      "message": {
        "content": "",
        "reasoning_content": "The user is asking what the current directory is, and wants me to use a tool to check. I should use the run_command tool to run `Get-Location` or `pwd` in PowerShell.",
        "role": "assistant",
        "tool_calls": [
          {
            "function": {
              "arguments": "{\"command\": \"Get-Location\"}",
              "name": "run_command"
            },
            "id": "call_bbeb27c5ab7b4a10b435a276",
            "index": 0,
            "type": "function"
          }
        ]
      }
    }
  ],
  "created": 1791461819,
  "id": "edb2c02c2a6ca6cf8821a57be38f0e0a",
  "model": "glm-5.3",
  "object": "chat.completion",
  "usage": {
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 166,
    "cached_tokens": 166,
    "completion_thinking_tokens": 41,
    "completion_tokens": 55,
    "completion_tokens_details": {
      "accepted_prediction_tokens": 0,
      "audio_tokens": 0,
      "cached_tokens": 0,
      "reasoning_tokens": 41,
      "rejected_prediction_tokens": 0
    },
    "credit": 0.04,
    "prompt_cache_hit_tokens": 166,
    "prompt_cache_miss_tokens": 9,
    "prompt_cache_write_tokens": 0,
    "prompt_tokens": 175,
    "prompt_tokens_details": {
      "accepted_prediction_tokens": 0,
      "audio_tokens": 0,
      "cached_tokens": 166,
      "reasoning_tokens": 0,
      "rejected_prediction_tokens": 0
    },
    "total_tokens": 230
  }
};

/** HTTP 400 —— 模型名不存在时厂商的报错 */
export const glmError = {
  "error": {
    "code": "model_unavailable",
    "gateway_hint": "model_blocked: 5 account(s) cooling down this model; earliest unblock at 2026-10-09T02:15:03+08:00; upstream: 11102 model not available",
    "message": "model is unavailable on every account (per-model cooldown), try another model",
    "type": "api_error"
  }
};
