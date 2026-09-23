# Changelog

## [2.3.0] - 2026-09-23

### ✨ 新功能

- **多账户 Workers 计划（worker_plan）标记与付费 AI 模型智能路由（双端对称）**：
  - **数据库**：`accounts` 表新增 `worker_plan TEXT DEFAULT 'free'` 列，backend（SQLite 迁移 `0009_accounts_worker_plan`）与 worker（D1 迁移 `0010_accounts_worker_plan.sql` + `schema.sql`）严格对齐并经 `schema-check` 验证。
  - **计划探测与子域名分配**：`accountProbe` 支持探测账户的 Cloudflare Workers 计划类型；两端新增 `workerSubdomain.ts` 支持按需查询与预先分配 workers 子域名及计划类型。
  - **智能路由**：AI 推理与 OpenAI 兼容路由对付费定价模型（`isPaidPricing`）自动仅路由至 `worker_plan` 为 `paid` 或 `enterprise` 的账户，避免免费账户因 Workers 配额限制请求失败。
  - **前端与 i18n**：账户新增/编辑弹窗支持配置计划类型（free / paid / enterprise）并提供友好提示，双端国际化语言包同步补全。

### 🐞 修复与优化

- **Worker 定时任务（Cron Triggers）鲁棒性与异常处理修复（双端对称）**：
  - **空数组清空触发器**：修复部署服务 `deploy/triggers.ts` 中 `crons && crons.length > 0` 导致无法清空已有定时任务的缺陷，调整为 `crons !== undefined`，传递 `[]` 显式清理旧触发器，`undefined` 保持现状。
  - **Worker 端部署错误识别**：修复 Worker 端仅判断 `resp.ok` 导致 Cloudflare API 返回 200 但包含 `{ success: false, errors: [...] }` 时误报成功的问题。
  - **接口防崩与校验**：双端 `PUT /:accountId/workers/:name/schedules` 引入 `normalizeCronExpressions`，对非法格式拦截并返回 400 校验错误；增加空请求体兜底，消除 `Cannot destructure` / `SyntaxError` 导致的 500 崩溃。
  - **前端交互与校验**：`WorkerSettingsDrawer.vue` 实时校验 5 段式 Cron 表达式并给出明确红字提示；修复 `saveSchedules()` 缺少 `catch` 块导致保存失败时静默无响应的问题，保存前自动清洗与去重；纠正 weekly 预设为标准 `0 0 * * SUN`。
- **前端存储管理（StorageView）账户切换缓存隔离**：
  - 新增 `resetStorageCaches()`，在切换账户时彻底清空 KV、D1、R2 的选中项与游标缓存，防止跨账户数据残留导致旧资源 ID 错误请求 404。
  - 修复 R2 可用性探测与 tab 激活时的重复网络请求问题。
- **前端 AI 各子模块账户下拉选项去重**：
  - 在 `AiChatView`、`AiImageView`、`AiAudioView`、`AiTranslateView` 中对账户下拉框选项按 `value` 严格去重，避免重复 key 引发的 Naive UI 警告。
- **凭证加解密（Encryption）兼容性与单元测试覆盖**：
  - 完善 backend 与 worker 端对 Hex 格式密钥与常规格式密钥的解析兼容，补齐加解密和计划判定的单元测试。

## [2.2.0] - 2026-09-11

### ✨ 新功能

- **账户管理新增「导出 CSV」，与既有「导入 CSV」打通跨实例迁移闭环（双端对称）**：backend（Express）与 worker（Hono）的 accounts 路由新增 `GET /api/accounts/export-csv`。列集刻意保持最小且与导入端严格对齐——常驻 `name,email,globalKey`（`globalKey` 即 Cloudflare **Global API Key**，落库到 `accounts.api_key`，刻意不叫 `apiKey` 以与 `apiToken` 区分）；仅当导出范围内存在 **token 认证账户**时追加 `apiToken` 列（该类型无邮箱，无法用 `email+globalKey` 表达，不追加就会静默丢账户）。导出范围三选一：`ids=1,2,3`（仅指定账户）、`filter=all|active|unverified` + `search=xxx`（按列表当前筛选条件）、默认全量；`includeCredentials=0` 只导出名称与邮箱，默认 `1` 导出 `globalKey` / `apiToken` 明文。响应前置 BOM（Excel 正确识别 UTF-8）+ `Content-Disposition: attachment`，文件名 `cf-manager-accounts-<时间戳>.csv`。两端新增 `toCsvCell` 转义（逗号/换行/双引号）与分页取全量的 `collectAccountsForExport`（`listAccountsPaged` 单页上限 500）。
  - **响应包装兼容**：worker 侧 `responseWrapper` 按 `content-type` 跳过非 JSON 响应；backend 侧改用 `res.send` 绕开只劫持 `res.json` 的包装逻辑，两端返回体均保持纯 CSV。
- **`POST /import-csv` 升级为按列名解析，可直接回灌导出文件（双端对称）**：此前只识别 `email` / `apiKey` / `password` 三列且认证类型写死为 `global_key`，导致 token 类型账户（无邮箱）整行报错跳过。现**只识别 `email` / `globalKey` / `apiToken` / `name` 四个列名**（大小写不敏感，其余列一律忽略）：
  - `globalKey` → global_key 账户凭证，需与 `email` 同时提供
  - `apiToken` → 识别为 token 认证（backend 用 `Cloudflare({ apiToken })`、worker 用 `Authorization: Bearer` 校验），**token 行允许没有 email**
  - `name` → 原样还原账户名；缺列时仍回退 `nameFromEmail()`，token 行无邮箱时用 `未命名账户-N` 占位
  - **去重键按认证类型区分**：global_key 按邮箱；token 因密文含随机 IV 无法比对密文，改为**解密后比对明文**（`tokenAccountExists`），同批次内也按 `apiToken` 去重
  - **表头校验**：必须包含 `globalKey` 或 `apiToken` 列，且必须包含 `email` 或 `apiToken` 列
- **前端：账户列表页新增导出弹窗**：`AccountsView` 顶部新增「导出 CSV」按钮，弹窗内选择导出范围（全部 / 当前筛选结果 / 已选中，各带数量提示）与是否包含明文凭证；勾选凭证时展示明文泄露警示并提示该文件可在其他实例完整还原，未勾选时提示该文件无法直接用于重新导入。新增 `accountsApi.exportCsv`（`responseType: blob` + `_silent`，失败时解析 JSON Blob 取出后端真实错误信息）与 `accountStore.exportCsv`；导入弹窗说明文案同步更新；补齐 `accounts.*` 中英文文案。

