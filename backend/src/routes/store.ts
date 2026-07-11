import { Router, Request, Response, NextFunction } from 'express';
import {
  getCatalogSources, getEnabledCatalogSources, getCatalogSourceById,
  createCatalogSource, updateCatalogSource, deleteCatalogSource, ensureDefaultCatalogSource,
} from '../models/catalogSource';
import { validateCatalog, Catalog, CatalogTemplate } from '../services/catalogValidator';
import { deployTemplate } from '../services/catalogDeploy';
import { getAccountById } from '../models/account';
import { appLogger } from '../services/logger';
import { assertUrlSafe } from '../services/ssrfGuard';

// 主源用 surge.sh：Surge 静态托管，更新即时生效，避免 jsDelivr 缓存 GitHub 主分支导致更新延迟。
// 兜底顺序：surge.sh → jsDelivr → GitHub raw（GitHub raw 放最后，作为最终兜底）。
const DEFAULT_CATALOG_URL = 'https://cf-store.surge.sh/catalog.json';
const DEFAULT_CATALOG_FALLBACK_URLS = [
  'https://cdn.jsdelivr.net/gh/hefy2027/cf-store@main/catalog.json',
  'https://raw.githubusercontent.com/hefy2027/cf-store/main/catalog.json',
];
const DEFAULT_CATALOG_URLS = [DEFAULT_CATALOG_URL, ...DEFAULT_CATALOG_FALLBACK_URLS];
const DEFAULT_CATALOG_NAME = '官方源';

const router = Router();

// In-memory catalog cache for Docker version
const catalogCache = new Map<number, Catalog>();

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
  const isLocal = url?.startsWith('http://localhost:') || url?.startsWith('http://127.0.0.1:');
  if (!url || (!url.startsWith('https://') && !isLocal)) {
    return { ok: false, errorCode: 'VALIDATION_ERROR', error: 'url must be a valid HTTPS URL' };
  }
  let resp;
  try {
    await assertUrlSafe(url);
    resp = await fetch(url);
  } catch (e: any) {
    return { ok: false, errorCode: 'SSRF_BLOCKED', error: e.message || `无法连接: ${e.message}` };
  }
  if (!resp.ok) {
    return { ok: false, status: resp.status, errorCode: 'FETCH_ERROR', error: `URL 不可达: HTTP ${resp.status}` };
  }
  let json: any;
  try {
    json = await resp.json();
  } catch (e: any) {
    return { ok: false, errorCode: 'PARSE_ERROR', error: `不是合法 JSON: ${e.message}` };
  }
  const result = validateCatalog(json);
  if (!result.valid) {
    return { ok: false, errorCode: 'INVALID_CATALOG', error: `不是有效的 catalog: ${result.errors.join('; ')}` };
  }
  return { ok: true, templateCount: Array.isArray(json.templates) ? json.templates.length : 0, etag: resp.headers.get('etag'), json };
}

router.get('/sources', (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(getCatalogSources());
  } catch (err) { next(err); }
});

// 独立测试接口：验证 URL 是否可拉取且符合 catalog 格式（不落库）
router.post('/sources/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url } = req.body;
    const result = await testCatalogUrl(url);
    res.json(result);
  } catch (err) { next(err); }
});

router.post('/sources', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, name } = req.body;
    if (!name) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } });
      return;
    }
    const test = await testCatalogUrl(url);
    if (!test.ok) {
      res.status(400).json({ error: { code: test.errorCode || 'FETCH_ERROR', message: test.error } });
      return;
    }
    const id = createCatalogSource({ url, name });
    catalogCache.set(id, test.json as Catalog);
    if (test.etag) updateCatalogSource(id, { etag: test.etag, last_synced: new Date().toISOString(), last_status: 'ok', last_error: null });
    res.status(201).json({ id });
  } catch (err) { next(err); }
});

