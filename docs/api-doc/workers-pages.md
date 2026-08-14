# Workers / Pages

> 挂载路径：`/api/workers`

---

## 目录

### 列表与用量
- [GET / — 列出所有 Workers 和 Pages](#get---列出所有-workers-和-pages)
- [GET /summary — 用量摘要](#get-summary-用量摘要)
- [GET /usage — Workers 今日用量](#get-usage-workers-今日用量)

### Worker 操作
- [DELETE /:accountId/workers/:name — 删除 Worker](#delete-accountidworkersname-删除-worker)
- [GET /:accountId/workers/:name/logs — 获取日志](#get-accountidworkersnamelogs-获取日志)
- [GET /:accountId/workers/:name/content — 获取脚本内容](#get-accountidworkersnamecontent-获取脚本内容)
- [GET /:accountId/workers/:name/config — 获取配置](#get-accountidworkersnameconfig-获取配置)
- [GET /:accountId/workers/:name/deployments — 列出部署](#get-accountidworkersnamedeployments-列出部署)

### Worker Secrets
- [GET /:accountId/workers/:name/secrets — 列出 Secrets](#get-accountidworkersnamesecrets-列出-secrets)
- [PUT /:accountId/workers/:name/secrets — 创建/更新 Secret](#put-accountidworkersnamesecrets-创建更新-secret)
- [DELETE /:accountId/workers/:name/secrets/:secretName — 删除 Secret](#delete-accountidworkersnamesecretssecretname-删除-secret)

### Worker 定时触发器
- [GET /:accountId/workers/:name/schedules — 获取 Cron 触发器](#get-accountidworkersnameschedules-获取-cron-触发器)
- [PUT /:accountId/workers/:name/schedules — 更新 Cron 触发器](#put-accountidworkersnameschedules-更新-cron-触发器)

### Worker 自定义域名
- [GET /:accountId/workers/:name/domains — 列出自定义域名](#get-accountidworkersnamedomains-列出自定义域名)
- [POST /:accountId/workers/:name/domains — 添加自定义域名](#post-accountidworkersnamedomains-添加自定义域名)
- [DELETE /:accountId/workers/:name/domains/:domainId — 删除自定义域名](#delete-accountidworkersnamedomainsdomainid-删除自定义域名)

### Worker workers.dev 子域名
- [GET /:accountId/workers/:name/subdomain — 获取子域名状态](#get-accountidworkersnamesubdomain-获取子域名状态)
- [PUT /:accountId/workers/:name/subdomain — 启用/禁用子域名](#put-accountidworkersnamesubdomain-启用禁用子域名)

### Worker 脚本设置与路由
- [GET /:accountId/workers/:name/settings — 获取脚本设置](#get-accountidworkersnamesettings-获取脚本设置)
- [PATCH /:accountId/workers/:name/settings — 更新脚本设置](#patch-accountidworkersnamesettings-更新脚本设置)
- [GET /:accountId/workers/:name/routes — 列出路由](#get-accountidworkersnameroutes-列出路由)
- [POST /:accountId/workers/:name/routes — 创建路由](#post-accountidworkersnameroutes-创建路由)
- [DELETE /:accountId/workers/:name/routes/:routeId — 删除路由](#delete-accountidworkersnameroutesrouteid-删除路由)

### Pages 操作
- [DELETE /:accountId/pages/:name — 删除 Pages 项目](#delete-accountidpagesname-删除-pages-项目)
- [GET /:accountId/pages/:name/project — 获取项目详情](#get-accountidpagesnameproject-获取项目详情)
- [PATCH /:accountId/pages/:name/project — 编辑项目](#patch-accountidpagesnameproject-编辑项目)
- [GET /:accountId/pages/:name/config — 获取配置](#get-accountidpagesnameconfig-获取配置)
- [GET /:accountId/pages/:name/domains — 列出域名](#get-accountidpagesnamedomains-列出域名)
- [POST /:accountId/pages/:name/domains — 添加域名](#post-accountidpagesnamedomains-添加域名)
- [DELETE /:accountId/pages/:name/domains/:hostname — 删除域名](#delete-accountidpagesnamedomainshostname-删除域名)
- [GET /:accountId/pages/:name/deployments — 列出部署](#get-accountidpagesnamedeployments-列出部署)
- [DELETE /:accountId/pages/:name/deployments/:deploymentId — 删除单个部署](#delete-accountidpagesnamedeploymentsdeploymentid-删除单个部署)
- [DELETE /:accountId/pages/:name/deployments — 批量删除部署](#delete-accountidpagesnamedeployments-批量删除部署)
- [PUT /:accountId/pages/:name/bindings — 更新绑定](#put-accountidpagesnamebindings-更新绑定)

### CF 资源查询
- [GET /:accountId/resources/kv — 列出 KV](#get-accountidresourceskv-列出-kv)
- [GET /:accountId/resources/d1 — 列出 D1](#get-accountidresourcesd1-列出-d1)
- [GET /:accountId/resources/r2 — 列出 R2](#get-accountidresourcesr2-列出-r2)
- [GET /:accountId/resources/zones — 列出域名](#get-accountidresourceszones-列出域名)

### 批量部署
- [POST /batch-deploy — 批量部署 Worker](#post-batch-deploy-批量部署-worker)
- [POST /batch-deploy-pages — 批量部署 Pages](#post-batch-deploy-pages-批量部署-pages)
- [POST /env-sync/preview — 环境同步预览](#post-env-syncpreview-环境同步预览)
- [POST /env-sync/execute — 环境同步执行](#post-env-syncexecute-环境同步执行)

---

## GET / — 列出所有 Workers 和 Pages

### 请求

```
GET /api/workers
GET /api/workers?accountId=1
```

| 参数 | 位置 | 类型 | 说明 |
|---|---|---|---|
| `accountId` | query | number | 可选，仅返回该账户的 Worker/Pages |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": "my-worker",
      "name": "my-worker",
      "type": "worker",
      "status": "deployed",
      "cfAccountId": 1,
      "accountName": "my-account",
      "created_on": "2024-01-01T00:00:00Z",
      "modified_on": "2024-01-02T00:00:00Z"
    },
    {
      "id": "my-pages-project",
      "name": "my-pages-project",
      "type": "pages",
      "cfAccountId": 1,
      "accountName": "my-account",
      "subdomain": "my-pages-project.pages.dev"
    }
  ]
}
```

---

## GET /summary — 用量摘要

### 请求

```
GET /api/workers/summary
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "accountId": 1,
      "accountName": "my-account",
      "requests": 50000,
      "errors": 10,
      "subrequests": 200,
      "cpuTimeMs": 15000,
      "workerCount": 5,
      "pagesCount": 2
    }
  ]
}
```

---

## GET /usage — Workers 今日用量

### 请求

```
GET /api/workers/usage
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "accountId": 1,
      "accountName": "my-account",
      "requests": 50000,
      "errors": 10,
      "subrequests": 200,
      "cpuTimeMs": 15000
    }
  ]
}
```

---

## DELETE /:accountId/workers/:name — 删除 Worker

### 请求

```
DELETE /api/workers/1/workers/my-worker
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

## GET /:accountId/workers/:name/logs — 获取日志

### 请求

```
GET /api/workers/1/workers/my-worker/logs
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "timestamp": "2024-01-01T12:00:00Z",
      "level": "info",
      "message": "Worker started"
    }
  ]
}
```

---

## GET /:accountId/workers/:name/content — 获取脚本内容

### 请求

```
GET /api/workers/1/workers/my-worker/content
```

### 响应

**200 OK** — 纯文本（非 JSON）

```
export default {
  async fetch(request, env) {
    return new Response("Hello World");
  }
};
```

---

## GET /:accountId/workers/:name/config — 获取配置

获取 Worker 的完整配置（绑定、环境变量等），用于重部署时预填表单。

### 请求

```
GET /api/workers/1/workers/my-worker/config
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "vars": [
      { "name": "API_KEY", "type": "secret_text" },
      { "name": "DEBUG", "type": "plain_text", "value": "true" }
    ],
    "bindings": [
      { "type": "kv_namespace", "name": "MY_KV", "namespace_id": "kv-uuid" },
      { "type": "d1", "name": "MY_DB", "id": "d1-uuid" }
    ],
    "main_module": "index.js"
  }
}
```

---

## GET /:accountId/workers/:name/deployments — 列出部署

### 请求

```
GET /api/workers/1/workers/my-worker/deployments
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "deployment-uuid",
        "created_on": "2024-01-01T00:00:00Z",
        "source": "api",
        "author_email": "user@example.com"
      }
    ]
  }
}
```

---

## GET /:accountId/workers/:name/secrets — 列出 Secrets

### 请求

```
GET /api/workers/1/workers/my-worker/secrets
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    { "name": "API_KEY", "type": "secret_text" },
    { "name": "DB_PASSWORD", "type": "secret_text" }
  ]
}
```

---

## PUT /:accountId/workers/:name/secrets — 创建/更新 Secret

### 请求

```
PUT /api/workers/1/workers/my-worker/secrets
```

```json
{
  "name": "API_KEY",
  "type": "secret_text",
  "text": "my-secret-value"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | Secret 名称 |
| `type` | string | 是 | `secret_text` 或 `secret_key_value` |
| `text` | string | type=secret_text 时必填 | Secret 文本值 |
| `key_base64` | string | type=secret_key_value 时必填 | Base64 编码的密钥 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": { "success": true }
}
```

---

## DELETE /:accountId/workers/:name/secrets/:secretName — 删除 Secret

### 请求

```
DELETE /api/workers/1/workers/my-worker/secrets/API_KEY
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

## GET /:accountId/workers/:name/schedules — 获取 Cron 触发器

### 请求

```
GET /api/workers/1/workers/my-worker/schedules
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "schedules": [
      { "cron": "0 */6 * * *" },
      { "cron": "0 0 * * 0" }
    ]
  }
}
```

---

## PUT /:accountId/workers/:name/schedules — 更新 Cron 触发器

### 请求

```
PUT /api/workers/1/workers/my-worker/schedules
```

```json
{
  "crons": ["0 */6 * * *", "0 0 * * 0"]
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "schedules": [
      { "cron": "0 */6 * * *" },
      { "cron": "0 0 * * 0" }
    ]
  }
}
```

---

## GET /:accountId/workers/:name/domains — 列出自定义域名

### 请求

```
GET /api/workers/1/workers/my-worker/domains
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": "domain-uuid",
      "hostname": "app.example.com",
      "environment": "production",
      "service": "my-worker"
    }
  ]
}
```

---

## POST /:accountId/workers/:name/domains — 添加自定义域名

### 请求

```
POST /api/workers/1/workers/my-worker/domains
```

```json
{
  "hostname": "app.example.com",
  "environment": "production"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `hostname` | string | 是 | 自定义域名 |
| `environment` | string | 否 | 环境（如 `production`） |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "id": "domain-uuid",
    "hostname": "app.example.com",
    "environment": "production"
  }
}
```

---

## DELETE /:accountId/workers/:name/domains/:domainId — 删除自定义域名

### 请求

```
DELETE /api/workers/1/workers/my-worker/domains/domain-uuid
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

## GET /:accountId/workers/:name/subdomain — 获取子域名状态

### 请求

```
GET /api/workers/1/workers/my-worker/subdomain
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "subdomain": "my-worker.my-account.workers.dev"
  }
}
```

---

## PUT /:accountId/workers/:name/subdomain — 启用/禁用子域名

### 请求

```
PUT /api/workers/1/workers/my-worker/subdomain
```

```json
{
  "enabled": true
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "enabled": true,
    "subdomain": "my-worker.my-account.workers.dev"
  }
}
```

---

## GET /:accountId/workers/:name/settings — 获取脚本设置

### 请求

```
GET /api/workers/1/workers/my-worker/settings
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "bindings": [],
    "compatibility_date": "2024-01-01",
    "usage_model": "bundled"
  }
}
```

---

## PATCH /:accountId/workers/:name/settings — 更新脚本设置

### 请求

```
PATCH /api/workers/1/workers/my-worker/settings
```

```json
{
  "compatibility_date": "2024-03-01",
  "usage_model": "unbound"
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "compatibility_date": "2024-03-01",
    "usage_model": "unbound"
  }
}
```

---

## GET /:accountId/workers/:name/routes — 列出路由

### 请求

```
GET /api/workers/1/workers/my-worker/routes?zone_id=zone-uuid
```

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `zone_id` | query | 是 | Zone ID |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": "route-uuid",
      "pattern": "example.com/*",
      "script": "my-worker"
    }
  ]
}
```

---

## POST /:accountId/workers/:name/routes — 创建路由

### 请求

```
POST /api/workers/1/workers/my-worker/routes
```

```json
{
  "zone_id": "zone-uuid",
  "pattern": "example.com/*",
  "script": "my-worker"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `zone_id` | string | 是 | Zone ID |
| `pattern` | string | 是 | 路由匹配模式 |
| `script` | string | 否 | Worker 名称（默认为 URL 中的 `:name`） |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "id": "route-uuid",
    "pattern": "example.com/*",
    "script": "my-worker"
  }
}
```

---

## DELETE /:accountId/workers/:name/routes/:routeId — 删除路由

### 请求

```
DELETE /api/workers/1/workers/my-worker/routes/route-uuid?zone_id=zone-uuid
```

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `zone_id` | query | 是 | Zone ID |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": { "success": true }
}
```

---

## DELETE /:accountId/pages/:name — 删除 Pages 项目

### 请求

```
DELETE /api/workers/1/pages/my-pages-project
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

## GET /:accountId/pages/:name/project — 获取项目详情

### 请求

```
GET /api/workers/1/pages/my-pages-project/project
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "name": "my-pages-project",
    "subdomain": "my-pages-project.pages.dev",
    "domains": ["app.example.com"],
    "created_on": "2024-01-01T00:00:00Z",
    "deployment_configs": {
      "production": {
        "env_vars": { "API_KEY": { "type": "secret_text" } }
      }
    }
  }
}
```

---

## PATCH /:accountId/pages/:name/project — 编辑项目

### 请求

```
PATCH /api/workers/1/pages/my-pages-project/project
```

```json
{
  "deployment_configs": {
    "production": {
      "env_vars": {
        "DEBUG": { "type": "plain_text", "value": "true" }
      }
    }
  }
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "name": "my-pages-project",
    "deployment_configs": {
      "production": {
        "env_vars": { "DEBUG": { "type": "plain_text", "value": "true" } }
      }
    }
  }
}
```

---

## GET /:accountId/pages/:name/config — 获取配置

### 请求

```
GET /api/workers/1/pages/my-pages-project/config
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "vars": [
      { "name": "API_KEY", "type": "secret_text" },
      { "name": "DEBUG", "type": "plain_text", "value": "true" }
    ],
    "bindings": [
      { "type": "kv_namespace", "name": "MY_KV", "namespace_id": "kv-uuid" }
    ]
  }
}
```

---

## GET /:accountId/pages/:name/domains — 列出域名

### 请求

```
GET /api/workers/1/pages/my-pages-project/domains
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "name": "app.example.com",
      "status": "active",
      "verification_status": "verified"
    }
  ]
}
```

---

## POST /:accountId/pages/:name/domains — 添加域名

### 请求

```
POST /api/workers/1/pages/my-pages-project/domains
```

```json
{
  "hostname": "app.example.com"
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "name": "app.example.com",
    "status": "pending"
  }
}
```

---

## DELETE /:accountId/pages/:name/domains/:hostname — 删除域名

### 请求

```
DELETE /api/workers/1/pages/my-pages-project/domains/app.example.com
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

## GET /:accountId/pages/:name/deployments — 列出部署

### 请求

```
GET /api/workers/1/pages/my-pages-project/deployments
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": "deployment-uuid",
      "environment": "production",
      "created_on": "2024-01-01T00:00:00Z",
      "url": "https://abc123.my-pages-project.pages.dev",
      "latest_stage": { "name": "deploy", "status": "success" }
    }
  ]
}
```

---

## DELETE /:accountId/pages/:name/deployments/:deploymentId — 删除单个部署

### 请求

```
DELETE /api/workers/1/pages/my-pages-project/deployments/deployment-uuid
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

## DELETE /:accountId/pages/:name/deployments — 批量删除部署

### 请求

```
DELETE /api/workers/1/pages/my-pages-project/deployments
```

```json
{
  "ids": ["deployment-uuid-1", "deployment-uuid-2"]
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "total": 2,
    "succeeded": 2,
    "failed": 0
  }
}
```

---

## PUT /:accountId/pages/:name/bindings — 更新绑定

### 请求

```
PUT /api/workers/1/pages/my-pages-project/bindings
```

```json
{
  "deployment_configs": {
    "production": {
      "kv_namespaces": {
        "MY_KV": { "namespace_id": "kv-uuid" }
      },
      "d1_databases": {
        "MY_DB": { "id": "d1-uuid" }
      },
      "env_vars": {
        "DEBUG": { "type": "plain_text", "value": "true" }
      }
    }
  }
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

## GET /:accountId/resources/kv — 列出 KV

### 请求

```
GET /api/workers/1/resources/kv
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": "kv-namespace-uuid",
      "title": "my-kv-namespace",
      "supports_url_encoding": true
    }
  ]
}
```

---

## GET /:accountId/resources/d1 — 列出 D1

### 请求

```
GET /api/workers/1/resources/d1
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "uuid": "d1-db-uuid",
      "name": "my-database",
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

---

## GET /:accountId/resources/r2 — 列出 R2

自动检测 R2 可用性，若未启用则返回 `r2_not_enabled: true`。

### 请求

```
GET /api/workers/1/resources/r2
```

### 响应 — R2 已启用

**200 OK**

```json
{
  "success": true,
  "data": {
    "buckets": [
      {
        "name": "my-bucket",
        "creation_date": "2024-01-01T00:00:00Z"
      }
    ]
  }
}
```

### 响应 — R2 未启用

```json
{
  "success": true,
  "data": {
    "r2_not_enabled": true,
    "buckets": []
  }
}
```

---

## GET /:accountId/resources/zones — 列出域名

### 请求

```
GET /api/workers/1/resources/zones
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": "zone-uuid",
      "name": "example.com",
      "status": "active",
      "cfAccountId": 1
    }
  ]
}
```

---

## POST /batch-deploy — 批量部署 Worker

`multipart/form-data`，支持 `.js` 单模块 / `.zip` 多模块包 / URL 远程拉取。

### 请求

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `targets` | JSON string | 是 | `[{"accountId": 1, "workerName": "my-worker"}]` |
| `script` | File | 条件必填 | `.js` 或 `.zip` 文件（与 `url` 二选一） |
| `assets` | File | 否 | 静态资源 ZIP |
| `url` | string | 条件必填 | 脚本远程 URL |
| `vars` | JSON string | 否 | `[{"name":"KEY","value":"val","secret":false,"keep":false}]` |
| `bindings` | JSON string | 否 | `[{"type":"kv_namespace","name":"MY_KV","namespace_id":"kv-uuid"}]` |
| `isRedeploy` | string | 否 | `"true"` 时仅更新配置 |
| `mainModule` | string | 否 | ZIP 部署入口模块名 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    { "accountId": 1, "workerName": "my-worker", "success": true },
    { "accountId": 2, "workerName": "my-worker", "success": false, "error": "Account not found" }
  ]
}
```

---

## POST /batch-deploy-pages — 批量部署 Pages

`multipart/form-data`，上传 ZIP 文件。

### 请求

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `targets` | JSON string | 是 | `[{"accountId": 1, "workerName": "my-pages"}]` |
| `zipFile` | File | 条件必填 | ZIP 静态文件包 |
| `vars` | JSON string | 否 | 环境变量 |
| `bindings` | JSON string | 否 | 资源绑定 |
| `isRedeploy` | string | 否 | `"true"` 时仅更新配置 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    { "accountId": 1, "workerName": "my-pages", "success": true },
    { "accountId": 2, "workerName": "my-pages", "success": false, "error": "项目名只能包含小写字母、数字和连字符" }
  ]
}
```

---

## POST /env-sync/preview — 环境同步预览

对比源 Worker 与目标 Worker 的 Secrets 差异。

### 请求

```json
{
  "source": {
    "accountId": 1,
    "workerName": "source-worker"
  },
  "targets": [
    { "accountId": 2, "workerName": "target-worker" }
  ],
  "syncTypes": ["secrets"]
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "accountId": 2,
      "workerName": "target-worker",
      "secrets": {
        "added": ["API_KEY", "DB_PASSWORD"],
        "existing": ["DEBUG"]
      }
    }
  ]
}
```

---

## POST /env-sync/execute — 环境同步执行

将源 Worker 的 Secrets 同步到目标 Worker。

### 请求

```json
{
  "source": {
    "accountId": 1,
    "workerName": "source-worker"
  },
  "targets": [
    { "accountId": 2, "workerName": "target-worker" }
  ],
  "syncTypes": ["secrets"],
  "secretValues": {
    "API_KEY": "actual-secret-value",
    "DB_PASSWORD": "actual-password"
  }
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "accountId": 2,
      "workerName": "target-worker",
      "success": true,
      "synced": 2
    }
  ]
}
```