### 🔒 安全与合规

- **演示（Demo）部署整体禁用导出**：新增实例级判定 `isDemoMode()` / `isDemoMode(demoIds)`（约定：配置了 `DEMO_ACCOUNT_IDS` 即为演示部署），`GET /export-csv` 命中即返回 403 `DEMO_PROTECTED`（「演示模式下不支持导出账户」）——导出会把账户清单与凭证整体带出，与演示实例对外只读的定位冲突。前端 `AccountsView` 从 `/api/settings` 的 `demo_account_ids` 识别演示模式，「导出 CSV」按钮置灰并附 tooltip 说明，`openExportModal` 另加一道兜底拦截。
- **导出凭证的暴露面收敛**：演示账户（`DEMO_ACCOUNT_IDS`）凭证始终置空（保留为纵深防御，防止后续放开导出时误泄露）；单个账户解密失败仅该行凭证留空、不阻断整体导出；批量导出只写一条汇总审计（`export_accounts_csv`，含范围与是否含凭证），避免逐账户审计记录淹没日志界面。

### ⚠️ 破坏性变更（双端）

- **CSV 导入列名严格化，旧的 `apiKey` 表头不再兼容**：`globalKey` 列不保留历史 `apiKey` / `api_key` 别名，`apiToken` 同样不认 `api_token`——每个字段只对应一个列名。用旧格式（`email,password,apiKey`）导入会在表头校验处直接返回 400「CSV 必须包含 globalKey 或 apiToken 列」，不会静默错判；请将表头改为 `name,email,globalKey`（token 账户行用 `apiToken`）。
- **彻底移除 `accounts.password` 字段**：该字段（登录密码）是早期批量导入「邮箱 + 密码 + API Key」三件套账号时顺带落库的字段，**界面从未提供填写/编辑入口**（`updateAccount` 的白名单也不含它），唯一写入途径是 CSV 导入的 `password` 列；实际部署中大量库该列全为空。经确认无用后连同数据库列一并移除。
  - **数据库**：
    - backend：基础建表去掉该列；`src/db.ts` 的 `MIGRATIONS` 新增 `0008_accounts_drop_password`，并为迁移记录引入 `kind: 'add' | 'drop'` 语义（`drop` 仅当列确实存在时才执行 `ALTER TABLE ... DROP COLUMN`，新库自动跳过），同时移除历史 `0002_accounts_password` 加列条目。
    - worker：`src/db/schema.sql` 去掉该列；新增 `migrations/0009_accounts_drop_password.sql`；**删除**历史 `0002_accounts_password.sql`（其 `ADD COLUMN password` 会触发 CI `schema-check` 的「迁移增加的列必须在 schema.sql 中」规则；已部署库已在 `_migrations` 记录该版本，删文件无影响）。
  - **迁移器**：`worker/scripts/migrate.mjs` 对 `DROP COLUMN` 语句单独放宽——仅当语句本身是删列且报错为 `no such column` 时视为幂等成功，避免全新库（schema.sql 已无该列）执行删列迁移时中断部署；其余语句的错误处理不变，不会误吞真实的列名错误。
  - **代码/接口**：`Account` / `AccountInput` 与 worker `createAccount` 的 `password` 字段与参数移除；`GET /:id/credentials` 不再解密与返回 `password`；CSV 导入不再解析 `password` 列（旧 CSV 含该列会被安全忽略）；前端「查看 API 凭证」弹窗移除「登录密码」行及 `accounts.loginPassword` 文案；README 双语版功能表中的「可选登录密码」条目同步删除。
  - **升级影响（不可逆）**：本版本起，此前由 CSV 导入写入的登录密码将随列一并丢弃、无法恢复。如仍需留档，请在升级前自行备份（直接读取 `accounts.password` 并用 `ENCRYPTION_KEY` 解密）。

## [2.1.0] - 2026-09-04

### ✨ 新功能

- **新增 OpenAI 兼容文本嵌入端点 `POST /v1/embeddings`（双端对称）**：backend（Express）与 worker（Hono）的 `openai` 路由新增 `/embeddings`，调用 Cloudflare Workers AI Text Embeddings 模型（`bge-base/small/large-en-v1.5`、`bge-m3`、`qwen3-embedding-0.6b`、`plamo-embedding-1b`、`embeddinggemma-300m` 等）。请求体兼容 OpenAI 格式（`{ model, input, encoding_format }`，`input` 支持 string 或 string[]），经 `/ai/run/{model}` 转发 `{ text: [...] }` 并将响应转换为 OpenAI 的 `object:list + data[].embedding + usage`；支持 `encoding_format: "base64"`（Float32 little-endian）、`X-Account-ID` 指定账户与账户轮换/配额记账/审计日志。新增 `estimateEmbeddingsNeurons` 神经元估算（按 token 计费，沿用 `model-pricing.json` 已有 embedding 模型费率）。
- **新增 OpenAI 兼容语音转文本端点 `POST /audio/transcriptions`（双端对称）**：让 `whisper` / `whisper-large-v3-turbo` / `whisper-tiny-en` / `deepgram/nova-3` / `deepgram/flux` 等语音识别模型支持 OpenAI 兼容格式调用。请求体统一为 JSON `{ model, audio: <base64>, language?, prompt?, response_format? }`，出参支持 JSON 或 `response_format: "text"` 纯文本；复用账户轮换（`selectBestAccount`）、`X-Account-ID` 指定路由、配额记账（`estimateAsrNeurons` 音频时长折算）、审计日志与 429 故障自动轮换；针对静音/无文本输入做稳健兼容，不再误报 502。
- **新增 `flux-2-klein` / `flux-2-dev` / `flux-2-klein-4b` 图生图编辑支持（双端对称）**：`/images/generations` 对 Flux 2 族模型适配官方 multipart 协议，透传 `guidance`/`seed`；前端 `AiImageView` 图生图模式按能力启用；客户端 canvas 自动缩放与 JPEG 压缩兜底（≤1024px，≤900KB），防止超出 Cloudflare multipart 1MB 上限。协议要点（经 A/B 矩阵直连 CF 逐项实测确定）：参考图字段必须为 `input_image_0` 且以二进制文件附件提交；请求头不得携带 `Accept: application/json`（否则 CF 返回 500 / code 3043）；backend 用 `Buffer.concat` 组装二进制块、worker 用原生 `FormData` + `Blob`；multipart part 的 `Content-Type` 与扩展名按参考图真实格式声明（内置 magic bytes 检测 JPEG/PNG/WebP/GIF），PNG 谎报 `image/jpeg` 同样触发 3043。
  - **非 Flux 2 模型图生图显式拒绝**：经 10 个图像模型 × 多种字段格式全量实测，CF REST 通道下仅 Flux 2 族真正支持图生图——`flux-1-schnell` / `leonardo/lucid-origin` / `leonardo/phoenix-1.0` 的 schema 无 `image` 字段；`stable-diffusion-xl-base-1.0` / `bytedance/stable-diffusion-xl-lightning` 的 runtime 返回 `input tensor 'image' is not present`；`dreamshaper-8-lcm` 返回 `unexpected shape for input 'image'`；`runwayml/stable-diffusion-v1-5-inpainting` 字段层通过但 CF triton 上游推理失败。故对非 Flux 2 模型收到参考图时直接返回 400 `img2img_unsupported`，避免发到 CF 后拿到模糊上游错误；前端 `AiImageView` 图生图模式本就以白名单仅对 Flux 2 启用，此为后端兜底。
  - **上游错误透传**：多账户轮换时收集每个账户的失败详情到 `details` 数组一并透传，仅当全部账户均为 4006 配额耗尽时才返回 `ALL_ACCOUNTS_EXHAUSTED`，否则透传具体上游状态码与原因，便于定位真实故障。

