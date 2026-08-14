# 系统设置

> 挂载路径：`/api/settings`

---

## 目录

- [GET / — 获取系统设置](#get---获取系统设置)
- [POST /cache/clear — 清除缓存](#post-cacheclear-清除缓存)
- [PUT /proxy — 更新代理设置](#put-proxy-更新代理设置)
- [POST /proxy/test — 测试代理连接](#post-proxytest-测试代理连接)
- [PUT /resin — 更新 Resin 代理池](#put-resin-更新-resin-代理池)
- [POST /resin/test — 测试 Resin 连接](#post-resintest-测试-resin-连接)

---

## GET / — 获取系统设置

### 请求

```
GET /api/settings/
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "encryption_key_configured": true,
    "api_secret_configured": true,
    "demo_account_ids": "1,2",
    "db_path": "/data/cf-manager.db",
    "proxy_url": "http://proxy:8080",
    "proxy_enabled": true,
    "resin_enabled": false,
    "resin_url": "",
    "resin_token": "",
    "resin_platform": "Default",
    "platform": "node-backend",
    "version": "1.0.0",
    "git_commit": "abc1234"
  }
}
```

---

## POST /cache/clear — 清除缓存

清除所有内存缓存，包括 Zone 缓存、配额缓存、SDK 客户端缓存。

### 请求

```
POST /api/settings/cache/clear
```

无请求体。

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "success": true,
    "message": "All caches cleared (zones, quota, SDK clients)"
  }
}
```

---

## PUT /proxy — 更新代理设置

### 请求

```
PUT /api/settings/proxy
```

```json
{
  "proxy_url": "http://proxy:8080",
  "proxy_enabled": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `proxy_url` | string | 否 | 代理地址（HTTP/HTTPS/SOCKS） |
| `proxy_enabled` | boolean | 否 | 是否启用代理 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "success": true,
    "proxy_url": "http://proxy:8080",
    "proxy_enabled": true
  }
}
```

---

## POST /proxy/test — 测试代理连接

### 请求

```
POST /api/settings/proxy/test
```

```json
{
  "proxy_url": "http://proxy:8080"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `proxy_url` | string | 否 | 要测试的代理地址（不传则使用当前配置） |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "success": true,
    "ip": "1.2.3.4",
    "latency": 120
  }
}
```

**502 Bad Gateway**

```json
{
  "success": false,
  "error": {
    "code": "PROXY_TEST_FAILED",
    "message": "Connection refused"
  }
}
```

---

## PUT /resin — 更新 Resin 代理池

### 请求

```
PUT /api/settings/resin
```

```json
{
  "enabled": true,
  "url": "https://resin.example.com",
  "token": "resin-api-token",
  "platform": "Default"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `enabled` | boolean | 否 | 是否启用 Resin |
| `url` | string | 否 | Resin 服务地址 |
| `token` | string | 否 | Resin API Token |
| `platform` | string | 否 | 平台标识（默认 `Default`） |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "success": true,
    "enabled": true,
    "url": "https://resin.example.com",
    "token": "***",
    "platform": "Default"
  }
}
```

---

## POST /resin/test — 测试 Resin 连接

### 请求

```
POST /api/settings/resin/test
```

无请求体（使用当前配置）。

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "success": true,
    "ip": "1.2.3.4",
    "latency": 80
  }
}
```

**502 Bad Gateway**

```json
{
  "success": false,
  "error": {
    "code": "RESIN_TEST_FAILED",
    "message": "Connection refused"
  }
}
```
