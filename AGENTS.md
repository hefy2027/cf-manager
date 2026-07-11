# AGENTS.md

> 本文件为 AI 编程助手提供项目导航与开发约定，帮助 Agent 在本仓库中高效工作。

## 项目概述

CF Manager 是一个 Cloudflare 多账户管理平台，提供 Workers / Pages / DNS / KV / D1 / R2 / AI 推理 / 浏览器渲染的统一管理界面，同时暴露 OpenAI 兼容 API 供外部调用。

项目采用**双后端架构**——同一套业务逻辑分别用 Express（Docker 自建部署）和 Hono（Cloudflare Pages 部署）实现，共享同一套前端。

## 仓库结构

```
cf-manager/
├── backend/          # Express 后端（Docker 部署版）
│   └── src/
│       ├── index.ts        # Express 入口，路由挂载
│       ├── config.ts       # 环境变量配置
│       ├── db.ts           # SQLite 数据库初始化
│       ├── routes/         # API 路由（accounts, dns, workers, ai, openai, storage, ...）
│       ├── services/       # 业务逻辑层（Cloudflare SDK 封装、加密、配额追踪、代理等）
│       ├── models/         # 数据模型（account, auditLog, quotaUsage, catalogSource）
│       ├── middleware/     # 认证、响应包装、错误处理、日志、请求ID
│       └── data/           # 运行时数据（model-pricing.json 等自动同步文件）
├── frontend/         # Vue 3 前端
│   └── src/
│       ├── api/            # Axios 封装的 API 调用
│       ├── views/          # 页面组件（Dashboard, Accounts, DNS, Workers, AI, Storage, ...）
│       ├── components/     # 可复用组件
│       ├── stores/         # Pinia 状态管理
│       ├── router/         # Vue Router 路由配置
│       └── utils/          # 工具函数
├── worker/           # Hono 后端（Cloudflare Pages 部署版）
│   ├── src/
│   │   ├── index.ts        # Hono 入口 + Pages Functions handler
│   │   ├── types.ts        # Env 接口（D1, KV, ASSETS 等 binding）
│   │   ├── routes/         # API 路由（与 backend 对称）
│   │   ├── services/       # 业务逻辑（与 backend 对称，用 fetch 替代 SDK）
│   │   ├── db/             # D1 数据模型 + schema.sql
│   │   ├── middleware/     # 认证、响应包装、错误处理
│   │   └── pages/          # 伪装 nginx 页面
│   ├── build.js            # 一键构建脚本（前端 + worker + ZIP）
│   └── wrangler.toml       # Wrangler 配置
├── shared/           # 前后端共享源（唯一真实来源）
│   ├── model-pricing.json  # AI 模型定价
│   ├── catalog.schema.json # Catalog JSON Schema
│   └── catalogValidator.ts # Catalog 校验器源码
├── scripts/          # 构建辅助脚本
│   ├── sync-shared.js      # 将 shared/ 同步到 backend 和 worker
│   ├── gen-version.js      # 从 CHANGELOG.md 生成 version.ts
│   └── gen-catalog-validator.js  # 预编译 AJV 校验器（兼容 Workers）
├── docker/           # Docker 构建配置
├── docs/             # 文档
├── docker-compose.yml
├── deploy.sh         # Docker 一键部署脚本
└── CHANGELOG.md      # 更新日志（版本号来源）
```

## 技术栈

| 层级 | Docker 版 (backend/) | Worker 版 (worker/) |
|---|---|---|
| 框架 | Express 5 + TypeScript | Hono 4 + TypeScript |
| 数据库 | SQLite (better-sqlite3) | Cloudflare D1 |
| CF 交互 | `cloudflare` SDK (Node.js) | 原生 `fetch` 调用 CF REST API |
| 部署 | Docker Compose | Cloudflare Pages |
| 模块系统 | CommonJS | ESM (esbuild bundle) |
| TS target | ES2022 | ESNext |
| 前端 | Vue 3 + Naive UI + Pinia + Vite + TypeScript | 同左 |

## 关键架构约定

### 双后端对称性

`backend/src/` 和 `worker/src/` 的路由（routes/）、服务（services/）、中间件（middleware/）需要**保持功能对称**。新增功能时通常需要同时修改两端：

