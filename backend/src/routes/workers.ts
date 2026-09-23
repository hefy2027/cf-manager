import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { getActiveAccountsByFeature, getAccountById } from '../models/account';
import { createAuditLog } from '../models/auditLog';
import { appLogger } from '../services/logger';
import { mapConcurrent } from '../utils/concurrent';
import { normalizeCronExpressions } from '../utils/cronValidation';
import { getAccountOr404, demoDestructiveGuard } from './routeUtils';
import {
  listWorkers, listPages, deployWorker, deployWorkerFromUrl, deleteWorker, deletePagesProject, getWorkerLogs, WorkerAssetsInput,
  extractZipFiles, validatePagesProjectName,
  // Secrets
  listSecrets, updateSecret, deleteSecret,
  // Schedules
  getSchedules, updateSchedules,
  // Domains
  listDomains, createDomain, deleteDomain,
  // Subdomain
  getSubdomain, setSubdomain,
  // Settings
  getScriptSettings, updateScriptSettings,
  // Routes
  listRoutes, createRoute, deleteRoute,
  // Script content
  getScriptContent,
  // Deployments
  listDeployments,
  // Pages settings
  getPagesProject, editPagesProject, listPagesDomains, addPagesDomain, removePagesDomain, listPagesDeployments, deletePagesDeployment, batchDeletePagesDeployments,
  // Resources for bindings
  listKvNamespaces, listD1Databases, listR2Buckets, updatePagesBindings,
  // Usage
  getWorkersUsageToday,
} from '../services/workerService';
import { varsToBindings, resolveManualBindings, buildPagesConfigsFromInput, ManualVarInput, ManualBindingInput } from '../services/bindings';
import { getWorkerConfig, getPagesConfig, applyWorkerConfigDiff } from '../services/workerService';
import { deployPages as deployPagesService } from '../services/deploy/pagesDeploy';
import { getAllZones } from '../services/accountRouter';

// 手动/批量 Worker 部署：script 可为单个 .js（单模块）或 .zip（多模块包）+ 可选 assets（zip 较大放宽到 50MB，与 Pages 一致）
const uploadWorkerAssets = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, fields: 10 },
});
// Pages 部署：单文件 50MB，最多 100 个文件，总上传限制 200MB
const uploadPages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 100, fields: 10, fieldSize: 1024 * 1024 },
});
const router = Router();

// 由上传的 assets 文件构造 deployWorker 的 assets 选项（默认 ASSETS 绑定、无 config）。
// 单文件当 raw 处理，.zip 当压缩包解包处理。
function toAssetsOptions(file?: Express.Multer.File): { assets: WorkerAssetsInput; assetsBuffer: Buffer } | undefined {
  if (!file) return undefined;
  const isZip = file.originalname.toLowerCase().endsWith('.zip');
  return {
    assets: { source: { kind: isZip ? 'zip' : 'raw', url: file.originalname } },
    assetsBuffer: file.buffer,
  };
}

// 从 multipart 表单中解析 JSON 字符串字段；空/非法返回空数组
function parseJsonField(raw: unknown, _field: string): any {
  if (raw === undefined || raw === null || raw === '') return [];
  if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return []; } }
  return raw;
}


// 演示账户：拦截所有销毁/删除类操作（DELETE 等）
router.use(demoDestructiveGuard);

