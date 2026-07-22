import { Account } from '../../models/account';
import { getDeployHeaders } from './headers';
import { getCfClient } from '../cfFactory';
import { appLogger } from '../logger';

const CF_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * 部署触发器 — Cron Schedules + Custom Routes。
 * 所有操作均为软失败（失败仅记录 warning，不中断部署）。
 */
export async function deployTriggers(
  account: Account,
  scriptName: string,
  crons: string[],
  routes: string[],
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const accountId = account.account_id!;

  // 1. Cron Schedules（仅 Worker 脚本支持）
  if (crons && crons.length > 0) {
    try {
      const cf = getCfClient(account);
      const res = await cf.workers.scripts.schedules.update(scriptName, {
        account_id: accountId,
        body: crons.map(c => ({ cron: c })),
      });
      const ok = (res as any)?.success === true || Array.isArray((res as any)?.schedules) || Array.isArray((res as any)?.result?.schedules);
      if (!ok) {
        warnings.push(`定时任务注册失败: ${JSON.stringify((res as any)?.errors || res)}`);
      } else {
        appLogger.info(`[Triggers] Cron triggers set for ${scriptName}: ${crons.join(', ')}`);
      }
    } catch (e: any) {
      warnings.push(`定时任务注册失败: ${e.message}`);
    }
  }

  // 2. Custom Routes
  if (routes && routes.length > 0) {
    const cf = getCfClient(account);
    for (const pattern of routes) {
      try {
        const hostname = pattern.split('/')[0];
        const zones: any[] = [];
        for await (const z of (cf.zones.list as any)({ account_id: accountId })) {
          zones.push(z);
        }
        const zone = zones.find(z => z.name === hostname || hostname.endsWith('.' + z.name));
        if (!zone) {
          warnings.push(`路由 ${pattern} 创建失败: 未找到 zone`);
          continue;
        }
        await cf.workers.routes.create({ zone_id: zone.id, pattern, script: scriptName });
      } catch (e: any) {
        warnings.push(`路由 ${pattern} 创建失败: ${e.message}`);
      }
    }
  }

  return { warnings };
}
