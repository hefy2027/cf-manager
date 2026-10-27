# 第三方 fork 功能调研：Heisenberg2024/cf-manager

> 本文整理社区活跃 fork `Heisenberg2024/cf-manager` 相对上游 `hefy2027/cf-manager` 的全部功能改动与实现细节，并给出移植评估。
>
> 调研日期：2026-10-14，2026-10-27 补充 v2.10.0–v2.10.2 三个提交（见第十三节）。对比基线：上游 `master` @ `559de0a`（v2.4.2）。

---

## 一、概述

| 项 | 值 |
|---|---|
| 上游仓库 | `hefy2027/cf-manager` |
| 调研对象 | `Heisenberg2024/cf-manager`（master 分支） |
| 领先上游 | **14 个提交**（落后 2 个；2026-10-27 复核） |
| 提交时间跨度 | 2026-10-04 → 2026-10-15 |
| 代码规模 | 28,575 行 diff、413 个文件（截至 v2.10.2） |
| 核心增量 | **15 个新增 `shared/` 共享源文件** + 多个前端组件 + Dashboard 持久化资源目录 |
| 版本推进 | 基线 → v2.10.2 |
| 测试规模 | 三端 296 → **764 项**（v2.9.0 时点；v2.10.x 又新增 Dashboard/迁移/滚动三类契约与浏览器回归） |

### 14 个提交索引

| SHA | 日期 | 主题 |
|---|---|---|
| `410f55bb` | 10-04 | 多账户凭证体系及生产运维改造 |
| `248d6e04` | 10-05 | DNS 多 Zone 批量管理、浮层与滚动布局修复 |
| `7a90f026` | 10-09 | 区分凭证账户、域名套餐顺序分配 |
| `eb5ab26c` | 10-09 | 精简账户列表、多行域名搜索 |
| `7d45afd4` | 10-12 | 套餐管理完善、统一域名批量操作面板 |
| `43567701` | 10-12 | DNS 按需加载与安全缓存优化 |
| `79978a9a` | 10-13 | v2.7 DNS 与 Workers/Pages 性能优化 |
| `033370e2` | 10-13 | v2.8 Zone 设置与 Storage 优化 |
| `0ea99c96` | 10-13 | 域名批量 SSL/TLS 与缓存清除、统一账户标签 |
| `7a317de4` | 10-13 | Pages 列表分页读取修复（v2.8.2 热修复） |
| `c7beed92` | 10-14 | v2.9.0 隧道与规则安全加固、读取性能 |
| `b146cf81` | 10-14 | v2.10.0 Dashboard 总览、审计中心与公共账号查询优化 |
| `dd0e3a31` | 10-14 | v2.10.1 后台持久化资源扫描 + 滚动容器修复 |
| `12d149a9` | 10-15 | v2.10.2 快照一致性与用量统计、首页布局重整 |

### 调研方法

1. 通过 GitHub API 列出全部 fork，按 `pushed_at` 与 `compare` 筛出领先上游的分支；
2. 拉取 11 个提交的完整 `.diff`（37,825 行），提取文件级增删统计建立改动地图；
3. 按功能域分组精读 diff，重点确认函数名、API 路径、参数阈值；
4. 对涉及主干的结论，**回到主干代码逐条复核**（下方标注「已复核」的条目均已核对本仓库源码）。

---

## 二、结论摘要

- **价值密度高，但形态是架构演进而非独立补丁**。新增 15 个 `shared/` 文件 + `ReadScheduler`/`resourceCache` 等地基，多项功能相互依赖，不宜整段 cherry-pick。
- **最值得立刻吸收的**：Worker 端列表分页（主干存在真实数据丢失 bug）、`style.css` 一行 CSS 修复、`retry:false` + 读回确认的写入范式。
- **破坏性最大**：多账户凭证体系改动数据模型与 API 契约，建议独立立项。
- **需要警惕**：该 fork 自身出现过 `per_page` 参数导致 400 的自我回归（见第七节），说明其部分"修复"是针对自己引入的问题，移植时须重新验证。

---

## 三、多账户凭证体系（`410f55bb`）

**解决的问题**：账户模型只能存一套凭证，无法「同一 token 管多个账户」，也无法在 UI 上区分账户归属。

### 数据模型

新增表 `credentials`（backend 内联 DDL；worker 走 `schema.sql` + `migrations/0011_credentials.sql`）：

| 字段 | 说明 |
|---|---|
| `id` / `name` | 主键、凭证名 |
| `auth_type` | `CHECK('token'\|'global_key')` |
| `api_token` / `api_key` / `email` | 密文存储 |
| `fingerprint` | `UNIQUE`，密钥指纹 |
| `legacy_account_id` | `UNIQUE`，迁移用 |
| `status` / `last_checked_at` | 探测状态 |

`accounts` 新增 4 列：`credential_id`(FK)、`is_enabled DEFAULT 1`、`access_status DEFAULT 'unknown'`、`last_checked_at`。

**关系**：1 凭证 : N 本地绑定。`accounts` 行 = 本地绑定，指向真实 CF `account_id`；唯一索引 `idx_accounts_binding(credential_id, account_id)` 去重。

