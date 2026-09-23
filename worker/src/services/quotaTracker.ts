import { getActiveAccounts, getActiveAccountsByFeature, hasFeature, isPaidPlan, getAllQuotaToday, setQuota, incrementQuota, getQuotaByAccount, getQuotaTodayByResource, addOptimisticD1, clearOptimisticD1, getOptimisticMapD1, getSetting, setSetting, type Account, type AccountFeature } from '../db/models';
import type { Env } from '../types';
import { cfGraphQL } from './cfApi';
import { logger } from './logger';
import { mapConcurrent } from '../utils/concurrent';
import { isPaidModelName } from './aiService';
import pricingData from '../data/model-pricing.json';

export type ResourceType = 'workers_requests' | 'ai_neurons' | 'browser_render_seconds';

export const LIMITS: Record<string, number> = {
  workers_requests: 100000,
  ai_neurons: 10000,
  browser_render_seconds: 600,
};

const KV_KEY = 'ai_neuron_snapshot';
const KV_TTL = 60; // seconds
const KV_OPTIMISTIC_KEY = 'ai_neuron_optimistic';
const KV_LAST_USED_KEY = 'ai_last_used_account';

/** Threshold for cache affinity: prefer last-used account if it's within this many neurons of the best. */
const CACHE_AFFINITY_THRESHOLD = 10000;

/** Check if a model supports prompt caching (has cachedInput in pricing). */
function modelSupportsCaching(model: string): boolean {
  return !!(pricingData.models[model as keyof typeof pricingData.models] as any)?.cachedInput;
}

interface AiKvEntry {
  id: number;
  account_id: string;
  name: string;
  used: number;
}

interface OptimisticEntry {
  [accountId: number]: number;  // accountId -> optimistic neurons
}

const RESOURCE_FEATURE: Record<ResourceType, AccountFeature> = {
  workers_requests: 'workers',
  ai_neurons: 'ai',
  browser_render_seconds: 'browser_render',
};

export async function trackUsage(db: D1Database, accountId: number, resource: ResourceType, amount = 1): Promise<void> {
  await incrementQuota(db, accountId, resource, amount);
}

export async function syncUsageFromCloudflare(db: D1Database, encryptionKey: string): Promise<void> {
  const accounts = await getActiveAccounts(db);
  const SYNC_CONCURRENCY = 6;

  await mapConcurrent(accounts, SYNC_CONCURRENCY, async (account) => {
    if (hasFeature(account, 'ai')) {
      try {
        const usage = await getAiUsageToday(account, encryptionKey);
        if (usage.totalNeurons > 0) {
          // CF 返回非零 → 以 CF 数据为准
          await setQuota(db, account.id, 'ai_neurons', Math.round(usage.totalNeurons));
          // 不清除 exhausted 标记：exhausted 是 CF 返回 4006 时设置的，
          // 表示当天免费额度已用完。使用量 > 0 只代表今天用了多少 neurons，
          // 不代表额度没用完。标记只应通过日期变化或手动清除。
        } else {
          // CF 返回 0 → 保留本地数据，不覆盖
          logger.info('sync', `${account.name}: CF returned 0 neurons, keeping local data`);
        }
      } catch (e) {
        logger.error('sync', `AI usage failed for ${account.name}: ${e}`);
      }
    }
    if (hasFeature(account, 'workers')) {
      try {
        const usage = await getWorkersUsageToday(account, encryptionKey);
        await setQuota(db, account.id, 'workers_requests', usage.requests);
      } catch (e) {
        logger.error('sync', `Workers usage failed for ${account.name}: ${e}`);
      }
    }
  });
}

export async function getQuotaSummary(db: D1Database, _encryptionKey: string) {
  const accounts = await getActiveAccounts(db);
  const usage = await getAllQuotaToday(db);
  const resourceTypes = Object.keys(LIMITS) as ResourceType[];

  return accounts.map(account => {
    const resources = resourceTypes
      .filter(r => hasFeature(account, RESOURCE_FEATURE[r]))
      .map(resource => {
        const row = usage.find(u => u.account_id === account.id && u.resource === resource);
        const count = row?.count || 0;
        const limit = LIMITS[resource];
        const exhausted = row?.exhausted === 1;
        return { resource, count, limit, remaining: Math.max(0, limit - count), exhausted };
      });
    return { accountId: account.id, accountName: account.name, resources };
  });
}