### 🔒 安全与凭证兼容

- **跨部署加密线格式统一与平滑兼容（P0-3）**：统一 Express（backend）与 Workers（worker）加密线格式为标准 `ivHex:encHex`（12-byte IV + GCM tag 内联于密文末尾），实现跨端凭证无缝解密；双端内置对历史 3 段格式（`iv:tag:enc`）的向下兼容解析，存量 API Token 无需迁移直接可用。
- **SSRF 深度防护与私网请求拦截（SSRF Guard）**：浏览器渲染接口（browserRender）增加双端对称的 SSRF 校验与重定向过滤，严格阻断 RFC1918 私网网段、链路本地地址、云元数据 IP（如 `169.254.169.254`）及内网回环，防止管理服务被利用作为内部探测跳板。
- **演示模式写操作全量保护**：扩展 `demoDestructiveGuard` / `demo.ts` 守卫，不仅拦截删除操作，同时严格拦截 PUT / POST / PATCH 等任何对演示账户的修改、记录添加与部署指令，彻底杜绝演示账户被篡改。

### 💰 模型定价更新（按官方费率校准）

- **按 Cloudflare Workers AI 官方定价页（2026-08-28）校准新增图/音模型费率**（数值约定：USD×1e6，即 `perImage`=每张图、`perAudioMinute`=每音频分钟、`input/output`=每百万 token）：
  - 文生图：`flux-2-dev` perImage≈49600、`flux-2-klein-4b` 1384、`flux-2-klein-9b` 15000、`leonardo/lucid-origin` 30624、`leonardo/phoenix-1.0` 25520（官方系 tile×step 计费，按 1024²=4 tile、默认 20 步 折算为固定 `perImage`，实际随尺寸/步数浮动）。
  - 图像分类：`microsoft/resnet-50` perImage=2.51（官方 $2.51/1M 张，精确）。
  - 音频：`myshell-ai/melotts`(TTS) perAudioMinute=200；ASR 类 `deepgram/flux` 7700、`deepgram/nova-3` 5200、`openai/whisper` 500、`openai/whisper-large-v3-turbo` 500、`openai/whisper-tiny-en` 500（按每音频分钟计费，直接取官方单价×1e6）。
  - **修正分类**：`deepgram/flux` 官方目录为 ASR（语音识别），此前误归为 TTS，已改为 `perAudioMinute`。
  - 兜底保留（官方定价页未收录）：`lykon/dreamshaper-8-lcm`、`runwayml/stable-diffusion-v1-5-inpainting` 维持 perImage=1338。
- **定价逻辑增强（双端对称）**：`pricing.ts` 的 `estimateTtsNeurons` 新增 `perAudioMinute` 优先分支——音频分钟计费模型按 ~900 字符/分钟 由文本长度折算分钟数估算，避免沿用字符费率导致的偏差；无 `perAudioMinute` 的模型回退 `perKChar`。折算假设与来源记录在 `shared/model-pricing.json` 的 `_pricingAssumptions` 字段。
- **修正图/音模型计费单位错误（单位换算 bug）**：经与官方定价页及既有文本模型核对，确认 `model-pricing.json` 全部数值的真实单位为 **Neurons**（基准 $0.011 / 1,000 Neurons，即 1 Neuron = $0.000011），而非此前误写的「USD×1e6」。既有文本/嵌入/重排/翻译模型数值已与官方一致（如 `llama-3.2-1b` $0.027/1M→2.457 = ×90.909 = 每 1k tokens 的 Neurons）。但本轮新增的图/音模型初版误用 USD×1e6，整体偏大 ~11×，已按正确单位重算并修正：`flux-2-dev` 49600→4508、`flux-2-klein-4b` 1384→126、`flux-2-klein-9b` 15000→1364、`leonardo/lucid-origin` 30624→2784、`leonardo/phoenix-1.0` 25520→2320、`microsoft/resnet-50` 2.51→0.228（按 $2.51/1M 张图，单张极廉价）；音频 `deepgram/flux` 7700→700、`deepgram/nova-3` 5200→473、`myshell-ai/melotts` 200→18、`openai/whisper` 与 `whisper-large-v3-turbo` 500→45、`whisper-tiny-en` 维持近似 45；同时把此前兜底为 30 的 `deepgram/aura-1`/`aura-2-en`/`aura-2-es` 按官方 $/1k 字符 修正为 1364/2727/2727。换算规则统一写入 `_pricingAssumptions`：`input/output`=每 1k tokens 的 Neurons（×90.909），`perImage`=每张图 Neurons（×90909.09），`perKChar`=每 1k 字符 Neurons（×90.909），`perAudioMinute`=每音频分钟 Neurons（×90909.09）。
- **补充 GLM 模型官方定价**：`@cf/zai-org/glm-5.3` 与 `@cf/zai-org/glm-5.3-flash` 此前官方定价页未收录、沿用兜底 `30/60`，现已补录官方费率（重新核对 2026-08-28 定价页，二者已上线）：`glm-5.3` = 127.273 / 23.636(缓存) / 400.000（=$1.400/$0.260/$4.400 每 1M tokens），`glm-5.3-flash` = 13.636 / 2.727(缓存) / 45.455（=$0.150/$0.030/$0.500 每 1M tokens）。
- **补录其余已上架官方价的占位模型**：重新全量核对 `model-pricing.json` 中仍为兜底 `30/60` 的条目，确认下列模型官方定价页（2026-08-28）已收录并补录：`deepseek-v4-flash-0731` = 40.000 / 1.273(缓存) / 120.000（=$0.440/$0.014/$1.320 每 1M tokens）、`deepseek-v4-pro-0813` = 120.000 / 4.000(缓存) / 360.000（=$1.320/$0.044/$3.960）、`qwen3.8-27b` = 40.909 / 290.909（=$0.450/$3.200，无缓存）、`moondream3.1-9B-A2B` = 27.273 / 90.909（=$0.300/$1.000 每 1M tokens，属 Other 表 token 计费）、`pipecat-ai/smart-turn-v2` = `{perAudioMinute: 30.723}`（=$0.00033795 每音频分钟，Audio 表）。剩余占位 `30/60`：`gemma-2b-it-lora`、`gemma-7b-it-lora`、`llava-1.5-7b-hf`、`llama-2-7b-chat-hf-lora`、`mistral-7b-instruct-v0.2-lora` 及 `default` —— 已核对官方模型目录页（2026-08-12），这 5 个 lora/旧版变体**仍在在售目录中**（均带 Beta 标签），故予以保留而非清理；但其不在任何定价表内（Beta 模型通常免费或暂未公布费率），无权威费率可填，维持兜底 `30/60`（如需可按相近在售模型近似，待确认）。

