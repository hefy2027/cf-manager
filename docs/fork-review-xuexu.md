# 第三方 fork 功能调研：xuexu/cf-manager

> 整理社区 fork `xuexu/cf-manager` 相对上游 `hefy2027/cf-manager` 的全部改动，并给出移植评估。
>
> 调研日期：2026-10-27。对比基线：上游 `master` @ `2d09c51`（PR #63）；该 fork 分叉点 `5742b36`（2026-09-29，PR #62），当前落后上游 2 个提交。

---

## 一、概述

| 项 | 值 |
|---|---|
| 调研对象 | `xuexu/cf-manager`（`master` 分支） |
| 领先上游 | **1 个提交**（落后 2 个） |
| 提交 | `e2da1e6`（2026-10-13） |
| 代码规模 | 7 个文件，+243 −14 |
| 内容 | 跨账户批量创建 KV/D1/R2 + 账户页 TXT 批量导入 |
| 结论 | **值得移植**，是本次盘点里性价比最高的功能增量；需补演示账户保护、并发与数量上限 |

> 该 fork 明确写道：「原 fork 中的批量部署（新建/覆盖）、Pages zip 前缀剥离、特殊文件名、responseWrapper 修复已由上游覆盖，不再重复迁移」——即它自己先做了一次上游差异裁剪，剩下的确实是净增量。

---

## 二、跨账户批量创建资源（`POST /api/storage/batch`）

### 接口契约

```ts
// body
{ type: 'kv' | 'd1' | 'r2', accounts: Array<{ accountId: number; name: string }> }

// 响应（经 responseWrapper 后为 { success: true, data: {...} }）
{
  results: Array<{ accountId: number; accountName: string; name: string; success: boolean; id?: string; error?: string }>,
  total: number, succeeded: number, failed: number
}
```

设计取舍：**同名资源逐个账号创建**，而不是「每个账号不同名」；`accounts[]` 里每项自带 `name`，便于后续扩展为不同名。前端当前传同一个名字给所有目标账号。

### 双端实现

| 端 | 文件 | 关键点 |
|---|---|---|
| Express | `backend/src/routes/storage.ts`（+55） | `getAccountById(accountId)` → 复用 `createKvNamespace` / `createD1Database` / `createR2Bucket`；每个账号一条审计日志 `kv_batch_create_ns` / `d1_batch_create_db` / `r2_batch_create_bucket` |
| Hono | `worker/src/routes/storage.ts`（+61） | 直接 `cfFetch()` 打 `/storage/kv/namespaces`、`/d1/database`、`/r2/buckets`；KV 额外 `kvListCache.delete(accountId)` 清缓存；`addAuditLog()` 双端字段对齐 |

两端都是 **`for` 串行 + 单账号 try/catch**，失败只记录进 `results`，不影响后续账号，整体始终 200。这是批量接口正确的错误模型（部分成功）。

### 前端

`frontend/src/views/StorageView.vue`（+73）：

- 创建资源弹窗（`openCreateModal`）增加 `type` 参数与「目标账号」多选（`n-select filterable multiple` + 全选/清空），默认选中当前账号；
- 新增「批量创建结果」弹窗：`total / succeeded / failed` 三个 `n-statistic` + 明细表（账号 / 资源名 / 结果标签 / 错误详情 tooltip）；
- `frontend/src/api/storage.ts` 增加 `storageApi.batchCreate()`；
- i18n 中英文各 +14 条。

### 审查意见（移植时必须处理）

1. **演示账户保护被绕过（两端都有）**
   - backend `storage.ts` 顶部 `router.use(demoDestructiveGuard)`，但该中间件只读 `req.params.accountId`：
     ```36:48:backend/src/routes/routeUtils.ts
     const accountId = parseInt(req.params.accountId as string, 10);
     ```
     `/batch` 的账号在 body 里 → `accountId` 为 `NaN` → 直接放行；
   - worker 端 `app.use('/:accountId/*', demoDestructiveGuard())`，`/batch` 不匹配该前缀；即便匹配，guard 内部也是 `parseInt(c.req.param('accountId'))` → `NaN` → 放行。
   - 结果：演示模式下可以给演示账号批量创建 KV/D1/R2。**移植时必须在路由内自行校验 `isDemoAccountId()`**，或把 guard 改为同时解析 body。