**指纹归一**：`fingerprint = HMAC-SHA256(encryptionKey, JSON([auth_type, email(仅 global_key 小写), 明文密钥]))` —— 同一 token 跨账户自动归一为一条凭证。

### 实现要点

**查询边界投影（关键手法）**：两端导出同名常量 `ACCOUNT_SELECT`，用
`LEFT JOIN credentials` + `CASE WHEN c.id IS NOT NULL THEN c.api_token ELSE accounts.api_token END`
在查询层把凭证投影成账户字段，**业务代码零改动**。

**`shared/accountDiscovery.ts`**
- `createCfRequest()`：**仅对 429 重试（上限 2 次）**，`Retry-After > 5s` 直接抛错不早退；**写操作网络失败绝不重试**
- `listAccessibleAccounts()`：`per_page=50`、上限 1000 页、4 种终止条件、**页不前进即抛错**、账户 ID 必须匹配 `^[a-f\d]{32}$`
- `validateManualAccount()`：403 时降级用 `zones?account.id=` / `workers/scripts` / `kv/namespaces` 验证，**支持 DNS-only token**
- `discoverAccounts()`：403 时对 token 走 `/user/tokens/verify` 区分 invalid 与 permission

**`shared/credentialManager.ts`**：`CredentialRepository`（14 方法）+ manager（`list/discover/save/sync/addBindings/update/remove`）。阈值：单次选账户 1–500、sync 并发 3、绑定状态 `available/unauthorized/unavailable/error`、**失权只标 `unauthorized` 不自动删绑定**。

**认证头切换**：`auth_type='token'` → `Authorization: Bearer`；`'global_key'` → `X-Auth-Key` + `X-Auth-Email`。

### 后端落地

| 位置 | 内容 |
|---|---|
| `backend/src/models/credential.ts` | `ensureCredential/updateCredential/getCredential/listCredentials/credentialFingerprint` + `ACCOUNT_SELECT` |
| `backend/src/services/credentials.ts` | repo 注入 shared manager：`bind→createAccount`、`mark→updateAccount`、`remove→事务删 accounts+credentials`、`assertMutable→isDemoAccountId`、`invalidate→clearCache` |
| `backend/src/routes/credentials.ts` | `GET /`、`POST /discover`、`POST /`、`POST /:id/sync`、`POST /:id/accounts`、`PUT /:id`、`DELETE /:id` |
| `backend/src/services/cfFactory.ts` | 新增 `credentialRequest/accountRequest`（proxyFetch + `AbortSignal.timeout(15000)`）；`is_enabled===0` → 409 `ACCOUNT_DISABLED` |
| `backend/src/services/accountRouter.ts` | `getAllZones(refresh)` 并发 3；多绑定歧义 → 409 `AMBIGUOUS_ACCOUNT` |

Worker 端同构镜像：`db/credentials.ts`（`crypto.subtle` HMAC）、`db/migrations/0011_credentials.sql`、`services/credentials.ts`（`invalidate→KV.delete('dns_zones_all')`）、`services/cfApi.ts`（分页上限 1000）。

### 前端

`CredentialPanel.vue`(+170)：折叠表格（凭证名/认证类型/绑定账户串/状态/最后检查 + 同步·关联账户·编辑·删除），编辑模态支持密钥留空即保留、检测按钮调 `/discover`、手动 32 位 hex Account ID。
`AccountsView.vue`：「添加账户」改调 `credentialPanel.open()`，新增 `credential_name` 列与 `is_enabled` 开关列；`client.ts` 401/403 **仅在 code 为 `UNAUTHORIZED/FORBIDDEN` 时登出**（避免 CF 权限错误误清 API_SECRET）。

### 破坏性变更（移植风险）

1. `POST /api/accounts` 契约变：`name/auth_type` 不再必填，响应 `{id,...}` → `{credential_id,id,ids,accounts}`
2. `POST /:id/test` 不再返回 `{user}`
3. 编辑账户传 `api_token` 会改整条凭证、影响所有绑定（仅 UI 警告，API 无隔离）
4. 删除凭证级联删全部绑定 + 配额，旧「删一个账户」语义须改用删绑定
5. `hasFeature` 由 `||` 改 `??`
6. `accounts.api_token` 语义变为联表投影，直写该列的旧代码会失效

### 迁移与测试

迁移：单事务回填 + `_migrations='0011_credentials_backfill'`，**密文原样复制、accounts.id 不变** → 外键不断、幂等可重跑。
测试：`accountDiscovery.test.ts`（95 行，含 429 重试上限、写操作不重试、密钥脱敏）、`workerCredentials.test.ts`（95 行，用自写 `d1Adapter` 在 better-sqlite3 上跑 worker 代码）、`credentialMigration.test.ts`（66 行，生产 SQLite 迁移验证）。

---

## 四、DNS 批量操作（`248d6e04`）

**`shared/dnsBatch.ts`**(+210) —— 批量引擎

