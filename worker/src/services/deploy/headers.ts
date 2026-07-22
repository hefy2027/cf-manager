import type { Account } from '../../db/models';
import { getAuthHeaders } from '../cfApi';

const WRANGLER_UA = 'wrangler/4.112.0';

/** 部署专用 headers — 在常规 auth headers 基础上追加 wrangler UA */
export async function getDeployHeaders(account: Account, encryptionKey: string): Promise<Record<string, string>> {
  return { ...(await getAuthHeaders(account, encryptionKey)), 'User-Agent': WRANGLER_UA };
}
