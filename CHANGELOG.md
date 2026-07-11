# Changelog

## [1.3.5] - 2026-07-11

### 🚀 新特性

- **版本号标识**：部署时自动从 `CHANGELOG.md` 提取版本号和 git commit SHA，`/api/settings` 接口返回 `version` 和 `git_commit` 字段，管理面板设置页面同步展示版本号，解决线上版本识别问题。
- **应用商店（Catalog Store）**：新增完整的应用商店能力，用户可从 catalog 源浏览、部署 Cloudflare Worker / Pages 模板。
  - **后端**：新增 `store` 路由（catalog 源 CRUD、模板列表、部署、刷新）、`catalogSource` 数据模型、`catalogDeploy` 部署服务；`db.ts` 增加 catalog 源相关表与初始化。
  - **Worker**：对称实现 `store` 路由、D1 `catalogSource` 模型与 `schema.sql`、KV 缓存（`catalog:${id}`）、`catalogDeploy` 服务；`index.ts` / `wrangler.toml` 接入新路由与绑定。
  - **前端**：新增「商店」视图 `StoreView.vue` 与 `StoreDeployDialog.vue` 部署对话框，路由与侧边栏接入；`api/store.ts` 封装全部 store 接口。
- **Catalog 源可用性测试**：新增 `POST /store/sources/test` 接口（backend 与 worker 对称实现），在添加/编辑自定义源前测试 URL 是否可拉取且符合 catalog 格式，前端设置页对接实时反馈（`✓ 可用，包含 N 个模板` / `✗ 错误原因`），测试通过前禁用「添加/保存」按钮。
- **官方源多地址 fallback**：官方默认源支持多个备用地址，主地址不可达（如 GitHub raw 被限流）时按顺序自动切换镜像，当前 fallback 链为 `surge.sh → jsDelivr → GitHub raw`；自定义源仅使用自身 URL，不触发 fallback。
- **Pages 部署能力**：新增 Cloudflare Pages 项目部署能力——worker 端 `pagesDeploy.ts` 与后端 `workerService` 的 `deployPages()`，支持创建/确保 Project 并上传构建产物发布部署；补充 `docs/pages-upload.md` 调研与实现指南（文档化 multipart 直传契约）。
- **设置页 Catalog 源管理**：`SettingsView.vue` 支持添加 / 编辑 / 删除自定义 catalog 源，编辑默认源 URL 受保护（禁止修改官方源地址）。

### ♻️ 重构

- **catalog 校验逻辑共享化**：将 catalog 校验逻辑抽离到 `shared/catalogValidator.ts` 与 `shared/catalog.schema.json`，backend 与 worker 共用，删除各自旧有的 `catalogValidator.ts`；新增 `scripts/sync-shared.js` 同步脚本替换旧的 `scripts/sync-pricing.js`。
- **部署服务整合**：`workerService.ts` 与 worker `workers.ts` 重构，承接 store / Pages 部署逻辑，统一 catalog 拉取与 etag 缓存策略。

### 🐛 修复

- **Catalog 校验器运行时报错**：`catalogValidator` 改为 ajv **standalone 预编译**，消除 Workers/Pages 运行时调用 `new Function`（被 CF Workers 运行时禁止）导致的校验失败。
- **默认 catalog 主源切换**：官方默认源主地址改为 `surge.sh`（更新即时生效），fallback 链调整为 `surge.sh → jsDelivr → GitHub raw`；worker 端同步主源配置。
- **Catalog schema 扩展**：schema 顶层允许 `mirrorOf` / `description` 等镜像元数据字段；binding 新增 `secret` 布尔字段（`true`/缺省按加密写入，前端密码框；`false` 按明文写入，前端普通文本框）。
- **Pages 端变量类型丢失**：Worker 与 backend 在写入 Pages `deployment_configs.env_vars` 时保留 `cfBinding.type`，修复变量被强制退化为明文的问题。
- **Hybrid 部署误删 Worker**：修复 hybrid 模板在 Pages 环节失败时 `rollback` 会无条件删除已部署成功 Worker 的连坐 bug；现仅回滚本轮未成功部署的部分，并在失败时输出真实报错。
- **Worker 端 hybrid 部署崩溃**：worker 端 `catalogDeploy` 重构支持 hybrid（按 `template.type` 分别下载 `sources.worker` / `sources.pages` 并部署），补全部署后 URL 返回，并为 `rollback` 增加 `deleteWorker` 保护。