- `BatchAction = create|update|delete|proxy|ttl`；`BatchZone{credentialId,accountId,zoneId,zoneName}`
- `BatchSpec{zones, action, match{host,types,currentContent}, record?, changes?, conflictPolicy: skip|update|create}`
- `BatchStatus` **11 态**：READY/FOUND/SKIP/ERROR → PENDING/RUNNING/SUCCESS/SKIPPED/CONFLICT/NOT_FOUND/FAILED
- `BATCH_CONCURRENCY = 3`；限制 **1–500 Zone、≤5000 预览项**；`zoneId` 须匹配 `/^[a-f\d]{32}$/`，同 zoneId 重复绑定拒绝；proxy/ttl 动作仅允许单字段
- **预览签名**：`HMAC-SHA256("cf-manager/dns-batch/v1:{secret}")`，15 分钟过期
- **幂等**：新表 `dns_batch_executions(id, expires_at)` + `INSERT OR IGNORE`（SQLite 迁移 `0012`，D1 同名 migration）
- **归属三重校验**：`credentialId` + `GET /zones/{id}` 的 `id / name / account.id`
- **冲突判定链**：内容相同→`SKIP`；CNAME/NS 跨类型→`CONFLICT`；同类型不同内容默认 `CONFLICT`；`update` 仅命中 1 条才 PATCH
- **写前重读快照比对**：POST 比 `existing` 集合、PATCH/DELETE 比 `before`，不一致→CONFLICT；404→NOT_FOUND
- **审计只记身份/状态，不记 TXT 内容**

**端点**（两端对称）：`POST /dns/batch/preview`、`POST /dns/batch/execute`（**SSE 流式**，Express 手写 `res.write` + 10s 心跳 / Worker 用 `hono/streaming` 的 `streamSSE`）。
适配层 `services/dnsBatchRuntime.ts`（backend 25 行 / worker 23 行）：`resolve` 校验 enabled/active/dns feature/credential 绑定 + demo 账户 403；`audit` 写 `batch_dns_{action}`。

**`shared/dnsRecord.ts`**(+36)：`DNS_TYPES`(9 种)、`PROXY_TYPES`(A/AAAA/CNAME)；`dnsName()` 处理 `@`→zone、通配符必须最左标签、逐标签正则 `^(\*|[a-z0-9_-]{1,63})$`、FQDN ≤253；`validateDnsTtl` 仅 1(Auto) 或 60–86400；`buildDnsRecord()` 组装 SRV `data{target,priority,weight,port}`、CAA `data{flags,tag,value}`、MX `priority`；proxied 时强制 `ttl=1`。

**前端**：`DnsBatchDialog.vue`(+272) 5 步向导 configure→preview→confirm→execute→result，`generation` 计数器防过期响应；`DnsRecordFields.vue`(+128) 字段白名单 + `patch` 标志；`DnsOperationModal.vue`(+42) 统一弹窗外壳。

---

## 五、域名套餐管理与顺序分配（`7a90f026` + `7d45afd4` + `eb5ab26c`）

**`shared/zonePlans.ts`**（+147 → +162 −45）

- 新增 **`rate_plan_id`**（真实可订阅 ID），区别于 `available_plans` 的不透明 product ID
- 别名映射：`cf_free→free`、`cf_biz→business`、`cf_pro_20_20→pro`、`cf_ent→enterprise`；兜底按 `name/public_name` 去 "Website Plan" 后缀匹配；**拒绝把 Enterprise 附加项误判为网站套餐**
- `availablePlans()` 并行读 `available_plans` + `available_rate_plans`（各分页 ≤20 页），`Promise.allSettled` 容错合并；rate 源提供真实 `rate_plan_id` 且 `can_subscribe` 默认 true
- `ChangeZonePlanResult{success, zone_id, requested_plan, previous_plan, unchanged, activation_pending, outcome_uncertain, warning, error, http_status}`

**顺序分配算法**（`createZonesWithPlan`，串行 for 循环）

1. `POST /zones` 建区 → 读回套餐；已是目标套餐→success；已是付费套餐→409 不降级
2. `capacityFailure()`（正则匹配 400/403/409/422 + quota/capacity/slots 关键词）命中才置 `capacityExhausted`；置位后**后续域名自动走 Free 并标 `fallback`**
3. 调 `changeZonePlan`：`free→付费` 用 `POST /zones/{id}/subscription`，其他用 `PUT`；body `{rate_plan:{id: rate_plan_id||plan}, frequency?}`
4. `confirm([0,250,750])` 纯读确认，**绝不重复写**；不匹配→`activation_pending=true`
5. `outcome_uncertain`（network/timeout/5xx）先读回确认，读到目标套餐则翻转为 success
6. **单域名失败不中断整批**，返回新增 `pending_count`

**端点**：`GET /dns/domains/:domain/plans`、`PATCH /dns/domains/:domain/plan`（两端同路径）；demo 账户 403；审计动作 `change_zone_plan`。

**前端**：`ZonePlanDialog.vue`(+171) 打开时 `runBatch` 并发拉每 Zone 套餐选项，用 `processedZones` Set 保证同一远端 Zone 只提交一次（跨凭证别名去重）；状态 `ready/running/success/pending/failed/uncertain/skipped`。`ZoneDeleteDialog.vue`(+97) 批量删 Zone，逐行 `ready/success/failed/uncertain`，删除失败不回滚列表。

**账户标签统一**：`frontend/src/utils/dnsAccountLabel.ts` 输出格式 **`{账户名}｜{凭证名}`**（全角竖线），凭证名取不到时回落 `Credential #id`。域名搜索框改 `textarea` + `:autosize="{minRows:1,maxRows:4}"` 支持多行粘贴。

