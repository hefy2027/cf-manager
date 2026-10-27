# 第三方 fork 功能调研：FLuoXue/cf-manager

> 整理社区 fork `FLuoXue/cf-manager` 相对上游 `hefy2027/cf-manager` 的全部改动，并给出移植评估。
>
> 调研日期：2026-10-27。对比基线：上游 `master` @ `2d09c51`（PR #63）；该 fork 分叉点 `5742b36`（2026-09-29，PR #62），当前落后上游 2 个提交。

---

## 一、概述

| 项 | 值 |
|---|---|
| 调研对象 | `FLuoXue/cf-manager`（`master` 分支） |
| 领先上游 | **5 个提交**（落后 2 个） |
| 提交时间跨度 | 2026-09-05 → 2026-10-08 |
| 代码规模 | 23 个文件，+711 −121 |
| 版本推进 | v2.4.1 → **v2.5.1** |
| 核心增量 | `GET /api/pricing`（new-api 倍率同步）、`accounts.password` 字段回归、代理下 415 修复 |
| 结论 | 只有 `/api/pricing` 值得移植；`password` 是对上游决策的反向操作；415 修复与上游 `2ba4ddc` 重复 |

### 提交索引

| SHA | 日期 | 主题 | 规模 |
|---|---|---|---|
| `00f74ac` | 09-05 | 新增 `/api/pricing` 供 new-api 同步倍率 | 4 文件 +194 |
| `3bdfa95` | 10-02 | 恢复 `accounts.password` 并支持前端查看 | 12 文件 +112 −25 |
| `1f72504` | 10-02 | 发布 v2.5.0（仅 CHANGELOG） | 1 文件 +15 |
| `1e69e0e` | 10-08 | 修复代理下脚本/资源上传被 415 拒绝 | 7 文件 +390 −96 |
| `e32f1b8` | 10-08 | 修正 CHANGELOG 日期 | 1 文件 ±1 |

---

## 二、`GET /api/pricing`（`00f74ac`）

### 定位

**公开、无鉴权**的定价端点，把 `shared/model-pricing.json`（Cloudflare Neurons 计价）翻译成 **new-api / one-api 的模型倍率格式**，供第三方网关定时拉取，省去在 new-api 后台逐个模型手填倍率。

实现刻意挂载在 `authMiddleware` **之前**：

```ts
// backend/src/index.ts
import pricingRouter from './routes/pricing';
// Public pricing endpoint (no auth required) — used by new-api ratio sync
app.use('/api/pricing', pricingRouter);

app.use(authMiddleware);   // ← 之后才鉴权
```

```ts
// worker/src/index.ts
app.route('/api/pricing', pricingRouter);   // 同样在 app.use('/api/*', authMiddleware) 之前
```

双端各 93 行，逻辑完全对称，直接 `import pricingData from '../data/model-pricing.json'`（即 `shared/model-pricing.json` 的同步产物）。

### 换算公式

```text
1 Neuron             = $0.000011     (CF 基准 $0.011 / 1K Neurons)
new-api 1 ratio 单位  = $0.002 / 1K tokens
model_ratio       = neurons_per_1k × 0.000011 / 0.002 = neurons_per_1k × 0.0055
completion_ratio  = output_neurons / input_neurons
cache_ratio       = cachedInput_neurons / input_neurons
```

### 四类模型映射

| `model-pricing.json` 字段 | `quota_type` | 输出字段 |
|---|---|---|
| `input` / `output`（文本） | 0 | `model_ratio`、`completion_ratio`，有 `cachedInput` 时加 `cache_ratio` |
| `perImage`（图像） | 2 | `image_ratio = perImage × 0.0055` |
| `perKChar`（TTS） | 1 | `model_price = perKChar × 0.000011`（$/1K 字符） |
| `perAudioMinute`（ASR） | 1 | `model_price = perAudioMinute × 0.000011`（$/分钟） |

响应：

```json
{ "success": true, "data": [
  { "model_name": "@cf/meta/llama-3.2-1b-instruct", "quota_type": 0,
    "model_ratio": 0.013514, "completion_ratio": 7.428571, "model_price": 0 }
] }
```

自建 `{ success, data }` 与上游 `responseWrapper` 兼容（wrapper 检测到 `success` + `data` 会原样透传，不会二次包装）。

### 该实现的问题

1. **两个基准都写死**：`0.000011`（Neuron 单价）与 `$0.002/1K`（new-api ratio 基准）。new-api 侧改 `QuotaPerUnit` 后倍率会整体偏移，且 `NEURON_TO_RATIO` 与 `model-pricing.json` 的 Neuron 数值构成**两个真相源**。
2. **图像倍率必然失真**：`perImage` 本身已是按 tile×step 折算的固定值（JSON 里 `imageTileStepToPerImage` 有说明），实际随尺寸/步数浮动。
3. **TTS/ASR 用 `model_price` 表达“按字符/按分钟”并非 new-api 原生语义**（它没有对应字段），跨网关对账易偏差。
4. **无缓存/ETag/版本号**，每次全量返回；网关高频拉取无谓消耗。
5. **完全公开**：模型清单与价格对任何能访问域名的人可见。

### 移植建议

**建议移植**，但要按当前架构改造：