// ============ List all ============
// 支持 ?accountId= 仅返回该账户的 Worker/Pages（按需加载）；不带参数返回全部（批量部署/环境同步用）
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accountIdFilter = req.query.accountId ? Number(req.query.accountId) : null;
    let accounts;
    if (accountIdFilter) {
      const acc = getAccountById(accountIdFilter);
      accounts = acc ? [acc] : [];
    } else {
      accounts = getActiveAccountsByFeature('workers');
    }
    const results = await Promise.all(accounts.map(async (account) => {
      const items: Array<any> = [];
      const [workers, pages] = await Promise.allSettled([
        listWorkers(account),
        listPages(account),
      ]);
      if (workers.status === 'fulfilled') {
        items.push(...workers.value.map(w => ({ ...w, name: w.id, status: 'deployed', type: 'worker', cfAccountId: account.id, accountName: account.name })));
      } else {
        appLogger.error(`[Workers] Failed to list workers for ${account.name}: ${workers.reason}`);
      }
      if (pages.status === 'fulfilled') {
        items.push(...pages.value.map(p => ({ ...p, name: p.name ?? p.id, type: 'pages', cfAccountId: account.id, accountName: account.name })));
      } else {
        appLogger.error(`[Pages] Failed to list pages for ${account.name}: ${pages.reason}`);
      }
      return items;
    }));
    res.json(results.flat());
  } catch (err) { next(err); }
});

// ============ Delete ============
router.delete('/:accountId/workers/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const workerName = req.params.name as string;
    await deleteWorker(account, workerName);
    createAuditLog(account.id, 'delete_worker', workerName, null, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/:accountId/pages/:name', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const pagesName = req.params.name as string;
    await deletePagesProject(account, pagesName);
    createAuditLog(account.id, 'delete_pages', pagesName, null, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/:accountId/workers/:name/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const logs = await getWorkerLogs(account, req.params.name as string);
    res.json(logs);
  } catch (err) { next(err); }
});

// ============ Secrets ============
router.get('/:accountId/workers/:name/secrets', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const secrets = await listSecrets(account, req.params.name as string);
    res.json(secrets);
  } catch (err) { next(err); }
});

router.put('/:accountId/workers/:name/secrets', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const { name, type, text, key_base64 } = req.body;
    if (!name || !type) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name and type are required' } }); return; }
    const result = await updateSecret(account, req.params.name as string, name, type, text, key_base64);
    res.json(result);
  } catch (err) { next(err); }
});

router.delete('/:accountId/workers/:name/secrets/:secretName', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    await deleteSecret(account, req.params.name as string, req.params.secretName as string);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============ Schedules (Cron Triggers) ============
router.get('/:accountId/workers/:name/schedules', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await getSchedules(account, req.params.name as string);
    res.json(result);
  } catch (err) { next(err); }
});

router.put('/:accountId/workers/:name/schedules', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const { crons } = body;
    const normalizedCrons = normalizeCronExpressions(crons);
    if (!normalizedCrons) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'crons must be an array of valid five-field cron expressions' } });
      return;
    }
    const result = await updateSchedules(account, req.params.name as string, normalizedCrons);
    res.json(result);
  } catch (err) { next(err); }
});

// ============ Custom Domains ============
router.get('/:accountId/workers/:name/domains', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const domains = await listDomains(account, req.params.name as string);
    res.json(domains);
  } catch (err) { next(err); }
});

router.post('/:accountId/workers/:name/domains', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const { hostname, environment } = req.body;
    if (!hostname) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'hostname is required' } }); return; }
    const result = await createDomain(account, hostname, req.params.name as string, environment);
    res.json(result);
  } catch (err) { next(err); }
});

router.delete('/:accountId/workers/:name/domains/:domainId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    await deleteDomain(account, req.params.domainId as string);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============ Subdomain (workers.dev) ============
router.get('/:accountId/workers/:name/subdomain', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await getSubdomain(account, req.params.name as string);
    res.json(result);
  } catch (err) { next(err); }
});

router.put('/:accountId/workers/:name/subdomain', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'enabled must be boolean' } }); return; }
    const result = await setSubdomain(account, req.params.name as string, enabled);
    res.json(result);
  } catch (err) { next(err); }
});

// ============ Script Settings ============
router.get('/:accountId/workers/:name/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await getScriptSettings(account, req.params.name as string);
    res.json(result);
  } catch (err) { next(err); }
});

router.patch('/:accountId/workers/:name/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await updateScriptSettings(account, req.params.name as string, req.body);
    res.json(result);
  } catch (err) { next(err); }
});

