export interface Account {
  id: number;
  name: string;
  auth_type: 'token' | 'global_key';
  api_token: string | null;
  api_key: string | null;
  email: string | null;
  account_id: string | null;
  is_active: number;
  enabled_features: string;
  created_at: string;
  updated_at: string;
  available_features: string;
}

export type AccountFeature = 'ai' | 'workers' | 'browser_render' | 'dns' | 'storage';

export function hasFeature(account: Account, feature: AccountFeature): boolean {
  return (account.enabled_features || '').split(',').map(f => f.trim()).includes(feature);
}

export interface QuotaUsage {
  id: number;
  account_id: number;
  resource: string;
  date: string;
  count: number;
  optimistic: number;
  exhausted: number;
}

export interface AuditLogRow {
  id: number;
  account_id: number | null;
  action: string;
  target: string | null;
  detail: string | null;
  status: string;
  created_at: string;
  account_name?: string;
}

// ============ Account queries ============

export async function getActiveAccounts(db: D1Database): Promise<Account[]> {
  const { results } = await db.prepare('SELECT * FROM accounts WHERE is_active = 1 ORDER BY name').all<Account>();
  return results;
}

export async function getActiveAccountsByFeature(db: D1Database, feature: AccountFeature): Promise<Account[]> {
  const all = await getActiveAccounts(db);
  return all.filter(a => hasFeature(a, feature));
}

export async function getAllAccounts(db: D1Database): Promise<Account[]> {
  const { results } = await db.prepare('SELECT * FROM accounts ORDER BY created_at DESC').all<Account>();
  return results;
}

export type AccountListFilter = 'all' | 'active' | 'unverified';

export interface PagedAccounts {
  accounts: Account[];
  total: number;
  counts: { all: number; active: number; unverified: number };
}

/**
 * 分页查询账户，支持按 active/unverified 筛选 + 按名称/邮箱模糊搜索
 */
