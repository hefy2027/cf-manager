# Tunnel 隧道

> 挂载路径：`/api/tunnels`

---

## 目录

### 隧道账户与列表
- [GET /accounts — 列出隧道账户](#get-accounts-列出隧道账户)
- [GET /accounts/:id/tunnels — 列出隧道](#get-accountsidtunnels-列出隧道)
- [GET /accounts/:id/zones — 列出域名](#get-accountsidzones-列出域名)

### 隧道操作
- [POST /accounts/:id/tunnels — 创建隧道](#post-accountsidtunnels-创建隧道)
- [DELETE /accounts/:id/tunnels/:tunnelId — 删除隧道](#delete-accountsidtunnelstunnelid-删除隧道)
- [GET /accounts/:id/tunnels/:tunnelId/token — 获取令牌](#get-accountsidtunnelstunnelidtoken-获取令牌)
- [GET /accounts/:id/tunnels/:tunnelId/connections — 获取连接信息](#get-accountsidtunnelstunnelidconnections-获取连接信息)
- [GET /accounts/:id/tunnels/:tunnelId/hostnames — 列出主机名](#get-accountsidtunnelstunnelidhostnames-列出主机名)
- [GET /accounts/:id/tunnels/:tunnelId/config — 获取配置](#get-accountsidtunnelstunnelidconfig-获取配置)
- [PUT /accounts/:id/tunnels/:tunnelId/config — 更新配置](#put-accountsidtunnelstunnelidconfig-更新配置)

### 一键回源向导
- [POST /accounts/:id/wizard — 回源向导](#post-accountsidwizard-回源向导)

---

## GET /accounts — 列出隧道账户

### 请求

```
GET /api/tunnels/accounts
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "my-account",
      "account_id": "cf-account-uuid"
    }
  ]
}
```

---

## GET /accounts/:id/tunnels — 列出隧道

### 请求

```
GET /api/tunnels/accounts/1/tunnels
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": "tunnel-uuid-1",
      "name": "my-tunnel",
      "status": "healthy",
      "connections": [
        { "id": "conn-uuid", "colo_name": "SJC" }
      ],
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

---

## GET /accounts/:id/zones — 列出域名

### 请求

```
GET /api/tunnels/accounts/1/zones
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    { "id": "zone-uuid", "name": "example.com", "status": "active" }
  ]
}
```

---

## POST /accounts/:id/tunnels — 创建隧道

### 请求

```
POST /api/tunnels/accounts/1/tunnels
```

```json
{
  "name": "my-new-tunnel"
}
```

### 响应

**201 Created**

```json
{
  "success": true,
  "data": {
    "id": "new-tunnel-uuid",
    "name": "my-new-tunnel",
    "created_at": "2024-01-01T00:00:00Z"
  }
}
```

---

## DELETE /accounts/:id/tunnels/:tunnelId — 删除隧道

### 请求

```
DELETE /api/tunnels/accounts/1/tunnels/tunnel-uuid-1
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
    "message": "演示账户不可删除隧道"
  }
}
```

---

## GET /accounts/:id/tunnels/:tunnelId/token — 获取令牌

### 请求

```
GET /api/tunnels/accounts/1/tunnels/tunnel-uuid-1/token
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "token": "eyJhY2NvdW50X2lkIjoi..."
  }
}
```

**403 Forbidden** — 演示账户

```json
{
  "success": false,
  "error": {
    "code": "DEMO_PROTECTED",
    "message": "演示账户不可查看令牌"
  }
}
```

---

## GET /accounts/:id/tunnels/:tunnelId/connections — 获取连接信息

### 请求

```
GET /api/tunnels/accounts/1/tunnels/tunnel-uuid-1/connections
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": "conn-uuid",
      "colo_name": "SJC",
      "version": "2024.1.0",
      "is_pending_reconnect": false
    }
  ]
}
```

---

## GET /accounts/:id/tunnels/:tunnelId/hostnames — 列出主机名

### 请求

```
GET /api/tunnels/accounts/1/tunnels/tunnel-uuid-1/hostnames
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "hostname": "app.example.com",
      "lb_pool": "",
      "tunnel_id": "tunnel-uuid-1"
    }
  ]
}
```

---

## GET /accounts/:id/tunnels/:tunnelId/config — 获取配置

### 请求

```
GET /api/tunnels/accounts/1/tunnels/tunnel-uuid-1/config
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "hostname": "app.example.com",
      "service": "http://localhost:3000"
    },
    {
      "hostname": "api.example.com",
      "service": "http://localhost:8080",
      "path": "/v1"
    },
    {
      "service": "http_status:404"
    }
  ]
}
```

---

## PUT /accounts/:id/tunnels/:tunnelId/config — 更新配置

### 请求

```
PUT /api/tunnels/accounts/1/tunnels/tunnel-uuid-1/config
```

```json
{
  "ingress": [
    {
      "hostname": "app.example.com",
      "service": "http://localhost:3000"
    },
    {
      "hostname": "api.example.com",
      "service": "http://localhost:8080",
      "path": "/v1"
    },
    {
      "service": "http_status:404"
    }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ingress` | array | 是 | Ingress 规则数组，最后一条必须是 catch-all（无 `hostname`） |

每条规则：

| 字段 | 类型 | 说明 |
|---|---|---|
| `hostname` | string | 匹配的主机名（catch-all 规则不需要） |
| `service` | string | 后端服务地址（如 `http://localhost:3000` 或 `http_status:404`） |
| `path` | string | 可选路径匹配 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "tunnel_id": "tunnel-uuid-1",
    "version": 2
  }
}
```

---

## POST /accounts/:id/wizard — 回源向导

一键完成：创建隧道 → 创建 CNAME → 配置 Ingress 规则。失败时自动回滚（删除已创建的 CNAME 和隧道）。

### 请求

```
POST /api/tunnels/accounts/1/wizard
```

```json
{
  "mode": "create",
  "tunnelId": null,
  "hostname": "app.example.com",
  "port": 3000,
  "tunnelName": "my-tunnel",
  "protocol": "http",
  "path": "/api"
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `mode` | string | 否 | `"create"`(默认) 新建隧道 / `"reuse"` 复用已有隧道 |
| `tunnelId` | string | mode=reuse 时必填 | 要复用的隧道 ID |
| `hostname` | string | 是 | 回源主机名（如 `app.example.com`） |
| `port` | number | 是 | 本地服务端口 |
| `tunnelName` | string | 否 | 新建隧道的名称（默认 `tunnel-{hostname}`） |
| `protocol` | string | 否 | 本地服务协议（默认 `http`） |
| `path` | string | 否 | 路径匹配（可选） |

### 响应

**201 Created**

```json
{
  "success": true,
  "data": {
    "tunnelId": "new-tunnel-uuid",
    "hostname": "app.example.com",
    "cnameTarget": "new-tunnel-uuid.cfargotunnel.com",
    "mode": "create"
  }
}
```

**400 Bad Request** — CNAME 已存在

```json
{
  "success": false,
  "error": {
    "code": "CNAME_CONFLICT",
    "message": "hostname 已存在 CNAME 记录，请先在 DNS 页面删除或修改后再试"
  }
}
```

**500 Internal Server Error** — 部分失败并回滚

```json
{
  "success": false,
  "error": {
    "code": "WIZARD_PARTIAL_FAIL",
    "message": "向导部分步骤失败，回滚时也有错误",
    "failedStep": "wizard",
    "rollbackErrors": ["Tunnel tunnel-uuid: Connection refused"]
  }
}
```
