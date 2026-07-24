# Changelog

## [1.3.8] - 2026-07-24

### 🚀 新特性

- **隧道管理（Cloudflare Tunnel）**：account 级 CRUD + 连接状态 + 连接令牌 + Ingress 配置查看/编辑，双后端对称（backend + worker）。
  - Ingress 配置 UI：子域名/域名拆分选择、协议（HTTP/HTTPS/TCP/自定义）+ 端口、路径正则，6 列直观编辑。
  - CNAME 扫描自动发现隧道绑定域名。
- **通用规则引擎**：替代原有单一「回源规则」，统一支持 Cloudflare Rulesets API 的 8 种 Phase：
  - Zone 级：回源（Origin）、URL 重写（Transform）、请求头转换、响应头转换、缓存设置、防火墙（Firewall）、速率限制（Rate Limit）
  - Account 级：重定向（Redirect）、动态重定向（Dynamic Redirect）
  - 后端 `rulesetService.ts` 自动根据 Phase 选择 `/zones/{id}/rulesets`（`kind: 'zone'`）或 `/accounts/{id}/rulesets`（`kind: 'root'`），双端对称。
  - 前端「规则引擎」Tab：Phase 下拉 + 域名选择 + 规则列表 CRUD；账户级 Phase 标注 `[账户级]` 并显示提示条。
- **结构化规则配置表单（小白模式）**：每种 Phase 提供直观表单，无需手写 JSON：
  - URL 重写：重写类型（路径/查询参数）+ 新值输入
  - 请求头/响应头转换：操作类型（设置/添加/删除）+ Header 名 + Header 值
  - 缓存设置：启用开关 + TTL 模式（遵循源站/自定义）+ TTL 值
  - 速率限制：触发动作（阻断/验证码挑战/JS 挑战）+ 限流维度多选 + 时间窗口 + 请求数 + 处罚时间
  - 高级模式开关：开启后可直接输入原始 JSON；编辑规则时自动从 `action_parameters` 解析回表单字段，无法解析时自动切到高级模式。
- **表达式生成器**：匹配类型下拉（按主机名/按路径前缀/按路径正则/主机名+路径/自定义表达式）+ 子域名 + 路径输入，实时预览生成的 Cloudflare 表达式，无需手写表达式语法。
- **一键回源向导**：支持新建/复用隧道 + 自动创建 DNS CNAME + ingress 端口/协议/路径配置 + 部分失败回滚（逆序删除已创建资源）。
  - 向导模式切换：`create` 新建隧道并下发配置；`reuse` 复用已有隧道，自动合并 ingress 去重。
  - CNAME 冲突检测：hostname 已存在记录时返回 `CNAME_CONFLICT` 错误，提示用户先处理 DNS。
  - 同账户约束：向导要求隧道与域名属于同一 Cloudflare 账户，直接用隧道账户凭据拉 zone。
- **前端整合页**：新增「隧道/回源」页面（`TunnelsView.vue`），NTabs 分隧道管理和规则引擎两区，侧栏菜单新增入口。
- **Worker 设置抽屉域名可点击**：域名列改为可点击链接，优化操作按钮布局。
- **1101 错误提示**：StoreDeployDialog 添加 1101 错误解决提示。

### ♻️ 重构

- **CI 部署逻辑提取为 composite action**：将 `deploy-cf.yml` 和 `deploy-cf-secret.yml` 中重复的部署逻辑提取为 `.github/actions/deploy-cf/action.yml`，消除两个工作流间的代码重复；checkout 步骤移至工作流以修复本地 action 引用。
- **移除旧 `originRuleService.ts`**：双端删除已被通用 `rulesetService.ts` 取代的旧回源规则服务；前端清理对应的 `listOriginRules` / `createOriginRule` 等死方法。

### 📝 文档

- **README 增强**：添加相关项目链接、应用商店功能说明与截图。

### 🔒 安全

- **演示账户保护**：规则 DELETE 操作覆盖演示账户保护（`isDemoAccountId` / `isDemoAccount`）。

## [1.3.7] - 2026-07-23

### 🚀 新特性

