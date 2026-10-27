import { Account } from '../models/account';
import { getCfClient, getAuthHeaders } from './cfFactory';
import { CfHttpError } from './cfError';
import { clearCache } from './accountRouter';
import { appLogger } from './logger';
import { getHttpAgentForAccount } from './proxyService';

/** 支持的 Zone 设置项映射 */
const SETTING_PATHS: Record<string, string> = {
  ssl: 'ssl',
  always_use_https: 'always_use_https',
  security_level: 'security_level',
  automatic_https_rewrites: 'automatic_https_rewrites',
  cache_level: 'cache_level',
  browser_cache_ttl: 'browser_cache_ttl',
  development_mode: 'development_mode',
  minify: 'minify',
  brotli: 'brotli',
  zero_rtt: '0rtt',
};

/** CF REST API 基地址 */
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

/** 直接调用 CF REST API 的辅助函数 */
async function cfZoneApi(
  account: Account,
  method: string,
  path: string,
  body?: unknown
): Promise<any> {
  const headers = getAuthHeaders(account);
  const httpAgent = getHttpAgentForAccount(account);
  const resp = await fetch(`${CF_API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(httpAgent ? { agent: httpAgent } : {}),
  });
  if (!resp.ok) {
    const respBody = await resp.text();
    throw new CfHttpError(resp.status, respBody);
  }
  const data = await resp.json() as any;
  return data?.result ?? data;
}

/**
 * 获取 Zone 设置（修复版）。
 * 一次性调用 GET /zones/:zoneId/settings 获取全部设置，再过滤出需要的字段。
 */
export async function getZoneSettings(account: Account, zoneId: string): Promise<Record<string, any>> {
  try {
    const allSettings = await cfZoneApi(account, 'GET', `/zones/${zoneId}/settings`);
    // allSettings 是一个数组，每项 { id, value, ... }
    const settingsMap: Record<string, any> = {};
    if (Array.isArray(allSettings)) {
      for (const item of allSettings) {
        if (item.id && item.id in SETTING_PATHS) {
          settingsMap[item.id] = item.value;
        }
      }
    }
    return settingsMap;
  } catch (err) {
    appLogger.warn(`Failed to fetch zone settings for zone ${zoneId}: ${err}`);
    return {};
  }
}

/** 创建 Zone */
export async function createZone(
  account: Account,
  name: string,
  type: 'full' | 'partial'
): Promise<{ zone_id: string; name_servers: string[] }> {
  const cf = getCfClient(account);
  if (!account.account_id) throw new Error(`Account ${account.id} is missing account_id`);

  const zone = await cf.zones.create({
    name,
    account: { id: account.account_id },
    type,
  } as any) as any;

  return {
    zone_id: zone.id,
    name_servers: zone.name_servers || [],
  };
}

/** 删除 Zone */
export async function deleteZone(account: Account, zoneId: string): Promise<void> {
  const cf = getCfClient(account);
  await cf.zones.delete({ zone_id: zoneId } as any);
}

/** 更新 Zone 设置（批量，best-effort） */
export async function updateZoneSettings(
  account: Account,
  zoneId: string,
  settings: Record<string, any>
): Promise<{ updated: string[]; failed: string[] }> {
  const updated: string[] = [];
  const failed: string[] = [];

  for (const [key, value] of Object.entries(settings)) {
    const path = SETTING_PATHS[key];
    if (!path) {
      failed.push(key);
      continue;
    }
    try {
      await cfZoneApi(account, 'PATCH', `/zones/${zoneId}/settings/${path}`, { value });
      updated.push(key);
    } catch (err) {
      appLogger.warn(`Failed to update zone setting ${key} for zone ${zoneId}: ${err}`);
      failed.push(key);
    }
  }

  return { updated, failed };
}

/** 清除 Zone 缓存 */
export async function purgeZoneCache(
  account: Account,
  zoneId: string,
  options: { purge_everything?: boolean; files?: string[] }
): Promise<{ id: string }> {
  const result = await cfZoneApi(account, 'POST', `/zones/${zoneId}/purge_cache`, options);
  return { id: result?.id || '' };
}

/** 暂停/激活 Zone */
export async function setZoneStatus(
  account: Account,
  zoneId: string,
  paused: boolean
): Promise<void> {
  const cf = getCfClient(account);
  await cf.zones.edit({ zone_id: zoneId, paused } as any);
}

/** 清除 zones 缓存（创建/删除后调用） */
export function invalidateZonesCache(): void {
  clearCache();
}

/** 更新 DNS 记录代理状态（保留现有功能） */
export async function updateProxyStatus(account: Account, zoneId: string, recordId: string, proxied: boolean): Promise<void> {
  const cf = getCfClient(account);
  await cf.dns.records.edit(recordId, { zone_id: zoneId, proxied } as any);
}