---

## 六、性能基建与 Zone/Storage 优化（`43567701` + `79978a9a` + `033370e2`）

### `shared/readScheduler.ts` —— 调度器

`ReadScheduler(metric, limit=6, perAccount=2, timeoutMs=30000)`
- 全局并发 **6**，同账号 **2**，后台任务上限 `min(2, limit)`
- `drain()` 每次按 `background` 升序排序，**前台任务可提权插队**
- Singleflight：`Flight{promise, controller, consumers}`；**一个消费者 abort 只 `consumers--`，归零才中止真实请求**（`read_merged`）
- 取消记 `read_cancelled`、超时记 `read_timeout`；`flights.delete` 前做 `=== current` 校验，防删掉新一代 flight

### `shared/zoneDirectory.ts` —— Zone 目录

`ZoneDirectory(metric, freshMs=30000, staleMs=300000, capacity=500)`
- 三态：`fresh`(<30s) / `stale`(<300s，立即返回旧快照 + 后台 `waitUntil` 刷新) / `miss`；`refresh:true` 强制
- `bindingSignature()`：对 `account_id, credential_id, updated_at, auth_type, api_token, api_key, email, proxy_enabled, proxy_url` 做 SHA-256 指纹，**隔离身份与凭证**
- `recordPageQuery` 校验 page 1–1000、perPage 1–500、type `^[A-Z0-9]+$`、search ≤256
- `invalidate(accountId, cfAccountId)` 用 `revision/epoch` 生成 fence，阻止迟到填充写回

### `shared/resourceCache.ts` —— 边界缓存

`BoundReadCache(directory, metric, freshMs=30000, staleMs=180000, capacity=500, maxBytes=8MiB)`
- `read()` 返回 `structuredClone` 副本；SWR 在 `staleMs` 内返回旧值并后台刷新
- `revision` 全局代号实现 **generation 失效**且不清除无关条目
- `put()` 按 `JSON.stringify(value).length*2` 计量，单条超 `maxBytes` 直接不缓存；LRU 双重上限

### `shared/workerResources.ts` —— Workers/Pages 读取

`WorkerResources(directory, metric, listMs=30000, usageMs=120000, maxBytes=8MiB)`
- Workers `/workers/scripts` 是 **SinglePage 接口，只读一次**；Pages 逐页最多 1000 页
- 用量：单次 GraphQL，`workersInvocationsAdaptive limit:10000`、`pagesFunctionsInvocationsAdaptiveGroups limit:1`
- 缓存键含 `signature:usage:YYYY-MM-DD`（UTC 日期隔离），失效时保留用量
- 负缓存：失败 **5s**；**429 冷却 300s**（显式 refresh 也不绕过）
- 条目上限 1500 + 8MiB

**前端**：dnsStore 窗口化读取（`recordMode('all'|'page')`、`pageCache` 60 个 500 条窗口 / 30s、首屏 `page=1,perPage=500`、`total_count` 不可信即报错）；workerStore 改 `shallowRef` + 按账号 flights 去重（缓存 60 账号 / 8MiB / 30s、当前账号前台优先 + 最多 2 个后台渐进补齐）。

### Zone 设置快照与精确写入

- bulk GET 仅在 404/405/410/501 或 `CF_INVALID_RESPONSE` 时降级为逐项 GET（**403/429/网络错不算停用**），降级能力按 `bindingSignature:zoneId` 记忆 **300000ms**
- `writeZoneSettings(request, zoneId, changes, baseline, onProgress)` **只提交差异**：与 baseline 相同→`unchanged` 不发请求（**空保存 = 0 次上游调用**）
- 预检逐字段读；值相同→`unchanged`，`!editable`→`unavailable`，远端偏离 baseline→`conflict`；**存在任一 conflict 则整批停止**（`conflictDetection:'non-atomic'`）
- 写入 PATCH → GET 确认；失败/5xx/timeout → `uncertain` 且**不重发**
- `FieldStatus = updated|unchanged|unavailable|failed|uncertain|conflict`
- 按 `cfAccountId:zoneId` 加锁，并发保存抛 409 `SETTINGS_SAVE_PENDING`；`finally` 必失效快照
- SSE 阶段 `checking→saving→confirming→done`，断流被吞掉但不触发重试

### Storage / D1

`StorageResources` 内置 `BoundReadCache(directory, metric, 30000, 30000, capacity=300, 8MiB)`（fresh=stale=30s）。
- `pageOptions`：limit 1–1000（默认 100）、prefix/cursor/delimiter ≤4096 字符、delimiter 仅 1 字符；KV 用 `limit`、R2 用 `per_page`（默认 `delimiter='/'`）
- **`is_truncated=true` 必须有推进的 cursor**（等于 previous 或缺失即报错）；空页不终止
- `allBuckets` 每页 limit=1000、最多 1000 页、cursor 去重

**D1 安全阈值**（`shared/d1SqlPolicy.ts` + `shared/d1Resources.ts`）

