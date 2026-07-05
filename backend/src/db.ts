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
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      auth_type   TEXT NOT NULL CHECK(auth_type IN ('token', 'global_key')),
      api_token   TEXT,
      api_key     TEXT,
      email       TEXT,
      account_id  TEXT,
      is_active   INTEGER DEFAULT 1,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
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
  `);

  const cols = db.prepare("PRAGMA table_info('accounts')").all() as { name: string }[];
  if (!cols.find(c => c.name === 'enabled_features')) {
    db.exec("ALTER TABLE accounts ADD COLUMN enabled_features TEXT DEFAULT 'ai,workers,browser_render,dns,storage'");
  }
  if (!cols.find(c => c.name === 'password')) {
    db.exec("ALTER TABLE accounts ADD COLUMN password TEXT");
  }

  // Migrate quota_usage: add exhausted column if not exists
  const quotaCols = db.prepare("PRAGMA table_info('quota_usage')").all() as { name: string }[];
  if (!quotaCols.find(c => c.name === 'exhausted')) {
    db.exec("ALTER TABLE quota_usage ADD COLUMN exhausted INTEGER DEFAULT 0");
  }
  if (!quotaCols.find(c => c.name === 'optimistic')) {
    db.exec("ALTER TABLE quota_usage ADD COLUMN optimistic INTEGER DEFAULT 0");
  }
}

export function getSetting(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
}