// ============ Routes ============
router.get('/:accountId/workers/:name/routes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const { zone_id } = req.query;
    if (!zone_id) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'zone_id is required' } }); return; }
    const routes = await listRoutes(account, zone_id as string);
    res.json(routes);
  } catch (err) { next(err); }
});

router.post('/:accountId/workers/:name/routes', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const { zone_id, pattern, script } = req.body;
    if (!zone_id || !pattern) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'zone_id and pattern are required' } }); return; }
    const result = await createRoute(account, zone_id, pattern, script || req.params.name);
    res.json(result);
  } catch (err) { next(err); }
});

router.delete('/:accountId/workers/:name/routes/:routeId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const { zone_id } = req.query;
    if (!zone_id) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'zone_id is required' } }); return; }
    await deleteRoute(account, zone_id as string, req.params.routeId as string);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============ Script Content ============
router.get('/:accountId/workers/:name/content', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const content = await getScriptContent(account, req.params.name as string);
    res.type('text/plain').send(content);
  } catch (err) { next(err); }
});

// ============ Deployments ============
router.get('/:accountId/workers/:name/deployments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await listDeployments(account, req.params.name as string);
    res.json(result);
  } catch (err) { next(err); }
});

// ============ Pages Settings ============
router.get('/:accountId/pages/:name/project', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await getPagesProject(account, req.params.name as string);
    res.json(result);
  } catch (err) { next(err); }
});

router.patch('/:accountId/pages/:name/project', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await editPagesProject(account, req.params.name as string, req.body);
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/:accountId/pages/:name/domains', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const domains = await listPagesDomains(account, req.params.name as string);
    res.json(domains);
  } catch (err) { next(err); }
});

router.post('/:accountId/pages/:name/domains', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const { hostname } = req.body;
    if (!hostname) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'hostname is required' } }); return; }
    const result = await addPagesDomain(account, req.params.name as string, hostname);
    res.json(result);
  } catch (err) { next(err); }
});

router.delete('/:accountId/pages/:name/domains/:hostname', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    await removePagesDomain(account, req.params.name as string, req.params.hostname as string);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/:accountId/pages/:name/deployments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await listPagesDeployments(account, req.params.name as string);
    res.json(result);
  } catch (err) { next(err); }
});

// 单条删除 Pages 部署记录
router.delete('/:accountId/pages/:name/deployments/:deploymentId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await deletePagesDeployment(account, req.params.name as string, req.params.deploymentId as string);
    if (!result.success) {
      res.status(400).json({ error: { code: 'DELETE_FAILED', message: result.error } });
      return;
    }
    createAuditLog(account.id, 'delete_pages_deployment', `${req.params.name}/${req.params.deploymentId}`, null, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

// 批量删除 Pages 部署记录
router.delete('/:accountId/pages/:name/deployments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const { ids } = req.body as { ids?: string[] };
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'ids array is required' } });
      return;
    }
    const result = await batchDeletePagesDeployments(account, req.params.name as string, ids);
    createAuditLog(account.id, 'batch_delete_pages_deployments', req.params.name as string, `deleted ${result.succeeded}/${result.total} deployments`, 'success');
    res.json(result);
  } catch (err) { next(err); }
});

// ============ Cloudflare Resources (for Pages bindings) ============
router.get('/:accountId/resources/kv', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await listKvNamespaces(account);
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/:accountId/resources/d1', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await listD1Databases(account);
    res.json(result);
  } catch (err) { next(err); }
});

router.get('/:accountId/resources/r2', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    // 短路：缓存显示 R2 不可用则直接返回
    const r2Features = (account.available_features || '').split(',');
    if (r2Features.includes('-r2')) {
      res.json({ r2_not_enabled: true, buckets: [] });
      return;
    }
    const result = await listR2Buckets(account);
    res.json(result);
  } catch (err: any) {
    const msg = `${err?.message || ''} ${err?.status || ''} ${err?.error?.code || ''}`;
    if (msg.includes('10042') || msg.includes('enable R2') || msg.includes('Please enable R2')) {
      res.json({ r2_not_enabled: true, buckets: [] });
      return;
    }
    next(err);
  }
});

