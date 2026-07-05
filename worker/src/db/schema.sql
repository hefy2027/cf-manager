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
  password        TEXT,
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

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