| 项 | 阈值 / 规则 |
|---|---|
| SQL 长度 | ≤ 100,000 UTF-8 字节，禁 `\0` |
| 多语句 | **禁止**（去掉尾分号后仍含 `;` 即拒绝） |
| 事务控制 | 禁 ATTACH / BEGIN / COMMIT |
| 函数黑名单 | `LOAD_EXTENSION` / `WRITEFILE` / `READFILE` / `EVAL` / `FTS3_TOKENIZER` 及非白名单 `PRAGMA_*` 表值函数 |
| PRAGMA 白名单（只读 14 项） | TABLE_INFO/XINFO、TABLE_LIST、INDEX_*、FOREIGN_KEY_LIST、DATABASE_LIST、COMPILE_OPTIONS、SCHEMA_VERSION、PAGE_COUNT、FREELIST_COUNT、QUICK_CHECK、INTEGRITY_CHECK |
| PRAGMA 白名单（写 4 项） | FOREIGN_KEYS / DEFER_FOREIGN_KEYS / RECURSIVE_TRIGGERS / OPTIMIZE |
| EXPLAIN | 仅允许读查询且不能包 PRAGMA；CTE 体必须只读 |
| 写授权 | 必须 `allowWrite === true`（字符串 `'true'` 与数字 1 均拒绝）；demo 库只读 403 |
| 归属校验 | 写前实时 GET 校验 `uuid/id`，不符 → 409 `D1_OWNERSHIP_MISMATCH` |
| 参数 | ≤ 100 个标量（string/number/boolean/null），JSON ≤ 2 MiB |
| 结果截断 | **1000 行 / 4 MiB**，置 `result_truncated`；上游 `maxResponseBytes: 4MiB`、`retry:false` |
| 表分页 | 1–200/页（UI 100），`LIMIT limit+1` 探测 has_more；keyset 游标 ≤ 32,000 字符，带 schema hash（不匹配 → 409 `D1_CURSOR_MISMATCH`） |
| 缓存 | 元数据 30s；**查询结果永不缓存**（`cache.uncached`） |

### 实测性能数据

> 均为本地合成数据，非生产 P95（引自 fork 的 `docs/performance-*.json`）。

| 指标 | 优化前 | 优化后 |
|---|---|---|
| 60 账号缓存命中时 CF 调用数 | 182 | **0** |
| 5 并发冷摘要 | 900 | **180（−80%）** |
| 当前账号可读延迟 | 78.86ms | **3.58ms** |
| DNS 10000 条首次返回行数 | 10000 | 500 |
| DNS 10000 条 CF 请求数 | 20 | **1** |
| DNS 首屏耗时 | 348ms | 117ms |
| Zone 快照复访（60 账号） | 60 次 / 23.51ms | **0 次 / 2.00ms** |
| 无变化保存设置的上游 GET | 2 | **0** |
| 10000 KV Keys 可见序列化 | 617,782 B | **124,002 B** |

**如实记录的代价**：全账号统计 P50/P95 **75.12/85.52 → 272.50/274.25ms（变慢）**；Zone 冷读 23.98 → 29.83ms；D1 冷全账号 6.08 → 62.73ms（受控调度换取）。

---

## 七、Pages / Workers 列表分页（`7a317de4`）

### 根因实测数据

fork 的 `docs/pages-pagination-v2.8.2.md` 记录了真实 Cloudflare 响应：

> Pages 不传分页大小或仅传 `page=1` 成功返回 10 条；`per_page=20/25/100` **均返回 HTTP 400 / Code 8000024**。第一页 `result_info` 为 `{page:1, per_page:10, count:10, total_count:20, total_pages:2}`。

**该 400 是 fork 自己在 v2.8.1 引入的**（当时固定 `per_page=100`），v2.8.2 改为只传 `page=N` 修复。上游主干当前**不传 `per_page`，因此没有这个 400 问题**。

### 完整性校验规则（值得移植的部分）

`invalid()` → 502 `Incomplete or inconsistent Pages pagination`：
- `success !== false`、`errors` 为空、`Array.isArray(result)`
- `result_info` 的 `page / per_page / count / total_pages / total_count` 全部 `Number.isSafeInteger`
- `reportedPage === page`、`perPage > 0`、`count === result.length`
- `totalPages <= 1000`、`totalPages === ceil(totalCount / perPage)`
- `count === min(perPage, max(0, totalCount - (page-1) * perPage))`
- 跨页 `total_pages / total_count / per_page` 必须一致；`name` 非空且唯一、`id` 唯一
- 收尾校验 `rows.length === totalCount`；循环上限 1000 页
- **零资源仅在 `page===1 && count===0 && total_pages<=1` 时成功**（兼容 0/1）

**降级**：第二页失败则整批抛错，Pages 计数保持 `null`、`states.pages='error'/'timeout'`，**不缓存部分结果**；已成功的 Workers 结果保留。
**负缓存**：普通错误 5s；显式 `refresh` 绕过普通失败缓存，但 **429 冷却（300s）仍生效**。

### 主干现状（已复核）

- `backend/src/services/workerService.ts:61-69`、`backend/src/services/pagesService.ts:33-42` 使用 cloudflare SDK 的 `for await (... .list())`，**自动翻页，完整**
- `worker/src/routes/workers.ts:42-50` 使用 `cfFetch('/accounts/<id>/workers/scripts')` 与 `/pages/projects`，**只取单页 `result`，从不翻页**

