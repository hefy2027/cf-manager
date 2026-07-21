import { Hono } from 'hono';
import type { Env } from '../types';
import {
  getCatalogSources, getEnabledCatalogSources, getCatalogSourceById,
  createCatalogSource, updateCatalogSource, deleteCatalogSource,
  ensureDefaultCatalogSource, getDefaultCatalogSource,
} from '../db/models';
import { validateCatalog, type Catalog, type CatalogTemplate } from '../services/catalogValidator';
import { deployTemplate } from '../services/catalogDeploy';
import { getAccountById } from '../db/models';
import { assertUrlSafe } from '../services/ssrfGuard';

const app = new Hono<{ Bindings: Env }>();

// 主源用 surge.sh：Surge 静态托管，更新即时生效，避免 jsDelivr 缓存 GitHub 主分支导致更新延迟。
// 兜底顺序：surge.sh → jsDelivr → GitHub raw（GitHub raw 放最后，作为最终兜底）。
const DEFAULT_CATALOG_URL = 'https://cf-store.surge.sh/catalog.json';
const DEFAULT_CATALOG_FALLBACK_URLS = [
  'https://cdn.jsdelivr.net/gh/hefy2027/cf-store@main/catalog.json',
  'https://raw.githubusercontent.com/hefy2027/cf-store/main/catalog.json',
];
const DEFAULT_CATALOG_URLS = [DEFAULT_CATALOG_URL, ...DEFAULT_CATALOG_FALLBACK_URLS];
const DEFAULT_CATALOG_NAME = '官方源';

// KV 缓存 TTL：6 小时，避免脏数据永久驻留
const KV_CACHE_TTL = 6 * 60 * 60;

// ============ Source CRUD ============

// 校验某个 URL 是否为可拉取且格式合法的 catalog（供"添加源"创建前校验与独立测试复用）
interface CatalogUrlTestResult {
  ok: boolean;
  status?: number;
  templateCount?: number;
  errorCode?: string;
  error?: string;
  etag?: string | null;
  json?: any;
}

async function testCatalogUrl(url: string): Promise<CatalogUrlTestResult> {
  if (!url || !url.startsWith('https://')) {
    return { ok: false, errorCode: 'VALIDATION_ERROR', error: 'url must be a valid HTTPS URL' };
  }
  try {
    assertUrlSafe(url);
    const resp = await fetch(url);
    if (!resp.ok) return { ok: false, status: resp.status, errorCode: 'FETCH_ERROR', error: `URL 不可达: HTTP ${resp.status}` };
    const json: any = await resp.json();
    const result = validateCatalog(json);
    if (!result.valid) return { ok: false, errorCode: 'INVALID_CATALOG', error: `不是有效的 catalog: ${result.errors.join('; ')}` };
    return { ok: true, templateCount: Array.isArray(json.templates) ? json.templates.length : 0, etag: resp.headers.get('etag'), json };
  } catch (e: any) {
    return { ok: false, errorCode: 'FETCH_ERROR', error: `拉取校验失败: ${e.message}` };
  }
}

app.get('/sources', async (c) => {
  const sources = await getCatalogSources(c.env.DB);
  return c.json(sources);
});

// 独立测试接口：验证 URL 是否可拉取且符合 catalog 格式（不落库）
app.post('/sources/test', async (c) => {
  const { url } = await c.req.json();
  const result = await testCatalogUrl(url);
  return c.json(result);
});

app.post('/sources', async (c) => {
  const { url, name } = await c.req.json();
  if (!name) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } }, 400);
  }

  // Fetch and validate before saving
  const test = await testCatalogUrl(url);
  if (!test.ok) {
    return c.json({ error: { code: test.errorCode || 'FETCH_ERROR', message: test.error } }, 400);
  }
  const id = await createCatalogSource(c.env.DB, { url, name });
  // Cache the catalog in KV
  if (c.env.KV) {
    await c.env.KV.put(`catalog:${id}`, JSON.stringify(test.json), { expirationTtl: KV_CACHE_TTL });
  }
  if (test.etag) await updateCatalogSource(c.env.DB, id, { etag: test.etag, last_synced: new Date().toISOString(), last_status: 'ok', last_error: null });
  return c.json({ id }, 201);
});

