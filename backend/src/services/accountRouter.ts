import NodeCache from 'node-cache';
import { getActiveAccounts, getActiveAccountsByFeature, Account, AccountFeature, hasFeature } from '../models/account';
import { getCfClient } from './cfFactory';
import { getAccountQuota, ResourceType } from './quotaTracker';
import { getAiUsageToday } from './aiService';
import { appLogger } from './logger';

const ZONES_CACHE_TTL = 300; // 5 minutes
const QUOTA_CACHE_TTL = 60;  // 1 minute

interface Zone {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
}

const zonesCache = new NodeCache({ stdTTL: ZONES_CACHE_TTL });
const quotaCache = new NodeCache({ stdTTL: QUOTA_CACHE_TTL });

export async function getAllZones(): Promise<Array<Zone & { cfAccountId: number; accountName: string }>> {
  const cacheKey = 'all_zones';
  const cached = zonesCache.get<Array<Zone & { cfAccountId: number; accountName: string }>>(cacheKey);
  if (cached) return cached;

  const accounts = getActiveAccountsByFeature('dns');

  const results = await Promise.all(accounts.map(async (account) => {
    try {
      const cf = getCfClient(account);
      const zones: Zone[] = [];
      for await (const zone of cf.zones.list({ per_page: 100 })) {
        zones.push(zone as any);
      }
      return zones.map(zone => ({ ...zone, cfAccountId: account.id, accountName: account.name }));
    } catch (err) {
      appLogger.error(`Failed to fetch zones for account ${account.name}: ${err}`);
      return [];
    }
  }));
  const allZones = results.flat();

  zonesCache.set(cacheKey, allZones);
  return allZones;
}

export async function findAccountByDomain(domain: string): Promise<{ account: Account; zoneId: string }> {
  const zones = await getAllZones();
  const zone = zones.find(z => z.name === domain);
  if (!zone) {
    throw Object.assign(new Error(`Domain ${domain} not found in any account`), { statusCode: 404, code: 'DOMAIN_NOT_FOUND' });
  }
  const account = getActiveAccounts().find(a => a.id === zone.cfAccountId);
  if (!account) {
    throw Object.assign(new Error('Account not found'), { statusCode: 500, code: 'ACCOUNT_NOT_FOUND' });
  }
  return { account, zoneId: zone.id };
}

const AI_NEURON_LIMIT = 10000;

const RESOURCE_FEATURE_MAP: Record<ResourceType, AccountFeature> = {
  ai_neurons: 'ai',
  workers_requests: 'workers',
  browser_render_seconds: 'browser_render',
};

export async function selectBestAccount(resource: ResourceType): Promise<Account> {
  const cacheKey = `best_account_${resource}`;
  const cached = quotaCache.get<{ account: Account }>(cacheKey);
  if (cached) return cached.account;

  const feature = RESOURCE_FEATURE_MAP[resource];
  const accounts = feature ? getActiveAccountsByFeature(feature) : getActiveAccounts();
  if (accounts.length === 0) {
    throw Object.assign(new Error('No active accounts'), { statusCode: 400, code: 'NO_ACCOUNTS' });
  }

  let best = accounts[0];
  let bestRemaining = -1;

  if (resource === 'ai_neurons') {
    const usageResults = await Promise.all(
      accounts.map(async (account) => {
        try {
          const usage = await getAiUsageToday(account);
          return { account, remaining: AI_NEURON_LIMIT - usage.totalNeurons };
        } catch {
          return { account, remaining: 0 };
        }
      })
    );
    for (const { account, remaining } of usageResults) {
      if (remaining > bestRemaining) {
        bestRemaining = remaining;
        best = account;
      }
    }
  } else {
    for (const account of accounts) {
      const { remaining } = getAccountQuota(account.id, resource);
      if (remaining > bestRemaining) {
        bestRemaining = remaining;
        best = account;
      }
    }
  }

  quotaCache.set(cacheKey, { account: best });
  return best;
}

export async function getAccountsByPriority(resource: ResourceType): Promise<Account[]> {
  const feature = RESOURCE_FEATURE_MAP[resource];
  const accounts = feature ? getActiveAccountsByFeature(feature) : getActiveAccounts();
  if (accounts.length === 0) return [];

  if (resource === 'ai_neurons') {
    const usageResults = await Promise.all(
      accounts.map(async (account) => {
        try {
          const usage = await getAiUsageToday(account);
          return { account, remaining: AI_NEURON_LIMIT - usage.totalNeurons };
        } catch {
          return { account, remaining: 0 };
        }
      })
    );
    return usageResults
      .sort((a, b) => b.remaining - a.remaining)
      .map(r => r.account);
  }

  return accounts
    .map(account => ({ account, remaining: getAccountQuota(account.id, resource).remaining }))
    .sort((a, b) => b.remaining - a.remaining)
    .map(r => r.account);
}

export function clearCache(): void {
  zonesCache.flushAll();
  quotaCache.flushAll();
}