> **结论**：账户有 20 个 Pages 项目时，Worker 部署版 UI 只显示 10 个，**静默丢失一半且无报错**；Docker 版正常。这是主干真实存在的 bug，也是双后端对称性被破坏之处。

---

## 八、Tunnel 与规则集安全加固（`c7beed92`，+1929 −855）

### `shared/tunnelConfig.ts`

- `canonical()` 键排序 JSON 比较；`snapshot()` 用 `structuredClone` **整份保留** config（`originRequest`、`warp-routing`、未知字段全留）+ `version/source/fetchedAt`
- `validateConfig(v, allowEmpty)`：ingress 限 1–1000 条（读允许显式空）、≤1 MiB、catch-all 必须且仅在末位
- `assertBaseline()`：缺基线 → `BASELINE_REQUIRED`；不一致 → 409 `CONFIG_CONFLICT`
- `editIngress()`：**仅删除被清空的 hostname/path**；service 必更新
- `segment()` 限 `^[a-z\d_-]{1,128}$`

### `shared/tunnelResources.ts`

`new BoundReadCache(directory, metric, 30000, 30000, 200)`；`readConfig` 走 `cache.uncached`（**配置与 Token 不缓存**）。
`save()`：`validate → detail()`（校验 id、`deleted_at`、`account_id`、`config_src==='cloudflare'||remote_config`）→ 读基线 → `assertBaseline` → PUT（**`retry:false`**）→ 读回 `canonical` 比对 → `success/partial/unknown` + `recovered`；`uncertain()` = statusCode ≥500 或 408。

### 一键回源（`hostnames()` 默认**零 Zone 扫描**，标 `dns:'unverified'`）

- 校验 mode / hostname 正则 / port 1–65535 / protocol `http|https|tcp` / path ≤2048
- `liveAccountZone()` 实时归属（`ZONE_NOT_FOUND` / `ZONE_OWNERSHIP_MISMATCH`）
- create 模式先查同名 Tunnel → `TUNNEL_EXISTS`；reuse 模式 `detail()` + `readConfig`
- `dns_records?name.exact=` 扫 A/AAAA/CNAME 冲突 → `CNAME_CONFLICT` / `INGRESS_CONFLICT`
- **每次写前再查一次归属与 DNS**；最后读配置 + DNS 双确认
- `verify=true` 才精确查 `type=CNAME&name.exact&content.exact` → `confirmed/missing/unknown` + `complete`

**补偿语义（核心思想）**：`unknown` → **不重发、不删任何依赖**，返回 `residuals:["Tunnel <id>","CNAME <id>","Configuration <id>"]`；明确拒绝才删 CNAME（先重核身份、删后 404 确认），且仅当 `residuals` 为空才删新建 Tunnel，**复用 Tunnel 永不删除**；`exclusive()` 键 `wizard:<account>:<hostname>` → 409 `OPERATION_BUSY`。

### `shared/rulesResources.ts`

- `phaseActions` 白名单（10 个 phase 的合法 action）；仅 `http_request_redirect` 为 Account 级（`kind:'root'`，`/accounts/{id}/rulesets`），其余 Zone 级
- Single Redirect 用 `http_request_dynamic_redirect` + `from_value`（Zone）；Bulk Redirect 的 `redirect` 强制 `from_list{name,key}`
- 写入校验：未知 phase → `INVALID_PHASE`；账户禁用/未绑定 → 409 `BAD_ACCOUNT`；Zone 范围先 `liveAccountZone`
- `expression` 1–10000 字符、action 必在白名单、`action_parameters/ratelimit` 必为对象
- 规则不存在 → 404；缺 baseline → `BASELINE_REQUIRED`；`canonical(old) !== canonical(baseline)` → 409 `RULE_CONFLICT`
- **白名单外未知顶层字段 → 409 `UNSAFE_RULE`**（只允许 `action/action_parameters/description/enabled/expression/logging/ratelimit/ref/exposed_credential_check` + `id/version/last_updated/categories`）
- `uncertain(error)` 才吞异常，其余抛出；写入一律 `retry:false`；`finally` 失效真实 scope 缓存
- 写后读回确认：create 用「新 ID 差集 + 内容匹配」、update 用 ruleId 匹配、delete 用「不存在」
- **读路径绝不创建 Ruleset**；managed 类型忽略；多入口 → `AMBIGUOUS_RULESET`

**新增 Account 独立路径**：`/api/tunnels/accounts/:id/rules/:phase[/:ruleId]`，非 account phase → `INVALID_SCOPE` 400。

---

## 九、域名批量 SSL/TLS 与缓存清除（`0ea99c96`）

