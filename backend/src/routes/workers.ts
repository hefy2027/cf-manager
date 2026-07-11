import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { getActiveAccountsByFeature, getAccountById } from '../models/account';
import { createAuditLog } from '../models/auditLog';
import { appLogger } from '../services/logger';
import { getAccountOr404, demoDestructiveGuard } from './routeUtils';
import {
  listWorkers, listPages, deployWorker, deployWorkerFromUrl, deleteWorker, deletePagesProject, getWorkerLogs, deployPages,
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
  getPagesProject, editPagesProject, listPagesDomains, addPagesDomain, removePagesDomain, listPagesDeployments,
  // Resources for bindings
  listKvNamespaces, listD1Databases, listR2Buckets, updatePagesBindings,
  // Usage
  getWorkersUsageToday,
} from '../services/workerService';
import { getAllZones } from '../services/accountRouter';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1 * 1024 * 1024 } });
// Pages 部署：单文件 50MB，最多 100 个文件，总上传限制 200MB
const uploadPages = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 100, fields: 10, fieldSize: 1024 * 1024 },
});
const router = Router();

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

// ============ Deploy / Delete ============
router.post('/:accountId/workers', upload.single('script'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const name = req.body.name as string;
    if (!name) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Worker name is required' } }); return; }
    // Support both file upload and URL
    if (req.body.url) {
      const { script } = await deployWorkerFromUrl(account, name, req.body.url);
      createAuditLog(account.id, 'deploy_worker', name, `from_url=${req.body.url}`, 'success');
      res.status(201).json(script);
    } else if (req.file) {
      const { script } = await deployWorker(account, name, req.file.buffer.toString('utf-8'));
      createAuditLog(account.id, 'deploy_worker', name, `file_size=${req.file.size}`, 'success');
      res.status(201).json(script);
    } else {
      res.status(400).json({ error: { code: 'NO_FILE', message: 'Script file or URL is required' } });
    }
  } catch (err) { next(err); }
});

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

router.post('/:accountId/pages/deploy', (req: Request, res: Response, next: NextFunction) => {
  appLogger.info(`[Pages Deploy] Multer starting for ${req.url}`);
  uploadPages.array('files', 100)(req, res, (multerErr: any) => {
    if (multerErr) {
      appLogger.error(`[Pages Deploy] Multer error: ${multerErr.message} ${multerErr.code}`);
      const err = new Error(`File upload error: ${multerErr.message}`);
      (err as any).statusCode = 400;
      return next(err);
    }
    appLogger.info(`[Pages Deploy] Multer done, files: ${(req.files as any[])?.length || 0}`);
    handlePagesDeploy(req, res, next);
  });
});