### 🐛 Bug 修复

- **修正文生图模型 img2img 入参字段错误（双端对称）**：核对 Cloudflare 官方 input schema 后修正 `openai.ts` 的 `/images/generations` 路由（backend + worker）：(1) `lykon/dreamshaper-8-lcm` 原落入通用透传分支、把图生图输入以裸 base64 发到 `image`（整数数组字段），类型错误；现归入 SD 族分支改用 `image_b64`（官方 schema 字段名）；(2) SD 族 img2img 原发送 `mask_image`（白遮罩 PNG 字符串），但官方字段为 `mask`（8-bit 整数数组）且纯 img2img 无需遮罩，已删除该错误字段与不再使用的 `WHITE_MASK_PNG` 常量。文生图/图生图请求参数现已与官方 schema 对齐。
- **修正付费模型（require_workers_paid）误判为免费（双端对称）**：`/api/v1/models` 返回的模型元数据中，`require_workers_paid` 标记值在 Cloudflare `/ai/models/search` 实际为**字符串 `"true"`**（而非此前代码假设的布尔 `true`），导致 `modelRequiresWorkersPaid` 恒返回 false、前端所有付费模型（如 `@cf/zai-org/glm-5.3-flash`、`@cf/zai-org/glm-5.3`、`@cf/moonshotai/kimi-k2.6`/`kimi-k2.7-code`）都不显示「付费」徽标。现已兼容 `"true"`/`1`/`"1"`/`true` 取值。清掉排障用的临时日志 dump。
- **前端付费徽标渲染稳健化（AiChatView / AiImageView / AiAudioView）**：`n-select` 的 `render-label` 槽不再依赖 Naive UI 透传 option 的自定义字段（`option.requirePaid`），改为从 `modelOptions` 派生 `paidModelValues` 集合、以 `option.value` 查表渲染「付费」徽标，避免个别版本/缓存下自定义字段透传失败导致徽标不显示。
### 🎤 新增 ASR 语音转文本路由（双端对称）

- **新增 OpenAI 兼容 `POST /audio/transcriptions` 路由（backend + worker）**：让 `whisper` / `whisper-large-v3-turbo` / `whisper-tiny-en` / `deepgram/nova-3` / `deepgram/flux` 等语音识别模型真正可用（此前仅有 TTS 路由、ASR 无调用入口）。请求体统一为 JSON `{ model, audio: <base64>, language?, prompt?, response_format? }`（OpenAI 原版用 multipart `file`，此处与项目其余路由保持一致走 JSON base64）；转发 `POST /ai/run/{model}`（CF 请求体 `{ audio, language?, prompt? }`），出参 `{ text, neurons, task, language }`，`response_format: "text"` 时返回纯文本。复用账户选择（`selectBestAccount` + `X-Account-ID` 指定）、配额记账（`estimateAsrNeurons` 按音频字节数近似时长 × `perAudioMinute` 计费）、审计日志（`ai_asr_transcription`）、神经元耗尽轮换与 429 兜底，与 TTS/翻译路由完全对称。

### 🔧 CI / 质量门禁