- `ZoneBatchSettingsDialog.vue`(+176)：props `show / mode('ssl'|'purge') / targets`，emit `completed(zoneIds)`
- 仅 4 个字段：`ssl`(off/flexible/full/strict)、`always_use_https`、`automatic_https_rewrites`(on/off)、`security_level`(off…under_attack)，默认 `null` = 保持不变，**只提交显式选择项**
- `canExecute` 要求至少 1 行 ready 且（purge 或 ≥1 字段被选）；行状态 8 态 `ready/running/success/unchanged/partial/failed/uncertain/skipped`；执行中禁关闭、完成后不可重提；并发上限 **3**
- `frontend/src/utils/zoneOperations.ts`：`zoneOperationRows()` 按**真实 zoneId** 去重；`zoneOperationError()` 无 status 或 ≥500 → `uncertain`，其余 → `failed`；`runZoneOperations()` 只提交 ready 行，失败不阻塞后续
- `shared/zoneSettingsEvents.ts`(+14)：`FieldStatus`、`ZoneSettingsSnapshot`（`__meta[key]={editable,state,reason,modifiedOn}`）、`ZoneSettingsResult{updated,failed,errors,fields,settings,patchCount,conflictDetection:'non-atomic'}`
- **无新端点**，复用双端 `PATCH /api/dns/domains/:domain/settings`（体 `{changes, baseline}`，SSE）与 `POST /api/dns/domains/:domain/purge-cache`（体严格 `{purge_everything:true}`，须有非空回执 `data.id`）

---

## 十、UI 修复（易被低估的高价值项）

**浮层错位根因**：`frontend/src/style.css` 中 `@media (prefers-reduced-motion: reduce)` 的通配规则含 `transform: none !important`，把 Naive UI / vueuc `Follower` 的内联 `translateX/Y` 定位坐标清零 → Select / Dropdown / Popover 跑到左上角。
**修复**：仅删除该行，保留 animation / transition / scroll-behavior 的无障碍设置。

**滚动根因**：`.n-card__content` 在 Naive UI 2.44 已不命中实际内容节点。
**修复**：改用 Card 公开 `content-class="dns-list-content"` / `"dns-detail-content"`，CSS 改 `:deep(.dns-list-content)` 并加 `overflow: hidden`；新增独立滚动容器 `.dns-zone-list`（`flex:1; min-height:0; overflow-y:auto`，支持键盘 PageDown）；新增 `@media (max-width:1023px)` 断点使左右面板各自限高；批量工具栏从 `#header-extra` 移到卡片内 `.dns-zone-actions`（`flex-shrink:0`）。同类修复同步到 `StorageView.vue` / `StoreView.vue`。

---

## 十一、值得借鉴的工程手法

1. **`shared/` 作为唯一真实来源** + `sync-shared.js` 多目标同步（frontend / backend / worker 三方）
2. **契约测试复用**：`shared/tests/*.contract.ts` 一套 harness 双端跑；用自写 `d1Adapter` 让 worker 代码在 better-sqlite3 上运行
3. **离线 Playwright 回归**：`scripts/test-*.mjs` 在**禁网只读容器**中验证真实构建产物
4. **四个一致性原语贯穿全部改动**：`fingerprint` / `bindingSignature` / `revision` fence / `canonical` JSON
5. **性能基线 JSON 入库**，且**连"变慢"也如实记录**
6. **失败语义细分**：`unchanged / unavailable / conflict / uncertain` 严格区分，禁止把残缺结果当成功

---

## 十二、移植路线建议

| 优先级 | 内容 | 难度 | 理由与依赖 |
|---|---|---|---|
| **P0** | Worker 端 Pages/Workers 列表分页 | 低 | 主干真实数据丢失 bug；只需分页循环 + 不传 `per_page` + 完整性校验 |
| **P0** | `style.css` 删除 `transform: none` | 极低 | 一行修复全局浮层错位，无依赖 |
| **P1** | 写入范式：`retry:false` + 读回确认 + 不重发/不删依赖 + `uncertain` 语义 | 中 | 防误删、防重复写，可跨模块移植 |
| **P1** | D1 只读默认 + SQL 策略 + 结果截断 | 中 | 安全收紧；注意会让现有 D1 写路径行为变化 |
| **P1** | DNS 批量操作 / 批量 SSL+purge / 套餐管理 | 中 | 用户可见价值最高；需先打通 `shared/` 同步机制、`dns_batch_executions` 双端迁移、SSE |
| **P2** | `ReadScheduler` + `BoundReadCache` + `bindingSignature` | 中高 | 上述性能功能的地基，建议在批量功能之前先行移植 |
| **P2** | Tunnel / 规则集安全加固 | 中高 | 价值高但是破坏性契约（fail closed），前后端须同版本升级 |
| **P3** | 多账户凭证体系 | 高 | 数据模型 + 迁移 + API 契约全变，建议独立立项 |

### 推进原则

1. **先摘结论与原语，后摘功能**。分页校验、一行 CSS、`retry:false` + 读回确认、`canonical`/`fingerprint` 都是低风险高收益；批量与性能功能依赖 `shared/` 地基。
2. **移植方式以 hunk 摘取为主**，避免整文件覆盖 —— `DnsView.vue` 改动达 +430 行，整文件覆盖会吞掉主干既有演进。
3. **重新验证已修复的问题**。该 fork 出现过 `per_page` 导致 400 的自我回归，说明部分"修复"针对自身引入的问题；每项移植都应在真实 CF 响应下确认。
4. **双端对称性优先于单端功能**。凡涉及 `shared/` 的改动，必须通过 `scripts/sync-shared.js` 同步 backend 与 worker，并由 `ci.yml` 的 `schema-check` 校验双端表结构一致。

---

## 十三、v2.10.0 – v2.10.2 补充（2026-10-27 复核）

