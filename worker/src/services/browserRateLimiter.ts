import type { Env } from '../types';
import { getActiveAccountsByFeature, setExhausted, clearExhausted, getQuotaByAccount, getSetting, setSetting, type Account } from '../db/models';
import { logger } from './logger';

/** 每个账户两次请求之间的最小间隔（毫秒），对齐 backend 的 10 秒令牌桶。 */
const TOKEN_INTERVAL_MS = 10_000;

/** KV 中每个账户令牌桶状态的 key 前缀。 */
const KV_TOKEN_PREFIX = 'browser_token:';

/** KV 令牌桶条目 TTL，设为冷却窗口的 2 倍以留出余量。 */
const KV_TOKEN_TTL_SEC = Math.ceil((TOKEN_INTERVAL_MS * 2) / 1000);

/** D1 兜底时存储 lastUsedAt map 的 app_settings key。 */
const D1_LAST_USED_KEY = 'browser_token_last_used';

/** KV 令牌桶结构。 */
interface TokenBucketState {
  lastUsedAt: number;
  exhausted: boolean;
  /** 写入时的 UTC 日期（YYYY-MM-DD），用于跨日惰性重置。 */
  date: string;
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

/** 当前 UTC 日期字符串。 */
function todayUtc(): string {
  return new Date().toISOString().split('T')[0];
}

/** 计算距离下一个 UTC 午夜的毫秒数。 */
function msUntilNextUtcMidnight(): number {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return tomorrow.getTime() - now.getTime();
}

// ============ KV 令牌桶 ============

async function kvReadBucket(env: Env, accountId: number): Promise<TokenBucketState | null> {
  const raw = await env.KV!.get<TokenBucketState>(`${KV_TOKEN_PREFIX}${accountId}`, 'json');
  if (!raw) return null;
  // 跨 UTC 午夜则视为新一天的空桶：清掉 exhausted
  if (raw.date !== todayUtc()) {
    return { lastUsedAt: 0, exhausted: false, date: todayUtc() };
  }
  return raw;
}

async function kvWriteBucket(env: Env, accountId: number, state: TokenBucketState): Promise<void> {
  await env.KV!.put(`${KV_TOKEN_PREFIX}${accountId}`, JSON.stringify(state), {
    expirationTtl: KV_TOKEN_TTL_SEC,
  });
}

// ============ D1 兜底令牌桶 ============

/** D1 模式下从 app_settings 读取 {accountId: lastUsedAt} map。 */
async function d1ReadLastUsedMap(env: Env): Promise<Record<number, number>> {
  const raw = await getSetting(env.DB, D1_LAST_USED_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    // 跨 UTC 午夜则整体清空（新一天，所有 lastUsedAt 失效）
    const dateStamp = await getSetting(env.DB, `${D1_LAST_USED_KEY}_date`);
    if (dateStamp !== todayUtc()) return {};
    return parsed as Record<number, number>;
  } catch {
    return {};
  }
}

async function d1WriteLastUsedMap(env: Env, map: Record<number, number>): Promise<void> {
  await setSetting(env.DB, D1_LAST_USED_KEY, JSON.stringify(map));
  await setSetting(env.DB, `${D1_LAST_USED_KEY}_date`, todayUtc());
}

/** D1 兜底模式下检查账户是否 exhausted（直接读 quota_usage.exhausted）。 */
async function d1IsExhausted(env: Env, accountId: number): Promise<boolean> {
  const row = await getQuotaByAccount(env.DB, accountId, 'browser_render_seconds');
  return row?.exhausted === 1;
}

// ============ 公共 API ============

/**
 * 尝试获取一个可用账户的令牌。返回 ok / rate_limited / all_exhausted。
 * 选择策略与 backend 一致：遍历未耗尽的账户，谁冷却到期就用谁（先到期先用）。
 * 不堆叠令牌：不管空闲了多久都只给 1 个。
 */
export async function acquireToken(env: Env): Promise<AcquireResult> {
  const accounts = await getActiveAccountsByFeature(env.DB, 'browser_render');
  if (accounts.length === 0) return { type: 'all_exhausted' };

  const now = Date.now();
  let shortestWait = Infinity;
  let hasAvailableAccount = false;

  // D1 模式下预先一次性读 lastUsedAt map，避免多次往返
  let d1LastUsedMap: Record<number, number> | null = null;
  if (!env.KV) {
    d1LastUsedMap = await d1ReadLastUsedMap(env);
  }

  for (const account of accounts) {
    let isExhausted: boolean;
    let lastUsedAt: number;

    if (env.KV) {
      const bucket = await kvReadBucket(env, account.id);
      isExhausted = bucket?.exhausted ?? false;
      lastUsedAt = bucket?.lastUsedAt ?? 0;
    } else {
      isExhausted = await d1IsExhausted(env, account.id);
      lastUsedAt = d1LastUsedMap![account.id] ?? 0;
    }

    if (isExhausted) continue;
    hasAvailableAccount = true;

    const elapsed = now - lastUsedAt;
    if (elapsed >= TOKEN_INTERVAL_MS) {
      // 立即消费令牌，更新 lastUsedAt
      if (env.KV) {
        await kvWriteBucket(env, account.id, { lastUsedAt: now, exhausted: false, date: todayUtc() });
      } else {
        d1LastUsedMap![account.id] = now;
        await d1WriteLastUsedMap(env, d1LastUsedMap!);
      }
      logger.debug('BrowserRL', `acquired token for account ${account.name} (${account.id})`);
      return { type: 'ok', account };
    }

    const waitMs = TOKEN_INTERVAL_MS - elapsed;
    if (waitMs < shortestWait) shortestWait = waitMs;
  }

  if (!hasAvailableAccount) return { type: 'all_exhausted' };
  return { type: 'rate_limited', waitMs: shortestWait };
}

/** 把某个账户标记为当日已耗尽（CF 返回日限额错误时调用）。 */
export async function markAccountExhausted(env: Env, accountId: number): Promise<void> {
  if (env.KV) {
    const existing = await kvReadBucket(env, accountId);
    await kvWriteBucket(env, accountId, {
      lastUsedAt: existing?.lastUsedAt ?? 0,
      exhausted: true,
      date: todayUtc(),
    });
  }
  // 无论 KV 还是 D1 模式，都同步持久化到 D1 quota_usage.exhausted，
  // 使 getQuotaSummary / 前端仪表盘能正确反映耗尽状态
  await setExhausted(env.DB, accountId, 'browser_render_seconds');
  logger.info('BrowserRL', `account ${accountId} marked exhausted (CF daily limit)`);
}

/** 清除某个账户的 exhausted 标记。 */
export async function clearAccountExhausted(env: Env, accountId: number): Promise<void> {
  if (env.KV) {
    const existing = await kvReadBucket(env, accountId);
    if (existing) {
      await kvWriteBucket(env, accountId, { ...existing, exhausted: false });
    }
  }
  // 同步清除 D1 中的 exhausted 标记，保持 KV 与 D1 一致
  await clearExhausted(env.DB, accountId, 'browser_render_seconds');
}

/** 距离下一个 UTC 午夜的毫秒数。 */
export function getMsUntilNextUtcMidnight(): number {
  return msUntilNextUtcMidnight();
}

/** 获取当前限流器状态（供状态接口/调试使用）。 */
export async function getBrowserRenderStatus(env: Env): Promise<BrowserRenderStatus> {
  const accounts = await getActiveAccountsByFeature(env.DB, 'browser_render');
  let available = 0;

  if (env.KV) {
    for (const account of accounts) {
      const bucket = await kvReadBucket(env, account.id);
      if (!bucket?.exhausted) available++;
    }
  } else {
    for (const account of accounts) {
      if (!(await d1IsExhausted(env, account.id))) available++;
    }
  }

  return {
    available_accounts: available,
    total_accounts: accounts.length,
    token_interval_ms: TOKEN_INTERVAL_MS,
  };
}
