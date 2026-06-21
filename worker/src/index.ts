import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { responseWrapper } from './middleware/responseWrapper';
import { getRecentLogs } from './db/models';
import { getQuotaSummary, syncUsageFromCloudflare } from './services/quotaTracker';
import { getFakeNginxPage } from './pages/fakeNginx';

import accountsRouter from './routes/accounts';
import dnsRouter from './routes/dns';
import workersRouter from './routes/workers';
import aiRouter from './routes/ai';
import storageRouter from './routes/storage';
import browserRenderRouter from './routes/browserRender';
import settingsRouter from './routes/settings';
import openaiRouter from './routes/openai';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());
app.use('*', errorHandler);
app.use('/api/*', responseWrapper);

app.onError((err: any, c) => {
  const status = err.statusCode || err.status || 500;
  const message = err.message || 'Internal server error';
  console.error(`[OnError] ${c.req.method} ${c.req.path}: ${message}`);
  return c.json({ error: { code: status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_ERROR', message } }, status as any);
});

app.get('/api/health', async (c) => {
  const diag: Record<string, any> = {
    status: 'ok',
    platform: 'cloudflare-workers',
    bindings: {
      DB: !!c.env.DB,
      ENCRYPTION_KEY: !!c.env.ENCRYPTION_KEY,
      API_SECRET: !!c.env.API_SECRET,
      ASSETS: !!c.env.ASSETS,
    },
  };
  if (c.env.DB) {
    try {
      await c.env.DB.prepare('SELECT 1').first();
      diag.db_connected = true;
    } catch (e: any) {
      diag.db_connected = false;
      diag.db_error = e.message;
    }
  }
  return c.json(diag);
});

app.use('/api/*', authMiddleware);

app.route('/api/accounts', accountsRouter);
app.route('/api/dns', dnsRouter);
app.route('/api/workers', workersRouter);
app.route('/api/ai', aiRouter);
app.route('/api/browser-render', browserRenderRouter);
app.route('/api/settings', settingsRouter);
app.route('/api/storage', storageRouter);

app.get('/api/quota', async (c) => {
  await syncUsageFromCloudflare(c.env.DB, c.env.ENCRYPTION_KEY);
  const summary = await getQuotaSummary(c.env.DB, c.env.ENCRYPTION_KEY);
  return c.json(summary);
});

app.get('/api/audit-log', async (c) => {
  const logs = await getRecentLogs(c.env.DB, 20);
  return c.json(logs);
});

app.use('/v1/*', authMiddleware);
app.route('/v1', openaiRouter);

app.get('/admin', (c) => c.redirect('/admin/', 302));

app.all('/admin/*', async (c) => {
  const url = new URL(c.req.url);
  const strippedPath = url.pathname.replace(/^\/admin/, '') || '/';

  if (/\.\w+$/.test(strippedPath)) {
    const assetUrl = new URL(strippedPath, url.origin).toString();
    const res = await c.env.ASSETS.fetch(new Request(assetUrl));
    if (res.status !== 404) {
      return res;
    }
  }

  const index = await c.env.ASSETS.fetch(new Request(new URL('/index.html', url.origin).toString()));
  return new Response(index.body, {
    status: 200,
    headers: new Headers(index.headers),
  });
});

app.all('*', (c) => {
  return c.html(getFakeNginxPage());
});

export default app;