- **CI 新增类型检查、单元测试与 Lint 门禁（P1-7）**：`ci.yml` 三个 job 在构建后依次执行 `npm run typecheck` → `npm run lint` → `npm run test`。Worker 端首次获得真正的 TypeScript 类型检查——此前 `build` 走 esbuild 直接剥离类型，类型错误无法被 CI 捕获（Docker↔Worker 迁移类缺陷易静默合入）。backend 与 worker 新增 vitest 单测，覆盖 P0-3 加密统一线格式（明文轮转、旧三段 `iv:tag:enc` 兼容解密、两端互解），锁定跨部署凭证迁移契约。frontend 新增 `typecheck` 脚本（复用 vue-tsc）。Lint 门禁：三端各加 `eslint.config.mjs`（扁平配置），根 `eslint.shared.mjs` 共享规则；规则为 curated error-only——风格类（引号/分号/缩进）全部关闭、仅保留真实 bug 级规则（`no-unused-vars`/`prefer-const`/`no-var`/`no-duplicate-case`/`no-fallthrough`/`eqeqeq`/`no-unreachable` 等）作为 error，`no-explicit-any` 仅 warning 不阻断；清掉存量未用变量/应改 const 的 error（backend 19 + worker 17 + frontend 4 = 40 处），CI 现对 lint/typecheck/test 三者全部门禁。
- **新增 `vitest` 测试依赖**：backend / worker 的 `package.json` 加入 `vitest` 与 `typecheck` / `test` 脚本；因 CI 使用 `npm ci`，需在 backend / worker 目录执行 `npm install` 刷新对应 `package-lock.json` 后再提交，否则 CI 安装阶段会失败。
- **路径规范化中间件（P1-4）**：backend 与 worker 新增对称的中间件 `canonicalizeMiddleware`，在认证与路由匹配之前改写请求路径——折叠连续斜杠（`/api//ai`→`/api/ai`）、去除尾部斜杠（根路径 `/` 保留）、对 `/api` 与 `/v1` 前缀小写化（`/API/AI`→`/api/ai`）。消除 Docker(Express) 与 Worker(Hono) 两端对变形路径的路由匹配结果不一致，避免路径绕过或 404/500 差异；非 API 路径（如 `/admin` 静态资源）保持大小写原样，避免破坏资源文件名。两端新增 `normalizePath` 边界单测。
- **双端数据库结构对齐（P1-15）**：逐表核对 backend `db.ts` 与 worker `schema.sql`+`migrations.sql`，5 张共享表的列集合/类型/默认值/索引一致；把 `enabled_features`/`password`/`available_features`/`proxy_url`/`proxy_enabled` 补进 backend `accounts` 基础 CREATE，使规范建表与 worker `schema.sql` 逐字对齐（ALTER 兜底块保留以兼容旧库）。`scheduled_tasks`/`task_executions` 为 backend 独有（worker 走 Cron Triggers），属设计性差异。
- **数据库迁移机制版本化（P1-17 / P1-18 / P1-19）**：废弃「backend 陈旧 base CREATE + ALTER 块」「worker `migrations.sql` 逐行跑」的手工三处同步，改为版本化迁移 + `_migrations` 记录表（每条只执行一次、失败即中断）。
  - **Worker（D1）**：历史演进拆为 `worker/src/db/migrations/NNNN_*.sql`（一条逻辑迁移一个文件），由新增 `worker/scripts/migrate.mjs` 在部署时按版本号有序应用并记录到 D1 的 `_migrations` 表；对现网已含全部列的库，命中「列/表已存在」按幂等跳过并照常记录（兼容旧库），其余错误暴露并中止部署。`schema.sql` 保持为「当前完整 schema」的单一真相源，全新库已由它含全部列，迁移仅补齐旧库——消除 P1-19 的冗余废语句。worker `package.json` 新增 `db:migrate` 脚本。
  - **Backend（SQLite）**：`db.ts` 内嵌 `MIGRATIONS` 数组（历史演进用 `ADD COLUMN IF NOT EXISTS` 幂等），`initDb` 改为先建表再 `applyMigrations(db)`，迁移写入本地 `_migrations` 表；旧的 PRAGMA 探测 + ALTER 块删除。
  - **CI 门禁（P1-17 核心）**：新增 `scripts/check-db-schema.mjs` 并在 `ci.yml` 加 `schema-check` job，解析 backend `db.ts` 与 worker `schema.sql` 的**共享表**列集合做比对（两端不一致则 PR 检查变红），并校验 worker 迁移不引入 `schema.sql` 之外的列，从机制上杜绝双端 schema 漂移。

### 🧩 代码结构与性能治理（P2）

- **`workerService.ts` 巨型文件拆分（职责收敛）**：将 backend `workerService.ts` 中约 400 行与 Worker 脚本本身无关的逻辑拆为两个专职服务——`pagesService.ts`（Pages 项目管理：列表/详情/域名/部署记录/绑定/删除等，+221 行）与 `workerConfig.ts`（Worker/Pages 配置读取与差异应用：`getWorkerConfig` / `getPagesConfig` / `applyWorkerConfigDiff`，供重部署预填使用，+178 行）。原文件瘦身约 400 行，路由层按职责分别 import，消除单体服务文件的维护负担。拆分时同步在 `routes/workers.ts` 补齐 `mapConcurrent`（并发映射 helper，本次一并抽取到 `utils/concurrent.ts`）的导入。
- **抽取并发控制 helper `utils/concurrent.ts`（双端对称，新增文件）**：把账户级并发映射 `mapConcurrent(items, concurrency, fn)` 从服务层抽到 `backend/src/utils/concurrent.ts` 与 `worker/src/utils/concurrent.ts`（各 29 行），供 `quotaTracker` / `workers.ts` / `ai.ts` 等复用，避免各服务重复实现并发逻辑。
- **配额同步并发限流与防重入（双端对称）**：`syncUsageFromCloudflare()` 原使用无节流的 `Promise.all` 遍历全部账户，账户数多时会瞬时打出大量并发 CF 请求；改为 `mapConcurrent(accounts, 6, ...)` 限制并发度，并新增 `inFlightSyncPromise` 请求去重——同一时刻的多个同步请求合并为同一个 in-flight Promise，避免重复打 CF。
- **AI 账户缓存快照与淘汰修正（backend `accountRouter`）**：`getAiAccountSnapshot()` 原只要缓存 key 存在就返回，当缓存值为空数组时会形成「永远命中空快照」的死状态；改为 `cached && cached.length > 0` 才算有效。`removeAccountFromAiCache()` 在列表清空后立即 `del` 缓存 key，避免残留空数组导致快照永不刷新。新建/更新账户时同步清理 AI 缓存（`accounts.ts` 调 `clearCache()`）。
- **前端配额同步交互与内存/查询保护治理**：仪表盘新增「同步额度」入口（`DashboardView` + `quotaStore.fetchQuota(refresh)` 走 `?sync=true` 触发服务端同步），`loading` 与 `syncing` 状态分离，避免手动同步时整页 loading 闪烁；`AiStatsView` 配合调整配额统计展示。同时对 `App.vue` / `AccountsView` / `AiChatView` / `StorageView` / `TunnelsView` 做内存泄漏与查询保护治理——清理未释放的事件监听、定时器与未 abort 的请求，对渲染的用户输入 HTML 统一走 DOMPurify 净化，消除组件卸载后状态更新与 XSS 注入面。
- **国际化补充**：`en.json` / `zh-CN.json` 各新增 `dashboard.syncQuota` / `dashboard.syncingQuota`（同步额度 / 同步中...）两条文案。
- **工程规范与仓库卫生**：`.gitignore` 补充构建与归档产物（`dist/`、`*.zip`、`*.tar.gz`、`*.tgz`）与测试覆盖率输出（`coverage/`、`.vitest/`），并移除对 `.claude/` 的忽略；`AGENTS.md` 同步更新功能场景索引表。

