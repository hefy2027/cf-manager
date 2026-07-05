import { getDb } from '../db';

export type AccountFeature = 'ai' | 'workers' | 'browser_render' | 'dns' | 'storage';

export const ALL_FEATURES: AccountFeature[] = ['ai', 'workers', 'browser_render', 'dns', 'storage'];

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
  password: string | null;
}

export interface AccountInput {
  name: string;
  auth_type: 'token' | 'global_key';
  api_token?: string;
  api_key?: string;
  email?: string;
  account_id?: string;
  enabled_features?: string;
  password?: string;
}

export function hasFeature(account: Account, feature: AccountFeature): boolean {
  const features = (account.enabled_features || ALL_FEATURES.join(',')).split(',');
  return features.includes(feature);
}

export function getActiveAccountsByFeature(feature: AccountFeature): Account[] {
  return getActiveAccounts().filter(a => hasFeature(a, feature));
}

export function getAllAccounts(): Account[] {
  return getDb().prepare('SELECT * FROM accounts ORDER BY created_at DESC').all() as Account[];
}

export type AccountListFilter = 'all' | 'active' | 'unverified';

export interface PagedAccounts {
  accounts: Account[];
  total: number;          // 当前筛选条件下的总数
  counts: { all: number; active: number; unverified: number }; // 三种状态的各自总数（用于切换 tab 时显示数字）
}

/**
 * 分页查询账户，支持按 active/unverified 筛选 + 按名称/邮箱模糊搜索
 */
export function listAccountsPaged(opts: {
  page: number;
  pageSize: number;
  filter?: AccountListFilter;
  search?: string;
}): PagedAccounts {
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

  const total = (getDb().prepare(`SELECT COUNT(*) as c FROM accounts ${whereSql}`).get(...params) as { c: number }).c;
  const offset = (page - 1) * pageSize;
  const accounts = getDb()
    .prepare(`SELECT * FROM accounts ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, offset) as Account[];

  // 三种状态的计数（不受 filter/search 影响，用于 tab 显示）
  const counts = {
    all: (getDb().prepare('SELECT COUNT(*) as c FROM accounts').get() as { c: number }).c,
    active: (getDb().prepare('SELECT COUNT(*) as c FROM accounts WHERE is_active = 1').get() as { c: number }).c,
    unverified: (getDb().prepare('SELECT COUNT(*) as c FROM accounts WHERE is_active = 0').get() as { c: number }).c,
  };

  return { accounts, total, counts };
}

export function getActiveAccounts(): Account[] {
  return getDb().prepare('SELECT * FROM accounts WHERE is_active = 1 ORDER BY created_at DESC').all() as Account[];
}

export function getAccountById(id: number): Account | undefined {
  return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Account | undefined;
}

export function createAccount(input: AccountInput): number {
  const features = input.enabled_features || ALL_FEATURES.join(',');
  const stmt = getDb().prepare(
    'INSERT INTO accounts (name, auth_type, api_token, api_key, email, account_id, enabled_features, password) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const result = stmt.run(
    input.name,
    input.auth_type,
    input.api_token || null,
    input.api_key || null,
    input.email || null,
    input.account_id || null,
    features,
    input.password || null
  );
  return result.lastInsertRowid as number;
}

export function updateAccountFeatures(id: number, features: string): void {
  getDb().prepare('UPDATE accounts SET enabled_features = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(features, id);
}

export function deleteAccount(id: number): void {
  getDb().prepare('DELETE FROM accounts WHERE id = ?').run(id);
}

export function updateAccountStatus(id: number, isActive: boolean): void {
  getDb().prepare('UPDATE accounts SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(isActive ? 1 : 0, id);
}

export function updateAccountId(id: number, accountId: string): void {
  getDb().prepare('UPDATE accounts SET account_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(accountId, id);
}

export function getAccountByEmail(email: string): Account | undefined {
  return getDb().prepare('SELECT * FROM accounts WHERE email = ?').get(email) as Account | undefined;
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
    // 没有点：直接用完整本地部分
    return localPart;
  }
  // 有点：取最后一段（去掉中间名缩写等）
  return parts[parts.length - 1];
}
