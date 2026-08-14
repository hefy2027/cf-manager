# CF Manager 后端 API 接口文档

> 本文档集涵盖 CF Manager 后端所有 API 端点，按模块分文件整理，每个端点包含完整的请求参数和返回示例。

## 通用说明

- **内部 API**（`/api/*`）：经过 `responseWrapper` 中间件，响应自动包装为 `{ success: true, data }` 或 `{ success: false, error }`
- **外部 API**（`/v1/*` 和 `/api/v1/*`）：OpenAI 兼容格式，不经过 `responseWrapper`
- **认证**：除 `/api/health` 外，所有请求需在 Header 中携带 `Authorization: Bearer <API_SECRET>`
- **Docker 版 Base URL**：`http://<host>:3000`
- **本地开发 Base URL**：`http://localhost:3001`
- **前端 Axios 拦截器**自动解包 `success`/`data`，错误时提取 `error.message`

## 文档索引

| # | 模块 | 文件 | 挂载路径 | 端点数 |
|---|---|---|---|---|
| 1 | 健康检查 | [health.md](./health.md) | `/api/health` | 1 |
| 2 | 账户管理 | [accounts.md](./accounts.md) | `/api/accounts` | 13 |
| 3 | DNS 管理 | [dns.md](./dns.md) | `/api/dns` | 16 |
| 4 | Workers / Pages | [workers-pages.md](./workers-pages.md) | `/api/workers` | 43 |
| 5 | 存储管理 (KV/D1/R2) | [storage.md](./storage.md) | `/api/storage` | 22 |
| 6 | AI 推理（内部） | [ai.md](./ai.md) | `/api/ai` | 1 |
| 7 | OpenAI 兼容 API | [openai.md](./openai.md) | `/v1`、`/api/v1` | 5 |
| 8 | 浏览器渲染 | [browser-render.md](./browser-render.md) | `/api/browser-render`、`/v1/browser` | 3 |
| 9 | 系统设置 | [settings.md](./settings.md) | `/api/settings` | 6 |
| 10 | 应用商店 / Catalog | [store.md](./store.md) | `/api/store` | 11 |
| 11 | 定时任务 | [tasks.md](./tasks.md) | `/api/tasks` | 6 |
| 12 | Tunnel 隧道 | [tunnels.md](./tunnels.md) | `/api/tunnels` | 11 |
| 13 | 配额 | [quota.md](./quota.md) | `/api/quota` | 1 |
| 14 | 审计日志 | [audit-log.md](./audit-log.md) | `/api/audit-log` | 2 |
| — | 附录（响应格式/错误码/认证/对称性） | [appendix.md](./appendix.md) | — | — |

## 快速查找

- **我要管理 Cloudflare 账户** → [accounts.md](./accounts.md)
- **我要管理 DNS 记录** → [dns.md](./dns.md)
- **我要部署 Worker / Pages** → [workers-pages.md](./workers-pages.md)
- **我要操作 KV / D1 / R2** → [storage.md](./storage.md)
- **我要调用 AI 推理** → [openai.md](./openai.md)
- **我要查看用量和配额** → [quota.md](./quota.md)
- **我要从应用商店部署模板** → [store.md](./store.md)
- **我要配置代理** → [settings.md](./settings.md)
