-- 为 accounts 表新增 worker_plan 字段：账号的 Cloudflare Workers 计划类型。
--
-- 取值：'free'（默认，未标注即视为免费）/ 'paid' / 'enterprise'
-- 用途：付费模型（CF 模型元数据 require_workers_paid = true）只路由到 paid/enterprise
--       账号；当不存在这类账号时，模型列表中隐藏付费模型。
-- 由用户在「账号管理」中手动标注（不依赖 /subscriptions，避免 Billing 读权限依赖）。
--
-- 幂等：重复执行会因列已存在而报错，migrate.mjs 已跳过此类幂等错误；与 backend/src/db.ts
-- 的 MIGRATIONS（0010_accounts_worker_plan）保持一致。
ALTER TABLE accounts ADD COLUMN worker_plan TEXT DEFAULT 'free';