### 🎨 前端

- **部署对话框区分密钥与配置项**：`StoreDeployDialog` 将 `secret !== false` 的 var 归为「需要填写的密钥」（密码框），`secret === false` 的 var 归为「需要填写的配置项」（普通文本框），并纳入部署校验。
- **R2 预拉取误报**：`StoreDeployDialog` 改为只拉取当前模板实际用到的资源类型（按 `template.bindings` 过滤 kv/d1/r2），避免对未开通 R2 的账号无谓调用 R2 API 而误报 “R2 is not enabled”。

### 🔒 安全修复

- **SSRF / 任意远程 Worker 部署漏洞修复**：修复 Worker 部署（单部署 + 批量部署）与 Catalog 源拉取中全部裸 `fetch(url)` 调用。新增 `worker/src/services/ssrfGuard.ts` 与 `backend/src/services/ssrfGuard.ts`（双后端对称），提供 `fetchScriptSafely()` / `assertUrlSafe()`，强制校验：
  - 协议白名单（仅允许 `https:`，后端 Docker 版额外放行 `http://localhost` 用于本地 catalog 调试）
  - 主机/IP 校验：Worker 端拒绝环回/私网/链路本地/唯一本地 IP 字面量；后端通过 `dns.lookup` 解析域名后逐地址拒绝私网（真正阻断 DNS 重绑定类 SSRF）
  - 可选来源白名单（环境变量 `WORKER_DEPLOY_URL_ALLOWLIST`，逗号分隔主机名）
  - 重定向防护（`redirect: manual`，逐跳重新校验 Location）
  - Content-Type 校验（仅接受 JavaScript / 文本类型）
  - 响应大小限制（最大 5 MiB）
  - 恢复部署审计日志 `detail` 字段的来源 URL 记录（`url=...` / `source=upload`）
  - **部署建议**：生产环境强烈建议配置 `WORKER_DEPLOY_URL_ALLOWLIST` 仅允许可信脚本源；若无需 URL 部署，应直接在前端/接口层面禁用该能力。

### 🙏 致谢

感谢北京邮电大学网络空间安全学院 Liu Huan 和 Zifeng Kang 的负责任漏洞披露与版本复核。

---

## [1.1.2] - 2026-07-07

### 🔒 安全修复

- **SSRF 漏洞修复**：新增 `fetchScriptSafely()` 安全抓取函数，替换 Worker 部署和批量部署中三处裸 `fetch(url)` 调用，修复北邮网安学院报告的服务端请求伪造漏洞。安全函数强制校验：
  - 协议白名单（仅允许 `https:`）
  - 主机/IP 校验（拒绝环回、私网、链路本地及唯一本地地址段）
  - 重定向防护（`redirect: manual`，逐跳校验 Location）
  - Content-Type 校验（仅接受 JavaScript/文本类型）
  - 响应大小限制（最大 5 MiB）
  - 可选 URL 来源白名单（环境变量 `WORKER_DEPLOY_URL_ALLOWLIST`）
- **认证中间件加固**：当 `API_SECRET` 环境变量未配置时，不再静默跳过认证，而是自动生成密码学随机临时 secret 并在控制台输出明确的安全告警
- **审计日志增强**：Worker 部署审计日志 `detail` 字段新增来源 URL 记录（`url=...` / `source=upload`），便于事后安全追溯

### 🙏 致谢

感谢北京邮电大学网络空间安全学院 Liu Huan 和 Zifeng Kang 的负责任漏洞披露。

---

## [1.1.1] - 2026-07-05

### 🚀 新特性

