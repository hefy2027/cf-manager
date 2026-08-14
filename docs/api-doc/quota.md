# 配额

> 挂载路径：`/api/quota`

---

## GET / — 获取配额摘要

同步从 Cloudflare 获取最新使用量数据，刷新 AI 缓存，返回配额摘要。

### 请求

```
GET /api/quota
```

无参数。

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "ai_neurons": {
      "today": 5234.56,
      "accounts": [
        {
          "accountId": 1,
          "accountName": "my-account-1",
          "count": 4000.0,
          "exhausted": false
        },
        {
          "accountId": 2,
          "accountName": "my-account-2",
          "count": 1234.56,
          "exhausted": true
        }
      ]
    },
    "workers_requests": {
      "today": 50000,
      "accounts": [
        { "accountId": 1, "accountName": "my-account-1", "count": 50000 }
      ]
    }
  }
}
```
