# OpenAI 兼容 API

> 挂载路径：`/v1`（外部）和 `/api/v1`（内部别名）
>
> 外部 API 不经过 responseWrapper，保持 OpenAI 原始格式。

---

## 目录

- [GET /models — 获取模型列表](#get-models-获取模型列表)
- [POST /chat/completions — 聊天补全](#post-chatcompletions-聊天补全)
- [POST /images/generations — 图片生成](#post-imagesgenerations-图片生成)
- [POST /audio/speech — 文本转语音](#post-audiospeech-文本转语音)
- [POST /translations — 文本翻译](#post-translations-文本翻译)

---

## GET /models — 获取模型列表

返回当前可用的所有 Cloudflare Workers AI 模型，格式兼容 OpenAI `/v1/models`。

### 请求

```
GET /v1/models
GET /v1/models?task=text-to-speech
```

| 参数 | 位置 | 说明 |
|---|---|---|
| `task` | query | 可选，按任务类型过滤（如 `text-to-speech`、`text-generation` 等） |

### 响应

**200 OK**

```json
{
  "object": "list",
  "data": [
    {
      "id": "@cf/meta/llama-3.1-8b-instruct",
      "object": "model",
      "created": 1718179200,
      "owned_by": "cloudflare",
      "task": "text-generation"
    },
    {
      "id": "@cf/mychen-76/aura-2-en",
      "object": "model",
      "created": 1718179200,
      "owned_by": "cloudflare",
      "task": "text-to-speech",
      "speakers": ["luna", "mars", "athena", "..."],
      "default_speaker": "luna",
      "advanced_params": {
        "container": { "type": "string" },
        "sample_rate": { "type": "integer" },
        "bit_rate": { "type": "integer" }
      }
    }
  ]
}
```

> 当 `task=text-to-speech` 时，响应会额外携带 `speakers`（说话人枚举）、`default_speaker`、`advanced_params`（高级参数 schema）。

---

## POST /chat/completions — 聊天补全

支持流式和非流式响应，多账户自动轮换。支持指定账户。

### 请求头

| Header | 说明 |
|---|---|
| `Authorization` | `Bearer <API_SECRET>` |
| `X-Account-ID` | 可选，指定 CF 账户 ID（设为 `auto` 则自动轮换） |

### 请求 — 非流式

```json
{
  "model": "@cf/meta/llama-3.1-8b-instruct",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello, how are you?" }
  ],
  "stream": false,
  "temperature": 0.7,
  "max_tokens": 1000
}
```

### 响应 — 非流式

**200 OK**

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1718179200,
  "model": "@cf/meta/llama-3.1-8b-instruct",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! I'm doing well, thank you for asking. How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 15,
    "total_tokens": 40,
    "prompt_tokens_details": { "cached_tokens": 0 }
  }
}
```

### 请求 — 流式

```json
{
  "model": "@cf/meta/llama-3.1-8b-instruct",
  "messages": [
    { "role": "user", "content": "Write a haiku about coding" }
  ],
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

> 流式请求会自动注入 `stream_options.include_usage: true` 以便记账。

### 响应 — 流式（SSE）

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Lines"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" of"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}

data: [DONE]
```

> 慢响应时（15s+ 无数据）会发送 SSE 心跳 `: heartbeat\n\n` 防止客户端超时断开。

### 错误响应

**429 Too Many Requests** — 所有账户配额耗尽

```json
{
  "error": {
    "message": "All accounts have reached daily neuron limit",
    "type": "quota_exceeded",
    "code": "ALL_ACCOUNTS_EXHAUSTED",
    "last_error": "CF error: 4006 neuron limit"
  }
}
```

**404 Not Found** — 指定账户不存在

```json
{
  "error": {
    "message": "Account cf-account-uuid not found or inactive",
    "type": "invalid_request_error",
    "code": "ACCOUNT_NOT_FOUND"
  }
}
```

---

## POST /images/generations — 图片生成

文生图 / 图生图，支持 Flux 系列、Stable Diffusion 等模型。

### 请求头

| Header | 说明 |
|---|---|
| `X-Account-ID` | 可选，指定 CF 账户 ID |

### 请求 — 文生图

```json
{
  "model": "@cf/black-forest-labs/flux-1-schnell",
  "prompt": "a cat on the moon",
  "num_steps": 4,
  "width": 1024,
  "height": 1024
}
```

### 请求 — 图生图（SDXL）

```json
{
  "model": "@cf/stabilityai/stable-diffusion-xl-base-1.0",
  "prompt": "add a hat to the person",
  "image": "base64-encoded-image-data",
  "num_steps": 20,
  "guidance": 7.5,
  "strength": 0.8,
  "negative_prompt": "blurry, low quality",
  "width": 1024,
  "height": 1024
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | 模型 ID |
| `prompt` | string | 是 | 提示词 |
| `image` | string | 否 | Base64 图像（图生图） |
| `num_steps` | number | 否 | 推理步数 |
| `width` | number | 否 | 图像宽度（仅 SDXL） |
| `height` | number | 否 | 图像高度（仅 SDXL） |
| `guidance` | number | 否 | 引导强度（仅 SDXL） |
| `negative_prompt` | string | 否 | 负面提示词（仅 SDXL） |
| `strength` | number | 否 | 变换强度（仅 SDXL img2img） |

### 响应

**200 OK**

```json
{
  "created": 1718179200,
  "data": [
    {
      "b64_json": "iVBORw0KGgoAAAANSUhEUgAA...",
      "neurons": 12.5
    }
  ]
}
```

---

## POST /audio/speech — 文本转语音

不同 TTS 模型的参数完全不同。`voice`/`encoding`/`lang` 等字段由模型 schema 动态决定。

### 请求头

| Header | 说明 |
|---|---|
| `X-Account-ID` | 可选，指定 CF 账户 ID |

### 请求 — Aura 系列（英文）

```json
{
  "model": "@cf/mychen-76/aura-2-en",
  "input": "Hello world, this is a text-to-speech test.",
  "voice": "luna",
  "encoding": "mp3"
}
```

### 请求 — MeloTTS

```json
{
  "model": "@cf/mychen-76/melotts",
  "input": "你好，世界",
  "voice": null,
  "lang": "zh"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | TTS 模型 ID |
| `input` | string | 是 | 要合成的文本 |
| `voice` | string | 条件必填 | 说话人（Aura 系列需要，MeloTTS 不需要） |
| `encoding` | string | 否 | 音频编码（仅 Aura 系列） |
| `container` | string | 否 | 音频容器格式 |
| `sample_rate` | number | 否 | 采样率 |
| `bit_rate` | number | 否 | 比特率 |
| `lang` | string | 否 | 语言（仅 MeloTTS） |

### 响应

**200 OK**

```json
{
  "created": 1718179200,
  "data": [
    {
      "audio": "base64-encoded-audio-data",
      "neurons": 5.0,
      "content_type": "audio/mpeg"
    }
  ]
}
```

**502 Bad Gateway** — 空音频

```json
{
  "error": {
    "message": "TTS 模型未返回音频数据（content-type=application/json, bytes=0）",
    "type": "upstream_error",
    "code": "EMPTY_AUDIO"
  }
}
```

---

## POST /translations — 文本翻译

### 请求头

| Header | 说明 |
|---|---|
| `X-Account-ID` | 可选，指定 CF 账户 ID |

### 请求

```json
{
  "model": "@cf/meta/m2m100-1.2b",
  "text": "Hello world",
  "source_lang": "en",
  "target_lang": "zh"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | 翻译模型 ID |
| `text` | string | 是 | 要翻译的文本 |
| `source_lang` | string | 条件必填 | 源语言（M2M100 需要，IndicTrans2 不需要） |
| `target_lang` | string | 是 | 目标语言 |

### 响应

**200 OK**

```json
{
  "created": 1718179200,
  "data": [
    {
      "translated_text": "你好，世界",
      "source_lang": "en",
      "target_lang": "zh",
      "neurons": 2.0
    }
  ]
}
```
