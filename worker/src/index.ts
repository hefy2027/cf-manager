import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { v1ErrorHandler } from './middleware/v1ErrorHandler';
import { requestIdMiddleware } from './middleware/requestId';
import { responseWrapper } from './middleware/responseWrapper';
import { getRecentLogs } from './db/models';
import { getEnabledCatalogSources, updateCatalogSource } from './db/models';
import { getQuotaSummary, syncUsageFromCloudflare, invalidateAiCache } from './services/quotaTracker';
import { getFakeNginxPage } from './pages/fakeNginx';

import accountsRouter from './routes/accounts';
import dnsRouter from './routes/dns';
import workersRouter from './routes/workers';
import storageRouter from './routes/storage';
import browserRenderRouter from './routes/browserRender';
import settingsRouter from './routes/settings';
import openaiRouter from './routes/openai';
import storeRouter from './routes/store';
import tunnelsRouter from './routes/tunnels';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Account-ID'],
  exposeHeaders: ['Content-Length', 'X-Request-Id'],
  maxAge: 86400,
}));
app.use('*', errorHandler);

// OpenAI-compatible routes (MUST be registered BEFORE responseWrapper)
// These routes return OpenAI-standard format and should not be wrapped
app.use('/v1/*', requestIdMiddleware);
app.use('/v1/*', authMiddleware);
app.route('/v1', openaiRouter);
app.use('/v1/*', v1ErrorHandler);

app.use('/api/v1/*', requestIdMiddleware);
app.use('/api/v1/*', authMiddleware);
app.route('/api/v1', openaiRouter);
app.use('/api/v1/*', v1ErrorHandler);

// Other API routes (with responseWrapper)
app.use('/api/*', responseWrapper);
app.use('/api/*', authMiddleware);

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

app.route('/api/accounts', accountsRouter);
app.route('/api/dns', dnsRouter);
app.route('/api/workers', workersRouter);
app.route('/api/browser-render', browserRenderRouter);
app.route('/api/settings', settingsRouter);
app.route('/api/storage', storageRouter);
app.route('/api/store', storeRouter);
app.route('/api/tunnels', tunnelsRouter);

app.get('/api/quota', async (c) => {
  await syncUsageFromCloudflare(c.env.DB, c.env.ENCRYPTION_KEY);
  await invalidateAiCache(c.env);
  const summary = await getQuotaSummary(c.env.DB, c.env.ENCRYPTION_KEY);
  return c.json(summary);
});

app.get('/api/audit-log', async (c) => {
  const logs = await getRecentLogs(c.env.DB, 20);
  return c.json(logs);
});

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

export { app };

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // Periodic catalog refresh every 6 hours
    try {
      const sources = await getEnabledCatalogSources(env.DB);
      for (const source of sources) {
        try {
          const headers: Record<string, string> = {};
          if (source.etag) headers['If-None-Match'] = source.etag;
          const resp = await fetch(source.url, { headers });
          if (resp.status === 304) {
            await updateCatalogSource(env.DB, source.id, {
              last_synced: new Date().toISOString(), last_status: 'ok', last_error: null,
            });
            continue;
          }
          if (!resp.ok) {
            await updateCatalogSource(env.DB, source.id, {
              last_status: 'error', last_error: `HTTP ${resp.status}`,
            });
            continue;
          }
          const json = await resp.json();
          if (env.KV) await env.KV.put(`catalog:${source.id}`, JSON.stringify(json));
          const etag = resp.headers.get('etag');
          await updateCatalogSource(env.DB, source.id, {
            etag: etag || null, last_synced: new Date().toISOString(),
            last_status: 'ok', last_error: null,
          });
        } catch (e: any) {
          await updateCatalogSource(env.DB, source.id, {
            last_status: 'error', last_error: e.message,
          });
        }
      }
    } catch (e) {
      console.error('[Scheduled] Catalog refresh failed:', e);
    }
  },
} satisfies ExportedHandler<Env>;