- **Deploy Service 独立模块化**：将 Catalog 部署逻辑从 `catalogDeploy.ts` 重构为独立的 `deploy/` 子模块（backend + worker 双端对称），包含 `preflight.ts`、`workerDeploy.ts`、`pagesDeploy.ts`、`triggers.ts`、`assetsUpload.ts`、`uploadForm.ts`、`headers.ts`、`types.ts` 共 9 个子文件。
  - 部署 API 调用注入 `User-Agent: wrangler/4.112.0`，使 CF 识别为 wrangler 部署。
  - Worker 部署默认使用 Versions API（对标 wrangler），首次部署自动回退到传统 PUT。
  - Pages 部署实现 JWT 自动刷新、Hash 校验、分批上传及部署状态轮询。
  - Catalog Schema 扩展支持 Durable Objects、Service、Queue 绑定及 Migrations、Placement、Limits、Tail Consumers 等高级配置。
- **两阶段部署流程**：新增 `POST /api/store/preflight` 预检端点（backend + worker 对称），在用户确认部署前检查 Worker 存在性、配置差异（Config Diff）、Secrets 覆盖情况。
  - 前端 `StoreDeployDialog` 改造为自动预检流程：点击「确认部署」时自动先预检，无问题则直接部署，有配置差异或警告时展示结果等待用户二次确认；表单任何变更自动使预检结果失效。
- **ZIP 多模块部署**：部署 ZIP 产物时自动解包为多模块上传（对标 wrangler 本地解包），自动推断 main_module，非入口 JS 文件作为附属模块。
- **自定义域名 / 路由 Zone 选择器**：Worker 和 Pages 设置抽屉的域名绑定改为 Zone 下拉选择 + 子域名前缀输入 + 实时预览（如选 `example.com` + 输入 `api` → 预览 `api.example.com`），替代易出错的手动全文输入；路由 tab 的 Zone ID 同步改为 Zone 下拉选择，添加路由时自动建议 Pattern。
- **Pages 部署批量删除**：Pages 部署历史支持全选 / 批量删除，删除前弹窗确认并高亮警示生产环境部署。
- **Catalog Schema `run_worker_first`**：assets 配置支持 `run_worker_first` 路径前缀数组，指定由 Worker 优先处理的路径（如 `["/api/*"]`），避免被静态资源层拦截。

### 🐛 修复

- **Multipart 上传 Content-Length 不匹配**：手动构建 `multipart/form-data` body（`Buffer.concat`）替代 `FormData` + undici 自动序列化，精确控制每个 part 字节，解决 undici 在计算 Content-Length 时与实际 body 不一致导致 CF API 返回截断响应（`UND_ERR_RES_CONTENT_LENGTH_MISMATCH`）。
- **静态资源 MIME 类型**：assets 上传时按文件扩展名设置正确 Content-Type（如 `.js` → `application/javascript`），修复之前统一用 `octet-stream` 导致浏览器拒绝加载 JS 模块；默认 Content-Type 改为 `application/null`（对标 wrangler）；新增 `.webmanifest` 支持。
- **Assets 上传 JWT 分批刷新**：每个 bucket 上传后使用 CF 返回的新 JWT 作为下一批次的认证 token（对标 wrangler `syncAssets`），修复之前所有批次共用 session JWT 导致后续批次认证失败。
- **上传重试机制**：Worker 部署新增 `withRetry` 包装，遇到 `UND_ERR_RES_CONTENT_LENGTH_MISMATCH`、`UND_ERR_SOCKET`、`ECONNRESET`、`EPIPE` 等可重试错误时指数退避重试（最多 3 次）。
- **observability 上传方式**：observability 配置在上传 metadata 中一并设置（对标 wrangler），不再依赖后续 PATCH `script-settings`。
- **keep_bindings 类型修正**：CF API 期望 `keep_bindings` 为要保留的绑定类型字符串数组（如 `["kv_namespace", "d1", ...]`），修正之前传 boolean 的问题。

### ♻️ 重构

- **catalogDeploy.ts 精简**：部署逻辑全部迁移至 `deploy/` 模块，`catalogDeploy.ts` 仅保留 re-export 维持向后兼容。
- **uploadForm.ts 手动构建 multipart**：使用 `Buffer.concat` 精确拼接 multipart body，替代 `FormData` + Blob 自动序列化，确保 Content-Length 完全确定。

### 📝 文档

- **README 合规整改**：新增免责声明与合规提示前置区块，明确仅限学习研究及已授权自有账户运维使用；弱化套利相关措辞；补充 Global API Key 安全风险提示；演示站增加滥用警示。

