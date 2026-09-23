import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './config';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(config.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    db = new Database(config.dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function initDb(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      name            TEXT NOT NULL,
      auth_type       TEXT NOT NULL CHECK(auth_type IN ('token', 'global_key')),
      api_token       TEXT,
      api_key         TEXT,
      email           TEXT,
      account_id      TEXT,
      is_active       INTEGER DEFAULT 1,
      enabled_features TEXT DEFAULT 'ai,workers,browser_render,dns,storage',
      available_features TEXT DEFAULT '',
      worker_plan     TEXT DEFAULT 'free',
      proxy_url       TEXT DEFAULT '',
      proxy_enabled   INTEGER DEFAULT 0,
      created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS quota_usage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  INTEGER REFERENCES accounts(id) ON DELETE CASCADE,
      resource    TEXT NOT NULL,
      date        DATE NOT NULL,
      count       INTEGER DEFAULT 0,
      optimistic  INTEGER DEFAULT 0,
      exhausted   INTEGER DEFAULT 0,
      UNIQUE(account_id, resource, date)
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id  INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
      action      TEXT NOT NULL,
      target      TEXT,
      detail      TEXT,
      status      TEXT NOT NULL CHECK(status IN ('success', 'error')),
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_action_created ON audit_log(action, created_at);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      type        TEXT NOT NULL,
      cron        TEXT NOT NULL,
      config      TEXT,
      enabled     INTEGER DEFAULT 1,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS task_executions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES scheduled_tasks(id) ON DELETE CASCADE,
      status      TEXT NOT NULL CHECK(status IN ('running', 'success', 'error')),
      detail      TEXT,
      started_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalog_sources (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      url           TEXT NOT NULL UNIQUE,
      name          TEXT NOT NULL,
      is_default    INTEGER DEFAULT 0,
      enabled       INTEGER DEFAULT 1,
      last_synced   DATETIME,
      last_status   TEXT DEFAULT 'pending',
      last_error    TEXT,
      etag          TEXT,
      created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  applyMigrations(db);
}

// 版本化迁移（P1-17 / P1-18）：每条仅执行一次，记录于 _migrations 表。
// 新增列通过 PRAGMA table_info 判断列是否存在后再执行普通 ADD COLUMN，
// 跨所有 SQLite 版本保持幂等、可重复部署（当前 better-sqlite3 构建解析 ADD COLUMN IF NOT EXISTS 会报语法错误）；
// 非加法迁移（改名/改类型/删列/NOT NULL 无默认/数据回填）请新增带版本号的条目并写一次性脚本。
type Migration = {
  version: string;
  table: string;
  column: string;
  sql: string;
  /** add（默认）：列不存在才执行；drop：列存在才执行 */
  kind?: 'add' | 'drop';
};
const MIGRATIONS: Migration[] = [
  { version: '0001_accounts_enabled_features', table: 'accounts', column: 'enabled_features', sql: "ALTER TABLE accounts ADD COLUMN enabled_features TEXT DEFAULT 'ai,workers,browser_render,dns,storage';" },
  // 注：历史上此处有 0002_accounts_password（ADD COLUMN password），该字段已废弃并移除，
  // 见下方 0008 的删列迁移；已部署库 `_migrations` 中的 0002 记录留着无害。
  { version: '0003_accounts_available_features', table: 'accounts', column: 'available_features', sql: "ALTER TABLE accounts ADD COLUMN available_features TEXT DEFAULT '';" },
  { version: '0004_accounts_proxy_url', table: 'accounts', column: 'proxy_url', sql: "ALTER TABLE accounts ADD COLUMN proxy_url TEXT DEFAULT '';" },
  { version: '0005_accounts_proxy_enabled', table: 'accounts', column: 'proxy_enabled', sql: "ALTER TABLE accounts ADD COLUMN proxy_enabled INTEGER DEFAULT 0;" },
  { version: '0006_quota_optimistic', table: 'quota_usage', column: 'optimistic', sql: "ALTER TABLE quota_usage ADD COLUMN optimistic INTEGER DEFAULT 0;" },
  { version: '0007_quota_exhausted', table: 'quota_usage', column: 'exhausted', sql: "ALTER TABLE quota_usage ADD COLUMN exhausted INTEGER DEFAULT 0;" },
  // 移除从未在界面上使用的 accounts.password（登录密码）：旧库该列存在则删除，
  // 新库基础建表已不含该列，columnExists 为假直接跳过（见 applyMigrations 的 drop 分支）。
  { version: '0008_accounts_drop_password', table: 'accounts', column: 'password', kind: 'drop', sql: "ALTER TABLE accounts DROP COLUMN password;" },
  // worker_plan：账号的 Cloudflare Workers 计划类型（'free' 默认 / 'paid' / 'enterprise'），
  // 用于把付费模型只路由到付费账号；不标即免费。与 worker/src/db/migrations/0010_accounts_worker_plan.sql 对应。
  { version: '0010_accounts_worker_plan', table: 'accounts', column: 'worker_plan', sql: "ALTER TABLE accounts ADD COLUMN worker_plan TEXT DEFAULT 'free';" },
];

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === column);
}

function applyMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (version TEXT PRIMARY KEY, applied_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  const applied = new Set(
    (db.prepare('SELECT version FROM _migrations').all() as { version: string }[]).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const exists = columnExists(db, m.table, m.column);
    if (m.kind === 'drop') {
      // 删列：仅当列确实存在时执行
      if (exists) db.exec(m.sql);
    } else if (!exists) {
      // 加列：列已存在（旧库/手动加过）则跳过执行，但照常记录为已应用，保证幂等
      db.exec(m.sql);
    }
    db.prepare('INSERT OR IGNORE INTO _migrations (version) VALUES (?)').run(m.version);
  }
}

export function getSetting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}