router.put('/sources/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const source = getCatalogSourceById(id);
    if (!source) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Source not found' } }); return; }
    const body = req.body;
    if (source.is_default && body.url && body.url !== source.url) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: '默认源的 URL 不可修改' } });
      return;
    }
    if (body.url && body.url !== source.url) {
      try {
        await assertUrlSafe(body.url);
      } catch (e: any) {
        res.status(e.statusCode || 403).json({ error: { code: 'SSRF_BLOCKED', message: e.message } });
        return;
      }
      const resp = await fetch(body.url);
      if (!resp.ok) { res.status(400).json({ error: { code: 'FETCH_ERROR', message: `URL 不可达: ${resp.status}` } }); return; }
      const json: Catalog = await resp.json() as Catalog;
      const result = validateCatalog(json);
      if (!result.valid) {
        res.status(400).json({ error: { code: 'INVALID_CATALOG', message: `不是有效的 catalog: ${result.errors.join('; ')}` } });
        return;
      }
      catalogCache.set(id, json);
      const etag = resp.headers.get('etag') as string | null;
      updateCatalogSource(id, { ...body, etag: etag || null, last_synced: new Date().toISOString(), last_status: 'ok', last_error: null });
    } else {
      updateCatalogSource(id, body);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/sources/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    deleteCatalogSource(id);
    catalogCache.delete(id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============ Catalog Fetch ============

async function fetchSourceCatalog(source: any): Promise<Catalog | null> {
  // Check cache
  const cached = catalogCache.get(source.id);
  // 空目录（无模板）不视为有效命中：用户看到空白时应立即重新拉取，
  // 而不是长期返回缓存中的空结果导致页面一直空白。
  if (cached && cached.templates && cached.templates.length > 0) {
    // Try refresh in background
    refreshSourceInBackground(source).catch(e => appLogger.error(`[Store] refresh ${source.id}: ${e}`));
    return cached;
  }
  return refreshSource(source);
}

// 官方默认源启用 fallback 链；用户自定义源只使用自己的 url
function candidateUrls(source: any): string[] {
  return source.is_default ? DEFAULT_CATALOG_URLS : [source.url];
}

async function refreshSource(source: any): Promise<Catalog | null> {
  const urls = candidateUrls(source);
  let lastError = '';
  for (const url of urls) {
    try {
      await assertUrlSafe(url);
      const headers: Record<string, string> = {};
      // etag 仅对主记录 url 携带，避免跨地址 etag 误判
      if (url === source.url && source.etag) headers['If-None-Match'] = source.etag;
      const resp = await fetch(url, { headers });

      if (resp.status === 304) {
        updateCatalogSource(source.id, { last_synced: new Date().toISOString(), last_status: 'ok', last_error: null });
        return catalogCache.get(source.id) || null;
      }
      if (!resp.ok) {
        lastError = `HTTP ${resp.status} (${url})`;
        continue;
      }
      const json: Catalog = await resp.json() as Catalog;
      const result = validateCatalog(json);
      if (!result.valid) {
        lastError = `Schema invalid: ${result.errors.slice(0, 3).join('; ')} (${url})`;
        continue;
      }
      catalogCache.set(source.id, json);
      const etag = resp.headers.get('etag') as string | null;
      updateCatalogSource(source.id, { etag: etag || null, last_synced: new Date().toISOString(), last_status: 'ok', last_error: null });
      return json;
    } catch (e: any) {
      lastError = `${e.message} (${url})`;
      continue;
    }
  }
  updateCatalogSource(source.id, { last_status: 'error', last_error: lastError });
  return catalogCache.get(source.id) || null;
}

async function refreshSourceInBackground(source: any): Promise<void> {
  // Only refresh if last sync was > 5 minutes ago
  if (source.last_synced) {
    const age = Date.now() - new Date(source.last_synced).getTime();
    if (age < 5 * 60 * 1000) return;
  }
  await refreshSource(source);
}

// ============ Template List ============

router.get('/templates', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const sources = getEnabledCatalogSources();
    const results = await Promise.all(sources.map(s => fetchSourceCatalog(s)));

    const seen = new Map<string, { template: CatalogTemplate; sourceId: number; sourceName: string; sourceCount: number }>();
    const idSources = new Map<string, number>();

    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      const catalog = results[i];
      if (!catalog?.templates) continue;
      for (const template of catalog.templates) {
        const count = idSources.get(template.id) || 0;
        idSources.set(template.id, count + 1);
        if (!seen.has(template.id)) {
          seen.set(template.id, { template, sourceId: source.id, sourceName: source.name, sourceCount: 0 });
        }
      }
    }
    for (const entry of seen.values()) {
      entry.sourceCount = idSources.get(entry.template.id) || 1;
    }
    res.json({ templates: Array.from(seen.values()), sources });
  } catch (err) { next(err); }
});

// ============ Refresh ============

router.post('/refresh', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const sources = getEnabledCatalogSources();
    const results = await Promise.all(sources.map(async (s) => {
      if (s.etag) updateCatalogSource(s.id, { etag: null });
      const cat = await refreshSource(s);
      return { id: s.id, name: s.name, success: !!cat };
    }));
    res.json(results);
  } catch (err) { next(err); }
});

// ============ Init ============

router.get('/init', (_req: Request, res: Response) => {
  ensureDefaultCatalogSource(DEFAULT_CATALOG_URL, DEFAULT_CATALOG_NAME);
  res.json({ success: true });
});

// ============ Deploy ============

router.post('/deploy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { accountId, templateId, name, bindingSelections, secretValues, deployType } = req.body;
    if (!accountId || !templateId || !name) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'accountId, templateId, name are required' } });
      return;
    }
    const account = getAccountById(parseInt(accountId, 10));
    if (!account) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }); return; }

    const sources = getEnabledCatalogSources();
    let template: CatalogTemplate | null = null;
    for (const source of sources) {
      const catalog = await fetchSourceCatalog(source);
      if (catalog?.templates) {
        template = catalog.templates.find(t => t.id === templateId) || null;
        if (template) break;
      }
    }
    if (!template) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Template not found' } }); return; }

    const result = await deployTemplate({
      account, template, name,
      bindingSelections: bindingSelections || {},
      secretValues: secretValues || {},
      deployType: deployType || undefined,
    });
    if (result.success) {
      res.json(result);
    } else {
      // 使用标准 error 格式，避免 responseWrapper 将 success:false 体的其余字段包装为 error 对象
      res.status(500).json({
        error: {
          code: 'DEPLOY_FAILED',
          message: result.error || '部署失败',
          rolledBack: result.rolledBack,
          rollbackErrors: result.rollbackErrors,
          warnings: result.warnings,
        },
      });
    }
  } catch (err) { next(err); }
});

export default router;
export { refreshSource as refreshCatalogSource, DEFAULT_CATALOG_URL, DEFAULT_CATALOG_NAME };