- **账户密码字段支持**：数据库 `accounts` 表新增 `password` 字段，支持在创建/导入账户时存储密码，前端账户列表页和凭据接口均可解密展示密码信息，CSV 导入也支持密码字段。
- **审计日志筛选**：后端审计日志新增按操作类型和日期范围筛选查询，提供去重操作类型列表接口；前端账户列表页对接筛选与状态管理。
- **浏览器渲染限流器**：Worker 端新增令牌桶限流器（`browserRateLimiter.ts`），对 CF Browser Rendering 请求进行并发控制；后端同步接入限流逻辑。
- **流式响应 SSE 心跳机制**：后端和 Worker 端均为流式响应添加 SSE 心跳，防止客户端等待 TTFB 超时断开连接。
- **演示模式自动检测**：`deploy-cf.yml` 中演示模式账户保护自动从 D1 查询 `demo_account_ids`，不再需要手动输入。
- **完全覆盖模式自动部署账户**：`full_wipe` 模式下自动插入部署账户并使用 AES-GCM 加密 API Key。
- **cf-reg 批量注册工具**（已下线）：新增 `reg/` 目录，提供跨平台安装脚本（`install.sh` / `install.bat`）和注册脚本 `cf-reg.mjs`，支持批量注册 Cloudflare 账户、验证邮箱、提取 API Key；出于安全原因，该功能后续已移除。

### 🐛 修复

- **AI 缓存精准移除**：`removeAccountFromAiCache` 精确移除指定账户而非清空整个缓存，避免误伤其他正常账户。
- **4006 错误检测优化**：优先解析 JSON 格式错误码，避免纯文本中数字误匹配导致错误判断。
- **Worker 跳过已耗尽账户**：Worker 端记录 `skipped` 账户，防止对已耗尽（4006）账户重复发起请求。
- **AI 配额同步修复**：后端配额同步不再清除 `exhausted` 标记，正确保留 4006 错误状态。
- **Wrangler v4 部署兼容性修复**（多项）：
  - KV namespace 命令语法从冒号改为空格（`kv namespace`）
  - D1 delete 使用 `-y` 替代 `--yes`
  - KV namespace 解析处理 `already exists` 不视为错误
  - D1 完全覆盖改用 `DROP TABLE` 替代仅重新执行 schema.sql
  - KV 绑定通过 Cloudflare REST API PATCH 实现
- **Docker 构建修复**：Backend Dockerfile 将 build context 改为项目根目录，`COPY shared/` 确保 `model-pricing.json` 包含在镜像中。
- **中间件类型安全**：`responseWrapper.ts` 对 `body.id` 添加字符串类型检查，防止运行时 `startsWith` 调用报错。
- **表格列宽与重试逻辑**：多个视图中的表格列添加固定宽度/最小宽度，省略号和 tooltip；`MAX_RETRY_PER_ACCOUNT` 从 3 降为 1，重试间增加 1 秒延迟。
- **Windows 安装脚本兼容性**：移除 `chcp 65001`，使用标准 ASCII 符号替换 Unicode 字符，PowerShell 下载改用 `WebClient` 方式。

### 🔧 优化

- **前端响应式布局**：统一页面布局（`page-view` 类名），卡片网格列数响应式适配（`cols="1 s:2 m:4 l:6 xl:8"`），滚动容器添加 `scrollbar-gutter: stable` 防止抖动。
- **仪表盘增强**：DashboardView 统计数据支持 K/M 紧凑格式，新增 Workers 和浏览器渲染总量统计，移动端自适应表格列宽。
- **账户卡片优化**：移除名称截断逻辑，完整展示账户名；调整进度条 flex 布局，优化紧凑卡片样式和内边距。
- **安装脚本标准化**：输出格式改为 `[OK]` / `[ERR]` / `[WARN]` 标记，移除 emoji 图标；安装目录改为当前目录，跳过已存在文件避免重复下载。
- **Chromium 预下载**：安装脚本中预下载 Stealth Chromium，提取为独立 `.download-chromium.mjs` 文件，避免重复创建临时文件。
- **API 路由类型增强**：`/api/quota` 路由添加 `Request`/`Response`/`NextFunction` 类型定义，提升类型安全。
- **分页调整**：前端列表分页大小从 20 降到 10，提升移动端体验。

