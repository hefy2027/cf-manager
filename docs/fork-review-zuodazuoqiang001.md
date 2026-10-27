# 第三方 fork 功能调研：zuodazuoqiang001/cf-manager

> 整理社区 fork `zuodazuoqiang001/cf-manager` 相对上游 `hefy2027/cf-manager` 的差异，并评估其中可借鉴的设计。
>
> 调研日期：2026-10-27。对比基线：上游 `master` @ `2d09c51`（PR #63）。

---

## 一、概述：这是一个「历史被重写」的 fork

| 项 | 值 |
|---|---|
| 调研对象 | `zuodazuoqiang001/cf-manager`（`master` 分支） |
| 分支提交总数 | **83**（根提交 `94b11cb`，2026-06-13） |
| 时间跨度 | 2026-06-13 → 2026-08-28（最后提交 `8c924f4`） |
| 与上游关系 | **无共同祖先**（`git merge-base` 失败，`exit=1`） |
| 文件级差异 | 282 个文件，+48,116 −10,342 |

**关键判断**：该仓库不是「在上游基础上增量开发」，而是把一份 2026-06 中旬的代码**重新初始化并重写了全部历史**（根提交即 `feat(accounts): 添加账户管理和AI推理功能`）。因此：

- ❌ **无法 cherry-pick**，也没有可用的 `merge-base` 做三方对比；
- ✅ 只能按「**设计参考**」阅读：它独立解决的几个问题在上游至今仍缺失；
- ⚠️ 代码基线落后约 4 个月，`openai.ts` / `aiService.ts` / `proxyService.ts` 与当前上游已是两套实现（单次提交 `5c3790b` 就重写 `openai.ts` 945 行）。

---

## 二、三个上游至今仍缺失的能力（值得看设计，不建议照搬代码）

### 1. `POST /v1/responses`——让 Codex CLI 能用（`43fa315`，+586）

**动机**：Codex CLI 强制 `wire_api = "responses"`，而 Cloudflare Workers AI 大多只提供 `/v1/chat/completions`，需要网关做格式转换。

**实现**：新增 `backend/src/services/responsesAdapter.ts`（478 行），导出三个函数：

| 函数 | 作用 |
|---|---|
| `convertResponsesRequest(body)` | Responses 请求 → Chat Completions 请求：`instructions` → `system` message；`input` 数组里的 message / `function_call` / `function_call_output` → assistant `tool_calls` + `tool` message；`input` 为字符串时包装成单条 user message |
| `convertChatCompletionToResponse()` | 非流式：Chat Completions → Responses 对象（含 `output` items 与 `usage`） |
| `convertStreamToResponsesSSE()` | 流式：把 Chat 的 `data: {delta}` 重新编码为 Responses 的事件序列 |

SSE 事件序列（实测顺序，Codex CLI 依赖）：

```text
response.created
response.in_progress
response.output_item.added
response.content_part.added
response.output_text.delta   × N
response.output_text.done
response.content_part.done
response.output_item.done
response.completed
```

路由侧（`router.post('/responses')`）额外做两件事：`req.body.model` 为空时用 API Key 的 `default_model` 兜底；失败时按 `getAccountsByPriority('ai_neurons')` 顺序切账号重试。

**上游对照**：主干 `openai.ts` 仅有 `chat/completions`、`images/generations`、`audio/speech`、`audio/transcriptions`、`translations`、`embeddings` 六个端点，**确认无 `/v1/responses`**。

**移植要点**：适配器逻辑与架构无关，可直接抄设计；但收敛点要换成上游的 `selectBestAccount` / `quotaTracker` 记账链路，不要照搬它的 `getAccountsByPriority`。

---

### 2. API Key 管理 + 多 key 调度（`b138547`，+731）

上游目前只有**单一** `API_SECRET`（`authMiddleware`），所有调用方共用。该 fork 引入完整的多 key 体系：