app.put('/sources/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const source = await getCatalogSourceById(c.env.DB, id);
  if (!source) return c.json({ error: { code: 'NOT_FOUND', message: 'Source not found' } }, 404);

  const body = await c.req.json();
  if (source.is_default && body.url && body.url !== source.url) {
    return c.json({ error: { code: 'FORBIDDEN', message: '默认源的 URL 不可修改' } }, 403);
  }

  // If URL changed, re-fetch and validate
  if (body.url && body.url !== source.url) {
    const test = await testCatalogUrl(body.url);
    if (!test.ok) {
      return c.json({ error: { code: test.errorCode || 'FETCH_ERROR', message: test.error } }, 400);
    }
    if (c.env.KV) await c.env.KV.put(`catalog:${id}`, JSON.stringify(test.json), { expirationTtl: KV_CACHE_TTL });
    await updateCatalogSource(c.env.DB, id, {
      ...body, etag: test.etag || null, last_synced: new Date().toISOString(), last_status: 'ok', last_error: null,
    });
  } else {
    await updateCatalogSource(c.env.DB, id, body);
  }
  return c.json({ success: true });
});

app.delete('/sources/:id', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  await deleteCatalogSource(c.env.DB, id);
  if (c.env.KV) await c.env.KV.delete(`catalog:${id}`);
  return c.json({ success: true });
});

// ============ Catalog Fetch ============

// 官方默认源启用 fallback 链；用户自定义源只使用自己的 url
function candidateUrls(source: any): string[] {
  return source.is_default ? DEFAULT_CATALOG_URLS : [source.url];
}

async function fetchSourceCatalog(c: any, source: any): Promise<Catalog | null> {
  return fetchSourceCatalogImpl(c, source, false);
}

// skipCache=true 时跳过 KV 缓存读取，强制从远程拉取（供 /refresh 使用）
async function fetchSourceCatalogImpl(c: any, source: any, skipCache: boolean): Promise<Catalog | null> {
  const getCached = async (): Promise<Catalog | null> => {
    if (c.env.KV) {
      const cached = await c.env.KV.get(`catalog:${source.id}`);
      if (cached) { try { return JSON.parse(cached); } catch {} }
    }
    return null;
  };

  // Try KV cache first (unless force refresh)
  if (!skipCache) {
    const cached = await getCached();
    // 空目录（无模板）不视为有效命中：用户看到空白时应立即重新拉取远程
    if (cached && cached.templates && cached.templates.length > 0) return cached;
  }

  // Fetch from remote with fallback chain
  const urls = candidateUrls(source);
  let lastError = '';
  for (const url of urls) {
    try {
      assertUrlSafe(url);
      const headers: Record<string, string> = {};
      // etag 仅对主记录 url 携带，避免跨地址 etag 误判
      if (url === source.url && source.etag) headers['If-None-Match'] = source.etag;
      const resp = await fetch(url, { headers });

      if (resp.status === 304) {
        await updateCatalogSource(c.env.DB, source.id, {
          last_synced: new Date().toISOString(), last_status: 'ok', last_error: null,
        });
        const c2 = await getCached();
        if (c2) return c2;
        continue; // 缓存缺失，尝试下一个地址
      }

      if (!resp.ok) {
        lastError = `HTTP ${resp.status} (${url})`;
        continue;
      }

      const json = await resp.json();
      const result = validateCatalog(json);
      if (!result.valid) {
        lastError = `Schema invalid: ${result.errors.slice(0, 3).join('; ')} (${url})`;
        continue;
      }

      // Cache + update metadata
      if (c.env.KV) await c.env.KV.put(`catalog:${source.id}`, JSON.stringify(json), { expirationTtl: KV_CACHE_TTL });
      const etag = resp.headers.get('etag');
      await updateCatalogSource(c.env.DB, source.id, {
        etag: etag || null, last_synced: new Date().toISOString(),
        last_status: 'ok', last_error: null,
      });

      return json as Catalog;
    } catch (e: any) {
      lastError = `${e.message} (${url})`;
      continue;
    }
  }
  await updateCatalogSource(c.env.DB, source.id, {
    last_status: 'error', last_error: lastError,
  });
  return null;
}

