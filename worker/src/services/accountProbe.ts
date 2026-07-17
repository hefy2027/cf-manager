import type { Account } from '../db/models';
import { cfFetch } from './cfApi';

/**
 * 探测账户可用的付费功能（首期仅 R2）。
 * 返回逗号分隔字符串：r2=支持，-r2=不支持，空串=未探测。
 */
export async function probeAvailableFeatures(account: Account, encryptionKey: string): Promise<string> {
  if (!account.account_id) return '';
  const results: string[] = [];

  // R2 探测
  try {
    await cfFetch(account, `/accounts/${account.account_id}/r2/buckets`, encryptionKey);
    results.push('r2');
  } catch (e: any) {
    const body = e?.body || e?.message || '';
    if (body.includes('10042') || body.includes('enable R2') || body.includes('Please enable R2')) {
      results.push('-r2');
    } else {
      console.warn(`[Probe] R2 check failed for account ${account.id}: ${e}`);
    }
  }

  return results.join(',');
}
