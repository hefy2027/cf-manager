import { Account } from '../../models/account';
import { getAuthHeaders } from '../cfFactory';

const WRANGLER_UA = 'wrangler/4.112.0';

/** 部署专用 headers — 在常规 auth headers 基础上追加 wrangler UA */
export function getDeployHeaders(account: Account): Record<string, string> {
  return { ...getAuthHeaders(account), 'User-Agent': WRANGLER_UA };
}