## [2.0.4] - 2026-08-19

### 🐛 Bug 修复

- **修复 DNS 记录编辑逻辑错误**：DNS 管理页「编辑记录」与「添加记录」此前共用同一套提交逻辑，实际始终调用 `POST` 创建接口，导致编辑操作变成「新增一条同名但内容不同的记录」，旧记录需手动删除；且编辑时会把 `id`/`meta` 等脏字段一并提交。现已拆分新增/编辑模式，编辑时走 `PUT` 更新接口、仅提交干净字段并禁用类型修改；编辑时「名称」字段自动转为相对名称（如 `www.example.com` → `www`，根记录 → `@`），与新增填写习惯一致，新增/编辑记录行为恢复正常（closes #46）。
- **修复 DNS 记录 TTL 不生效**：开启代理（橙云）的记录 TTL 被 Cloudflare 强制为「自动」（`1`），此前自定义 TTL 被静默忽略。现已按代理状态处理：代理开启时禁用 TTL 输入并提示「代理记录固定使用自动 TTL」，提交时强制 `ttl: 1`；关闭代理时恢复默认 TTL，与 Cloudflare 官方控制台行为一致。
- **修复 StorageView 中 D1 表列表变量名遮蔽 i18n 函数**：D1 数据库表列表渲染中 `v-for` 迭代变量名 `t` 遮蔽了 vue-i18n 的 `t()` 翻译函数，点击数据库加载表列表时抛出 `TypeError: e is not a function`。将循环变量重命名为 `table`（#45）。

### 📝 文档

- 补充 GitHub 社区标准文件（中英双语）：新增 Issue 模板（Bug 报告 / 功能请求 / 配置）与 PR 模板，以及 `CODE_OF_CONDUCT.md`、`CONTRIBUTING.md`、`SECURITY.md`（#44）。

### 🔧 CI

- 新增 PR 自动构建检查工作流（`.github/workflows/ci.yml`）：针对 master 的 PR 自动触发 backend / frontend / worker 三部分编译校验，任一失败则该 PR 状态检查变红，配合分支规则集（protect-master）阻止合并（#42）。

## [2.0.2] - 2026-08-12

### 🐛 Bug 修复

- **修复 SOCKS5h / SOCKS4a 代理协议识别错误**：代理协议判断正则 `/^socks[45h]?:\/\//` 仅匹配单个字符，导致 `socks5h://` 与 `socks4a://` 被误判为 HTTP 代理，进而使用 `HttpsProxyAgent` 连接 SOCKS 服务端而失败（请求的还是 HTTP）。修正为 `/^socks([45][ah]?)?:\/\//`，正确识别 socks4 / socks4a / socks5 / socks5h 协议；Resin 代理池与账户专属代理、全局代理均受益。

### 📝 文档

- 根据 Cloudflare 权限改版更新 API Token 权限清单（closes #39）。
- 更正 README 中 `CF_GLOBAL_KEY` 权限说明。

### 🔧 CI

- 统一 Cloudflare API Key 环境变量命名，新增 `CLOUDFLARE_API_KEY` 以兼容 API 密钥命名。

## [2.0.1] - 2026-08-10

### 🔧 优化

- **浏览器渲染支持 Kitesurf 引擎**：浏览器渲染（Browser Run）Quick Action 新增浏览器引擎选择，支持 Cloudflare 新一代 Kitesurf 引擎（`?browser=kitesurf`）与默认 Chromium 引擎切换。前端新增「浏览器引擎」选择器（Chrome / Kitesurf），请求透传至 backend 与 worker 双后端；非法引擎返回 `INVALID_BROWSER` 错误。双后端（Express + Hono）对称实现。

## [2.0.0] - 2026-08-07

### 🚀 新特性

- **AI 图片生成（文生图/图生图）**：新增 AI 图片生成功能，支持 Cloudflare Workers AI 的 Text-to-Image 和 Image-to-Image 模型（Flux-1-Schnell、Stable Diffusion XL 等）。
  - 新增 `POST /v1/images/generations` 和 `POST /api/v1/images/generations` 端点（OpenAI 兼容格式），支持账户轮换、神经元消耗追踪、审计日志。
  - 前端新增「AI 绘图」页面，支持文生图/图生图模式切换、参考图上传、高级参数（宽高/步数/引导强度/反向提示词）、图片预览/下载/复用、历史记录画廊。
  - 新增图片生成模型定价（`perImage` 字段）和 `estimateImageNeurons` 估算函数。
  - 双后端（Express + Hono）对称实现。
- **AI 语音合成（TTS）**：新增文字转语音功能，支持 Cloudflare Workers AI 的 Deepgram Aura 系列模型。
  - 新增 `POST /v1/audio/speech` 和 `POST /api/v1/audio/speech` 端点（OpenAI 兼容格式），支持账户轮换、神经元消耗追踪。
  - 前端新增 AI 语音页面，支持模型/语音选择、文本输入、音频播放/下载/复用/删除。
  - 新增 TTS 模型定价（`perKChar` 字段）和 `estimateTtsNeurons` 估算函数。
  - 双后端（Express + Hono）对称实现，统一返回 JSON base64 音频格式。
- **AI 翻译（Translation）**：新增文本翻译功能，支持 Cloudflare Workers AI 的 M2M100 系列模型。
  - 新增 `POST /v1/translations` 和 `POST /api/v1/translations` 端点（OpenAI 格式扩展），支持账户轮换、神经元消耗追踪、审计日志。
  - 前端新增 AI 翻译页面，支持模型选择、源语言/目标语言选择、文本输入、翻译结果显示、复制、神经元消耗显示。
  - 新增翻译模型定价和 `estimateTranslationNeurons` 估算函数。
  - 双后端（Express + Hono）对称实现。
- **AI 功能整合**：将 AI 对话、绘图、语音、翻译、统计合并为统一菜单，顶部 Tab 切换。
  - 新增 `AiUnifiedView.vue` 统一视图，包含统计、对话、绘图、语音、翻译五个 Tab。
  - AI 统计作为首个 Tab，展示账户维度的用量汇总。
  - 路由 `/ai` 指向统一视图，移除独立的 `/ai-image` 和 `/ai-audio` 路由。
  - 导航菜单精简，AI 相关功能整合为单入口。