export async function getAccountQuota(db: D1Database, accountId: number, resource: ResourceType): Promise<{ used: number; remaining: number }> {
  const usage = await getQuotaByAccount(db, accountId, resource);
  const used = usage?.count || 0;
  const limit = LIMITS[resource] || 0;
  return { used, remaining: Math.max(0, limit - used) };
}

async function getAiSnapshot(env: Env): Promise<Array<AiKvEntry & { _account?: Account }>> {
  if (env.KV) {
    const cached = await env.KV.get<AiKvEntry[]>(KV_KEY, 'json');
    if (cached) return cached as Array<AiKvEntry & { _account?: Account }>;
  }
  const accounts = await getActiveAccountsByFeature(env.DB, 'ai');
  const usageRows = await getQuotaTodayByResource(env.DB, 'ai_neurons');
  const usageMap = new Map(usageRows.map(r => [r.account_id, r]));
  const ranked = accounts
    .map(account => ({
      id: account.id,
      account_id: account.account_id || '',
      name: account.name,
      used: usageMap.get(account.id)?.count || 0,
      _exhausted: usageMap.get(account.id)?.exhausted === 1,
      _account: account,
    }))
    .filter(r => !r._exhausted)
    .sort((a, b) => a.used - b.used);

  if (env.KV) {
    const kvData = ranked.map(r => ({ id: r.id, account_id: r.account_id, name: r.name, used: r.used }));
    await env.KV.put(KV_KEY, JSON.stringify(kvData), { expirationTtl: KV_TTL });
  }
  return ranked;
}

export async function invalidateAiCache(env: Env): Promise<void> {
  // P1-12: 快照本身已有 KV_TTL(60s) 的 TTL 缓存；此前每次调用整体删除快照，
  // 导致下次 selectBestAccount 重建（DB 查询 + 排序）放大开销。改为依赖 TTL 自动过期，
  // 不再整体失效（如需立即刷新可调用 getAiSnapshot(env) 直接写回）。保留空实现以兼容调用点。
  void env;
  return;
}

export async function clearOptimistic(env: Env, accountId: number): Promise<void> {
  if (env.KV) {
    const optimistic = await env.KV.get<OptimisticEntry>(KV_OPTIMISTIC_KEY, 'json') || {};
    if (optimistic[accountId]) {
      console.log(`[AI] Cleared optimistic for ${accountId}: was ${optimistic[accountId]}`);
      delete optimistic[accountId];
      if (Object.keys(optimistic).length > 0) {
        await env.KV.put(KV_OPTIMISTIC_KEY, JSON.stringify(optimistic), { expirationTtl: 300 });
      } else {
        await env.KV.delete(KV_OPTIMISTIC_KEY);
      }
    }
  } else {
    // D1 fallback
    await clearOptimisticD1(env.DB, accountId, 'ai_neurons');
  }
}

// ============ 存储抽象层 (KV 优先 / D1 兜底) ============

async function readOptimistic(env: Env): Promise<OptimisticEntry> {
  if (env.KV) {
    return await env.KV.get<OptimisticEntry>(KV_OPTIMISTIC_KEY, 'json') || {};
  }
  const map = await getOptimisticMapD1(env.DB, 'ai_neurons');
  const entry: OptimisticEntry = {};
  for (const [k, v] of map) entry[k] = v;
  return entry;
}

async function writeOptimistic(env: Env, optimistic: OptimisticEntry): Promise<void> {
  if (env.KV) {
    await env.KV.put(KV_OPTIMISTIC_KEY, JSON.stringify(optimistic), { expirationTtl: 300 });
  }
  // D1: written per-account via addOptimisticD1 below
}

async function addOptimisticOne(env: Env, accountId: number): Promise<void> {
  if (env.KV) {
    // handled in writeOptimistic
  } else {
    await addOptimisticD1(env.DB, accountId, 'ai_neurons', 1000);
  }
}

