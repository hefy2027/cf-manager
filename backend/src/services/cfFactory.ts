import Cloudflare from 'cloudflare';
import { Account } from '../models/account';
import { decrypt, DecryptError } from './encryptionService';
import { getHttpAgentForAccount } from './proxyService';

/** 错误提示里用的账号标识：让用户在几十个账号里知道是哪一个坏了。 */
function accountLabel(account: Account): string {
  return account.name ? `${account.name} (ID ${account.id})` : `ID ${account.id}`;
}

/**
 * 解密账号凭据。解密失败时补上账号标识后继续抛 DecryptError，
 * 让上层（errorHandler / 前端提示）能直接告诉用户「哪个账号、该怎么办」。
 */
function decryptCredential(value: string, account: Account): string {
  try {
    return decrypt(value);
  } catch (err) {
    if (err instanceof DecryptError) throw new DecryptError(accountLabel(account), err);
    throw err;
  }
}

export function getAuthHeaders(account: Account): Record<string, string> {
  if (account.auth_type === 'token') {
    if (!account.api_token) throw new Error(`Account ${account.id} is missing api_token`);
    return { 'Authorization': `Bearer ${decryptCredential(account.api_token, account)}` };
  }
  if (!account.api_key) throw new Error(`Account ${account.id} is missing api_key`);
  if (!account.email) throw new Error(`Account ${account.id} is missing email`);
  return { 'X-Auth-Email': account.email, 'X-Auth-Key': decryptCredential(account.api_key, account) };
}

export function getCfClient(account: Account): Cloudflare {
  const httpAgent = getHttpAgentForAccount(account);
  const opts: Record<string, any> = {};
  if (httpAgent) opts.httpAgent = httpAgent;

  if (account.auth_type === 'token') {
    if (!account.api_token) throw new Error(`Account ${account.id} is missing api_token`);
    return new Cloudflare({ apiToken: decryptCredential(account.api_token, account), ...opts });
  }
  if (!account.api_key) throw new Error(`Account ${account.id} is missing api_key`);
  if (!account.email) throw new Error(`Account ${account.id} is missing email`);
  return new Cloudflare({ apiKey: decryptCredential(account.api_key, account), apiEmail: account.email, ...opts });
}

export function clearClientCache(): void {
  // No-op since we're not caching anymore
}
