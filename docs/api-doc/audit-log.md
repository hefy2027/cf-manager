# 审计日志

> 挂载路径：`/api/audit-log`

---

## 目录

- [GET / — 获取审计日志](#get---获取审计日志)
- [GET /actions — 获取操作类型列表](#get-actions-获取操作类型列表)

---

## GET / — 获取审计日志

默认返回最近 100 条日志。传入筛选参数时返回最多 500 条匹配记录。

### 请求

```
GET /api/audit-log
GET /api/audit-log?action=create_account&startDate=2024-01-01&endDate=2024-01-31
```

| 参数 | 位置 | 类型 | 说明 |
|---|---|---|---|
| `action` | query | string | 按操作类型筛选 |
| `startDate` | query | string | 开始日期（如 `2024-01-01`） |
| `endDate` | query | string | 结束日期（如 `2024-01-31`） |

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "account_id": 2,
      "action": "create_account",
      "target": "my-account",
      "detail": "auth_type=token",
      "status": "success",
      "created_at": "2024-01-01T12:00:00Z"
    },
    {
      "id": 2,
      "account_id": 2,
      "action": "test_account",
      "target": "my-account",
      "detail": "batch",
      "status": "success",
      "created_at": "2024-01-01T12:01:00Z"
    },
    {
      "id": 3,
      "account_id": 1,
      "action": "ai_chat_completion",
      "target": "@cf/meta/llama-3.1-8b-instruct",
      "detail": "[req-abc] non-stream tokens: in=25 out=15 total=40 neurons=12.5",
      "status": "success",
      "created_at": "2024-01-01T12:05:00Z"
    }
  ]
}
```

---

## GET /actions — 获取操作类型列表

返回所有审计日志中出现的操作类型，用于前端筛选下拉框。

### 请求

```
GET /api/audit-log/actions
```

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    "create_account",
    "update_account",
    "delete_account",
    "test_account",
    "batch_delete_account",
    "view_credentials",
    "create_dns",
    "update_dns",
    "delete_dns",
    "batch_create_zone",
    "batch_delete_zone",
    "purge_cache",
    "create_rule",
    "update_rule",
    "delete_rule",
    "delete_worker",
    "delete_pages",
    "batch_deploy",
    "batch_deploy_pages",
    "kv_create_ns",
    "kv_delete_ns",
    "kv_write",
    "kv_delete",
    "d1_create_db",
    "d1_delete_db",
    "d1_query",
    "r2_create_bucket",
    "r2_delete_bucket",
    "r2_upload",
    "r2_delete",
    "ai_chat_completion",
    "ai_image_generation",
    "ai_tts_generation",
    "ai_translation",
    "create_tunnel",
    "delete_tunnel",
    "update_tunnel_config",
    "wizard_origin",
    "env_sync",
    "task_create",
    "task_delete",
    "task_run"
  ]
}
```
