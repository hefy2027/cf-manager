# 浏览器渲染

---

## 目录

- [POST /api/browser-render/ — 内部渲染](#post-apibrowser-render-内部渲染)
- [POST /v1/browser/render — 外部渲染](#post-v1browserrender-外部渲染)
- [GET /v1/browser/status — 限速状态](#get-v1browserstatus-限速状态)

---

## POST /api/browser-render/ — 内部渲染

内部浏览器渲染接口，直接返回渲染结果。

### 请求

```
POST /api/browser-render/
```

```json
{
  "url": "https://example.com",
  "mode": "screenshot",
  "browser": "chromium",
  "accountId": "cf-account-uuid"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `url` | string | 是 | 要渲染的页面 URL |
| `mode` | string | 否 | 渲染模式：`screenshot`（截图）、`html`（HTML 内容）、`pdf`（PDF） |
| `browser` | string | 否 | 浏览器引擎（默认 `chromium`） |
| `accountId` | string | 否 | 指定 CF 账户 ID |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "screenshots": [
      { "image": "base64-encoded-image-data", "mimeType": "image/png" }
    ]
  }
}
```

---

## POST /v1/browser/render — 外部渲染

外部浏览器渲染接口，带限速控制。返回完整的响应体（包含元数据）。

### 请求

```
POST /v1/browser/render
```

```json
{
  "url": "https://example.com",
  "mode": "screenshot",
  "browser": "chromium",
  "accountId": "cf-account-uuid"
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "result": {
    "screenshots": [
      { "image": "base64-encoded-image-data", "mimeType": "image/png" }
    ],
    "metadata": {
      "url": "https://example.com",
      "title": "Example Domain",
      "status": 200
    }
  }
}
```

---

## GET /v1/browser/status — 限速状态

获取浏览器渲染的限速状态信息。

### 请求

```
GET /v1/browser/status
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "limit": 50,
    "remaining": 45,
    "reset": 1718182800,
    "windowMs": 60000
  }
}
```