---

## [1.1.0] - 2026-07-03

### 🚀 新特性

- **Prompt Caching 感知的神经元计费**：#37 缓存模型（GLM-5.2 / Kimi K2.5 / K2.6 / K2.7-code）现在根据 CF 返回的 `prompt_tokens_details.cached_tokens` 字段区分缓存命中与未命中的输入 token，缓存命中部分按 ~1/5 价格计费，大幅提升本地估算的准确性。
- **缓存模型智能路由**：`selectBestAccount` 对支持 Prompt Caching 的模型启用软粘性路由，优先复用最近使用的账户以提升缓存命中率；仅当粘性账户用量超出最优账户 10,000 神经元时才切换。其他模型保持原有 least-used 策略不变。
- **流式响应强制 usage 返回**：流式请求自动注入 `stream_options.include_usage: true`，确保 CF 返回 `usage` 信息，避免流式场景下漏记神经元用量。
- **Worker KV 支持**：Worker 端新增可选 KV 绑定（`KV` namespace），用于乐观预估并发控制和缓存粘性路由的跨请求持久化。部署工作流自动创建并绑定 KV 命名空间。
- **完全覆盖部署**：`deploy-cf.yml` 新增 `full_wipe` 参数，勾选后自动删除并重建 D1 数据库 + 清空 KV 命名空间，实现纯净部署。

### 🐛 修复

- **Node.js Readable 流跨 chunk buffer**：修复 Docker 部署下 SSE 行被 TCP 分包截断导致 `usage` 解析丢失的问题，与 Web Streams 路径的 buffer 逻辑对齐。
- **D1 乐观预估兜底**：Worker 端在无 KV 绑定时，乐观预估和缓存粘性路由自动降级为 D1 存储（`quota_usage.optimistic` 列 + `app_settings` 表），确保核心功能不缺失。

### 🔧 优化

- **模型定价同步**：`shared/model-pricing.json` 新增 GLM-5.2 / Kimi K2.5 / K2.6 / K2.7-code 的 `cachedInput` 定价字段，通过 `sync-pricing.js` 同步到 Backend 和 Worker。
- **审计日志增强**：AI 请求日志新增 `cached=` 字段，明确展示缓存命中 token 数。
- **Worker 代码质量**：移除未使用的变量和函数引用。

---

## [1.0.0] - 2026-06

### 初始发布

#### 多账户管理
- 支持 API Token 和 Global API Key 两种认证方式
- 多账户统一管理，凭证自动加密存储
- 账户功能开关（AI / Workers / Browser Render / DNS / Storage）
- 批量测试连接、批量导入导出

#### 仪表盘
- 实时展示各账户今日配额使用量
- 可视化进度条 + 最近操作审计日志

#### Workers / Pages 管理
- Workers 脚本和 Pages 项目的查看、部署、删除
- 跨账户批量部署
- 脚本绑定、环境变量、路由、自定义域名管理
- Pages 支持创建空项目、上传 ZIP 部署
- R2 可用性检查与优雅降级

#### DNS 管理
- 多账户 DNS Zone 汇总查看
- DNS 记录 CRUD，横向滚动兼容窄屏

#### 存储管理
- R2 Bucket 浏览、文件上传/下载/删除
- KV Namespace 键值对管理

#### AI 推理代理
- OpenAI 兼容 `/v1/chat/completions` + `/v1/models`
- 流式 (SSE) 和非流式响应
- 多账户自动轮询，配额耗尽自动切换
- 请求级重试与错误处理
- 支持 `X-Account-ID` 指定账户

#### 浏览器渲染
- `/v1/browser/render` API（screenshot/content/markdown/pdf/links）
- 内置速率限制器
- 浏览器渲染代理，支持并发控制

#### 部署
- Docker Compose 一键部署（Backend + Frontend）
- Cloudflare Pages + D1 无服务器部署
- GitHub Actions 自动化部署工作流
- 代理服务器支持（HTTP_PROXY）