2. **串行无并发**：N 个账号 = N 次串行 CF 请求，50 个账号可能超过网关/浏览器超时。建议 `Promise.allSettled` + 并发上限（上游 `quotaTracker`/`catalogDeploy` 里已有类似限流写法可复用）。
3. **无数量上限**：`accounts` 未限制长度，缺少 `MAX_BATCH = 20` 之类的护栏。
4. **审计日志只记成功**：失败分支没有 `addAuditLog(..., 'failed')`，事后无法追溯。另外 backend 端 `createAuditLog(account.id, ..., 'success')` 的实参与 worker `addAuditLog(db, {...})` 语义一致，但**两端的 action 命名空间建议统一**（当前直接复用 raw action 字符串）。
5. **返回 id 的取值不一致**：backend 取 `result?.id || result?.uuid || result?.name`，worker 取 `result.result?.id || ...`（cfFetch 多包一层 `result`）。移植时要按各自封装统一。
6. **路由顺序**：`/batch` 放在文件末尾；当前不存在 `POST /:accountId`（单段）路由，所以不会被遮蔽，但建议放前面并加注释，避免以后新增 `POST /:accountId` 时踩坑。

---

## 三、TXT 批量导入账号（同提交，前端 37 行）

把 `.txt`（每行「账号名称 apiToken」）**在前端转换成 CSV**，复用已有的 `POST /api/accounts/import-csv`：

```ts
async function txtToCsvFile(file: File): Promise<File> {
  const text = (await file.text()).replace(/^\uFEFF/, '');   // 去 BOM
  const lines = ['name,apiToken'];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;              // 支持注释
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const token = parts.pop() as string;                      // 最后一段是 token
    lines.push(`${csvCell(parts.join(' '))},${csvCell(token)}`);// 名称允许含空格
  }
  ...
}
```

优点：**没有新增后端接口**，去重 / 校验 / 自动取 `account_id` 全部由现有 `/import-csv` 承担；`csvCell()` 正确做了引号与双引号转义。这块几乎可以直接照搬（仅需确认上游 `import-csv` 的列名是 `name,apiToken`）。

---

## 四、移植建议

| 内容 | 优先级 | 难度 | 备注 |
|---|---|---|---|
| TXT 批量导入账号 | **P0** | 极低 | 纯前端 40 行，无后端改动 |
| `POST /api/storage/batch` | **P1** | 低 | 双端各 ~60 行 + 前端弹窗；必须补 demo 校验、并发限流、数量上限 |
| 批量创建结果弹窗 | P1 | 低 | 与接口一起，无独立风险 |
| 审计日志补失败分支 | P2 | 极低 | 与上游审计规范对齐 |

### 推进顺序

1. 先落 TXT 导入（无依赖、零风险），单独一个 PR；
2. 再落 `/storage/batch`，**同一 PR 内**补齐 `isDemoAccountId()` 校验 + 并发上限，避免把安全隐患带进来；
3. 若后续要做「批量删除/批量改配置」，这套 `results/total/succeeded/failed` 契约可直接复用，建议抽成 `routeUtils` 里的 `runPerAccount()` 辅助函数。

### 复现命令

```bash
git fetch --no-tags https://github.com/xuexu/cf-manager.git \
  '+refs/heads/*:refs/remotes/fk/xuexu/*'
git show e2da1e6 --stat
git show e2da1e6:backend/src/routes/storage.ts | tail -60
```

---

## 附：关联文档

- [API 接口文档](api-v1.md)
- [部署文档](deploy.md)
- [FLuoXue fork 调研](fork-review-fluoxue.md)
- [Heisenberg2024 fork 调研](fork-review-heisenberg2024.md)
