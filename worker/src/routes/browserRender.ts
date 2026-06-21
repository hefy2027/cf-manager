import { Hono } from 'hono';
import type { Env } from '../types';
import { getAccountById, addAuditLog } from '../db/models';
import { getAuthHeaders } from '../services/cfApi';
import { selectBestAccount, trackUsage } from '../services/quotaTracker';

type RenderMode = 'screenshot' | 'content' | 'markdown' | 'pdf' | 'links';
const VALID_MODES: RenderMode[] = ['screenshot', 'content', 'markdown', 'pdf', 'links'];

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const app = new Hono<{ Bindings: Env }>();

app.post('/', async (c) => {
  const { url, mode = 'screenshot', accountId } = await c.req.json();

  if (!url || typeof url !== 'string') return c.json({ error: { message: 'url is required', code: 'INVALID_REQUEST' } }, 400);
  if (!VALID_MODES.includes(mode)) return c.json({ error: { message: `Invalid mode: ${mode}`, code: 'INVALID_MODE' } }, 400);

  const account = accountId
    ? await getAccountById(c.env.DB, accountId)
    : await selectBestAccount(c.env.DB, c.env.ENCRYPTION_KEY, 'browser_render_seconds');

  if (!account) return c.json({ error: { message: 'No available account', code: 'NO_ACCOUNTS' } }, 503);

  const headers = await getAuthHeaders(account, c.env.ENCRYPTION_KEY);
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/browser-rendering/${mode}`;
  const startTime = Date.now();

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });

  if (!resp.ok) {
    const browserMs = parseInt(resp.headers.get('x-browser-ms-used') || '0', 10);
    if (browserMs > 0) await trackUsage(c.env.DB, account.id, 'browser_render_seconds', Math.ceil(browserMs / 1000));
    const text = await resp.text();
    return c.json({ error: { message: `${mode} failed (${resp.status}): ${text}`, code: 'RENDER_FAILED' } }, resp.status as any);
  }

  const browserMsUsed = parseInt(resp.headers.get('x-browser-ms-used') || '0', 10);
  const duration = browserMsUsed > 0 ? browserMsUsed / 1000 : (Date.now() - startTime) / 1000;
  await trackUsage(c.env.DB, account.id, 'browser_render_seconds', Math.ceil(duration));

  const contentType = resp.headers.get('content-type') || '';
  const result: any = { mode, duration, browserMsUsed };

  switch (mode) {
    case 'screenshot': {
      const buf = await resp.arrayBuffer();
      result.screenshot = `data:image/png;base64,${arrayBufferToBase64(buf)}`;
      break;
    }
    case 'pdf': {
      const buf = await resp.arrayBuffer();
      result.pdf = `data:application/pdf;base64,${arrayBufferToBase64(buf)}`;
      break;
    }
    case 'content': {
      if (contentType.includes('application/json')) {
        const json = await resp.json() as any;
        result.html = json.result || JSON.stringify(json);
      } else { result.html = await resp.text(); }
      break;
    }
    case 'markdown': {
      if (contentType.includes('application/json')) {
        const json = await resp.json() as any;
        result.markdown = json.result || JSON.stringify(json);
      } else { result.markdown = await resp.text(); }
      break;
    }
    case 'links': {
      const json = await resp.json() as any;
      result.links = json.result ?? json;
      break;
    }
  }

  await addAuditLog(c.env.DB, { account_id: account.id, action: 'browser_render', target: url, detail: `mode=${mode} ${browserMsUsed}ms`, status: 'success' });
  return c.json(result);
});

export default app;
