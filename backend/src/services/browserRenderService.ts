import { Account } from '../models/account';
import { getAuthHeaders } from './cfFactory';
import { trackUsage } from './quotaTracker';
import { proxyFetch } from './proxyService';

export type RenderMode = 'screenshot' | 'content' | 'markdown' | 'pdf' | 'links';

export interface RenderResult {
  mode: RenderMode;
  screenshot?: string;
  html?: string;
  markdown?: string;
  pdf?: string;
  links?: string[];
  duration: number;
  browserMsUsed?: number;
}

export async function renderPage(
  account: Account,
  url: string,
  mode: RenderMode = 'screenshot'
): Promise<RenderResult> {
  const accountId = account.account_id;
  const headers = getAuthHeaders(account);
  const startTime = Date.now();
  const result: RenderResult = { mode, duration: 0 };

  const body: Record<string, any> = { url };

  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/browser-rendering/${mode}`;
  const resp = await proxyFetch(endpoint, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errorBrowserMs = parseInt(resp.headers.get('x-browser-ms-used') || '0', 10);
    if (errorBrowserMs > 0) {
      trackUsage(account.id, 'browser_render_seconds', Math.ceil(errorBrowserMs / 1000));
    }
    const retryAfter = parseInt(resp.headers.get('retry-after') || '0', 10);
    const text = await resp.text();
    const err = new Error(`${mode} 失败 (${resp.status}): ${text}`);
    (err as any).statusCode = resp.status;
    (err as any).retryAfter = retryAfter;
    throw err;
  }

  const contentType = resp.headers.get('content-type') || '';

  switch (mode) {
    case 'screenshot': {
      const buf = Buffer.from(await resp.arrayBuffer());
      result.screenshot = `data:image/png;base64,${buf.toString('base64')}`;
      break;
    }
    case 'pdf': {
      const buf = Buffer.from(await resp.arrayBuffer());
      result.pdf = `data:application/pdf;base64,${buf.toString('base64')}`;
      break;
    }
    case 'content': {
      if (contentType.includes('application/json')) {
        const json = await resp.json() as any;
        result.html = json.result || JSON.stringify(json);
      } else {
        result.html = await resp.text();
      }
      break;
    }
    case 'markdown': {
      if (contentType.includes('application/json')) {
        const json = await resp.json() as any;
        result.markdown = json.result || JSON.stringify(json);
      } else {
        result.markdown = await resp.text();
      }
      break;
    }
    case 'links': {
      const json = await resp.json() as any;
      result.links = json.result ?? json;
      break;
    }
  }

  const browserMsUsed = parseInt(resp.headers.get('x-browser-ms-used') || '0', 10);
  const browserSeconds = browserMsUsed > 0 ? browserMsUsed / 1000 : (Date.now() - startTime) / 1000;
  result.duration = browserSeconds;
  result.browserMsUsed = browserMsUsed;
  trackUsage(account.id, 'browser_render_seconds', Math.ceil(browserSeconds));
  return result;
}