export async function listAccountsPaged(db: D1Database, opts: {
  page: number;
  pageSize: number;
  filter?: AccountListFilter;
  search?: string;
}): Promise<PagedAccounts> {
  const page = Math.max(1, opts.page || 1);
  const pageSize = Math.max(1, Math.min(500, opts.pageSize || 20));
  const filter = opts.filter || 'all';
  const search = (opts.search || '').trim();

  const where: string[] = [];
  const params: any[] = [];
  if (filter === 'active') {
    where.push('is_active = 1');
  } else if (filter === 'unverified') {
    where.push('is_active = 0');
  }
  if (search) {
    where.push('(name LIKE ? OR email LIKE ?)');
    params.push(`%${search}%`, `%${search}%`);
  }
  const whereSql = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';

  const totalRow = await db.prepare(`SELECT COUNT(*) as c FROM accounts ${whereSql}`).bind(...params).first<{ c: number }>();
  const total = totalRow?.c ?? 0;
  const offset = (page - 1) * pageSize;
  const { results } = await db
    .prepare(`SELECT * FROM accounts ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...params, pageSize, offset)
    .all<Account>();

  const [allRow, activeRow, unverifiedRow] = await Promise.all([
    db.prepare('SELECT COUNT(*) as c FROM accounts').first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) as c FROM accounts WHERE is_active = 1').first<{ c: number }>(),
    db.prepare('SELECT COUNT(*) as c FROM accounts WHERE is_active = 0').first<{ c: number }>(),
  ]);

  return {
    accounts: results,
    total,
    counts: {
      all: allRow?.c ?? 0,
      active: activeRow?.c ?? 0,
      unverified: unverifiedRow?.c ?? 0,
    },
  };
}

export async function getAccountById(db: D1Database, id: number): Promise<Account | null> {
  return db.prepare('SELECT * FROM accounts WHERE id = ?').bind(id).first<Account>();
}

export async function createAccount(db: D1Database, data: {
  name: string; auth_type: string; api_token?: string; api_key?: string;
  email?: string; account_id?: string; enabled_features?: string;
}): Promise<number> {
  const res = await db.prepare(
    'INSERT INTO accounts (name, auth_type, api_token, api_key, email, account_id, enabled_features) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(data.name, data.auth_type, data.api_token || null, data.api_key || null,
    data.email || null, data.account_id || null, data.enabled_features || 'ai,workers,browser_render,dns,storage').run();
  return res.meta.last_row_id;
}

export async function updateAccount(db: D1Database, id: number, data: Partial<Account>): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined && !['id', 'created_at'].includes(key)) {
      sets.push(`${key} = ?`);
      vals.push(val);
    }
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  vals.push(id);
  await db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
}

export async function deleteAccount(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM accounts WHERE id = ?').bind(id).run();
}

export async function getAccountByEmail(db: D1Database, email: string): Promise<Account | null> {
  return db.prepare('SELECT * FROM accounts WHERE email = ?').bind(email).first<Account>();
}

/**
 * 从邮箱中提取账户名：
 * - lauren.bailey2701@maildrop.cc -> bailey2701
 * - laurenbailey2701@maildrop.cc -> laurenbailey2701
 * - lauren.b.bailey2701@maildrop.cc -> bailey2701 (取最后一段)
 */
export function nameFromEmail(email: string): string {
  const localPart = (email.split('@')[0] || '').trim().toLowerCase();
  if (!localPart) return '';
  const parts = localPart.split('.');
  if (parts.length <= 1) {
    return localPart;
  }
  return parts[parts.length - 1];
}

// ============ Quota queries ============

export async function getAllQuotaToday(db: D1Database): Promise<QuotaUsage[]> {
  const today = new Date().toISOString().split('T')[0];
  const { results } = await db.prepare('SELECT * FROM quota_usage WHERE date = ?').bind(today).all<QuotaUsage>();
  return results;
}

export async function setQuota(db: D1Database, accountId: number, resource: string, count: number): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  await db.prepare(
    `INSERT INTO quota_usage (account_id, resource, date, count) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, resource, date) DO UPDATE SET count = ?`
  ).bind(accountId, resource, today, count, count).run();
}

export async function incrementQuota(db: D1Database, accountId: number, resource: string, amount: number): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  await db.prepare(
    `INSERT INTO quota_usage (account_id, resource, date, count) VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, resource, date) DO UPDATE SET count = count + ?`
  ).bind(accountId, resource, today, amount, amount).run();
}

export async function getQuotaByAccount(db: D1Database, accountId: number, resource: string): Promise<QuotaUsage | null> {
  const today = new Date().toISOString().split('T')[0];
  return db.prepare('SELECT * FROM quota_usage WHERE account_id = ? AND resource = ? AND date = ?')
    .bind(accountId, resource, today).first<QuotaUsage>();
}

export async function setExhausted(db: D1Database, accountId: number, resource: string): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  await db.prepare(
    `INSERT INTO quota_usage (account_id, resource, date, count, exhausted) VALUES (?, ?, ?, 0, 1)
     ON CONFLICT(account_id, resource, date) DO UPDATE SET exhausted = 1`
  ).bind(accountId, resource, today).run();
}

export async function clearExhausted(db: D1Database, accountId: number, resource: string): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  await db.prepare(
    `UPDATE quota_usage SET exhausted = 0 WHERE account_id = ? AND resource = ? AND date = ?`
  ).bind(accountId, resource, today).run();
}

export async function getQuotaTodayByResource(db: D1Database, resource: string): Promise<QuotaUsage[]> {
  const today = new Date().toISOString().split('T')[0];
  const { results } = await db.prepare('SELECT * FROM quota_usage WHERE resource = ? AND date = ?')
    .bind(resource, today).all<QuotaUsage>();
  return results;
}

// ============ Audit log ============

export async function addAuditLog(db: D1Database, data: {
  account_id?: number; action: string; target?: string; detail?: string; status: string;
}): Promise<void> {
  await db.prepare(
    'INSERT INTO audit_log (account_id, action, target, detail, status) VALUES (?, ?, ?, ?, ?)'
  ).bind(data.account_id || null, data.action, data.target || null, data.detail || null, data.status).run();
}

export async function getRecentLogs(db: D1Database, limit = 20): Promise<AuditLogRow[]> {
  const { results } = await db.prepare(
    `SELECT l.*, a.name as account_name FROM audit_log l
     LEFT JOIN accounts a ON l.account_id = a.id
     ORDER BY l.created_at DESC LIMIT ?`
  ).bind(limit).all<AuditLogRow>();
  return results;
}

// ============ Settings ============

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').bind(key, value).run();
}

// ============ Optimistic tracking (D1 fallback) ============

/** Atomically increment optimistic count for a given account+resource. */
export async function addOptimisticD1(db: D1Database, accountId: number, resource: string, amount: number): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  await db.prepare(
    `INSERT INTO quota_usage (account_id, resource, date, count, optimistic) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(account_id, resource, date) DO UPDATE SET optimistic = optimistic + ?`
  ).bind(accountId, resource, today, amount, amount).run();
}

/** Clear optimistic for a given account+resource after real usage is recorded. */
export async function clearOptimisticD1(db: D1Database, accountId: number, resource: string): Promise<void> {
  const today = new Date().toISOString().split('T')[0];
  await db.prepare(
    'UPDATE quota_usage SET optimistic = 0 WHERE account_id = ? AND resource = ? AND date = ?'
  ).bind(accountId, resource, today).run();
}

/** Get all optimistic values for a resource, keyed by account_id. */
export async function getOptimisticMapD1(db: D1Database, resource: string): Promise<Map<number, number>> {
  const today = new Date().toISOString().split('T')[0];
  const { results } = await db.prepare(
    'SELECT account_id, optimistic FROM quota_usage WHERE resource = ? AND date = ?'
  ).bind(resource, today).all<{ account_id: number; optimistic: number }>();
  const map = new Map<number, number>();
  for (const r of results) map.set(r.account_id, r.optimistic || 0);
  return map;
}

// ============ Catalog Sources ============

export interface CatalogSource {
  id: number;
  url: string;
  name: string;
  is_default: number;
  enabled: number;
  last_synced: string | null;
  last_status: string;
  last_error: string | null;
  etag: string | null;
  created_at: string;
}

export async function getCatalogSources(db: D1Database): Promise<CatalogSource[]> {
  const { results } = await db.prepare('SELECT * FROM catalog_sources ORDER BY is_default DESC, id ASC').all<CatalogSource>();
  return results;
}

export async function getEnabledCatalogSources(db: D1Database): Promise<CatalogSource[]> {
  const { results } = await db.prepare('SELECT * FROM catalog_sources WHERE enabled = 1 ORDER BY is_default DESC, id ASC').all<CatalogSource>();
  return results;
}

export async function getCatalogSourceById(db: D1Database, id: number): Promise<CatalogSource | null> {
  return db.prepare('SELECT * FROM catalog_sources WHERE id = ?').bind(id).first<CatalogSource>();
}

export async function getDefaultCatalogSource(db: D1Database): Promise<CatalogSource | null> {
  return db.prepare('SELECT * FROM catalog_sources WHERE is_default = 1').first<CatalogSource>();
}

export async function createCatalogSource(db: D1Database, data: {
  url: string; name: string; is_default?: number;
}): Promise<number> {
  const res = await db.prepare(
    'INSERT INTO catalog_sources (url, name, is_default) VALUES (?, ?, ?)'
  ).bind(data.url, data.name, data.is_default || 0).run();
  return res.meta.last_row_id;
}

export async function updateCatalogSource(db: D1Database, id: number, data: Partial<{
  url: string; name: string; enabled: number; last_synced: string;
  last_status: string; last_error: string | null; etag: string | null;
}>): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined) {
      sets.push(`${key} = ?`);
      vals.push(val);
    }
  }
  if (sets.length === 0) return;
  vals.push(id);
  await db.prepare(`UPDATE catalog_sources SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
}

export async function deleteCatalogSource(db: D1Database, id: number): Promise<void> {
  await db.prepare('DELETE FROM catalog_sources WHERE id = ? AND is_default = 0').bind(id).run();
}

export async function ensureDefaultCatalogSource(db: D1Database, url: string, name: string): Promise<void> {
  const existing = await getDefaultCatalogSource(db);
  if (!existing) {
    await db.prepare(
      'INSERT INTO catalog_sources (url, name, is_default) VALUES (?, ?, 1)'
    ).bind(url, name).run();
  } else if (existing.url !== url || existing.name !== name) {
    // 代码常量已变更（如迁移到新仓库），同步修正已存在的默认源地址
    await updateCatalogSource(db, existing.id, { url, name });
  }
}