router.get('/:accountId/resources/zones', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const allZones = await getAllZones();
    res.json(allZones.filter(z => z.cfAccountId === account.id));
  } catch (err) { next(err); }
});

router.put('/:accountId/pages/:name/bindings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const result = await updatePagesBindings(account, req.params.name as string, req.body.deployment_configs);
    res.json(result);
  } catch (err) { next(err); }
});

// ============ Summary (用量 + 已部署数量) ============
router.get('/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = getActiveAccountsByFeature('workers');
    const results = await mapConcurrent(accounts, 6, async (account) => {
      try {
        const [usageRes, workersRes, pagesRes] = await Promise.allSettled([
          getWorkersUsageToday(account),
          listWorkers(account),
          listPages(account),
        ]);
        const usage = usageRes.status === 'fulfilled'
          ? usageRes.value
          : { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
        const workerCount = workersRes.status === 'fulfilled' ? workersRes.value.length : 0;
        const pagesCount = pagesRes.status === 'fulfilled' ? pagesRes.value.length : 0;
        return { accountId: account.id, accountName: account.name, ...usage, workerCount, pagesCount };
      } catch (err) {
        appLogger.error(`[Summary] Failed for ${account.name}: ${err}`);
        return { accountId: account.id, accountName: account.name, requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0, workerCount: 0, pagesCount: 0 };
      }
    });
    res.json(results);
  } catch (err) { next(err); }
});

// ============ Pages Config (重部署预填) ============
router.get('/:accountId/pages/:name/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    res.set('Cache-Control', 'no-store'); // 防浏览器缓存旧配置
    const config = await getPagesConfig(account, req.params.name as string);
    res.json(config);
  } catch (err) { next(err); }
});

// ============ Workers Usage (GraphQL) ============
router.get('/usage', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = getActiveAccountsByFeature('workers');
    const results = await Promise.all(accounts.map(async (account) => {
      try {
        const usage = await getWorkersUsageToday(account);
        return { accountId: account.id, accountName: account.name, ...usage };
      } catch (err) {
        appLogger.error(`[Usage] Failed for account ${account.name}: ${err}`);
        return { accountId: account.id, accountName: account.name, requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
      }
    }));
    res.json(results);
  } catch (err) { next(err); }
});

