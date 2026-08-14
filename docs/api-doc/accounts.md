# 账户管理

> 挂载路径：`/api/accounts`

---

## 目录

- [GET / — 获取账户列表](#get---获取账户列表)
- [POST / — 创建账户](#post---创建账户)
- [PUT /:id — 更新账户](#put-id-更新账户)
- [PATCH /:id/features — 更新功能开关](#patch-idfeatures-更新功能开关)
- [DELETE /:id — 删除账户](#delete-id-删除账户)
- [GET /:id/credentials — 查看凭证](#get-idcredentials-查看凭证)
- [POST /:id/test — 测试连通性](#post-idtest-测试连通性)
- [POST /:id/clear-exhausted — 清除配额标记](#post-idclear-exhausted-清除配额标记)
- [POST /test-batch — 批量测试](#post-test-batch-批量测试)
- [POST /batch/features — 批量设置功能](#post-batchfeatures-批量设置功能)
- [POST /batch/delete — 批量删除](#post-batchdelete-批量删除)
- [POST /batch/proxy — 批量设置代理](#post-batchproxy-批量设置代理)
- [POST /import-csv — CSV 批量导入](#post-import-csv-csv-批量导入)

---

## GET / — 获取账户列表

支持全量和分页两种模式。传入 `page` 或 `pageSize` 时启用分页。

### 请求

| 参数 | 位置 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| `page` | query | number | 否 | 页码（传入时启用分页模式） |
| `pageSize` | query | number | 否 | 每页条数（默认 20） |
| `filter` | query | string | 否 | 筛选：`all`(默认) / `active` / `unverified` |
| `search` | query | string | 否 | 搜索关键词 |

### 响应 — 全量模式

**200 OK**

```json
{
  "success": true,
  "data": {
    "accounts": [
      {
        "id": 1,
        "name": "my-account",
        "auth_type": "token",
        "account_id": "cf-account-uuid",
        "email": null,
        "api_token": "***encrypted***",
        "api_key": null,
        "is_active": 1,
        "enabled_features": "workers,dns,ai",
        "available_features": "r2,ai",
        "proxy_url": "",
        "proxy_enabled": 0,
        "is_demo": false
      }
    ],
    "quota": {
      "ai_neurons": { "today": 1234.5, "limit": 10000 },
      "workers_requests": { "today": 50000 }
    }
  }
}
```

### 响应 — 分页模式

```json
{
  "success": true,
  "data": {
    "accounts": [ /* ... */ ],
    "quota": { /* ... */ },
    "total": 50,
    "counts": { "all": 50, "active": 45, "unverified": 5 }
  }
}
```

---

## POST / — 创建账户

创建前自动验证 Cloudflare 凭证，验证通过后加密存储。自动获取 `account_id` 并探测 R2 等可用功能。

### 请求

```json
{
  "name": "my-account",
  "auth_type": "token",
  "api_token": "cf-token-xxx",
  "api_key": null,
  "email": null,
  "account_id": null,
  "enabled_features": "workers,dns,ai",
  "proxy_url": "",
  "proxy_enabled": false
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 账户显示名称 |
| `auth_type` | string | 是 | `"token"` 或 `"global_key"` |
| `api_token` | string | auth_type=token 时必填 | Cloudflare API Token |
| `api_key` | string | auth_type=global_key 时必填 | Cloudflare Global API Key |
| `email` | string | auth_type=global_key 时必填 | Cloudflare 账户邮箱 |
| `account_id` | string | 否 | Cloudflare Account ID（不传则自动获取） |
| `enabled_features` | string | 否 | 启用的功能列表，逗号分隔 |
| `proxy_url` | string | 否 | 代理地址 |
| `proxy_enabled` | boolean | 否 | 是否启用代理 |

### 响应

**201 Created**

```json
{
  "success": true,
  "data": {
    "id": 2,
    "name": "my-account",
    "auth_type": "token",
    "account_id": "cf-account-uuid",
    "enabled_features": "workers,dns,ai",
    "api_token": "***",
    "api_key": "***"
  }
}
```

**400 Bad Request** — 凭证验证失败

```json
{
  "success": false,
  "error": {
    "code": "CREDENTIAL_INVALID",
    "message": "Cloudflare API 凭证验证失败: Invalid API Token"
  }
}
```

---

## PUT /:id — 更新账户

更新账户信息。如果切换认证类型或提供新凭证，会重新验证。自动刷新 `account_id` 和探测可用功能。

### 请求

```
PUT /api/accounts/2
```

```json
{
  "name": "updated-name",
  "auth_type": "token",
  "api_token": "new-cf-token-xxx",
  "proxy_url": "http://proxy:8080",
  "proxy_enabled": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 账户名称 |
| `auth_type` | string | 是 | `"token"` 或 `"global_key"` |
| `api_token` | string | 条件必填 | 新 Token（切换到 token 或更新 Token 时需提供） |
| `api_key` | string | 条件必填 | 新 Key（切换到 global_key 时需提供） |
| `email` | string | 条件必填 | 邮箱（切换到 global_key 时需提供） |
| `proxy_url` | string | 否 | 代理地址 |
| `proxy_enabled` | boolean | 否 | 是否启用代理 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": { "success": true }
}
```

**403 Forbidden** — 演示账户不可编辑

```json
{
  "success": false,
  "error": {
    "code": "DEMO_PROTECTED",
    "message": "演示账户不可编辑"
  }
}
```

---

## PATCH /:id/features — 更新功能开关

### 请求

```
PATCH /api/accounts/2/features
```

```json
{
  "enabled_features": "workers,dns,ai,storage"
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": { "success": true }
}
```

---

## DELETE /:id — 删除账户

### 请求

```
DELETE /api/accounts/2
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": { "success": true }
}
```

**403 Forbidden** — 演示账户不可删除

```json
{
  "success": false,
  "error": {
    "code": "DEMO_PROTECTED",
    "message": "演示账户不可删除"
  }
}
```

---

## GET /:id/credentials — 查看凭证

返回解密后的 API Token / API Key / Password。操作写入审计日志。

### 请求

```
GET /api/accounts/2/credentials
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "id": 2,
    "name": "my-account",
    "auth_type": "token",
    "email": null,
    "api_token": "cf-real-token-value",
    "api_key": null,
    "password": null,
    "account_id": "cf-account-uuid",
    "proxy_url": "",
    "proxy_enabled": 0
  }
}
```

---

## POST /:id/test — 测试连通性

测试 Cloudflare API 凭证是否有效。成功时自动获取 `account_id`、更新状态为活跃、探测可用功能。

### 请求

```
POST /api/accounts/2/test
```

无请求体。

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "success": true,
    "user": {
      "id": "user-uuid",
      "email": "user@example.com",
      "first_name": "John",
      "last_name": "Doe"
    }
  }
}
```

---

## POST /:id/clear-exhausted — 清除配额标记

清除指定账户的 AI 配额耗尽标记（`ai_neurons`），允许该账户重新参与 AI 账户轮换。

### 请求

```
POST /api/accounts/2/clear-exhausted
```

无请求体。

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "success": true,
    "message": "已清除 AI 配额耗尽标记"
  }
}
```

---

## POST /test-batch — 批量测试

批量测试多个账户的连通性，每批 5 个并发。

### 请求

```json
{
  "ids": [1, 2, 3],
  "onlyUnverified": false
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ids` | number[] | 否 | 要测试的账户 ID 数组（不传时测试全部或未验证） |
| `onlyUnverified` | boolean | 否 | 为 true 时仅测试 `is_active=0` 的账户 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "summary": {
      "total": 3,
      "success": 2,
      "error": 1
    },
    "results": [
      { "id": 1, "name": "account-1", "status": "success" },
      { "id": 2, "name": "account-2", "status": "success" },
      { "id": 3, "name": "account-3", "status": "error", "message": "Invalid API Token" }
    ]
  }
}
```

---

## POST /batch/features — 批量设置功能

### 请求

```json
{
  "ids": [1, 2, 3],
  "enabled_features": "workers,dns,ai"
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "summary": { "total": 3, "success": 2, "skipped": 1, "error": 0 },
    "results": [
      { "id": 1, "name": "account-1", "status": "success" },
      { "id": 2, "name": "account-2", "status": "success" },
      { "id": 3, "name": "demo-account", "status": "skipped", "message": "演示账户不可修改" }
    ]
  }
}
```

---

## POST /batch/delete — 批量删除

### 请求

```json
{
  "ids": [1, 2, 3]
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "summary": { "total": 3, "success": 2, "skipped": 1, "error": 0 },
    "results": [
      { "id": 1, "name": "account-1", "status": "success" },
      { "id": 2, "name": "account-2", "status": "success" },
      { "id": 3, "name": "demo-account", "status": "skipped", "message": "演示账户不可删除" }
    ]
  }
}
```

---

## POST /batch/proxy — 批量设置代理

### 请求

```json
{
  "ids": [1, 2],
  "proxy_url": "http://proxy:8080",
  "proxy_enabled": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ids` | number[] | 是 | 账户 ID 数组 |
| `proxy_url` | string | 否 | 代理地址 |
| `proxy_enabled` | boolean | 否 | 是否启用 |

> 至少提供 `proxy_url` 或 `proxy_enabled` 之一。

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "summary": { "total": 2, "success": 2, "skipped": 0, "error": 0 },
    "results": [
      { "id": 1, "name": "account-1", "status": "success" },
      { "id": 2, "name": "account-2", "status": "success" }
    ]
  }
}
```

---

## POST /import-csv — CSV 批量导入

通过上传 CSV 文件批量导入账户。按邮箱去重，单个账户错误不影响批量导入。

### 请求

`multipart/form-data`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | File | 是 | CSV 文件（表头：`email,password,apiKey`） |
| `skipVerify` | string | 否 | `"1"` 跳过凭证验证（秒级完成，后续手动测试激活） |

CSV 格式示例：

```csv
email,password,apiKey
user1@example.com,password1,cf-key-1
user2@example.com,password2,cf-key-2
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "summary": {
      "total": 10,
      "success": 7,
      "skipped": 2,
      "error": 1
    },
    "results": [
      { "email": "user1@example.com", "name": "user1", "status": "success" },
      { "email": "user2@example.com", "name": "user2", "status": "skipped", "message": "数据库已存在该邮箱" },
      { "email": "user3@example.com", "name": "user3", "status": "error", "message": "凭证验证失败: Invalid API Key" }
    ]
  }
}
```
