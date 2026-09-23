import type { Account } from '../db/models';
import { cfFetchRaw } from './cfApi';
import { logger } from './logger';

/**
 * 账号级 workers.dev 子域名（/accounts/{id}/workers/subdomain）。
 *
 * 这是**账号级设置**且全 Cloudflare 唯一：账号未注册子域名时，该账号下任何 Worker 都无法
 * 通过 *.workers.dev 访问（脚本级 /workers/scripts/{name}/subdomain 开关也会失败）。
 * 部署 Worker 时顺手注册，可以省掉"先去 CF 后台手动设置子域名"这一步。
 *
 * 与 backend/src/services/workerSubdomain.ts 保持同构。
 */

const MAX_SUBDOMAIN_LENGTH = 63;

/** 读取账号当前已注册的子域名；未注册或读取失败返回 ''。 */
export async function getAccountSubdomain(account: Account, encryptionKey: string): Promise<string> {
  if (!account.account_id) return '';
  try {
    const resp = await cfFetchRaw(account, `/accounts/${account.account_id}/workers/subdomain`, encryptionKey);
    if (!resp.ok) return '';
    const json = await resp.json() as any;
    return json?.result?.subdomain || '';
  } catch {
    return '';
  }
}

/** 由邮箱/账号名推导子域名前缀；无可用字符时返回 ''。 */
export function subdomainPrefix(account: Account): string {
  const raw = (account.email || account.name || '').split('@')[0].toLowerCase();
  return raw.replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, MAX_SUBDOMAIN_LENGTH);
}

/** 候选前缀：先试原前缀，撞名时追加短随机后缀再试。 */
function* candidatePrefixes(base: string): Generator<string> {
  yield base;
  for (const len of [4, 8]) {
    const suffix = Math.random().toString(36).slice(2, 2 + len);
    yield `${base.slice(0, MAX_SUBDOMAIN_LENGTH - len - 1)}-${suffix}`;
  }
}

/**
 * 判断失败是否是"该子域名不可用"（被占用/非法），以便换候选重试。
 * CF 的错误形态未穷举，这里按状态码 + 关键词尽力匹配；匹配不到则视为真实错误直接返回。
 */
function looksLikeUnavailable(status: number, body: string): boolean {
  if (status === 409) return true;
  return /taken|already|exist|occupied|unavailable|in use|not available/i.test(body);
}

/**
 * 确保账号已注册 workers.dev 子域名：已有则直接返回；没有则用「邮箱/名称前缀」注册，
 * 撞名时退化为「前缀-随机后缀」。不抛异常，失败通过 error 字段返回，由调用方决定如何上报。
 */
export async function ensureAccountSubdomain(account: Account, encryptionKey: string): Promise<{ subdomain: string; error?: string }> {
  const existing = await getAccountSubdomain(account, encryptionKey);
  if (existing) return { subdomain: existing };

  if (!account.account_id) return { subdomain: '', error: '账号缺少 Cloudflare Account ID' };
  const base = subdomainPrefix(account);
  if (!base) return { subdomain: '', error: '无法由邮箱/名称推导出可用的子域名前缀' };

  const path = `/accounts/${account.account_id}/workers/subdomain`;
  let lastError = '';

  for (const prefix of candidatePrefixes(base)) {
    try {
      const resp = await cfFetchRaw(account, path, encryptionKey, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subdomain: prefix }),
      });

      if (resp.ok) {
        const json = await resp.json() as any;
        const subdomain = json?.result?.subdomain || prefix;
        logger.info('WorkerSubdomain', `Registered workers.dev subdomain "${subdomain}" for account "${account.name}"`);
        return { subdomain };
      }

      const body = (await resp.text()).slice(0, 300);
      lastError = `HTTP ${resp.status}: ${body}`;
      if (!looksLikeUnavailable(resp.status, body)) {
        logger.warn('WorkerSubdomain', `Failed to register subdomain="${prefix}" for "${account.name}": ${lastError}`);
        return { subdomain: '', error: lastError };
      }
      logger.info('WorkerSubdomain', `"subdomain=${prefix}" unavailable for "${account.name}", trying next candidate`);
    } catch (err: any) {
      lastError = err?.message || String(err);
      logger.warn('WorkerSubdomain', `subdomain registration error for "${account.name}": ${lastError}`);
      return { subdomain: '', error: lastError };
    }
  }

  logger.warn('WorkerSubdomain', `All subdomain candidates are taken for "${account.name}": ${lastError}`);
  return { subdomain: '', error: lastError || '所有候选子域名均不可用' };
}