- 放到 `shared/` 作为共享实现是不合适的（涉及 Express/Hono 两种 Router），维持双端各一份 + `ci.yml` 结构对齐即可；
- 汇率基准提到 `shared/model-pricing.json` 的 `_pricingAssumptions`（或新增强制同步的常量文件），避免两份真相；
- 路径建议 `/api/public/pricing` 或保留 `/api/pricing` 但补 `ETag` + `Cache-Control: public, max-age=300`；
- 若不想公开，改为挂在 `authMiddleware` 之后并要求 `API_SECRET`，new-api 侧用自定义请求头携带。

---

## 三、`accounts.password` 字段回归（`3bdfa95`）

### 做了什么

| 层 | 改动 |
|---|---|
| 数据库 | backend 基础建表加回 `password TEXT`；**移除**上游 `0008_accounts_drop_password` 删列迁移；新增 `0011_accounts_password`（`ADD COLUMN password TEXT`）。worker 同步 `schema.sql` + `migrations/0011_accounts_password.sql`，删除 `0009_accounts_drop_password.sql` |
| 接口 | 双端对称：创建/编辑接受 `password`（非空才写入，AES-256-GCM 加密落库）；`GET /:id/credentials` 解密返回；列表接口以 `***encrypted***` 掩码 |
| CSV | 导出新增 `password` 列（明文，随「包含凭证」开关）；导入识别该列并加密入库 |
| 前端 | 新增/编辑弹窗加「登录密码」（可点击显示）；凭证弹窗加展示行；编辑时留空表示不修改；补中英文案 |

### 与上游冲突

上游在 v2.2.0 已**主动删除**该列，并在 `backend/src/db.ts` 与 `worker/src/db/migrations/0009_accounts_drop_password.sql` 保留删列迁移：

```text
// 移除从未在界面上使用的 accounts.password（登录密码）：旧库该列存在则删除
{ version: '0008_accounts_drop_password', ..., kind: 'drop', sql: "ALTER TABLE accounts DROP COLUMN password;" }
```

该 fork 的做法是「不执行该删列迁移，让旧库存量数据保留；列确实缺失时才补空列」。技术上成立，但方向与上游相反。

### 移植建议

**不建议移植**：

1. 上游删除它的原因是「界面从未使用 + 减少一处高价值凭证落库」，恢复等于把登录密码重新纳入本系统保管范围；
2. 一旦移植，`ci.yml` 的 `schema-check`（双端表列集合比对）会因删列迁移被移除而出现历史库与新库不一致；
3. 若确有「留备注」需求，正确做法是新增独立字段（如 `note` 或 `login_hint`），而不是复活一个语义为密码的列，也不该进 CSV 导出。

---

## 四、代理下 415 修复（`1e69e0e`）

### 根因分析（本文档最有价值的部分之一）

> 不走代理时由 undici 自动序列化 `FormData`；启用代理后 `proxyFetch` 改用 `node-fetch@2`，而 node-fetch v2 无法序列化 undici 的 `FormData` —— body 退化为字符串 `[object FormData]`、`Content-Type` 变成 `text/plain`，Cloudflare 直接返回 `415 code 10001`。

### 修法

新增通用 `backend/src/services/deploy/uploadForm.ts` 的 `buildMultipartBody()`，手工拼字节并显式声明 `Content-Type`，覆盖四条上传通道：legacy `workerService` 的脚本上传与 assets 桶上传、`deploy/assetsUpload.ts`、`deploy/pagesDeploy.ts`。

### 与上游对照

上游 `2ba4ddc`（fix(deploy): 统一手动构建 multipart 上传表单，修复代理下 CF 返回 415）已用同一思路解决，仓库内已有 `backend/src/services/deploy/uploadForm.ts`，**功能重复，无需移植**。

**唯一可借鉴项**：该 fork 补的回归测试

- `backend/tests/workerUploadForm.test.ts`（含经由 node-fetch 的传输层用例）
- `backend/tests/workerDeployUpload.test.ts`（驱动真实 `deployWorker`，断言代理通道下发的是 multipart `Buffer`）

当前上游虽然有 `uploadForm.ts`，但缺少「代理通道下 body 必须是 multipart」的断言型测试，建议挑选这两个文件的用例补进 `backend/tests/`。

---

## 五、结论

| 内容 | 判断 | 动作 |
|---|---|---|
| `GET /api/pricing` | ⭐ 值得移植 | 补 ETag / 缓存 / 基准常量化后再落 |
| 415 修复的测试用例 | ⭐ 值得借鉴 | 只取测试，不取实现 |
| `accounts.password` 回归 | ❌ 与上游决策相反 | 不做；如需备注另加字段 |
| `docs/admin-ui-plan.md`（主题规划） | ➖ 与本仓库无关 | 忽略 |

### 复现命令

```bash
git fetch --no-tags https://github.com/FLuoXue/cf-manager.git \
  '+refs/heads/*:refs/remotes/fk/FLuoXue/*'
git show fk/FLuoXue/master:backend/src/routes/pricing.ts
git diff 5742b36 fk/FLuoXue/master --stat
```

---

## 附：关联文档

- [账户认证方式说明](account-auth.md)
- [部署文档](deploy.md)
- [API 接口文档](api-v1.md)
- [Heisenberg2024 fork 调研](fork-review-heisenberg2024.md)
