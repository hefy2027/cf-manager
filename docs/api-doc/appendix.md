# 附录

---

## A. 响应格式

### 内部 API（`/api/*`）

经过 `responseWrapper` 中间件自动包装：

**成功响应：**

```json
{
  "success": true,
  "data": { /* 实际数据 */ }
}
```

**失败响应：**

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "错误描述"
  }
}
```

> 前端 Axios 拦截器自动解包 `success`/`data`，错误时提取 `error.message`。

### 外部 API（`/v1/*`、`/api/v1/*`）

保持 OpenAI 原始格式，不经过 `responseWrapper`：

**成功响应：** 直接返回数据

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "choices": [...]
}
```

**失败响应：** OpenAI 错误格式

```json
{
  "error": {
    "message": "错误描述",
    "type": "error_type",
    "code": "error_code"
  }
}
```

---

## B. 错误码

| 错误码 | HTTP 状态 | 说明 |
|---|---|---|
| `VALIDATION_ERROR` | 400 | 请求参数校验失败 |
| `CREDENTIAL_INVALID` | 400 | Cloudflare API 凭证验证失败 |
| `WRITE_NOT_ALLOWED` | 400 | D1 写操作未授权（需 `allowWrite: true`） |
| `NO_FILE` | 400 | 文件上传缺失 |
| `EMPTY_ZIP` | 400 | ZIP 文件为空 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `ACCOUNT_NOT_FOUND` | 404 | 指定账户不存在或未激活 |
| `TUNNEL_NOT_FOUND` | 400 | 隧道不存在 |
| `ZONE_NOT_FOUND` | 400 | 域名（Zone）不存在 |
| `CNAME_CONFLICT` | 400 | CNAME 记录已存在 |
| `DEMO_PROTECTED` | 403 | 演示账户受保护，不可操作 |
| `FORBIDDEN` | 403 | 禁止操作（如修改默认源 URL） |
| `R2_NOT_ENABLED` | 403 | R2 存储未启用 |
| `SSRF_BLOCKED` | 403 | URL 安全校验拦截（SSRF 防护） |
| `DECRYPT_ERROR` | 500 | 凭证解密失败 |
| `WIZARD_PARTIAL_FAIL` | 500 | 回源向导部分失败 |
| `DEPLOY_FAILED` | 500 | 模板部署失败 |
| `PROXY_TEST_FAILED` | 502 | 代理测试失败 |
| `RESIN_TEST_FAILED` | 502 | Resin 代理池测试失败 |
| `ALL_ACCOUNTS_EXHAUSTED` | 429 | 所有账户 AI 配额已耗尽 |
| `EMPTY_AUDIO` | 502 | TTS 模型未返回音频数据 |

---

## C. 认证

### 请求头

```
Authorization: Bearer <API_SECRET>
```

- `API_SECRET` 通过环境变量配置
- `/api/health` 不需要认证
- 静态前端资源在认证中间件之前提供（确保登录页可访问）

### OpenAI 兼容 API 专用头

| Header | 说明 |
|---|---|
| `X-Account-ID` | 可选，指定使用的 CF 账户 ID。设为 `auto` 或不传则自动轮换 |

### API Token 加密存储

- 账户的 Cloudflare API Token / API Key 使用 AES 加密存储
- 加密密钥为 `ENCRYPTION_KEY` 环境变量
- API 返回时自动脱敏为 `***encrypted***`
- 通过 `GET /api/accounts/:id/credentials` 可查看解密后的凭证（写入审计日志）

### 演示账户保护

- 演示账户 ID 由 `DEMO_ACCOUNT_IDS` 环境变量配置
- 演示账户不可：删除、编辑、查看凭证、执行销毁性操作（删 DNS、删 Worker、删 KV 等）
- 批量操作会自动跳过演示账户并返回 `status: "skipped"`

---

## D. 双后端对称性说明

本项目采用双后端架构，以下端点在 **Docker 版 (backend/)** 和 **Worker 版 (worker/)** 之间保持功能对称：

| 模块 | Docker 版路由 | Worker 版路由 | 差异 |
|---|---|---|---|
| 账户管理 | ✅ | ✅ | — |
| DNS 管理 | ✅ | ✅ | — |
| Workers/Pages | ✅ | ✅ | — |
| 存储 (KV/D1/R2) | ✅ | ✅ | — |
| AI 推理 | ✅ | ✅ | — |
| OpenAI 兼容 | ✅ | ✅ | — |
| 浏览器渲染 | ✅ | ✅ | Worker 版外部渲染内联在 browserRender |
| 系统设置 | ✅ | ✅ | Worker 版无代理/Resin 配置 |
| 应用商店 | ✅ | ✅ | — |
| 定时任务 | ✅ | ❌ | Worker 版使用 `scheduled` handler |
| Tunnel 隧道 | ✅ | ✅ | — |
| 配额 | ✅ | ✅ | — |
| 审计日志 | ✅ | ✅ | — |

> 注：Worker 版缺少 `externalBrowserRender.ts`（外部浏览器渲染内联在 `browserRender.ts` 中）和 `tasks.ts`（使用 Cloudflare `scheduled` handler 替代）。

---

## E. 路由挂载总览

```
# 无认证
GET  /api/health

# 外部 API（无 responseWrapper）
/v1/*          → OpenAI 兼容 API
/api/v1/*      → OpenAI 兼容 API（内部别名）
/v1/browser/*  → 外部浏览器渲染

# 内部 API（有 responseWrapper）
/api/accounts/*     → 账户管理
/api/dns/*          → DNS 管理
/api/workers/*      → Workers/Pages
/api/storage/*      → 存储管理
/api/ai/*           → AI 推理（内部）
/api/browser-render/*  → 浏览器渲染（内部）
/api/settings/*     → 系统设置
/api/store/*        → 应用商店
/api/tasks/*        → 定时任务
/api/tunnels/*      → Tunnel 隧道
/api/quota          → 配额
/api/audit-log/*    → 审计日志
```