// ============ Template List (merged + dedup) ============

app.get('/templates', async (c) => {
  const sources = await getEnabledCatalogSources(c.env.DB);

  // Fetch all source catalogs in parallel
  const results = await Promise.all(sources.map(s => fetchSourceCatalog(c, s)));

  // Dedup by id, priority: default source first, then by id ASC
  const seen = new Map<string, { template: CatalogTemplate; sourceId: number; sourceName: string; sourceCount: number }>();
  const idSources = new Map<string, number>();

  for (let i = 0; i < sources.length; i++) {
    const source = sources[i];
    const catalog = results[i];
    if (!catalog || !catalog.templates) continue;

    for (const template of catalog.templates) {
      const existing = idSources.get(template.id) || 0;
      idSources.set(template.id, existing + 1);

      if (!seen.has(template.id)) {
        seen.set(template.id, {
          template, sourceId: source.id, sourceName: source.name, sourceCount: 0,
        });
      }
    }
  }

  // Update source counts
  for (const entry of seen.values()) {
    entry.sourceCount = idSources.get(entry.template.id) || 1;
  }

  const templates = Array.from(seen.values());
  return c.json({ templates, sources });
});

// ============ Force Refresh ============

app.post('/refresh', async (c) => {
  const sources = await getEnabledCatalogSources(c.env.DB);
  const results = await Promise.all(sources.map(async (s) => {
    // Force refresh: clear etag + KV 缓存，确保从远程重新拉取
    if (s.etag) await updateCatalogSource(c.env.DB, s.id, { etag: null });
    if (c.env.KV) await c.env.KV.delete(`catalog:${s.id}`);
    const cat = await fetchSourceCatalogImpl(c, s, true);
    return { id: s.id, name: s.name, success: !!cat };
  }));
  return c.json(results);
});

// ============ Init default source ============

app.get('/init', async (c) => {
  await ensureDefaultCatalogSource(c.env.DB, DEFAULT_CATALOG_URL, DEFAULT_CATALOG_NAME);
  return c.json({ success: true });
});

// ============ Deploy ============

app.post('/deploy', async (c) => {
  const body = await c.req.json();
  const { accountId, templateId, name, bindingSelections, secretValues, deployType, traces, logs } = body;

  if (!accountId || !templateId || !name) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'accountId, templateId, name are required' } }, 400);
  }

  const account = await getAccountById(c.env.DB, accountId);
  if (!account) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

  // Find template from enabled sources
  const sources = await getEnabledCatalogSources(c.env.DB);
  let template: CatalogTemplate | null = null;
  for (const source of sources) {
    const catalog = await fetchSourceCatalog(c, source);
    if (catalog?.templates) {
      template = catalog.templates.find(t => t.id === templateId) || null;
      if (template) break;
    }
  }
  if (!template) return c.json({ error: { code: 'NOT_FOUND', message: 'Template not found' } }, 404);

  const result = await deployTemplate({
    account, encryptionKey: c.env.ENCRYPTION_KEY, template, name,
    bindingSelections: bindingSelections || {}, secretValues: secretValues || {},
    deployType: deployType || undefined,
    traces: traces !== false,
    logs: logs !== false,
    db: c.env.DB,
  });

  if (result.success) {
    return c.json(result, 200);
  } else {
    return c.json({
      error: {
        code: 'DEPLOY_FAILED',
        message: result.error || '部署失败',
        rolledBack: result.rolledBack,
        rollbackErrors: result.rollbackErrors,
        warnings: result.warnings,
      },
    }, 500);
  }
});

export default app;
export { fetchSourceCatalog, DEFAULT_CATALOG_URL, DEFAULT_CATALOG_NAME };
