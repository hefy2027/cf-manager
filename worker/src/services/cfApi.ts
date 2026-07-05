import type { Account } from '../db/models';
import { decrypt } from './encryption';
import { logger } from './logger';

export class CfApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`CF API error ${status}: ${body}`);
    this.status = status;
    this.body = body;
  }
}

export async function getAuthHeaders(account: Account, encryptionKey: string): Promise<Record<string, string>> {
  if (account.auth_type === 'token') {
    if (!account.api_token) throw new Error(`Account ${account.id} missing api_token`);
    const token = await decrypt(account.api_token, encryptionKey);
    return { Authorization: `Bearer ${token}` };
  }
  if (!account.api_key) throw new Error(`Account ${account.id} missing api_key`);
  if (!account.email) throw new Error(`Account ${account.id} missing email`);
  const apiKey = await decrypt(account.api_key, encryptionKey);
  return { 'X-Auth-Email': account.email, 'X-Auth-Key': apiKey };
}

const CF_BASE = 'https://api.cloudflare.com/client/v4';

export async function cfFetch<T = any>(
  account: Account,
  path: string,
  encryptionKey: string,
  init?: RequestInit
): Promise<T> {
  const headers = await getAuthHeaders(account, encryptionKey);
  const resp = await fetch(`${CF_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...headers, ...(init?.headers as Record<string, string> || {}) },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new CfApiError(resp.status, body);
  }
  return resp.json() as Promise<T>;
}

export async function cfFetchRaw(
  account: Account,
  path: string,
  encryptionKey: string,
  init?: RequestInit
): Promise<Response> {
  const headers = await getAuthHeaders(account, encryptionKey);
  return fetch(`${CF_BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> || {}) },
  });
}

export async function cfGraphQL(
  account: Account,
  query: string,
  variables: Record<string, unknown>,
  encryptionKey: string
): Promise<any> {
  const headers = await getAuthHeaders(account, encryptionKey);
  const resp = await fetch(`${CF_BASE}/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ query, variables }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new CfApiError(resp.status, body);
  }
  const json = await resp.json() as any;
  if (json.errors?.length) {
    const msg = `GraphQL errors for account ${account.id} (${account.name}): ${JSON.stringify(json.errors)}`;
    logger.error('cfApi', msg);
    throw new Error(msg);
  }
  return json;
}

interface CfListResponse<T> {
  result: T[];
  result_info?: { page: number; per_page: number; total_pages: number; total_count: number };
}

export async function cfFetchAll<T>(
  account: Account,
  path: string,
  encryptionKey: string,
  perPage = 50
): Promise<T[]> {
  const all: T[] = [];
  let page = 1;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await cfFetch<CfListResponse<T>>(account, `${path}${sep}page=${page}&per_page=${perPage}`, encryptionKey);
    all.push(...(data.result || []));
    if (!data.result_info || page >= data.result_info.total_pages) break;
    page++;
  }
  return all;
}