- **前端国际化（i18n）**：引入 vue-i18n，支持中文（zh-CN）与英文（en）双语界面。
  - 新增 zh-CN / en 两个语言包（各 1052 个词条），自动检测浏览器语言并持久化到 localStorage。
  - 全站视图与组件的硬编码文案统一替换为 `t()` 国际化调用。
- **Zone 管理（创建/删除）**：DNS 管理页面新增批量创建和删除 Zone 功能。支持 textarea 每行一个域名批量添加，选择目标账户和 Zone 类型（Full/Partial）；域名列表支持 checkbox 多选后批量删除，二次确认防误操作。创建成功后展示 Cloudflare 分配的 NS 信息，支持一键复制。
- **Zone 设置管理**：新增 Zone 级别设置面板，支持查看和修改 SSL/TLS 模式、Always HTTPS、自动 HTTPS 重写、安全等级、Auto Minify、Brotli 压缩、0-RTT 等设置项。
- **Zone 缓存管理**：支持清除 Zone 全部缓存或按 URL 清除缓存，可查看和修改缓存级别、浏览器缓存 TTL、开发模式。
- **Zone 状态管理**：支持在 CF Manager 中暂停/激活 Zone，暂停前二次确认警告。
- **DNS View UI 重构**：DNS 管理页面全面重构——新增账户过滤器（默认选上次使用账户，localStorage 记忆）、域名搜索框、Zone 状态指示器（彩色圆点）、按账户分组折叠列表、DNS 记录分页、删除二次确认、MX 记录优先级字段、表单验证、错误处理、加载/空状态、暗色模式修复。

### 🔧 优化

- **Worker 端点补全**：Worker 补充 `GET /accounts/:id/credentials`（查看凭证）和 `POST /v1/browser/render` + `GET /v1/browser/status`（外部浏览器渲染）端点，与 backend 对称。
- **菜单优化**：「AI 推理」→「AI 工作台」重命名；「隧道/回源」菜单移至「AI 工作台」上方。
- **模型能力检测**：基于 CF 官方文档精确识别模型支持的生成模式——Flux 2 支持 image editing（图生图），Flux 1 仅文生图，SDXL 支持图生图。模式切换按钮仅在模型同时支持两种模式时显示。
- **图生图默认强度**：默认 `strength` 从 1.0 调整为 0.6，保留更多原图特征。
- **生成中 UX 改进**：生成图片时不再全屏遮罩，改为顶部加载条，用户可同时查看已有图片。
- **复用功能改进**：点击"复用"时自动切换到图生图模式并使用生成的图片作为参考图（需模型支持）。
- **用量显示**：每张生成的图片返回并显示神经元消耗（⚡ neurons 徽章）。
- **组件重命名**：`AiView.vue` 重命名为 `AiChatView.vue`，更清晰地表达其职责。
- **Workers/Pages 管理 UI 改进**：暗色模式适配（移除硬编码浅色、改用半透明蓝）；间距统一 16px；账户卡片高度/圆角优化；用量详情 Popover 改为 hover 触发；删除后只刷新当前账户；Worker/Pages 状态文案统一（deployed/enabled/active 均显示「活跃」）；表格撑满剩余屏幕高度；底部统计栏显示总数/Worker 数/Pages 数/当前账户名；修改时间缺失时回退显示创建时间。
- **Worker KV 缓存**：Worker 端 `getAllZones()` 新增 KV 缓存（5 分钟 TTL），与 Backend 的 NodeCache 对齐，减少全量查询时的 CF API 调用。
- **批量操作并发池**：Zone 批量创建/删除使用并发池（concurrency=3），避免 CF API 速率限制。
- **缓存自动失效**：创建/删除 Zone 后自动清除 zones 缓存，确保列表数据实时性。

### 🛠 Workers & Pages 部署增强

#### 新增
- Workers & Pages 手动部署支持环境变量（明文/机密）与绑定（KV/D1/R2/AI/DO/Service/Queue），Worker 与 Pages 双端可用
- 重部署可只更新配置：打开部署对话框预填当前配置；secrets 变更走独立 API 不重传代码，vars/bindings 变更复用现有代码重传
- 单/批量部署入口合并：账户多选（选 1 = 单个部署），失败账户可单独重试
- 新增配置读取端点：GET /workers/:accountId/workers/:name/config、GET /workers/:accountId/pages/:name/config

#### 变更
- 删除单账户部署端点（POST /:accountId/workers、POST /:accountId/pages/deploy、deployFromUrl），统一走 batch-deploy / batch-deploy-pages
- 批量部署增加受控并发（concurrency=3）

#### 说明
- 重部署 diff：仅 secrets 变化时只调 secrets API 不重传代码；vars/bindings 变化时后端复用现有代码重传，用户无需再上传文件

### 📝 文档

- **项目分析报告**：新增 `docs/cf-manager-analysis.md`，提供项目架构、代码结构、构建部署流程的完整分析文档。

## [1.5.1] - 2026-08-05

### 🐛 Bug 修复

- **修复批量操作栏位置不明显**：将账户管理页的批量操作按钮（批量设置功能/代理/删除）整合到筛选行中，与"批量测试"按钮同一行显示，仅在勾选账户后通过竖线分隔符追加渲染，省去独立行的视觉冗余。
- **部署工作流新增演示模式开关**：`deploy-cf.yml` 和 `deploy-cf-secret.yml` 新增 `demo_mode` 输入参数（默认 `true`）。开启时根据部署邮箱（`CLOUDFLARE_EMAIL`）在 D1 中查询并保护对应的部署账户（既不保护全部账户，也不限于 full_wipe），无论是否为完全覆盖模式；关闭时不设置任何演示保护。

## [1.5.0] - 2026-08-04

### 🚀 新特性

