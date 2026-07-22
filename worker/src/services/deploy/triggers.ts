import type { Account } from '../../db/models';
import { getDeployHeaders } from './headers';

const CF_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * 部署触发器 — Cron Schedules + Custom Routes。
 * 所有操作均为软失败。
 */
export async function deployTriggers(
  account: Account,
  encryptionKey: string,
  scriptName: string,
  crons: string[],
  routes: string[],
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const accountId = account.account_id;
  const deployHeaders = await getDeployHeaders(account, encryptionKey);

  // 1. Cron Schedules
  if (crons && crons.length > 0) {
    try {
      const resp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/schedules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...deployHeaders },
        body: JSON.stringify(crons.map(c => ({ cron: c }))),
      });
      if (!resp.ok) {
        const body = await resp.text();
        warnings.push(`定时任务注册失败: ${resp.status} ${body.slice(0, 200)}`);
      } else {
        console.log(`[Triggers] Cron triggers set for ${scriptName}: ${crons.join(', ')}`);
      }
    } catch (e: any) {
      warnings.push(`定时任务注册失败: ${e.message}`);
    }
  }

  // 2. Custom Routes
  if (routes && routes.length > 0) {
    for (const pattern of routes) {
      try {
        const hostname = pattern.split('/')[0];
        // List zones to find matching zone
        const zonesResp = await fetch(`${CF_BASE}/zones?account_id=${accountId}`, {
          headers: { ...deployHeaders },
        });
        if (!zonesResp.ok) {
          warnings.push(`路由 ${pattern} 创建失败: 无法获取 zone 列表`);
          continue;
        }
        const zonesJson = await zonesResp.json() as any;
        const zones = zonesJson?.result || [];
        const zone = zones.find((z: any) => z.name === hostname || hostname.endsWith('.' + z.name));
        if (!zone) {
          warnings.push(`路由 ${pattern} 创建失败: 未找到 zone`);
          continue;
        }
        const routeResp = await fetch(`${CF_BASE}/zones/${zone.id}/workers/routes`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...deployHeaders },
          body: JSON.stringify({ pattern, script: scriptName }),
        });
        if (!routeResp.ok) {
          const body = await routeResp.text();
          warnings.push(`路由 ${pattern} 创建失败: ${routeResp.status} ${body.slice(0, 200)}`);
        }
      } catch (e: any) {
        warnings.push(`路由 ${pattern} 创建失败: ${e.message}`);
      }
    }
  }

  return { warnings };
}