| 层 | 实现 |
|---|---|
| 表 | `api_keys(id, name, key_prefix, key_hash UNIQUE, default_model, is_active, created_at, updated_at, last_used_at)`；`api_key_usage(api_key_id, date, account_id, model, requests, total_tokens)`，`UNIQUE(api_key_id, date, account_id, model)` |
| 生成 | `sk-cf-` + 24 字节 `base64url`；**只存 sha256**，明文仅创建时返回一次；展示用 `sk-cf-xxxxx...xxxx` 前缀掩码 |
| 鉴权 | 新增 `middleware/v1Auth.ts`，`findApiKeyByRaw()` → `req.apiKey`，`touchLastUsed()` 不做阻塞 |
| 前端 | `ApiKeysView.vue`（331 行）：列表 / 创建（一次性显示明文）/ 启停 / 删除 / 用量统计 |
| 收益 | 可按 key 设 `default_model`、按 key 统计 token、失效单个 key 而不影响其他人 |

**上游对照**：`worker/src/db/schema.sql` 与 `backend/src/db.ts` 中**均无 `api_keys` 表**，`openai.ts` 无任何 api key 逻辑。

**注意**：该实现只做了 backend，worker 端完全没有对应实现（`v1Auth` 在 Hono 侧不存在），移植时双端工作量 ×2，且 `workers` 运行时不能用 `crypto.createHash` 之外的 Node API——Hono 侧要用 `crypto.subtle.digest` 重写哈希。

---

### 3. 调用日志落库 + 流式 token 记账（`78a5e20` + `8c924f4`）

| 项 | 实现 |
|---|---|
| 表 | `ai_call_logs`（模型、账号、状态、耗时、输入/输出 token、错误信息） |
| 写入 | **异步**（不阻塞响应），并在 Docker 侧挂了数据卷保证持久化 |
| 前端 | `AiCallLogsView.vue`（182 行）+ 管理端「清理日志」 |
| 流式记账 | `8c924f4` 在 SSE 结束时从 `usage` 或累计 delta 中补齐 input/output tokens，写入日志与配额 |

**上游对照**：主干的 `v1Logger` / `apiLogger` 只是**请求日志中间件**（写文件 / console），不落库、无前端页面；配额记账在 `quotaTracker` 里（按 Neurons 估算）。两者互补——若要把「每个 key / 每个账号的 token 账」做成可查询，这套结构可作模板。

---

## 三、不建议借鉴的部分

| 内容 | 原因 |
|---|---|
| `40829fa` 删除每次请求的 Cloudflare GraphQL 额度查询，改为**纯 round-robin** | 上游 `selectBestAccount` 已是有缓存、按剩余额度加权的实现；退化到纯轮询会更快撞上「某账号当日耗尽」 |
| `5c3790b` 对 `openai.ts` / `aiService.ts` / `proxyService.ts` 的大规模重写（合计 ±3000 行） | 与上游现状已是两套实现，无法对齐；其中多数诉求（Qwen 流式、超时）上游已独立处理 |
| `api_keys` 表的具体字段设计 | 缺少 `expires_at`、`rate_limit`、`allowed_models`，若要做建议重新设计 |
| 无 worker 端对称实现 | 违反本仓库「双后端对称」约定，不能作为整体方案 |

---

## 四、落地建议

| 需求 | 建议做法 | 参考来源 |
|---|---|---|
| 支持 Codex CLI | 新写 `shared/responsesAdapter.ts`（放 shared 以便双端复用）；worker 端由 `openai.ts` 内联调用 | `43fa315` 的转换规则与 SSE 事件序列 |
| 多租户 / 多 Key | 独立立项：新增 `api_keys` + 用量表、双端迁移、Hono 侧哈希用 `crypto.subtle` | `b138547` 的「只存 hash + 一次性明文」 |
| 可查询的调用账本 | 在现有 `v1Logger` 基础上加可选落库开关，避免默认写库带来的 D1 成本 | `78a5e20` 的异步写入 + 清理入口 |

### 复现命令

```bash
git fetch --no-tags https://github.com/zuodazuoqiang001/cf-manager.git \
  '+refs/heads/master:refs/remotes/fk/zuodazuoqiang001/master'
git merge-base origin/master fk/zuodazuoqiang001/master   # 预期失败：无共同祖先
git show 43fa315:backend/src/services/responsesAdapter.ts | head -60
git show b138547:backend/src/models/apiKey.ts
```

---

## 附：关联文档

- [FLuoXue fork 调研](fork-review-fluoxue.md)
- [xuexu fork 调研](fork-review-xuexu.md)
- [58cdn fork 调研](fork-review-58cdn.md)
- [Heisenberg2024 fork 调研](fork-review-heisenberg2024.md)
- [API 接口文档](api-v1.md)
