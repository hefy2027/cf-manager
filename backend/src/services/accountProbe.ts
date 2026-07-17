import { Account } from '../models/account';
import { getCfClient } from './cfFactory';
import { appLogger } from './logger';

/**
 * 探测账户可用的付费功能（首期仅 R2）。
 * 返回逗号分隔字符串：r2=支持，-r2=不支持，空串=未探测。
 */
export async function probeAvailableFeatures(account: Account): Promise<string> {
  if (!account.account_id) return '';
  const results: string[] = [];

  // R2 探测
  try {
    const cf = getCfClient(account);
    await cf.r2.buckets.list({ account_id: account.account_id });
    results.push('r2');
  } catch (e: any) {
    const msg = e?.message || '';
    if (msg.includes('10042') || msg.includes('enable R2') || msg.includes('Please enable R2')) {
      results.push('-r2');
    } else {
      appLogger.warn(`[Probe] R2 check failed for account ${account.id}: ${e}`);
    }
  }

  return results.join(',');
}