- `backend/src/routes/*.ts` ↔ `worker/src/routes/*.ts`
- `backend/src/services/*.ts` ↔ `worker/src/services/*.ts`（名称可能不同，如 `cfFactory.ts` ↔ `cfApi.ts`、`encryptionService.ts` ↔ `encryption.ts`）
- `backend/src/models/*.ts` ↔ `worker/src/db/models.ts`（worker 端集中在一个文件）

### 共享文件同步机制

`shared/` 是唯一真实来源。构建/开发前 `scripts/sync-shared.js` 会自动将其复制到 backend 和 worker。**不要直接编辑 `backend/src/data/model-pricing.json` 或 `worker/src/data/model-pricing.json`**，应编辑 `shared/model-pricing.json`。新增共享文件时在 `sync-shared.js` 的 `jobs` 数组中追加条目。

### 版本号管理

版本号从 `CHANGELOG.md` 的首个 `## [x.y.z]` 提取，由 `scripts/gen-version.js` 生成 `version.ts`。**不要手动编辑 `version.ts`**。发版时更新 `CHANGELOG.md`。

### API 响应格式

- **内部 API**（`/api/*`）：经过 `responseWrapper` 中间件，自动包装为 `{ success: true, data }` 或 `{ success: false, error }`
- **外部 API**（`/v1/*` 和 `/api/v1/*`）：OpenAI 兼容格式，**不经过** responseWrapper
- 前端 Axios 拦截器自动解包 `success`/`data`，错误时提取 `error.message`

### 认证

- 通过 `Authorization: Bearer <API_SECRET>` 头部认证
- API Token 加密存储（AES），密钥为 `ENCRYPTION_KEY` 环境变量
- Worker 端的 `Env` 接口定义在 `worker/src/types.ts`

### 安全特性

- 根路径伪装为 nginx 默认页，管理界面在 `/admin/`
- 演示账户受 `DEMO_ACCOUNT_IDS` 保护，不可删除/修改
- API Token 在返回时脱敏为 `***encrypted***`

## 开发命令

### 本地开发

```bash
# 后端（http://localhost:3001）
cd backend && npm install && ENCRYPTION_KEY="dev-key" npm run dev

# 前端（http://localhost:5173，自动代理 /api 到后端）
cd frontend && npm install && npm run dev

# Worker 本地（需先构建前端到 worker/public/）
cd worker && npm run dev
```

### 构建

```bash
# Worker 一键构建（前端 + worker + ZIP）
cd worker && npm run build

# 后端编译
cd backend && npm run build

# 前端构建
cd frontend && npm run build
```

### Docker 部署

```bash
cp .env.example .env  # 至少设置 ENCRYPTION_KEY
chmod +x deploy.sh && ./deploy.sh
```

## 代码风格约定

- **TypeScript strict 模式**：所有项目均启用 `strict: true`
- **命名**：文件使用 camelCase（如 `accountRouter.ts`），类型/接口使用 PascalCase（如 `AccountInput`），路由变量使用 camelCase
- **路由定义**：backend 使用 Express `Router`，worker 使用 `new Hono<{ Bindings: Env }>()`
- **错误处理**：路由中使用 `try/catch + next(err)`（backend）或直接 `return c.json({ error: { code, message } }, status)`（worker）
- **数据库查询**：backend 使用同步的 `better-sqlite3`，worker 使用异步的 `D1Database.prepare().all()`
- **注释**：代码中中文注释和英文注释混用，新增代码可使用中文注释
- **环境变量**：通过 `config.ts`（backend）或 `c.env`（worker）访问，不直接引用 `process.env`（backend 的 config.ts 除外）

## 反馈与交互约定

若环境中存在 MCP 反馈工具（如 `feedback-agent` 等），在以下场景中**优先使用 MCP 工具**向用户反馈或交互，而非直接结束对话：

- **任务完成时**：通过 MCP 工具通知用户任务已完成，等待确认
- **即将结束对话时**：通过 MCP 工具确认用户是否还有后续需求
- **需要提问时**：通过 MCP 工具向用户提问以澄清需求
- **需要决策时**：遇到多条可行路径或设计选择时，通过 MCP 工具让用户决策

## 重要注意事项