// ============ Batch Deploy ============
router.post('/batch-deploy', uploadWorkerAssets.fields([{ name: 'script' }, { name: 'assets' }]), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url: scriptUrl } = req.body;
    const files = req.files as { script?: Express.Multer.File[]; assets?: Express.Multer.File[] };
    const assetsOpts = toAssetsOptions(files.assets?.[0]);
    const scriptFile = files.script?.[0];
    const scriptContent = scriptFile ? scriptFile.buffer.toString('utf-8') : null;
    const isZip = !!scriptFile && scriptFile.originalname.toLowerCase().endsWith('.zip');
    const mainModule = req.body.mainModule || undefined;
    // 版本化 worker 下 PUT 只创建版本不部署，必须显式创建 deployment 才会上线
    const baseOpts: any = { ...assetsOpts, mainModule, createDeployment: true };
    const parsedTargets = parseJsonField(req.body.targets, 'targets');
    if (!Array.isArray(parsedTargets) || parsedTargets.length === 0) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'targets must be a non-empty array' } }); return;
    }
    const vars: ManualVarInput[] = parseJsonField(req.body.vars, 'vars');
    const bindingsInput: ManualBindingInput[] = parseJsonField(req.body.bindings, 'bindings');
    const isRedeploy = req.body.isRedeploy === 'true' || req.body.isRedeploy === true;
    // 重部署可不带代码（只更新配置）；新建部署必须提供代码源
    if (!isRedeploy && !scriptContent && !scriptUrl && !isZip) {
      res.status(400).json({ error: { code: 'NO_FILE', message: 'Script file or URL is required' } }); return;
    }
    console.log(`[DBG] batch-deploy targets=${parsedTargets.length} isRedeploy=${isRedeploy} isZip=${isZip} vars=${JSON.stringify(vars.map((v: any) => `${v.name}:${v.secret ? 'S' : 'P'}${v.keep ? '(keep)' : ''}`))} bindings=${JSON.stringify(bindingsInput.map((b: any) => b.type + ':' + b.name))}`);

    const results: Array<{ accountId: number; workerName: string; success: boolean; error?: string }> = [];
    await mapConcurrent(parsedTargets, 3, async (t: { accountId: number; workerName: string }) => {
      try {
        const account = getAccountById(t.accountId);
        if (!account) { results.push({ ...t, success: false, error: 'Account not found' }); return; }
        const resolved = await resolveManualBindings(account, bindingsInput);
        const allBindings = [...varsToBindings(vars), ...resolved];

        if (isRedeploy && !isZip) {
          // 重部署未更换代码：走 diff（secrets 独立 API 保持 / 代码复用重传）
          await applyWorkerConfigDiff(account, t.workerName, {
            vars, bindings: allBindings,
            scriptContent: scriptContent ?? undefined,
          });
          createAuditLog(account.id, 'batch_deploy', t.workerName, 'redeploy_config', 'success');
          results.push({ ...t, success: true });
          return;
        }

        if (scriptUrl) {
          await deployWorkerFromUrl(account, t.workerName, scriptUrl, { ...baseOpts, bindings: allBindings });
        } else if (isZip) {
          await deployWorker(account, t.workerName, '', { ...baseOpts, packageZip: scriptFile!.buffer, bindings: allBindings });
        } else {
          await deployWorker(account, t.workerName, scriptContent!, { ...baseOpts, bindings: allBindings });
        }
        createAuditLog(account.id, 'batch_deploy', t.workerName, null, 'success');
        results.push({ ...t, success: true });
      } catch (err: any) {
        results.push({ ...t, success: false, error: err.message });
      }
    });
    res.json(results);
  } catch (err) { next(err); }
});

// ============ Batch Deploy Pages ============
router.post('/batch-deploy-pages', uploadPages.single('zipFile'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsedTargets = parseJsonField(req.body.targets, 'targets');
    if (!Array.isArray(parsedTargets) || parsedTargets.length === 0) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'targets must be a non-empty array' } }); return;
    }
    const vars: ManualVarInput[] = parseJsonField(req.body.vars, 'vars');
    const bindingsInput: ManualBindingInput[] = parseJsonField(req.body.bindings, 'bindings');
    const isRedeploy = req.body.isRedeploy === 'true' || req.body.isRedeploy === true;
    let files: Array<{ path: string; buffer: Buffer }> = [];
    if (req.file) {
      files = extractZipFiles(req.file.buffer);
      if (files.length === 0) { res.status(400).json({ error: { code: 'EMPTY_ZIP', message: 'Zip file contains no files' } }); return; }
    }
    if (!isRedeploy && !req.file) {
      res.status(400).json({ error: { code: 'NO_FILE', message: 'Zip file is required for new deploy' } }); return;
    }

    const results: Array<{ accountId: number; workerName: string; success: boolean; error?: string }> = [];
    await mapConcurrent(parsedTargets, 3, async (t: { accountId: number; workerName: string }) => {
      try {
        const account = getAccountById(t.accountId);
        if (!account) { results.push({ ...t, success: false, error: 'Account not found' }); return; }
        if (!validatePagesProjectName(t.workerName)) { results.push({ ...t, success: false, error: '项目名只能包含小写字母、数字和连字符' }); return; }

        if (isRedeploy && !req.file) {
          // 只更新配置：PATCH project deployment_configs
          const resolved = await resolveManualBindings(account, bindingsInput);
          const configs = buildPagesConfigsFromInput(vars, resolved);
          if (configs) await updatePagesBindings(account, t.workerName, configs);
          createAuditLog(account.id, 'redeploy_pages_config', t.workerName, null, 'success');
          results.push({ ...t, success: true });
          return;
        }

        const resolved = await resolveManualBindings(account, bindingsInput);
        const configs = buildPagesConfigsFromInput(vars, resolved);
        await deployPagesService(account, t.workerName, files, configs ? { deploymentConfigs: configs } : {});
        createAuditLog(account.id, 'batch_deploy_pages', t.workerName, `${files.length} files`, 'success');
        results.push({ ...t, success: true });
      } catch (err: any) {
        results.push({ ...t, success: false, error: err.message });
      }
    });
    res.json(results);
  } catch (err) { next(err); }
});