> 原文档覆盖到 `c7beed92`（v2.9.0）。此后该 fork 又推进 3 个提交，总计 14 个提交、413 个文件、+28,575 −6,883，版本到 **v2.10.2**，落后上游 2 个提交。

### 提交与主题

| SHA | 版本 | 主题 | 规模 |
|---|---|---|---|
| `b146cf81` | 2.10.0 | 综合总览 + 独立审计中心 + 公共账号查询 `/accounts/options` + Catalog 抓取加固 | 30+ 文件 |
| `dd0e3a31` | 2.10.1 | 后台持久化资源扫描（任务表 / 租约 / 增量补齐）+ Dashboard 与审计页滚动容器 | 30+ 文件（含 `package-lock`） |
| `12d149a9` | 2.10.2 | 快照一致性（`inventory:v2` 身份）+ 用量统计口径 + 首页六卡片布局重整 | 20+ 文件 |

### 新增能力要点

1. **持久化资源目录（`resource_summaries`，SQLite/D1 0013）**
   Dashboard 只读服务端持久化的数量，不再依赖进程缓存 / 浏览器状态 / 短期 API TTL；`inventory:v2` 身份把「名称、检测时间、`updated_at`」从身份里剔除，避免无意义失效；凭证/绑定/代理变化仍隔离迟到结果。**这条对我们有直接价值**——主干 Dashboard 每次进入都要重新全量拉 CF 资源。

2. **后台扫描执行器（0014 / 0015）**
   任务表 + 每项状态 + 冷却 + 租约 + dirty 范围；Docker 在 `listen` 后延迟启动执行器，支持每日校准与 UTC 时间窗；浏览器关闭不取消任务，异常退出后租约到期恢复；Pages 侧用 D1 + `waitUntil` 有界批次（1 项 / 20 秒 / 35 次上游请求）控制预算。

3. **`/api/accounts/options`**
   轻量账号选择器接口：按 `feature` 过滤、返回安全身份版本，各页面复用 30 秒内存缓存 + Singleflight，账号/凭证变更与登出时清理。主干当前各页面各自拉完整账号列表，这是可独立采用的小优化。

4. **Catalog 抓取加固**
   逐跳 SSRF 校验、8 秒超时、5 MiB 流式上限、Singleflight、3 并发、空目录有效缓存、正确 ETag/304、失败保留成功快照。可与主干的 `ssrfGuard` 对照，检查是否已覆盖「逐跳重定向校验」与「流式体积上限」。

5. **审计日志独立页 + 游标分页**
   稳定 `created_at/id` 游标、并发新增锚点、组合筛选与共享统计、详情字段白名单脱敏、旧数组接口兼容。主干目前只有 `GET /api/audit` 列表，没有独立页面。

6. **滚动容器范式（与第十节的 CSS 修复同源）**
   Dashboard / Audit 建「受限高度容器 + Grid 收缩关系」，移动端仍由 `mobile-layout` 滚动；页面聚焦时 `Home`/`End` 跳到两端。与主干 `#66`（DNS 列表无法滚动）是同一类问题的完整解法。

7. **迁移分号切分器修复**
   修复 D1 迁移脚本对 `trigger BEGIN/CASE/END` 的分号切分 —— 我们 `worker/scripts/migrate.mjs` 若将来引入含 `BEGIN...END` 的迁移（触发器/复杂 DDL）会踩同一个坑，值得先补测试。

### 移植评估（增量部分）

| 优先级 | 内容 | 难度 | 理由 |
|---|---|---|---|
| **P0** | 迁移分号切分器对 `BEGIN/CASE/END` 的处理 | 低 | 纯工具链修复，不改业务；先补测试再对齐实现 |
| **P0** | `/api/accounts/options` + 30 秒缓存 + Singleflight | 低 | 明显减少页面首屏请求体积，双端对称工作量小 |
| **P1** | `resource_summaries` 持久化目录 + 快照一致性语义 | 高 | 需要新增表、双端迁移、后台执行器；与主干 Dashboard 现状差异大，建议独立立项 |
| **P1** | 审计日志游标分页 + 独立页面 | 中 | 主干无游标分页，改动集中在 `models/auditLog` + 新页面 |
| **P2** | Catalog 抓取加固（逐跳 SSRF / 流式上限 / ETag） | 中 | 先与 `ssrfGuard` 现有实现逐条比对，只补缺口 |
| **P2** | 滚动容器范式 | 低 | 与第十节 CSS 修复一起做，避免重复踩坑 |

> 提醒：该 fork 的这些版本大量依赖它自己在 v2.7–v2.9 建的 `shared/` 地基（`ReadScheduler`、`resourceCache`、`bindingSignature`），**无法单独摘取**；P0 两项是本批里唯一「零依赖可直接落」的。

---

## 附：关联文档

- [账户认证方式说明](account-auth.md)
- [部署文档](deploy.md)
- [API 接口文档](api-v1.md)
- [FLuoXue fork 调研](fork-review-fluoxue.md)
- [xuexu fork 调研](fork-review-xuexu.md)
- [58cdn fork 调研](fork-review-58cdn.md)
- [zuodazuoqiang001 fork 调研](fork-review-zuodazuoqiang001.md)
