# 定时任务

> 挂载路径：`/api/tasks`
>
> 仅 Docker 版支持（Worker 版使用 `scheduled` handler）

---

## 目录

- [GET / — 获取所有任务](#get---获取所有任务)
- [POST / — 创建任务](#post---创建任务)
- [PUT /:id — 更新任务](#put-id-更新任务)
- [DELETE /:id — 删除任务](#delete-id-删除任务)
- [POST /:id/run — 立即执行](#post-idrun-立即执行)
- [GET /:id/history — 执行历史](#get-idhistory-执行历史)

---

## GET / — 获取所有任务

### 请求

```
GET /api/tasks/
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "name": "sync-usage",
      "type": "quota_sync",
      "cron": "0 */6 * * *",
      "config": { "syncTypes": ["ai_neurons"] },
      "enabled": 1,
      "created_at": "2024-01-01T00:00:00Z",
      "updated_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

---

## POST / — 创建任务

### 请求

```
POST /api/tasks/
```

```json
{
  "name": "sync-usage",
  "type": "quota_sync",
  "cron": "0 */6 * * *",
  "config": { "syncTypes": ["ai_neurons"] }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 任务名称 |
| `type` | string | 是 | 任务类型（如 `quota_sync`） |
| `cron` | string | 是 | Cron 表达式（如 `0 */6 * * *`） |
| `config` | object | 否 | 任务配置 |

### 响应

**201 Created**

```json
{
  "success": true,
  "data": { "id": 2 }
}
```

---

## PUT /:id — 更新任务

### 请求

```
PUT /api/tasks/2
```

```json
{
  "name": "updated-name",
  "cron": "0 0 * * *",
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

---

## DELETE /:id — 删除任务

### 请求

```
DELETE /api/tasks/2
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

## POST /:id/run — 立即执行

### 请求

```
POST /api/tasks/2/run
```

无请求体。

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "status": "success",
    "message": "Task executed successfully"
  }
}
```

---

## GET /:id/history — 执行历史

### 请求

```
GET /api/tasks/2/history?limit=20
```

| 参数 | 位置 | 类型 | 说明 |
|---|---|---|---|
| `limit` | query | number | 返回条数（默认 20） |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": 100,
      "task_id": 2,
      "status": "success",
      "started_at": "2024-01-01T12:00:00Z",
      "finished_at": "2024-01-01T12:00:05Z",
      "result": "Synced 5 accounts"
    },
    {
      "id": 99,
      "task_id": 2,
      "status": "error",
      "started_at": "2024-01-01T06:00:00Z",
      "finished_at": "2024-01-01T06:00:01Z",
      "error": "Network timeout"
    }
  ]
}
```