// ============ Config (重部署预填) ============
router.get('/:accountId/workers/:name/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    res.set('Cache-Control', 'no-store'); // 防浏览器缓存旧配置（部署后重开预填必须拿到最新）
    const config = await getWorkerConfig(account, req.params.name as string);
    res.json(config);
  } catch (err) { next(err); }
});

router.get('/:accountId/pages/:name/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    res.set('Cache-Control', 'no-store'); // 防浏览器缓存旧配置
    const config = await getPagesConfig(account, req.params.name as string);
    res.json(config);
  } catch (err) { next(err); }
});

// ============ Environment Sync ============
router.post('/env-sync/preview', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { source, targets, syncTypes } = req.body;
    if (!source?.accountId || !source?.workerName || !Array.isArray(targets)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'source and targets are required' } }); return;
    }
    const sourceAccount = getAccountById(source.accountId);
    if (!sourceAccount) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Source account not found' } }); return; }

    const doSecrets = !syncTypes || syncTypes.includes('secrets');
    const sourceSecrets = doSecrets ? await listSecrets(sourceAccount, source.workerName) : [];

    const diffs: Array<{ accountId: number; workerName: string; secrets?: { added: string[]; existing: string[] } }> = [];
    for (const t of targets) {
      const tAccount = getAccountById(t.accountId);
      if (!tAccount) continue;
      const tSecrets = doSecrets ? await listSecrets(tAccount, t.workerName) : [];
      const tNames = new Set(tSecrets.map((s: any) => s.name));
      const added = sourceSecrets.filter((s: any) => !tNames.has(s.name)).map((s: any) => s.name);
      const existing = sourceSecrets.filter((s: any) => tNames.has(s.name)).map((s: any) => s.name);
      diffs.push({ accountId: t.accountId, workerName: t.workerName, secrets: { added, existing } });
    }
    res.json(diffs);
  } catch (err) { next(err); }
});

router.post('/env-sync/execute', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { source, targets, syncTypes, secretValues } = req.body;
    if (!source?.accountId || !source?.workerName || !Array.isArray(targets)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'source and targets are required' } }); return;
    }
    if (!secretValues || typeof secretValues !== 'object') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'secretValues is required (map of name → value)' } }); return;
    }
    const doSecrets = !syncTypes || syncTypes.includes('secrets');
    const sourceAccount = getAccountById(source.accountId);
    if (!sourceAccount) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Source account not found' } }); return; }
    const sourceSecretsList = doSecrets ? await listSecrets(sourceAccount, source.workerName) : [];

    const results: Array<{ accountId: number; workerName: string; success: boolean; synced: number; error?: string }> = [];
    for (const t of targets) {
      try {
        const tAccount = getAccountById(t.accountId);
        if (!tAccount) { results.push({ ...t, success: false, synced: 0, error: 'Account not found' }); continue; }
        let synced = 0;
        if (doSecrets) {
          for (const s of sourceSecretsList) {
            const val = secretValues[s.name];
            if (val !== undefined) {
              await updateSecret(tAccount, t.workerName, s.name, s.type || 'secret_text', val);
              synced++;
            }
          }
        }
        createAuditLog(tAccount.id, 'env_sync', t.workerName, `from ${source.workerName}, ${synced} secrets`, 'success');
        results.push({ ...t, success: true, synced });
      } catch (err: any) {
        results.push({ ...t, success: false, synced: 0, error: err.message });
      }
    }
    res.json(results);
  } catch (err) { next(err); }
});

export default router;
