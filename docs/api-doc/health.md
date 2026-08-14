# 健康检查

> 挂载路径：`/api/health`
>
> 无需认证，供 Docker healthcheck 使用。

---

## GET /api/health

服务健康探针。

### 请求

```
GET /api/health
```

无需任何参数或认证头。

### 响应

**200 OK**

```json
{
  "success": true,
  "data": {
    "status": "ok"
  }
}
```

> 注：此端点在认证中间件之前注册，是唯一不需要 `Authorization` 头的接口。
