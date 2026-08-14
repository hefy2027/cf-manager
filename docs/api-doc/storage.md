# 存储管理 (KV/D1/R2)

> 挂载路径：`/api/storage`

---

## 目录

### KV 命名空间
- [GET /:accountId/kv — 列出 KV 命名空间](#get-accountidkv-列出-kv-命名空间)
- [POST /:accountId/kv — 创建 KV 命名空间](#post-accountidkv-创建-kv-命名空间)
- [DELETE /:accountId/kv/:nsId — 删除 KV 命名空间](#delete-accountidkvnsid-删除-kv-命名空间)

### KV 键值操作
- [GET /:accountId/kv/:nsId/keys — 列出键](#get-accountidkvnsidkeys-列出键)
- [GET /:accountId/kv/:nsId/values/:key — 获取键值](#get-accountidkvnsidvalueskey-获取键值)
- [PUT /:accountId/kv/:nsId/values/:key — 写入键值](#put-accountidkvnsidvalueskey-写入键值)
- [DELETE /:accountId/kv/:nsId/values/:key — 删除单个键](#delete-accountidkvnsidvalueskey-删除单个键)
- [POST /:accountId/kv/:nsId/bulk-delete — 批量删除键](#post-accountidkvnsidbulk-delete-批量删除键)

### D1 数据库
- [GET /:accountId/d1 — 列出 D1 数据库](#get-accountidd1-列出-d1-数据库)
- [POST /:accountId/d1 — 创建 D1 数据库](#post-accountidd1-创建-d1-数据库)
- [DELETE /:accountId/d1/:dbId — 删除 D1 数据库](#delete-accountidd1dbid-删除-d1-数据库)
- [GET /:accountId/d1/:dbId/tables — 列出表](#get-accountidd1dbidtables-列出表)
- [GET /:accountId/d1/:dbId/tables/:tableName/schema — 获取表结构](#get-accountidd1dbidtabletatablenameschema-获取表结构)
- [POST /:accountId/d1/:dbId/query — 执行 SQL 查询](#post-accountidd1dbidquery-执行-sql-查询)

### R2 存储桶
- [GET /:accountId/r2 — 列出 R2 存储桶](#get-accountidr2-列出-r2-存储桶)
- [POST /:accountId/r2 — 创建 R2 存储桶](#post-accountidr2-创建-r2-存储桶)
- [DELETE /:accountId/r2/:bucket — 删除 R2 存储桶](#delete-accountidr2bucket-删除-r2-存储桶)

### R2 对象操作
- [GET /:accountId/r2/:bucket/objects — 列出对象](#get-accountidr2bucketobjects-列出对象)
- [GET /:accountId/r2/:bucket/download — 下载对象](#get-accountidr2bucketdownload-下载对象)
- [PUT /:accountId/r2/:bucket/upload — 上传对象](#put-accountidr2bucketupload-上传对象)
- [DELETE /:accountId/r2/:bucket/objects — 删除对象](#delete-accountidr2bucketobjects-删除对象)
- [POST /:accountId/r2/:bucket/bulk-delete — 批量删除对象](#post-accountidr2bucketbulk-delete-批量删除对象)

---

## GET /:accountId/kv — 列出 KV 命名空间

### 请求

```
GET /api/storage/1/kv
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

## POST /:accountId/kv — 创建 KV 命名空间

### 请求

```
POST /api/storage/1/kv
```

```json
{
  "title": "new-kv-namespace"
}
```

### 响应

**201 Created**

```json
{
  "success": true,
  "data": {
    "id": "new-kv-uuid",
    "title": "new-kv-namespace"
  }
}
```

---

## DELETE /:accountId/kv/:nsId — 删除 KV 命名空间

### 请求

```
DELETE /api/storage/1/kv/kv-namespace-uuid
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

## GET /:accountId/kv/:nsId/keys — 列出键

### 请求

```
GET /api/storage/1/kv/kv-namespace-uuid/keys?prefix=user_&limit=50&cursor=abc
```

| 参数 | 位置 | 类型 | 说明 |
|---|---|---|---|
| `prefix` | query | string | 键名前缀过滤 |
| `cursor` | query | string | 分页游标 |
| `limit` | query | number | 每页条数 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "keys": [
      { "name": "user_001", "expiration": null, "metadata": { "role": "admin" } },
      { "name": "user_002", "expiration": null, "metadata": null }
    ],
    "list_complete": false,
    "cursor": "next-cursor-abc"
  }
}
```

---

## GET /:accountId/kv/:nsId/values/:key — 获取键值

### 请求

```
GET /api/storage/1/kv/kv-namespace-uuid/values/user_001
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "name": "user_001",
    "value": "{\"name\":\"John\",\"role\":\"admin\"}"
  }
}
```

---

## PUT /:accountId/kv/:nsId/values/:key — 写入键值

### 请求

```
PUT /api/storage/1/kv/kv-namespace-uuid/values/user_001
```

```json
{
  "value": "{\"name\":\"John\",\"role\":\"admin\"}",
  "expiration_ttl": 3600,
  "expiration": null,
  "metadata": { "role": "admin" }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `value` | string | 是 | 键值 |
| `expiration_ttl` | number | 否 | TTL（秒） |
| `expiration` | number | 否 | 绝对过期时间戳 |
| `metadata` | object | 否 | 元数据 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": { "success": true }
}
```

---

## DELETE /:accountId/kv/:nsId/values/:key — 删除单个键

### 请求

```
DELETE /api/storage/1/kv/kv-namespace-uuid/values/user_001
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

## POST /:accountId/kv/:nsId/bulk-delete — 批量删除键

### 请求

```
POST /api/storage/1/kv/kv-namespace-uuid/bulk-delete
```

```json
{
  "keys": ["user_001", "user_002", "user_003"]
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

## GET /:accountId/d1 — 列出 D1 数据库

### 请求

```
GET /api/storage/1/d1
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
      "created_at": "2024-01-01T00:00:00Z",
      "file_size": 1048576
    }
  ]
}
```

---

## POST /:accountId/d1 — 创建 D1 数据库

### 请求

```
POST /api/storage/1/d1
```

```json
{
  "name": "new-database"
}
```

### 响应

**201 Created**

```json
{
  "success": true,
  "data": {
    "uuid": "new-d1-uuid",
    "name": "new-database",
    "created_at": "2024-01-01T00:00:00Z"
  }
}
```

---

## DELETE /:accountId/d1/:dbId — 删除 D1 数据库

### 请求

```
DELETE /api/storage/1/d1/d1-db-uuid
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

## GET /:accountId/d1/:dbId/tables — 列出表

### 请求

```
GET /api/storage/1/d1/d1-db-uuid/tables
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    { "name": "users", "type": "table" },
    { "name": "orders", "type": "table" }
  ]
}
```

---

## GET /:accountId/d1/:dbId/tables/:tableName/schema — 获取表结构

### 请求

```
GET /api/storage/1/d1/d1-db-uuid/tables/users/schema
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    { "cid": 0, "name": "id", "type": "INTEGER", "notnull": 1, "dflt_value": null, "pk": 1 },
    { "cid": 1, "name": "email", "type": "TEXT", "notnull": 1, "dflt_value": null, "pk": 0 },
    { "cid": 2, "name": "created_at", "type": "TEXT", "notnull": 0, "dflt_value": null, "pk": 0 }
  ]
}
```

---

## POST /:accountId/d1/:dbId/query — 执行 SQL 查询

### 请求

```
POST /api/storage/1/d1/d1-db-uuid/query
```

```json
{
  "sql": "SELECT id, email FROM users LIMIT 10",
  "allowWrite": false
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `sql` | string | 是 | SQL 语句 |
| `allowWrite` | boolean | 否 | 写操作（INSERT/UPDATE/DELETE/DROP/ALTER/CREATE）需设为 `true` |

### 响应 — 查询

**200 OK**

```json
{
  "success": true,
  "data": {
    "results": [
      { "id": 1, "email": "user1@example.com" },
      { "id": 2, "email": "user2@example.com" }
    ],
    "success": true,
    "meta": {
      "served_by": "d1",
      "duration": 0.5,
      "changes": 0,
      "last_row_id": 0,
      "changed_db": false
    }
  }
}
```

### 响应 — 写操作

```json
{
  "success": true,
  "data": {
    "results": [],
    "success": true,
    "meta": {
      "changes": 5,
      "last_row_id": 6,
      "changed_db": true,
      "duration": 1.2
    }
  }
}
```

**400 Bad Request** — 写操作未授权

```json
{
  "success": false,
  "error": {
    "code": "WRITE_NOT_ALLOWED",
    "message": "Write query requires allowWrite: true"
  }
}
```

---

## GET /:accountId/r2 — 列出 R2 存储桶

自动检测 R2 可用性，缓存显示 `-r2` 或 CF 返回错误码 10042 时认为未启用。

### 请求

```
GET /api/storage/1/r2
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

**403 Forbidden**

```json
{
  "success": false,
  "error": {
    "code": "R2_NOT_ENABLED",
    "message": "R2 is not enabled for this account"
  }
}
```

---

## POST /:accountId/r2 — 创建 R2 存储桶

### 请求

```
POST /api/storage/1/r2
```

```json
{
  "name": "new-bucket"
}
```

### 响应

**201 Created**

```json
{
  "success": true,
  "data": {
    "name": "new-bucket",
    "creation_date": "2024-01-01T00:00:00Z"
  }
}
```

---

## DELETE /:accountId/r2/:bucket — 删除 R2 存储桶

### 请求

```
DELETE /api/storage/1/r2/my-bucket
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

## GET /:accountId/r2/:bucket/objects — 列出对象

### 请求

```
GET /api/storage/1/r2/my-bucket/objects?prefix=images/&delimiter=/&limit=50&cursor=abc
```

| 参数 | 位置 | 类型 | 说明 |
|---|---|---|---|
| `prefix` | query | string | 对象名前缀 |
| `delimiter` | query | string | 分隔符（默认 `/`） |
| `cursor` | query | string | 分页游标 |
| `limit` | query | number | 每页条数 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "objects": [
      {
        "key": "images/photo1.jpg",
        "size": 102400,
        "last_modified": "2024-01-01T00:00:00Z",
        "etag": "abc123"
      }
    ],
    "prefixes": ["images/thumbnails/"],
    "cursor": "next-cursor"
  }
}
```

---

## GET /:accountId/r2/:bucket/download — 下载对象

### 请求

```
GET /api/storage/1/r2/my-bucket/download?key=images/photo1.jpg&inline=false
```

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `key` | query | 是 | 对象键名 |
| `inline` | query | 否 | `true` 时 `Content-Disposition: inline`（浏览器预览），默认 `attachment`（下载） |

### 响应

**200 OK** — 二进制文件流（非 JSON）

```
Content-Type: image/jpeg
Content-Length: 102400
Content-Disposition: attachment; filename="photo1.jpg"

<binary data>
```

---

## PUT /:accountId/r2/:bucket/upload — 上传对象

`multipart/form-data`

### 请求

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `key` | string | 是 | 对象键名 |
| `file` | File | 是 | 上传的文件（最大 50MB） |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": { "success": true }
}
```

---

## DELETE /:accountId/r2/:bucket/objects — 删除对象

### 请求

```
DELETE /api/storage/1/r2/my-bucket/objects?key=images/photo1.jpg
```

| 参数 | 位置 | 必填 | 说明 |
|---|---|---|---|
| `key` | query | 是 | 对象键名 |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": { "success": true }
}
```

---

## POST /:accountId/r2/:bucket/bulk-delete — 批量删除对象

### 请求

```
POST /api/storage/1/r2/my-bucket/bulk-delete
```

```json
{
  "keys": ["images/photo1.jpg", "images/photo2.jpg", "images/photo3.jpg"]
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