- **Resin 代理池集成**：原生支持 [Resin](https://github.com/Resinat/Resin) 代理池网关，实现每账户 sticky IP 绑定。设置页新增「Resin 代理池」卡片，配置 Resin 服务地址、Token 和 Platform 后，系统自动为每个 CF 账户构建 `http://Platform.{accountId}:Token@resin-host:port` 格式的代理 URL，通过 Resin 的 sticky session 机制将每个账户绑定到稳定出口 IP，避免 Cloudflare 因 IP 频繁变动触发风控。
- **代理优先级链**：账户专属代理(已启用) > Resin(已启用) > 全局代理(已启用) > 无代理。账户专属代理可覆盖 Resin，允许个别账户不走代理池。
- **Docker 合并为单容器（All-in-One）**：将原来的双容器架构（Nginx 前端 + Node.js 后端）合并为单一 Node.js 容器。Express 直接通过 `express.static` + `compression` 中间件提供前端静态文件服务（gzip 压缩、30 天缓存、SPA 路由回退），不再依赖 Nginx。SSE 流式响应在 Node.js 中原生处理，无需 `proxy_buffering off` 等配置。
- **预构建 Docker 镜像发布到 GHCR**：新增 `docker-publish.yml` GitHub Actions workflow，在 Release 打 tag 时自动构建多架构（amd64 + arm64）镜像并推送到 `ghcr.io/hefy2027/cf-manager`。用户无需 clone 仓库，直接 `docker pull` 即可使用。

### 🐛 Bug 修复

- **修复 Worker 端批量部署缺少 `db` 参数**：`POST /store/deploy-batch` 调用 `deployTemplate` 时补充 `db: c.env.DB`，确保批量部署路径下审计日志正常写入（与单次部署路由 `POST /store/deploy` 行为一致）。
- **修复部署 Modal 账户预选不一致**：单次部署弹窗默认预选账户从分页的 `accountStore.accounts[0]` 改为全量 `accountOptions[0]`（与下拉选项数据源一致），避免分页翻页后预选到非预期的账户导致用户误部署到错误账户。
- **修复 Settings 任务表单账户下拉选项不全**：定时任务表单的账户下拉选项从分页的 `accountStore.accounts` 改为独立全量加载（`pageSize: 10000`），确保所有活跃账户在任务创建时可被选择。
- **修复部署按钮可能被错误禁用**：Workers 页面的「部署」按钮启用条件从分页的 `accountStore.accounts.length` 改为全量的 `allAccounts.length`，避免账户分页翻页后按钮被误禁用。

### 🔧 优化

- `proxyFetch` 新增 `account` 参数，支持自动使用 Resin/账户代理（pagesDeploy / workerDeploy / assetsUpload / preflight 调用已适配）。
- `getAccountProxyUrl` 修正账户专属代理需 `proxy_enabled === 1` 才生效（与 `getHttpAgentForAccount` 行为一致）。
- `proxyFetch` 重试逻辑（ECONNRESET/EPIPE）补充 `account` 分支，修复重试时丢失 Resin/账户代理的 bug。
- **部署路由增加账户日志**：在 backend 和 worker 的 `/store/deploy` 与 `/store/deploy-batch` 路由中添加部署账户信息日志（账户名、DB id、CF account_id），方便定位多账户部署时可能出现的账户选择问题。
- **部署结果包含账户信息**：`DeployResult` 接口新增 `accountName` / `accountId` 字段，前端成功弹窗展示部署目标账户名，用户可直观确认部署到了正确的账户。
- **Docker 部署简化**：`docker-compose.yml` 简化为单服务配置；`deploy.sh` 适配单容器构建流程。
- **移除 `BASE_URL` 环境变量**：Docker 版前端路径固定为 `/`，不再支持自定义子路径（Worker 版仍固定 `/admin/`）。
- **`.dockerignore` 更新**：适配新的 `docker/Dockerfile` 路径。

### 🗑️ 移除

- 删除 `docker/backend/Dockerfile`、`docker/frontend/` 目录（Dockerfile、nginx.conf、nginx.conf.template、entrypoint.sh）。

## [1.4.3] - 2026-08-03

### 🚀 新特性

- **Workers/Pages 批量部署支持任意账户**：批量部署弹窗从"只能从已部署列表中勾选"改为"多选目标账户 + 输入名称"的模式，与单账户部署一致，可在任意账户上新建部署，不再依赖 `workerStore.workers` 数据源。
- **Store 商店多账户批量部署**：部署对话框支持多选账户（`n-select multiple`），一键将同个模板部署到多个账户。多账户模式下绑定资源强制使用 auto 模式（每账户独立创建或按名称复用），避免跨账户资源 ID 冲突。后端新增 `POST /store/deploy-batch` 批量端点（backend + worker 对称），单次请求并行完成预检 + 部署，返回每个账户的独立结果。

### 🐛 Bug 修复

- **Pages 部署配置格式与文件上传逻辑**：修复 Pages 部署时配置参数格式不正确及文件上传处理逻辑的问题。

### 🔧 优化

- 批量部署按钮禁用条件改为检查 `allAccounts` 而非 `workerStore.workers`，打开弹窗时不需要先选中某个账户卡片。

## [1.4.2] - 2026-08-01

### 🐛 Bug 修复

- **AI 推理页用量统计 404**：`/api/ai/usage` 接口在 Worker（Cloudflare Pages）端缺失，前端 fetch 收到 nginx 伪装 HTML 页面，解析 JSON 抛出 `SyntaxError: Unexpected token '<'`。补齐 Worker 端 `routes/ai.ts` 的 `GET /usage` 实现并挂载到 `/api/ai`，与 backend 对称。
- **移动端暗黑模式切换缺失**：修复三个关联问题：1) `main.ts` 未导入 `style.css`，导致所有自定义 CSS 变量（`--app-bg`、`--app-bg-card` 等）从未加载，移动端布局、紧凑账户卡片、AI 建议卡等全部失效；2) `toggleTheme` 未调用 `setDiscreteTheme`，导致 message/notification/dialog 等离散组件不跟随主题；3) 主题状态未持久化（刷新后回退亮色）且未检测系统 `prefers-color-scheme`。现补齐 `style.css` 导入、`toggleTheme` 同步 `html.app-dark` class + localStorage 持久化 + `setDiscreteTheme` 调用、启动时从 localStorage/系统偏好恢复主题。

## [1.4.1] - 2026-07-27

### 🚀 新特性

- **账户级独立代理**：支持为每个账号分配独立代理 URL 与启用开关，代理优先级为「账户代理(启用) > 全局代理 > 环境变量」；全局开关仅控制全局默认代理，账户代理独立生效、互不影响。双后端（Express/Hono）对称实现，D1/SQLite 迁移新增 `proxy_url` / `proxy_enabled` 列。
- **审计日志筛选**：支持按操作类型和日期范围筛选审计日志，便于事后追溯与排查。

### 🎨 前端

- **账户批量操作**：账户列表支持批量勾选、批量删除、批量设置代理。
- **账户设置优化**：新增账户代理独立弹窗；操作列收纳为「更多」下拉，左右固定列适配移动端窄屏。

## [1.4.0] - 2026-07-24

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
