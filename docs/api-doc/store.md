# 应用商店 / Catalog

> 挂载路径：`/api/store`

---

## 目录

### Catalog 源管理
- [GET /sources — 获取所有源](#get-sources-获取所有源)
- [POST /sources — 添加源](#post-sources-添加源)
- [POST /sources/test — 测试源 URL](#post-sourcestest-测试源-url)
- [PUT /sources/:id — 更新源](#put-sourcesid-更新源)
- [DELETE /sources/:id — 删除源](#delete-sourcesid-删除源)

### 模板操作
- [GET /templates — 获取模板列表](#get-templates-获取模板列表)
- [POST /refresh — 强制刷新所有源](#post-refresh-强制刷新所有源)
- [GET /init — 初始化默认源](#get-init-初始化默认源)

### 部署
- [POST /preflight — 预检部署](#post-preflight-预检部署)
- [POST /deploy — 执行部署](#post-deploy-执行部署)
- [POST /deploy-batch — 多账户批量部署](#post-deploy-batch-多账户批量部署)

---

## GET /sources — 获取所有源

### 请求

```
GET /api/store/sources
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "官方源",
      "url": "https://cf-store.surge.sh/catalog.json",
      "is_default": 1,
      "enabled": 1,
      "etag": "\"abc123\"",
      "last_synced": "2024-01-01T12:00:00Z",
      "last_status": "ok",
      "last_error": null
    },
    {
      "id": 2,
      "name": "自定义源",
      "url": "https://my-store.com/catalog.json",
      "is_default": 0,
      "enabled": 1,
      "etag": null,
      "last_synced": "2024-01-01T11:00:00Z",
      "last_status": "ok",
      "last_error": null
    }
  ]
}
```

---

## POST /sources — 添加源

创建前自动校验 URL 可达性和 Catalog 格式。

### 请求

```
POST /api/store/sources
```

```json
{
  "name": "我的自定义源",
  "url": "https://my-store.com/catalog.json"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 源名称 |
| `url` | string | 是 | Catalog JSON URL（需 HTTPS） |

### 响应

**201 Created**

```json
{
  "success": true,
  "data": { "id": 3 }
}
```

**400 Bad Request** — URL 校验失败

```json
{
  "success": false,
  "error": {
    "code": "FETCH_ERROR",
    "message": "URL 不可达: HTTP 404"
  }
}
```

---

## POST /sources/test — 测试源 URL

验证 URL 是否可拉取且符合 Catalog 格式，不落库。

### 请求

```
POST /api/store/sources/test
```

```json
{
  "url": "https://my-store.com/catalog.json"
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "ok": true,
    "templateCount": 15,
    "etag": "\"abc123\""
  }
}
```

### 响应 — 校验失败

```json
{
  "success": true,
  "data": {
    "ok": false,
    "errorCode": "INVALID_CATALOG",
    "error": "不是有效的 catalog: data.templates must be array"
  }
}
```

---

## PUT /sources/:id — 更新源

默认源的 URL 不可修改，其他字段可更新。

### 请求

```
PUT /api/store/sources/2
```

```json
{
  "name": "更新后的名称",
  "enabled": false
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

**403 Forbidden** — 修改默认源 URL

```json
{
  "success": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "默认源的 URL 不可修改"
  }
}
```

---

## DELETE /sources/:id — 删除源

### 请求

```
DELETE /api/store/sources/2
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

## GET /templates — 获取模板列表

合并所有已启用源的模板，按 `id` 去重。

### 请求

```
GET /api/store/templates
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "templates": [
      {
        "template": {
          "id": "vue-starter",
          "name": "Vue 3 Starter",
          "description": "A Vue 3 + Vite starter template",
          "deployType": "pages",
          "repo": "https://github.com/user/vue-starter"
        },
        "sourceId": 1,
        "sourceName": "官方源",
        "sourceCount": 2
      }
    ],
    "sources": [
      { "id": 1, "name": "官方源", "url": "https://...", "enabled": 1 }
    ]
  }
}
```

---

## POST /refresh — 强制刷新所有源

清除 ETag 缓存，强制重新拉取所有已启用源的 Catalog。

### 请求

```
POST /api/store/refresh
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    { "id": 1, "name": "官方源", "success": true },
    { "id": 2, "name": "自定义源", "success": false }
  ]
}
```

---

## GET /init — 初始化默认源

确保默认 Catalog 源存在（幂等操作）。

### 请求

```
GET /api/store/init
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

## POST /preflight — 预检部署

两阶段部署第一步：检查配置和资源是否可用。

### 请求

```
POST /api/store/preflight
```

```json
{
  "accountId": "1",
  "templateId": "vue-starter",
  "name": "my-project",
  "bindingSelections": {
    "KV_NAMESPACE": { "source": "existing", "namespaceId": "kv-uuid" }
  },
  "secretValues": {
    "API_KEY": "my-secret-key"
  },
  "deployType": "pages"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `accountId` | string | 是 | 数据库账户 ID |
| `templateId` | string | 是 | 模板 ID |
| `name` | string | 是 | 部署后的项目名称 |
| `bindingSelections` | object | 否 | 绑定资源选择 |
| `secretValues` | object | 否 | Secret 值映射 |
| `deployType` | string | 否 | 部署类型覆盖 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "canProceed": true,
    "warnings": [],
    "bindingPreview": [
      { "name": "KV_NAMESPACE", "type": "kv_namespace", "namespaceId": "kv-uuid" }
    ]
  }
}
```

### 响应 — 预检未通过

```json
{
  "success": true,
  "data": {
    "canProceed": false,
    "warnings": ["KV namespace not found: kv-uuid"]
  }
}
```

---

## POST /deploy — 执行部署

两阶段部署第二步：实际创建 Worker/Pages 项目。

### 请求

```
POST /api/store/deploy
```

```json
{
  "accountId": "1",
  "templateId": "vue-starter",
  "name": "my-project",
  "bindingSelections": {},
  "secretValues": {
    "API_KEY": "my-secret-key"
  },
  "deployType": "pages",
  "traces": true,
  "logs": true
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "success": true,
    "url": "https://my-project.pages.dev",
    "warnings": []
  }
}
```

**500 Internal Server Error** — 部署失败

```json
{
  "success": false,
  "error": {
    "code": "DEPLOY_FAILED",
    "message": "Failed to upload assets",
    "rolledBack": true,
    "rollbackErrors": [],
    "warnings": []
  }
}
```

---

## POST /deploy-batch — 多账户批量部署

对多个账户执行同一模板的部署。每个目标独立执行 preflight + deploy。

### 请求

```
POST /api/store/deploy-batch
```

```json
{
  "deployments": [
    {
      "accountId": "1",
      "templateId": "vue-starter",
      "name": "project-1",
      "bindingSelections": {},
      "secretValues": { "API_KEY": "key1" },
      "deployType": "pages"
    },
    {
      "accountId": "2",
      "templateId": "vue-starter",
      "name": "project-2",
      "bindingSelections": {},
      "secretValues": { "API_KEY": "key2" },
      "deployType": "pages"
    }
  ]
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "accountId": "1",
      "accountName": "account-1",
      "cfAccountId": "cf-uuid-1",
      "name": "project-1",
      "success": true
    },
    {
      "accountId": "2",
      "accountName": "account-2",
      "cfAccountId": "cf-uuid-2",
      "name": "project-2",
      "success": false,
      "error": "项目名已存在"
    }
  ]
}
```