async function handlePagesDeploy(req: Request, res: Response, next: NextFunction) {
  try {
    const account = getAccountOr404(req, res);
    if (!account) return;
    const name = req.body.name as string;
    if (!name) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Project name is required' } }); return; }
    if (!validatePagesProjectName(name)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '项目名只能包含小写字母、数字和连字符，且以字母或数字开头' } }); return;
    }
    
    const uploadedFiles = req.files as Express.Multer.File[] | undefined;
    let files: Array<{ path: string; buffer: Buffer }> = [];
    
    // Check if it's a single zip file
    if (uploadedFiles && uploadedFiles.length > 0) {
      appLogger.info(`[Pages Deploy Route] Received ${uploadedFiles.length} files: ${uploadedFiles.map(f => f.originalname).join(', ')}`);
      if (uploadedFiles.length === 1 && uploadedFiles[0].originalname?.toLowerCase().endsWith('.zip')) {
        files = extractZipFiles(uploadedFiles[0].buffer);
        appLogger.info(`[Pages Deploy Route] ZIP extracted: ${files.length} files`);
      } else {
        files = uploadedFiles.map(f => ({
          path: (f as any).originalname || f.fieldname,
          buffer: f.buffer,
        }));
      }
    }
    
    const skipCreateProject = req.body.skipCreateProject === 'true' || req.body.skipCreateProject === true;
    const result = await deployPages(account, name, files, skipCreateProject);
    createAuditLog(account.id, 'deploy_pages', name, files.length > 0 ? `${files.length} files` : 'empty project', 'success');
    appLogger.info(`[Pages Deploy Route] Success for ${name}`);
    // 剥离 CF API 返回的 success 字段，避免与 responseWrapper 中间件冲突导致双重包装
    const { success: _cfSuccess, ...deploymentData } = result;
    res.status(201).json(deploymentData);
  } catch (err: any) {
    appLogger.error(`[Pages Deploy Route] Error: ${err.message} ${err.statusCode || 500}`);
    next(err);
  }
}

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
    const { crons } = req.body;
    if (!Array.isArray(crons)) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'crons must be an array' } }); return; }
    const result = await updateSchedules(account, req.params.name as string, crons);
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
    const results = await Promise.all(accounts.map(async (account) => {
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
    }));
    res.json(results);
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
router.post('/batch-deploy', upload.single('script'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { targets, url: scriptUrl } = req.body;
    const parsedTargets = typeof targets === 'string' ? JSON.parse(targets) : targets;
    if (!Array.isArray(parsedTargets) || parsedTargets.length === 0) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'targets must be a non-empty array' } }); return;
    }
    if (!req.file && !scriptUrl) {
      res.status(400).json({ error: { code: 'NO_FILE', message: 'Script file or URL is required' } }); return;
    }
    const scriptContent = req.file ? req.file.buffer.toString('utf-8') : null;
    const results: Array<{ accountId: number; workerName: string; success: boolean; error?: string }> = [];
    await Promise.all(parsedTargets.map(async (t: { accountId: number; workerName: string }) => {
      try {
        const account = getAccountById(t.accountId);
        if (!account) { results.push({ ...t, success: false, error: 'Account not found' }); return; }
        if (scriptUrl) {
          await deployWorkerFromUrl(account, t.workerName, scriptUrl);
        } else {
          await deployWorker(account, t.workerName, scriptContent!);
        }
        createAuditLog(account.id, 'batch_deploy', t.workerName, null, 'success');
        results.push({ ...t, success: true });
      } catch (err: any) {
        results.push({ ...t, success: false, error: err.message });
      }
    }));
    res.json(results);
  } catch (err) { next(err); }
});

// ============ Batch Deploy Pages ============
router.post('/batch-deploy-pages', uploadPages.single('zipFile'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { targets } = req.body;
    const parsedTargets = typeof targets === 'string' ? JSON.parse(targets) : targets;
    if (!Array.isArray(parsedTargets) || parsedTargets.length === 0) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'targets must be a non-empty array' } }); return;
    }
    if (!req.file) {
      res.status(400).json({ error: { code: 'NO_FILE', message: 'Zip file is required' } }); return;
    }
    const files = extractZipFiles(req.file.buffer);

    if (files.length === 0) {
      res.status(400).json({ error: { code: 'EMPTY_ZIP', message: 'Zip file contains no files' } }); return;
    }

    const results: Array<{ accountId: number; workerName: string; success: boolean; error?: string }> = [];
    for (const t of parsedTargets) {
      try {
        const account = getAccountById(t.accountId);
        if (!account) { results.push({ ...t, success: false, error: 'Account not found' }); continue; }
        if (!validatePagesProjectName(t.workerName)) {
          results.push({ ...t, success: false, error: '项目名只能包含小写字母、数字和连字符' }); continue;
        }
        await deployPages(account, t.workerName, files);
        createAuditLog(account.id, 'batch_deploy_pages', t.workerName, `${files.length} files`, 'success');
        results.push({ ...t, success: true });
      } catch (err: any) {
        results.push({ ...t, success: false, error: err.message });
      }
    }
    res.json(results);
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
