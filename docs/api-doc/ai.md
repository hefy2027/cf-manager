# AI 推理（内部）

> 挂载路径：`/api/ai`

---

## GET /usage — 获取 AI 使用量统计

获取所有活跃账户的 AI 使用量统计。同步从 Cloudflare 获取权威数据，失败时回退到本地估算值。

### 请求

```
GET /api/ai/usage
```

无参数。

### 响应

**200 OK**

```json
{
  "success": true,
  "data": [
    {
      "accountId": "cf-account-uuid-1",
      "accountName": "my-account-1",
      "totalNeurons": 5234.56,
      "models": [
        {
          "model": "@cf/meta/llama-3.1-8b-instruct",
          "neurons": 4000.0
        },
        {
          "model": "@cf/qwen/qwen2.5-coder-32b-instruct",
          "neurons": 1234.56
        }
      ]
    },
    {
      "accountId": "cf-account-uuid-2",
      "accountName": "my-account-2",
      "totalNeurons": 500.0,
      "models": [],
      "warning": "CF returned 0, using local estimate"
    }
  ]
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `totalNeurons` | 今日总神经元消耗量 |
| `models` | 按模型分类的消耗明细 |
| `warning` | CF 调用失败或返回 0 时的警告信息 |
