import { getActiveAccountsByFeature, Account } from '../models/account';
import { clearCache } from './accountRouter';
import { appLogger } from './logger';

const TOKEN_INTERVAL_MS = 10_000;

interface AccountBucket {
  accountId: number;
  lastUsedAt: number;
  exhausted: boolean;
}

const buckets = new Map<number, AccountBucket>();

function ensureBuckets(): void {
  const accounts = getActiveAccountsByFeature('browser_render');
  for (const acct of accounts) {
    if (!buckets.has(acct.id)) {
      buckets.set(acct.id, { accountId: acct.id, lastUsedAt: 0, exhausted: false });
    }
  }
  for (const [id] of buckets) {
    if (!accounts.find(a => a.id === id)) {
      buckets.delete(id);
    }
  }
}

export function markAccountExhausted(accountId: number): void {
  const bucket = buckets.get(accountId);
  if (bucket) bucket.exhausted = true;
  clearCache();
  appLogger.info(`[BrowserRL] Account ${accountId} marked as exhausted (CF daily limit)`);
}

export type AcquireResult =
  | { type: 'ok'; account: Account }
  | { type: 'rate_limited'; waitMs: number }
  | { type: 'all_exhausted' };

export interface BrowserRenderStatus {
  available_accounts: number;
  total_accounts: number;
  token_interval_ms: number;
}

export function getBrowserRenderStatus(): BrowserRenderStatus {
  ensureBuckets();
  const accounts = getActiveAccountsByFeature('browser_render');
  let available = 0;
  for (const account of accounts) {
    const bucket = buckets.get(account.id);
    if (bucket && !bucket.exhausted) available++;
  }
  return { available_accounts: available, total_accounts: accounts.length, token_interval_ms: TOKEN_INTERVAL_MS };
}

export function acquireToken(): AcquireResult {
  ensureBuckets();
  const accounts = getActiveAccountsByFeature('browser_render');
  const now = Date.now();

  let shortestWait = Infinity;
  let hasAvailableAccount = false;

  for (const account of accounts) {
    const bucket = buckets.get(account.id);
    if (!bucket || bucket.exhausted) continue;

    hasAvailableAccount = true;
    const elapsed = now - bucket.lastUsedAt;

    if (elapsed >= TOKEN_INTERVAL_MS) {
      // 立即消费令牌，设置 lastUsedAt = now（不堆叠，不管空闲了多久都只给1个）
      bucket.lastUsedAt = now;
      return { type: 'ok', account };
    }

    const waitMs = TOKEN_INTERVAL_MS - elapsed;
    if (waitMs < shortestWait) {
      shortestWait = waitMs;
    }
  }

  if (!hasAvailableAccount) {
    return { type: 'all_exhausted' };
  }

  return { type: 'rate_limited', waitMs: shortestWait };
}
