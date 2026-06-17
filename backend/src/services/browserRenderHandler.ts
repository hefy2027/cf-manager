import { Account, getAccountById } from '../models/account';
import { renderPage, RenderMode, RenderResult } from './browserRenderService';
import { acquireToken, markAccountExhausted } from './browserRateLimiter';
import { createAuditLog } from '../models/auditLog';

const VALID_MODES: RenderMode[] = ['screenshot', 'content', 'markdown', 'pdf', 'links'];

export interface BrowserRenderRequest {
  url: string;
  mode?: RenderMode;
  accountId?: number;
}

export interface BrowserRenderResponse {
  success: boolean;
  result?: RenderResult;
  error?: { message: string; code: string; waitMs?: number };
}

const DAILY_LIMIT_RETRY_AFTER_THRESHOLD = 60;

function isDailyLimitError(msg: string, retryAfter: number): boolean {
  if (msg.includes('Browser time limit exceeded') || msg.includes('browser limit')) {
    return true;
  }
  if (retryAfter > DAILY_LIMIT_RETRY_AFTER_THRESHOLD) {
    return true;
  }
  return false;
}

export async function handleBrowserRender(req: BrowserRenderRequest): Promise<{ status: number; body: BrowserRenderResponse }> {
  const { url, mode = 'screenshot', accountId } = req;

  if (!url || typeof url !== 'string') {
    return { status: 400, body: { success: false, error: { message: 'url is required', code: 'INVALID_REQUEST' } } };
  }
  if (!VALID_MODES.includes(mode)) {
    return { status: 400, body: { success: false, error: { message: `Invalid mode: ${mode}. Supported: ${VALID_MODES.join(', ')}`, code: 'INVALID_MODE' } } };
  }

  let account: Account;

  if (accountId) {
    const found = getAccountById(accountId);
    if (!found) {
      return { status: 404, body: { success: false, error: { message: `Account ${accountId} not found`, code: 'ACCOUNT_NOT_FOUND' } } };
    }
    account = found;
  } else {
    const token = acquireToken();

    if (token.type === 'all_exhausted') {
      return { status: 429, body: { success: false, error: { message: '所有账户今日浏览器渲染配额已耗尽', code: 'ALL_ACCOUNTS_EXHAUSTED' } } };
    }
    if (token.type === 'rate_limited') {
      return { status: 429, body: { success: false, error: { message: `请求过于频繁，请等待 ${Math.ceil(token.waitMs / 1000)} 秒后重试`, code: 'RATE_LIMITED', waitMs: token.waitMs } } };
    }
    account = token.account;
  }

  try {
    const result = await renderPage(account, url, mode);
    createAuditLog(account.id, 'browser_render', url, `mode=${mode} ${result.browserMsUsed || 0}ms`, 'success');
    return { status: 200, body: { success: true, result } };
  } catch (err: any) {
    const msg = err?.message || '';
    const statusCode = err?.statusCode || 500;
    const retryAfter: number = err?.retryAfter || 0;

    if (isDailyLimitError(msg, retryAfter)) {
      markAccountExhausted(account.id);
      createAuditLog(account.id, 'browser_render', url, 'daily limit exceeded', 'error');

      if (!accountId) {
        const retry = acquireToken();
        if (retry.type === 'ok') {
          try {
            const result = await renderPage(retry.account, url, mode);
            createAuditLog(retry.account.id, 'browser_render', url, `mode=${mode} retry ${result.browserMsUsed || 0}ms`, 'success');
            return { status: 200, body: { success: true, result } };
          } catch (retryErr: any) {
            return { status: retryErr?.statusCode || 500, body: { success: false, error: { message: retryErr.message, code: 'RENDER_FAILED' } } };
          }
        }
        if (retry.type === 'rate_limited') {
          return { status: 429, body: { success: false, error: { message: `当前账户已耗尽，备用账户冷却中，请等待 ${Math.ceil(retry.waitMs / 1000)} 秒`, code: 'RATE_LIMITED', waitMs: retry.waitMs } } };
        }
        return { status: 429, body: { success: false, error: { message: '所有账户今日浏览器渲染配额已耗尽', code: 'ALL_ACCOUNTS_EXHAUSTED' } } };
      }
    }

    if (statusCode === 429) {
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : 10_000;
      return { status: 429, body: { success: false, error: { message: msg, code: 'RATE_LIMITED', waitMs } } };
    }
    return { status: statusCode, body: { success: false, error: { message: msg, code: 'RENDER_FAILED' } } };
  }
}
