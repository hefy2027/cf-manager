# External API 文档 (`/v1`)

CF Manager 暴露 `/v1` 系列接口，兼容 OpenAI API 格式，可直接用于 Cursor、ChatGPT-Next-Web、Open WebUI 等工具。

## 认证

如果后端配置了 `API_SECRET`，所有请求需要在 Header 中携带：

```
Authorization: Bearer <你的 API_SECRET>
```

## Base URL

```
http://<你的服务器地址>:<端口>
```

Docker 部署默认为 `http://localhost:3000`，本地开发为 `http://localhost:3001`。

---

## AI 推理接口

### 获取模型列表

```
GET /v1/models
```

返回当前可用的所有 Cloudflare Workers AI 模型，格式兼容 OpenAI `/v1/models`。

**响应示例：**

```json
{
  "object": "list",
  "data": [
    {
      "id": "@cf/meta/llama-3.1-8b-instruct",
      "object": "model",
      "created": 1718179200,
      "owned_by": "cloudflare"
    },
    {
      "id": "@cf/qwen/qwen2.5-coder-32b-instruct",
      "object": "model",
      "created": 1718179200,
      "owned_by": "cloudflare"
    }
  ]
}
```

---

### 聊天补全

```
POST /v1/chat/completions
```

兼容 OpenAI Chat Completions API，支持流式和非流式模式。系统会自动选择配额最充裕的账户，如果当前账户配额耗尽会自动切换到下一个。

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `model` | string | 是 | 模型名称，如 `@cf/meta/llama-3.1-8b-instruct` |
| `messages` | array | 是 | 消息列表，OpenAI 格式 |
| `stream` | boolean | 否 | 是否开启流式返回，默认 `false` |

**请求示例：**

```json
{
  "model": "@cf/meta/llama-3.1-8b-instruct",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello!" }
  ],
  "stream": false
}
```

**非流式响应示例：**

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1718179200,
  "model": "@cf/meta/llama-3.1-8b-instruct",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 20,
    "completion_tokens": 10,
    "total_tokens": 30
  }
}
```

**流式响应：**

当 `stream: true` 时，返回 SSE（Server-Sent Events）格式，与 OpenAI 流式格式一致：

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"},"index":0}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"!"},"index":0}]}

data: [DONE]
```

**错误响应：**

| HTTP 状态码 | 场景 |
|---|---|
| 401 | 缺少或无效的 Authorization Header |
| 429 | 所有账户配额已耗尽 |
| 503 | 没有可用账户 |

```json
{
  "error": {
    "message": "All accounts have reached daily neuron limit",
    "type": "quota_exceeded",
    "code": "ALL_ACCOUNTS_EXHAUSTED"
  }
}
```

---

## 浏览器渲染接口

### 渲染页面

```
POST /v1/browser/render
```

使用 Cloudflare Browser Rendering API 渲染指定 URL 的网页，支持截图、内容提取等多种模式。

**请求体：**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | 是 | 要渲染的网页 URL |
| `mode` | string | 否 | 渲染模式，默认 `screenshot` |
| `accountId` | number | 否 | 指定账户 ID，不填则自动选择 |

**支持的渲染模式：**

| mode | 返回字段 | 数据格式 |
|---|---|---|
| `screenshot` | `result.screenshot` | `data:image/png;base64,...` Data URL |
| `content` | `result.html` | 原始 HTML 字符串 |
| `markdown` | `result.markdown` | Markdown 文本 |
| `pdf` | `result.pdf` | `data:application/pdf;base64,...` Data URL |
| `links` | `result.links` | URL 字符串数组 |

**请求示例：**

```json
{
  "url": "https://example.com",
  "mode": "markdown"
}
```

**成功响应 - screenshot 模式：**

```json
{
  "success": true,
  "result": {
    "mode": "screenshot",
    "screenshot": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...",
    "duration": 2.345,
    "browserMsUsed": 2345
  }
}
```

**成功响应 - content 模式：**

```json
{
  "success": true,
  "result": {
    "mode": "content",
    "html": "<!DOCTYPE html><html><head><title>Example Domain</title></head><body>...</body></html>",
    "duration": 1.234,
    "browserMsUsed": 1234
  }
}
```

**成功响应 - markdown 模式：**

```json
{
  "success": true,
  "result": {
    "mode": "markdown",
    "markdown": "# Example Domain\n\nThis domain is for use in illustrative examples in documents...",
    "duration": 1.567,
    "browserMsUsed": 1567
  }
}
```

**成功响应 - pdf 模式：**

```json
{
  "success": true,
  "result": {
    "mode": "pdf",
    "pdf": "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PAovVHlwZSAv...",
    "duration": 3.456,
    "browserMsUsed": 3456
  }
}
```

**成功响应 - links 模式：**

```json
{
  "success": true,
  "result": {
    "mode": "links",
    "links": [
      "https://www.iana.org/domains/example",
      "https://example.com/about",
      "https://example.com/contact"
    ],
    "duration": 1.890,
    "browserMsUsed": 1890
  }
}
```

> **说明：**
> - `duration`：总耗时（秒），包含网络请求和浏览器渲染
> - `browserMsUsed`：Cloudflare 浏览器实际渲染耗时（毫秒），用于配额计费
> - `screenshot` 和 `pdf` 返回 Data URL 格式，可直接用于 `<img>` 标签或下载
> - Data URL 前缀包含 MIME 类型，方便前端直接使用

**错误响应：**

| HTTP 状态码 | 场景 |
|---|---|
| 400 | 缺少 url 或无效的 mode |
| 404 | 指定的 accountId 不存在 |
| 429 | 请求频率过高或所有账户配额耗尽 |
| 500 | 渲染失败 |

```json
{
  "success": false,
  "error": {
    "message": "所有账户今日浏览器渲染配额已耗尽",
    "code": "ALL_ACCOUNTS_EXHAUSTED"
  }
}
```

---

## 使用示例

### Cursor 配置

在 Cursor 设置中将 API 地址配置为本服务的 `/v1` 端点：

```
Base URL: http://localhost:3000/v1
API Key:  <你的 API_SECRET，没配置则留空>
```

### Python (openai SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="your-api-secret",  # 没配置 API_SECRET 则随意填
)

response = client.chat.completions.create(
    model="@cf/meta/llama-3.1-8b-instruct",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### curl

```bash
# 非流式
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-secret" \
  -d '{
    "model": "@cf/meta/llama-3.1-8b-instruct",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# 流式
curl http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-secret" \
  -d '{
    "model": "@cf/meta/llama-3.1-8b-instruct",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'

# 浏览器渲染
curl http://localhost:3000/v1/browser/render \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-secret" \
  -d '{"url": "https://example.com", "mode": "markdown"}'
```
