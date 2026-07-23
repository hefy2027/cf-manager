-- ============================================================
-- D1 列级迁移脚本
-- 
-- 此文件包含所有需要通过 ALTER TABLE 添加的列。
-- D1 不支持 "ALTER TABLE ... ADD COLUMN IF NOT EXISTS" 语法，
-- 所以在 deploy-cf.yml 中执行时会用 "|| true" 忽略"列已存在"错误。
--
-- 新增列时：只需在此文件末尾追加 ALTER TABLE 语句即可，
-- 无需修改 deploy-cf.yml。
-- ============================================================

-- --- accounts 表 ---
ALTER TABLE accounts ADD COLUMN enabled_features TEXT DEFAULT 'ai,workers,browser_render,dns,storage';
ALTER TABLE accounts ADD COLUMN password TEXT;
ALTER TABLE accounts ADD COLUMN available_features TEXT DEFAULT '';

-- --- quota_usage 表 ---
ALTER TABLE quota_usage ADD COLUMN optimistic INTEGER DEFAULT 0;
ALTER TABLE quota_usage ADD COLUMN exhausted INTEGER DEFAULT 0;