1. **不要手动编辑自动生成的文件**：`version.ts`、`backend/src/data/*`、`worker/src/data/*`、`catalogValidate.generated.ts`
2. **修改 shared/ 后需要重新同步**：`node scripts/sync-shared.js`（dev/build 前自动执行）
3. **Worker 运行时限制**：不能用 `eval`、`new Function`、Node.js 原生模块。AJV 校验器需通过 `gen-catalog-validator.js` 预编译为 standalone 代码
4. **Cloudflare API 调用**：backend 通过 `cloudflare` SDK（`getCfClient()`），worker 通过 `fetch` 封装（`cfFetch()`）
5. **前端 base 路径**：Worker 版固定为 `/admin/`，Docker 版通过 `BASE_URL` 环境变量配置
6. **提交前检查**：确保两端（backend + worker）功能同步，`CHANGELOG.md` 已更新版本号

## 功能场景索引

按常见开发任务快速定位文件。**双后端项目，大多数后端改动需同步修改两端。**

### 后端 API 路由

| 任务 | Docker 版 (backend/) | Worker 版 (worker/) |
|---|---|---|
| 账户管理 CRUD | `src/routes/accounts.ts` | `src/routes/accounts.ts` |
| DNS 记录管理 | `src/routes/dns.ts` | `src/routes/dns.ts` |
| Workers/Pages 部署 | `src/routes/workers.ts` | `src/routes/workers.ts` |
| KV/D1/R2 存储 | `src/routes/storage.ts` | `src/routes/storage.ts` |
| AI 推理（内部） | `src/routes/ai.ts` | —（Worker 版无独立路由，复用 openai） |
| OpenAI 兼容 API | `src/routes/openai.ts` | `src/routes/openai.ts` |
| 浏览器渲染（内部） | `src/routes/browserRender.ts` | `src/routes/browserRender.ts` |
| 浏览器渲染（外部） | `src/routes/externalBrowserRender.ts` | —（Worker 版在 browserRender 内） |
| 系统设置 | `src/routes/settings.ts` | `src/routes/settings.ts` |
| 应用商店/Catalog | `src/routes/store.ts` | `src/routes/store.ts` |
| 定时任务 | `src/routes/tasks.ts` | —（Worker 用 scheduled handler） |
| 路由工具函数 | `src/routes/routeUtils.ts` | — |

### 后端业务逻辑（services/）

| 任务 | Docker 版 (backend/) | Worker 版 (worker/) |
|---|---|---|
| Cloudflare API 客户端 | `src/services/cfFactory.ts` | `src/services/cfApi.ts` |
| 账户轮换/AI 路由 | `src/services/accountRouter.ts` | —（内联在 quotaTracker/ai 逻辑中） |
| AI 推理核心 | `src/services/aiService.ts` | `src/routes/openai.ts`（内联） |
| 模型定价计算 | `src/services/pricing.ts` | `src/services/pricing.ts` |
| 配额追踪 | `src/services/quotaTracker.ts` | `src/services/quotaTracker.ts` |
| 浏览器渲染处理 | `src/services/browserRenderHandler.ts` | `src/routes/browserRender.ts`（内联） |
| 浏览器渲染服务 | `src/services/browserRenderService.ts` | `src/routes/browserRender.ts`（内联） |
| 浏览器限速 | `src/services/browserRateLimiter.ts` | `src/services/browserRateLimiter.ts` |
| 加密/解密 | `src/services/encryptionService.ts` | `src/services/encryption.ts` |
| 代理服务 | `src/services/proxyService.ts` | —（Worker 用 fetch 直连） |
| DNS 服务 | `src/services/dnsService.ts` | `src/routes/dns.ts`（内联） |
| 存储服务 | `src/services/storageService.ts` | `src/routes/storage.ts`（内联） |
| Worker 部署服务 | `src/services/workerService.ts` | `src/routes/workers.ts`（内联） |
| Zone 服务 | `src/services/zoneService.ts` | `src/routes/dns.ts`（内联） |
| Catalog 部署 | `src/services/catalogDeploy.ts` | `src/services/catalogDeploy.ts` |
| Catalog 校验 | `src/services/catalogValidator.ts`（自动生成） | `src/services/catalogValidator.ts`（自动生成） |
| 日志系统 | `src/services/logger.ts`（winston） | `src/services/logger.ts`（console） |
| 定时任务调度 | `src/services/taskScheduler.ts` | —（用 `scheduled` handler） |
| Pages 部署 | — | `src/services/pagesDeploy.ts` |
| 演示模式 | — | `src/services/demo.ts` |

### 数据库