## [1.3.6] - 2026-07-21

### 🚀 新特性

- **账户编辑功能**：新增 `PUT /accounts/:id` 接口（backend + worker 双端对称），支持原地修改账户名称、凭证、切换认证方式（token ↔ global_key），无需删除重建。
  - 部分更新语义：不填的凭证字段保留原值；`email` 与 `api_key` 为一组，需同时填写。
  - 切换认证方式时自动校验新凭证并清空旧凭证字段。
  - 前端复用现有"添加账号"对话框，编辑模式下隐藏功能复选框、凭证字段提示"不填则保留"。
- **R2 可用性缓存**：账户表新增 `available_features` 列，创建/编辑/测试账户时自动探测 R2 是否可用并缓存结果。
  - 前端存储管理页切换账户时直接读缓存，不再每次调 CF API 探测 R2。
  - 后端 4 个 R2 列表路由短路优化：`available_features` 含 `-r2` 时直接返回"不可用"响应，不调 CF API。
  - 存量账户部署后跑一次批量测试即可回填缓存，无需额外迁移脚本。
- **R2 能力标识展示**：账户列表"功能"列显示 R2 支持状态（蓝色=支持/灰色删除线=不支持）；存储管理页和商店部署对话框的账户选择器中支持 R2 的账户名后标记绿色 R2 小标签。
- **Worker with Assets 部署**：catalog 模板新增可选 `assets` 字段，双后端实现静态资源三阶段上传（manifest 校验、base64 分块、PUT 注入 JWT 与 ASSETS 绑定）；子域名设置面板新增完整访问地址展示（`https://<script>.<accountSubdomain>.workers.dev`）。
- **多模块 ZIP 部署与 Cron 定时任务**：worker 端支持多模块 zip 部署，并支持 cron 定时任务注册。
- **部署可观测性与兼容性增强**：新增 Workers traces / logs 部署开关（默认开启）；支持从模板读取并透传 `compatibility_date` 与 `compatibility_flags`；自动探测代码中的 Node.js 特性并注入 `nodejs_compat` 标志；兼容版本化 API（用 `version_id` 显式创建 deployment）；资产上传支持按 buckets 分批且跳过已存在资源；允许 Worker 产物为 zip 并自动解包。
- **应用商店增强**：模板新增「仓库入口」按钮并优化源地址推断；模板说明支持 Markdown 渲染；账户摘要支持按功能/状态过滤。
- **Workers / Pages 设置抽屉**：新增设置侧边抽屉，支持编辑绑定 / 环境变量 / 路由 / 自定义域名；新增 `StoreDeployDialog` 模板部署对话框。
- **Catalog / Pages 部署服务（backend + worker 对称）**：catalog 部署与 Pages 部署（worker）下沉为独立服务，打通 store 部署全链路。

### ♻️ 重构

- **Catalog KV 缓存与 Schema 精简**：移除 `catalog.schema.json` 中不必要的 `value` 字段及相关校验逻辑；优化 `store.ts` 中 KV 缓存处理，增加缓存 TTL 防止脏数据。

### 🐛 修复

- **Worker with Assets 部署修复**：修复手动 / 批量部署路由未传入 `assets` 元数据导致静态资源被静默跳过。
- **Store 详情抽屉与 R2 筛选修复**：修复 R2 账户筛选及详情抽屉布局问题。
- **Store 空目录缓存修复**：忽略无模板的空目录缓存，避免脏数据。
- **后端部署修复**：backend 新增 dotenv 支持，修复部署域名拼接错误。

### 🔒 安全

- **Catalog 部署 SSRF 防护**：store / catalog 部署链路补充 `ssrfGuard` 防护（backend + worker 对称），校验脚本与静态资源 URL 来源，收敛部署 SSRF 攻击面。

### 🔧 部署 / CI

- **GitHub Actions 部署工作流加固**：改用 GitHub Environments 管理密钥，新增 Secrets + Environments 部署方案；改用 CF REST API 替代 wrangler 操作 D1 和 KV；修复密钥泄露、资源匹配不稳健及子域名处理问题；修复 Pages 项目创建错误被静默吞掉（关联 issue #11 部署地址重复）。

### 📝 文档

- **合规使用声明与安全提示**：补充合规使用声明与安全提示文档。

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