async function readLastUsed(env: Env): Promise<{ id: number; time: number } | null> {
  if (env.KV) {
    return await env.KV.get<{ id: number; time: number }>(KV_LAST_USED_KEY, 'json');
  }
  const raw = await getSetting(env.DB, 'last_used_ai_account');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function writeLastUsed(env: Env, accountId: number): Promise<void> {
  const data = { id: accountId, time: Date.now() };
  if (env.KV) {
    await env.KV.put(KV_LAST_USED_KEY, JSON.stringify(data), { expirationTtl: 600 });
  } else {
    await setSetting(env.DB, 'last_used_ai_account', JSON.stringify(data));
  }
}

// ============ selectBestAccount ============

export async function selectBestAccount(
  env: Env,
  resource: ResourceType,
  excludeIds?: Set<number>,
  model?: string
): Promise<Account | null> {
  if (resource === 'ai_neurons') {
    let snapshot: Array<AiKvEntry & { _account?: Account }>;
    
    // 从 KV 或 DB 获取快照
    if (env.KV) {
      const cached = await env.KV.get<AiKvEntry[]>(KV_KEY, 'json');
      if (cached) {
        const accounts = await getActiveAccountsByFeature(env.DB, 'ai');
        const accountMap = new Map(accounts.map(a => [a.id, a]));
        snapshot = cached.map(r => ({ ...r, _account: accountMap.get(r.id) })).filter(r => r._account);
      } else {
        snapshot = await getAiSnapshot(env);
      }
    } else {
      snapshot = await getAiSnapshot(env);
    }

    if (!snapshot || snapshot.length === 0) return null;

    // 付费模型（require_workers_paid）只允许付费计划账号承接；未标注/标为 free 的账号不可用。
    // 付费模型名单由 /models 刷新（缓存未建立时 isPaidModelName 返回 false，行为不变）。
    if (isPaidModelName(model)) {
      snapshot = snapshot.filter(r => isPaidPlan(r._account?.worker_plan));
      if (snapshot.length === 0) {
        console.log(`[AI] Paid model "${model}" requested but no paid-plan account is available`);
        return null;
      }
    }

    // 读取乐观预估量 (KV 或 D1)
    const optimistic = await readOptimistic(env);

    // 按实际用量 + 乐观预估量排序
    snapshot.sort((a, b) => {
      const aTotal = a.used + (optimistic[a.id] || 0);
      const bTotal = b.used + (optimistic[b.id] || 0);
      return aTotal - bTotal;
    });

    const best = snapshot.find(r => !excludeIds?.has(r.id));
    if (!best) return null;

    const supportsCaching = model ? modelSupportsCaching(model) : false;

    // 缓存模型：优先复用最近使用的账户（软粘性）
    if (supportsCaching) {
      const lastUsed = await readLastUsed(env);
      if (lastUsed) {
        const recent = snapshot.find(r => r.id === lastUsed.id && !excludeIds?.has(r.id));
        if (recent && recent !== best) {
          const bestScore = best.used + (optimistic[best.id] || 0);
          const recentScore = (recent.used || 0) + (optimistic[recent.id] || 0);
          if (recentScore - bestScore <= CACHE_AFFINITY_THRESHOLD) {
            console.log(`[AI] Cache affinity: reusing ${recent.name} (gap=${recentScore - bestScore} <= ${CACHE_AFFINITY_THRESHOLD})`);
            optimistic[recent.id] = (optimistic[recent.id] || 0) + 1000;
            await writeOptimistic(env, optimistic);
            await addOptimisticOne(env, recent.id);
            await writeLastUsed(env, recent.id);
            return recent._account || null;
          }
        }
      }
    }

    // 乐观更新
    optimistic[best.id] = (optimistic[best.id] || 0) + 1000;
    await writeOptimistic(env, optimistic);
    await addOptimisticOne(env, best.id);
    if (supportsCaching) {
      await writeLastUsed(env, best.id);
    }
    console.log(`[AI] Selected ${best.name}, optimistic +1000 (total: ${optimistic[best.id]})`);

    return best._account || null;
  }

  // Non-ai_neurons branch keeps original logic
  const featureMap: Record<ResourceType, AccountFeature> = { workers_requests: 'workers', ai_neurons: 'ai', browser_render_seconds: 'browser_render' };
  const accounts = (await getActiveAccounts(env.DB)).filter(a => hasFeature(a, featureMap[resource]));
  if (accounts.length === 0) return null;

  let best: Account | null = null;
  let bestRemaining = -1;
  for (const account of accounts) {
    const { remaining } = await getAccountQuota(env.DB, account.id, resource);
    if (remaining > bestRemaining) { bestRemaining = remaining; best = account; }
  }
  return best;
}

interface AiUsage { totalNeurons: number; models: { modelId: string; neurons: number; requests: number }[] }

export async function getAiUsageToday(account: Account, encryptionKey: string): Promise<AiUsage> {
  if (!account.account_id) throw new Error(`AI usage: account "${account.name}" missing account_id`);
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const end = now.toISOString();

  const query = `query($accountTag:string!,$start:Time!,$end:Time!){viewer{accounts(filter:{accountTag:$accountTag}){total:aiInferenceAdaptiveGroups(filter:{datetime_geq:$start,datetime_leq:$end},limit:1){sum{totalNeurons}}byModel:aiInferenceAdaptiveGroups(filter:{datetime_geq:$start,datetime_leq:$end},limit:100,orderBy:[sum_totalNeurons_DESC]){count,sum{totalNeurons},dimensions{modelId}}}}}`;

  try {
    const json = await cfGraphQL(account, query, { accountTag: account.account_id, start, end }, encryptionKey);
    const acct = json?.data?.viewer?.accounts?.[0];
    const totalNeurons = acct?.total?.[0]?.sum?.totalNeurons || 0;
    const models = (acct?.byModel || [])
      .filter((r: any) => r.dimensions?.modelId)
      .map((r: any) => ({ modelId: r.dimensions.modelId, neurons: r.sum?.totalNeurons || 0, requests: r.count || 0 }));
    return { totalNeurons: Math.round(totalNeurons), models };
  } catch (e) {
    console.error(`[AI Usage] Failed for ${account.name}: ${e}`);
    throw new Error(`AI usage failed for ${account.name}: ${e}`, { cause: e });
  }
}

interface WorkersUsage { requests: number; errors: number; subrequests: number; cpuTimeMs: number }

async function getWorkersUsageToday(account: Account, encryptionKey: string): Promise<WorkersUsage> {
  if (!account.account_id) return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  const now = new Date();
  const todayDate = now.toISOString().substring(0, 10);
  const datetimeStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const datetimeEnd = now.toISOString();

  const query = `query($accountTag:string!,$datetimeStart:Time!,$datetimeEnd:Time!,$todayDate:Date!){viewer{accounts(filter:{accountTag:$accountTag}){workers:workersInvocationsAdaptive(filter:{datetime_geq:$datetimeStart,datetime_leq:$datetimeEnd},limit:10000){sum{requests,errors,subrequests,cpuTimeUs}}pages:pagesFunctionsInvocationsAdaptiveGroups(filter:{date:$todayDate},limit:1){sum{requests,errors}}}}}`;

  try {
    const json = await cfGraphQL(account, query, { accountTag: account.account_id, datetimeStart, datetimeEnd, todayDate }, encryptionKey);
    const acct = json?.data?.viewer?.accounts?.[0];
    const workerRecs = acct?.workers || [];
    const pagesRecs = acct?.pages || [];
    let requests = 0, errors = 0, subrequests = 0, cpuTimeUs = 0;
    for (const r of workerRecs) { requests += r.sum?.requests || 0; errors += r.sum?.errors || 0; subrequests += r.sum?.subrequests || 0; cpuTimeUs += r.sum?.cpuTimeUs || 0; }
    for (const r of pagesRecs) { requests += r.sum?.requests || 0; errors += r.sum?.errors || 0; }
    return { requests, errors, subrequests, cpuTimeMs: Math.round(cpuTimeUs / 1000) };
  } catch (e) {
    console.error(`[Workers Usage] Failed for ${account.name}: ${e}`);
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  }
}

export { getWorkersUsageToday };