| 任务 | Docker 版 (backend/) | Worker 版 (worker/) |
|---|---|---|
| 建表/初始化 | `src/db.ts` | `src/db/schema.sql` |
| 数据模型/查询 | `src/models/account.ts` | `src/db/models.ts`（集中） |
| 审计日志 | `src/models/auditLog.ts` | `src/db/models.ts` |
| 配额使用 | `src/models/quotaUsage.ts` | `src/db/models.ts` |
| Catalog 源 | `src/models/catalogSource.ts` | `src/db/models.ts` |

### 中间件

| 任务 | Docker 版 (backend/) | Worker 版 (worker/) |
|---|---|---|
| 认证 | `src/middleware/auth.ts` | `src/middleware/auth.ts` |
| 响应包装 | `src/middleware/responseWrapper.ts` | `src/middleware/responseWrapper.ts` |
| 全局错误处理 | `src/middleware/errorHandler.ts` | `src/middleware/errorHandler.ts` |
| OpenAI 格式错误 | `src/middleware/v1ErrorHandler.ts` | `src/middleware/v1ErrorHandler.ts` |
| 请求 ID | `src/middleware/requestId.ts` | `src/middleware/requestId.ts` |
| API 请求日志 | `src/middleware/apiLogger.ts` | — |
| V1 请求日志 | `src/middleware/v1Logger.ts` | — |

### 前端

| 任务 | 文件 |
|---|---|
| 全局布局/导航/登录 | `src/App.vue` |
| 路由配置 | `src/router/index.ts` |
| Axios 客户端/拦截器 | `src/api/client.ts` |
| 账户 API 封装 | `src/api/accounts.ts` |
| DNS API 封装 | `src/api/dns.ts` |
| Workers API 封装 | `src/api/workers.ts` |
| 存储 API 封装 | `src/api/storage.ts` |
| 设置 API 封装 | `src/api/settings.ts` |
| 商店 API 封装 | `src/api/store.ts` |
| 浏览器渲染 API 封装 | `src/api/browserRender.ts` |
| 账户状态管理 | `src/stores/accountStore.ts` |
| 配额状态管理 | `src/stores/quotaStore.ts` |
| Worker 状态管理 | `src/stores/workerStore.ts` |
| DNS 状态管理 | `src/stores/dnsStore.ts` |
| 仪表盘页 | `src/views/DashboardView.vue` |
| 账户管理页 | `src/views/AccountsView.vue` |
| DNS 管理页 | `src/views/DnsView.vue` |
| Workers/Pages 页 | `src/views/WorkersView.vue` |
| 存储管理页 | `src/views/StorageView.vue` |
| AI 推理页 | `src/views/AiView.vue` |
| 浏览器渲染页 | `src/views/BrowserRenderView.vue` |
| 应用商店页 | `src/views/StoreView.vue` |
| 系统设置页 | `src/views/SettingsView.vue` |
| 商店部署对话框 | `src/components/StoreDeployDialog.vue` |
| 紧凑账户卡片 | `src/components/CompactAccountCard.vue` |
| Naive UI discrete API | `src/utils/discreteApi.ts` |
| 日期格式化 | `src/utils/dateFormat.ts` |
| 配额工具 | `src/utils/quota.ts` |
| 演示账户 | `src/utils/demoAccounts.ts` |

### 构建/部署/配置

| 任务 | 文件 |
|---|---|
| Worker 一键构建 | `worker/build.js` |
| Wrangler 配置 | `worker/wrangler.toml` |
| 共享文件同步 | `scripts/sync-shared.js` |
| 版本号生成 | `scripts/gen-version.js` |
| Catalog 校验器预编译 | `scripts/gen-catalog-validator.js` |
| Docker Compose | `docker-compose.yml` |
| Docker 部署脚本 | `deploy.sh` |
| 后端 Dockerfile | `docker/backend/Dockerfile` |
| 前端 Dockerfile | `docker/frontend/Dockerfile` |
| Nginx 配置模板 | `docker/frontend/nginx.conf.template` |
| 后端环境变量 | `backend/src/config.ts` |
| Worker 环境变量/Binding | `worker/src/types.ts` + `worker/wrangler.toml` |
| Vite 配置 | `frontend/vite.config.ts` |

### 共享资源

| 任务 | 文件 |
|---|---|
| AI 模型定价 | `shared/model-pricing.json` |
| Catalog JSON Schema | `shared/catalog.schema.json` |
| Catalog 校验器源码 | `shared/catalogValidator.ts` |

## 文档索引

- [部署文档](docs/deploy.md)
- [API 接口文档](docs/api-v1.md)
- [账户认证说明](docs/account-auth.md)
