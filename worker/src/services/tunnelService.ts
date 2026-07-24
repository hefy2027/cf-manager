import type { Account } from '../db/models';
import { cfFetch, cfFetchAll } from './cfApi';

export interface TunnelAccountItem { id: number; name: string; account_id: string; }

export function listTunnelAccounts(accounts: Account[]): TunnelAccountItem[] {
  return accounts.filter((a) => !!a.account_id).map((a) => ({ id: a.id, name: a.name, account_id: a.account_id! }));
}

export async function listTunnels(account: Account, key: string): Promise<any[]> {
  return cfFetchAll<any>(account, `/accounts/${account.account_id}/cfd_tunnel`, key, 50);
}

export async function createTunnel(account: Account, name: string, key: string): Promise<any> {
  return cfFetch(account, `/accounts/${account.account_id}/cfd_tunnel`, key, {
    method: 'POST', body: JSON.stringify({ name, config_src: 'cloudflare' }),
  });
}

export async function deleteTunnel(account: Account, tunnelId: string, key: string): Promise<any> {
  return cfFetch(account, `/accounts/${account.account_id}/cfd_tunnel/${tunnelId}`, key, { method: 'DELETE' });
}

export async function getTunnelToken(account: Account, tunnelId: string, key: string): Promise<string> {
  const res = await cfFetch<{ result: string }>(account, `/accounts/${account.account_id}/cfd_tunnel/${tunnelId}/token`, key);
  return res.result;
}

export async function getTunnelConnections(account: Account, tunnelId: string, key: string): Promise<any> {
  const res = await cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/cfd_tunnel/${tunnelId}/connections`, key);
  return res.result;
}

export async function getTunnelConfig(account: Account, tunnelId: string, key: string): Promise<any[]> {
  const res = await cfFetch<{ result: { config: { ingress: any[] } } }>(account, `/accounts/${account.account_id}/cfd_tunnel/${tunnelId}/configurations`, key);
  return res.result?.config?.ingress ?? [];
}

export async function updateTunnelConfig(account: Account, tunnelId: string, ingress: Array<{ hostname?: string; service: string }>, key: string): Promise<any> {
  return cfFetch(account, `/accounts/${account.account_id}/cfd_tunnel/${tunnelId}/configurations`, key, {
    method: 'PUT', body: JSON.stringify({ config: { ingress } }),
  });
}

/**
 * 获取隧道绑定的域名列表：扫描账户下所有 zone 的 CNAME 记录，
 * 找到 content 为 {tunnelId}.cfargotunnel.com 的记录，返回其 name（hostname）。
 */
export async function listTunnelHostnames(account: Account, tunnelId: string, key: string): Promise<string[]> {
  const target = `${tunnelId}.cfargotunnel.com`;
  const zones = await cfFetchAll<any>(account, '/zones', key, 50);
  const hostnames: string[] = [];
  for (const zone of zones) {
    try {
      const records = await cfFetchAll<any>(account, `/zones/${zone.id}/dns_records?type=CNAME`, key, 100);
      for (const r of records) {
        if (r.content === target) {
          hostnames.push(r.name);
        }
      }
    } catch {
      // 某些 zone 可能无权限，跳过
    }
  }
  return hostnames;
}
