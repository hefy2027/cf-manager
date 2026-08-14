# DNS 管理

> 挂载路径：`/api/dns`

---

## 目录

### DNS 记录
- [GET /domains/:domain/records — 获取 DNS 记录列表](#get-domainsdomainrecords-获取-dns-记录列表)
- [POST /domains/:domain/records — 创建 DNS 记录](#post-domainsdomainrecords-创建-dns-记录)
- [PUT /domains/:domain/records/:id — 更新 DNS 记录](#put-domainsdomainrecordsid-更新-dns-记录)
- [DELETE /domains/:domain/records/:id — 删除 DNS 记录](#delete-domainsdomainrecordsid-删除-dns-记录)
- [PATCH /domains/:domain/proxy — 切换代理状态](#patch-domainsdomainproxy-切换代理状态)

### Zone 管理
- [GET /domains — 获取所有域名](#get-domains-获取所有域名)
- [POST /domains — 批量创建 Zone](#post-domains-批量创建-zone)
- [DELETE /domains — 批量删除 Zone](#delete-domains-批量删除-zone)
- [GET /domains/:domain/settings — 获取 Zone 设置](#get-domainsdomainsettings-获取-zone-设置)
- [PATCH /domains/:domain/settings — 更新 Zone 设置](#patch-domainsdomainsettings-更新-zone-设置)
- [PATCH /domains/:domain/status — 暂停/激活 Zone](#patch-domainsdomainstatus-暂停激活-zone)
- [POST /domains/:domain/purge-cache — 清除 Zone 缓存](#post-domainsdomainpurge-cache-清除-zone-缓存)

### 通用规则引擎
- [GET /domains/:domain/rules/:phase — 获取规则列表](#get-domainsdomainrulesphase-获取规则列表)
- [POST /domains/:domain/rules/:phase — 创建规则](#post-domainsdomainrulesphase-创建规则)
- [PUT /domains/:domain/rules/:phase/:ruleId — 更新规则](#put-domainsdomainrulesphaseruleid-更新规则)
- [DELETE /domains/:domain/rules/:phase/:ruleId — 删除规则](#delete-domainsdomainrulesphaseruleid-删除规则)

---

## GET /domains/:domain/records — 获取 DNS 记录列表

### 请求

```
GET /api/dns/domains/example.com/records
```

| 参数 | 位置 | 说明 |
|---|---|---|
| `domain` | path | 域名（如 `example.com`） |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": "record-uuid-1",
      "type": "A",
      "name": "www.example.com",
      "content": "192.168.1.1",
      "proxiable": true,
      "proxied": false,
      "ttl": 1,
      "locked": false,
      "priority": 0,
      "comment": ""
    },
    {
      "id": "record-uuid-2",
      "type": "CNAME",
      "name": "api.example.com",
      "content": "target.example.com",
      "proxiable": true,
      "proxied": true,
      "ttl": 1,
      "priority": 0
    }
  ]
}
```

---

## POST /domains/:domain/records — 创建 DNS 记录

### 请求

```
POST /api/dns/domains/example.com/records
```

```json
{
  "type": "A",
  "name": "www",
  "content": "192.168.1.1",
  "ttl": 1,
  "proxied": false,
  "priority": 0
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `type` | string | 是 | 记录类型：`A`、`AAAA`、`CNAME`、`MX`、`TXT`、`SRV` 等 |
| `name` | string | 是 | 记录名称（如 `www` 或 `@`） |
| `content` | string | 是 | 记录值 |
| `ttl` | number | 否 | TTL（1 = 自动） |
| `proxied` | boolean | 否 | 是否通过 Cloudflare 代理 |
| `priority` | number | 否 | 优先级（MX 记录） |

### 响应

**201 Created**

```json
{
  "success": true,
  "data": {
    "id": "new-record-uuid",
    "type": "A",
    "name": "www.example.com",
    "content": "192.168.1.1",
    "proxied": false,
    "ttl": 1,
    "priority": 0
  }
}
```

---

## PUT /domains/:domain/records/:id — 更新 DNS 记录

### 请求

```
PUT /api/dns/domains/example.com/records/record-uuid-1
```

```json
{
  "type": "A",
  "name": "www",
  "content": "10.0.0.1",
  "ttl": 300,
  "proxied": true
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "id": "record-uuid-1",
    "type": "A",
    "name": "www.example.com",
    "content": "10.0.0.1",
    "proxied": true,
    "ttl": 300
  }
}
```

---

## DELETE /domains/:domain/records/:id — 删除 DNS 记录

### 请求

```
DELETE /api/dns/domains/example.com/records/record-uuid-1
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": { "success": true }
}
```

**403 Forbidden** — 演示账户

```json
{
  "success": false,
  "error": {
    "code": "DEMO_PROTECTED",
    "message": "演示账户不可删除 DNS 记录"
  }
}
```

---

## PATCH /domains/:domain/proxy — 切换代理状态

### 请求

```
PATCH /api/dns/domains/example.com/proxy
```

```json
{
  "record_id": "record-uuid-1",
  "proxied": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `record_id` | string | 是 | DNS 记录 ID |
| `proxied` | boolean | 是 | 是否开启 Cloudflare 代理 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": { "success": true }
}
```

---

## GET /domains — 获取所有域名

返回所有账户下的所有域名（Zone），自动匹配域名所属账户。

### 请求

```
GET /api/dns/domains
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": "zone-uuid-1",
      "name": "example.com",
      "status": "active",
      "paused": false,
      "name_servers": ["ns1.cloudflare.com", "ns2.cloudflare.com"],
      "cfAccountId": "cf-account-uuid",
      "accountName": "my-account"
    }
  ]
}
```

---

## POST /domains — 批量创建 Zone

### 请求

```
POST /api/dns/domains
```

```json
{
  "names": ["example.com", "test.com"],
  "account_id": "1",
  "type": "full"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `names` | string[] | 是 | 域名列表 |
| `account_id` | string | 是 | 关联的账户 ID（数据库 ID） |
| `type` | string | 否 | `"full"`(默认) 或 `"partial"` |

### 响应

**201 Created**

```json
{
  "success": true,
  "data": {
    "total": 2,
    "succeeded": 1,
    "failed": 1,
    "results": [
      {
        "name": "example.com",
        "success": true,
        "zone_id": "zone-uuid-1",
        "name_servers": ["ns1.cloudflare.com", "ns2.cloudflare.com"]
      },
      {
        "name": "test.com",
        "success": false,
        "error": "Zone already exists"
      }
    ]
  }
}
```

---

## DELETE /domains — 批量删除 Zone

### 请求

```
DELETE /api/dns/domains
```

```json
{
  "domains": ["example.com", "test.com"]
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
    "failed": 0,
    "results": [
      { "name": "example.com", "success": true },
      { "name": "test.com", "success": true }
    ]
  }
}
```

---

## GET /domains/:domain/settings — 获取 Zone 设置

### 请求

```
GET /api/dns/domains/example.com/settings
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "always_use_https": "on",
    "ssl": "full",
    "min_tls_version": "1.2",
    "browser_cache_ttl": 14400,
    "cache_level": "aggressive"
  }
}
```

---

## PATCH /domains/:domain/settings — 更新 Zone 设置

### 请求

```
PATCH /api/dns/domains/example.com/settings
```

```json
{
  "always_use_https": "on",
  "ssl": "strict",
  "min_tls_version": "1.3",
  "browser_cache_ttl": 3600
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "updated": ["always_use_https", "ssl", "min_tls_version", "browser_cache_ttl"],
    "failed": []
  }
}
```

---

## PATCH /domains/:domain/status — 暂停/激活 Zone

### 请求

```
PATCH /api/dns/domains/example.com/status
```

```json
{
  "paused": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `paused` | boolean | 是 | `true` 暂停 Zone，`false` 激活 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": { "success": true }
}
```

---

## POST /domains/:domain/purge-cache — 清除 Zone 缓存

### 请求

```
POST /api/dns/domains/example.com/purge-cache
```

清除全部缓存：

```json
{
  "purge_everything": true
}
```

清除指定 URL：

```json
{
  "purge_everything": false,
  "files": [
    "https://example.com/css/style.css",
    "https://example.com/js/app.js"
  ]
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": { "id": "purge-job-uuid" }
}
```

---

## GET /domains/:domain/rules/:phase — 获取规则列表

### 请求

```
GET /api/dns/domains/example.com/rules/http_request_dynamic_redirect
```

| 参数 | 位置 | 说明 |
|---|---|---|
| `domain` | path | 域名 |
| `phase` | path | 规则阶段，如 `http_request_dynamic_redirect`、`http_request_firewall_custom` 等 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": "rule-uuid-1",
      "description": "Redirect HTTP to HTTPS",
      "expression": "(http.request.uri.scheme != \"https\")",
      "action": "redirect",
      "action_parameters": { "from_value": { "status_code": 301, "target_url": { "expression": "concat(\"https://\", http.host, http.request.uri.path)" } } },
      "enabled": true
    }
  ]
}
```

---

## POST /domains/:domain/rules/:phase — 创建规则

### 请求

```
POST /api/dns/domains/example.com/rules/http_request_dynamic_redirect
```

```json
{
  "description": "Block specific IP",
  "expression": "(ip.src == 1.2.3.4)",
  "action": "block",
  "action_parameters": {},
  "enabled": true
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `description` | string | 否 | 规则描述 |
| `expression` | string | 是 | Wirefilter 表达式 |
| `action` | string | 是 | 动作：`block`、`redirect`、`challenge` 等 |
| `action_parameters` | object | 否 | 动作参数 |
| `enabled` | boolean | 否 | 是否启用 |

### 响应

**201 Created**

```json
{
  "success": true,
  "data": {
    "id": "new-rule-uuid",
    "description": "Block specific IP",
    "expression": "(ip.src == 1.2.3.4)",
    "action": "block",
    "enabled": true
  }
}
```

---

## PUT /domains/:domain/rules/:phase/:ruleId — 更新规则

### 请求

```
PUT /api/dns/domains/example.com/rules/http_request_dynamic_redirect/rule-uuid-1
```

```json
{
  "description": "Updated description",
  "expression": "(ip.src == 1.2.3.4)",
  "action": "block",
  "enabled": false
}
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "id": "rule-uuid-1",
    "description": "Updated description",
    "expression": "(ip.src == 1.2.3.4)",
    "action": "block",
    "enabled": false
  }
}
```

---

## DELETE /domains/:domain/rules/:phase/:ruleId — 删除规则

### 请求

```
DELETE /api/dns/domains/example.com/rules/http_request_dynamic_redirect/rule-uuid-1
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": { "success": true }
}
```
