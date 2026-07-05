import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import Cloudflare from 'cloudflare';
import { getAllAccounts, createAccount, deleteAccount, getAccountById, getAccountByEmail, nameFromEmail, updateAccountStatus, updateAccountId, updateAccountFeatures, AccountInput } from '../models/account';
import { listAccountsPaged, AccountListFilter } from '../models/account';
import { encrypt } from '../services/encryptionService';
import { decrypt } from '../services/encryptionService';
import { getCfClient } from '../services/cfFactory';
import { getQuotaSummary } from '../services/quotaTracker';
import { clearCache } from '../services/accountRouter';
import { appLogger } from '../services/logger';
import { createAuditLog } from '../models/auditLog';
import { config } from '../config';
import { getHttpAgent } from '../services/proxyService';
import { clearExhausted } from '../models/quotaUsage';

const router = Router();

const uploadCsv = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

function isDemoAccount(id: number): boolean {
  if (!config.demoAccountIds) return false;
  return config.demoAccountIds.split(',').map(s => parseInt(s.trim(), 10)).includes(id);
}

router.get('/', (req: Request, res: Response, next: NextFunction) => {
  try {
    // 分页模式：当传入 page 或 pageSize 时启用；不传则保持原全量行为（向后兼容）
    const wantsPaged = req.query.page !== undefined || req.query.pageSize !== undefined;
    const quota = getQuotaSummary();
    if (wantsPaged) {
      const filter = (req.query.filter as string) as AccountListFilter;
      const validFilters: AccountListFilter[] = ['all', 'active', 'unverified'];
      const safeFilter: AccountListFilter = validFilters.includes(filter) ? filter : 'all';
      const paged = listAccountsPaged({
        page: parseInt(req.query.page as string, 10) || 1,
        pageSize: parseInt(req.query.pageSize as string, 10) || 20,
        filter: safeFilter,
        search: (req.query.search as string) || '',
      });
      const accounts = paged.accounts.map(a => ({
        ...a,
        api_token: a.api_token ? '***encrypted***' : null,
        api_key: a.api_key ? '***encrypted***' : null,
        is_demo: isDemoAccount(a.id),
      }));
      res.json({ accounts, quota, total: paged.total, counts: paged.counts });
    } else {
      const accounts = getAllAccounts().map(a => ({
        ...a,
        api_token: a.api_token ? '***encrypted***' : null,
        api_key: a.api_key ? '***encrypted***' : null,
        is_demo: isDemoAccount(a.id),
      }));
      res.json({ accounts, quota });
    }
  } catch (err) { next(err); }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, auth_type, account_id, api_token, api_key, email } = req.body;
    if (!name || !auth_type) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name and auth_type are required' } });
      return;
    }
    if (auth_type !== 'token' && auth_type !== 'global_key') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'auth_type must be "token" or "global_key"' } });
      return;
    }
    if (auth_type === 'token' && !api_token) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'api_token is required for token auth' } });
      return;
    }
    if (auth_type === 'global_key' && (!api_key || !email)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'api_key and email are required for global_key auth' } });
      return;
    }

    // Verify credentials before saving
    try {
      const httpAgent = getHttpAgent();
      const opts: Record<string, any> = {};
      if (httpAgent) opts.httpAgent = httpAgent;

      let tempCf: Cloudflare;
      if (auth_type === 'token') {
        tempCf = new Cloudflare({ apiToken: api_token, ...opts });
      } else {
        tempCf = new Cloudflare({ apiEmail: email, apiKey: api_key, ...opts });
      }
      await tempCf.user.get();
    } catch (e: any) {
      res.status(400).json({ error: { code: 'CREDENTIAL_INVALID', message: `Cloudflare API 凭证验证失败: ${e.message || e}` } });
      return;
    }

    const input: AccountInput = { name, auth_type, account_id, enabled_features: req.body.enabled_features };
    if (auth_type === 'token') {
      input.api_token = encrypt(api_token);
    } else {
      input.api_key = encrypt(api_key);
      input.email = email;
    }
    const id = createAccount(input);

    if (!account_id) {
      try {
        const saved = getAccountById(id);
        if (saved) {
          const cf = getCfClient(saved);
          const accts: any[] = [];
          for await (const acct of cf.accounts.list()) {
            accts.push(acct as any);
          }
          if (accts.length > 0) {
            updateAccountId(id, accts[0].id);
            appLogger.info(`[Account] Auto-fetched account_id=${accts[0].id} for "${name}"`);
          }
          updateAccountStatus(id, true);
        }
      } catch (e) {
        appLogger.warn(`[Account] Failed to auto-fetch account_id for "${name}": ${e}`);
      }
    }

    createAuditLog(id, 'create_account', name, `auth_type=${auth_type}`, 'success');
    res.status(201).json({ id, ...input, api_token: '***', api_key: '***' });
  } catch (err) { next(err); }
});

router.patch('/:id/features', (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isDemoAccount(id)) {
      res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改' } });
      return;
    }
    const account = getAccountById(id);
    if (!account) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }); return; }
    const { enabled_features } = req.body;
    if (typeof enabled_features !== 'string') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'enabled_features is required' } });
      return;
    }
    updateAccountFeatures(id, enabled_features);
    clearCache();
    createAuditLog(id, 'update_features', account.name, enabled_features, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.delete('/:id', (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isDemoAccount(id)) {
      res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可删除' } });
      return;
    }
    const account = getAccountById(id);
    if (!account) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }); return; }
    createAuditLog(id, 'delete_account', account.name, null, 'success');
    deleteAccount(id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============ 查看账号凭证（解密后的 apiKey / apiToken） ============
router.get('/:id/credentials', (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isDemoAccount(id)) {
      res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可查看凭证' } });
      return;
    }
    const account = getAccountById(id);
    if (!account) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }); return; }
    let api_token: string | null = null;
    let api_key: string | null = null;
    let password: string | null = null;
    try {
      if (account.api_token) api_token = decrypt(account.api_token);
      if (account.api_key) api_key = decrypt(account.api_key);
      if (account.password) password = decrypt(account.password);
    } catch (e) {
      appLogger.error(`[Account] 解密凭证失败 id=${id}: ${e}`);
      res.status(500).json({ error: { code: 'DECRYPT_ERROR', message: '凭证解密失败' } });
      return;
    }
    createAuditLog(id, 'view_credentials', account.name, account.auth_type, 'success');
    res.json({
      id: account.id,
      name: account.name,
      auth_type: account.auth_type,
      email: account.email,
      api_token,
      api_key,
      password,
      account_id: account.account_id,
    });
  } catch (err) { next(err); }
});

router.post('/:id/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accountId = parseInt(req.params.id as string, 10);
    const account = getAccountById(accountId);
    if (!account) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }); return; }
    const cf = getCfClient(account);
    const user = await cf.user.get();

    // 自动获取并存储 Cloudflare Account ID
    if (!account.account_id) {
      try {
        const accounts: any[] = [];
        for await (const acct of cf.accounts.list()) {
          accounts.push(acct as any);
        }
        if (accounts.length > 0) {
          updateAccountId(accountId, accounts[0].id);
        }
      } catch (e) {
        // 获取账号列表失败不是致命错误，继续返回测试结果
        appLogger.warn(`Failed to fetch account list: ${e}`);
      }
    }

    // 测试成功，更新状态为活跃
    updateAccountStatus(accountId, true);
    res.json({ success: true, user });
  } catch (err) { next(err); }
});

// ============ 清除 AI 配额耗尽标记 ============
router.post('/:id/clear-exhausted', (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    if (isDemoAccount(id)) {
      res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可操作' } });
      return;
    }
    const account = getAccountById(id);
    if (!account) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }); return; }
    clearExhausted(id, 'ai_neurons');
    createAuditLog(id, 'clear_exhausted', account.name, 'ai_neurons', 'success');
    res.json({ success: true, message: '已清除 AI 配额耗尽标记' });
  } catch (err) { next(err); }
});

// ============ 批量测试 ============
// body: { ids?: number[], onlyUnverified?: boolean }
// 不传 ids 且 onlyUnverified=true 时，测试所有 is_active=0 的账户
router.post('/test-batch', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const onlyUnverified = req.body?.onlyUnverified === true || req.body?.onlyUnverified === 'true';
    const ids: number[] | undefined = Array.isArray(req.body?.ids)
      ? req.body.ids.map((x: any) => parseInt(x, 10)).filter((n: number) => !isNaN(n))
      : undefined;

    let targets = getAllAccounts();
    if (ids && ids.length > 0) {
      const idSet = new Set(ids);
      targets = targets.filter(a => idSet.has(a.id));
    } else if (onlyUnverified) {
      targets = targets.filter(a => a.is_active === 0);
    }
    // 跳过演示账户
    targets = targets.filter(a => !isDemoAccount(a.id));

    const results: Array<{ id: number; name: string; status: 'success' | 'error'; message?: string }> = [];

    async function testOne(account: { id: number; name: string }): Promise<void> {
      try {
        const cf = getCfClient(getAccountById(account.id)!);
        await cf.user.get();
        // 自动获取 account_id
        const saved = getAccountById(account.id);
        if (saved && !saved.account_id) {
          try {
            const accts: any[] = [];
            for await (const acct of cf.accounts.list()) {
              accts.push(acct as any);
            }
            if (accts.length > 0) {
              updateAccountId(account.id, accts[0].id);
            }
          } catch (e) {
            appLogger.warn(`[Account:TestBatch] Failed to fetch account_id for "${account.name}": ${e}`);
          }
        }
        updateAccountStatus(account.id, true);
        createAuditLog(account.id, 'test_account', account.name, 'batch', 'success');
        results.push({ id: account.id, name: account.name, status: 'success' });
      } catch (e: any) {
        // 测试失败：标记为未活跃
        updateAccountStatus(account.id, false);
        createAuditLog(account.id, 'test_account', account.name, `batch: ${e.message || e}`, 'error');
        results.push({ id: account.id, name: account.name, status: 'error', message: e.message || String(e) });
      }
    }

    // 并发批处理：每批 5 条并发
    const BATCH_CONCURRENCY = 5;
    for (let i = 0; i < targets.length; i += BATCH_CONCURRENCY) {
      const batch = targets.slice(i, i + BATCH_CONCURRENCY);
      await Promise.all(batch.map(t => testOne(t)));
    }

    clearCache();
    const summary = {
      total: results.length,
      success: results.filter(r => r.status === 'success').length,
      error: results.filter(r => r.status === 'error').length,
    };
    appLogger.info(`[Account:TestBatch] 批量测试完成: 共 ${summary.total}，成功 ${summary.success}，失败 ${summary.error}`);
    res.json({ summary, results });
  } catch (err) { next(err); }
});

// ============ 批量导入 CSV ============
// CSV 表头: email,password,apiKey
// 按邮箱去重；账户名按规则从邮箱提取；单个账户错误不影响批量导入
router.post('/import-csv', uploadCsv.single('file'), async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: '未提供 CSV 文件' } });
      return;
    }
    const raw = req.file.buffer.toString('utf8').replace(/^\uFEFF/, ''); // 去除 BOM
    const rows = parseCsv(raw);
    if (rows.length === 0) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'CSV 文件为空或无有效数据行' } });
      return;
    }

    const header = rows[0].map(h => h.trim().toLowerCase());
    const emailIdx = header.findIndex(h => h === 'email');
    const apiKeyIdx = header.findIndex(h => h === 'apikey' || h === 'api_key');
    const passwordIdx = header.findIndex(h => h === 'password');

    if (emailIdx === -1 || apiKeyIdx === -1) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'CSV 必须包含 email 和 apiKey 列' } });
      return;
    }

    // skipVerify=1 跳过凭证验证（秒级完成），适合大批量导入 + 后续手动测试
    const skipVerify = req.body?.skipVerify === '1' || req.body?.skipVerify === 'true' || (req.query.skipVerify as string) === '1';

    const dataRows = rows.slice(1);
    const results: Array<{ email: string; name: string; status: 'success' | 'skipped' | 'error'; message?: string }> = [];
    const seenEmails = new Set<string>(); // 同批次内去重

    // 预过滤：解析 + 去重 + 数据库去重，生成待处理任务列表
    interface ImportTask {
      email: string;
      apiKey: string;
      password: string;
      name: string;
      result: { email: string; name: string; status: 'success' | 'skipped' | 'error'; message?: string };
    }
    const pendingTasks: ImportTask[] = [];
    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const email = (row[emailIdx] || '').trim();
      const apiKey = (row[apiKeyIdx] || '').trim();
      const password = passwordIdx !== -1 ? (row[passwordIdx] || '').trim() : '';

      if (!email || !apiKey) {
        results.push({ email: email || '(空)', name: '', status: 'error', message: '邮箱或 apiKey 为空' });
        continue;
      }
      // 同批次内去重
      if (seenEmails.has(email)) {
        results.push({ email, name: nameFromEmail(email), status: 'skipped', message: 'CSV 内重复邮箱' });
        continue;
      }
      seenEmails.add(email);
      // 数据库去重
      if (getAccountByEmail(email)) {
        results.push({ email, name: nameFromEmail(email), status: 'skipped', message: '数据库已存在该邮箱' });
        continue;
      }
      pendingTasks.push({
        email, apiKey, password, name: nameFromEmail(email),
        result: { email, name: nameFromEmail(email), status: 'success' },
      });
    }

    // 处理单个任务：验证凭证 + 入库 + 自动获取 account_id
    async function processTask(task: ImportTask): Promise<void> {
      const { email, apiKey, password, name } = task;
      try {
        // 验证 Cloudflare 凭证（可跳过）
        if (!skipVerify) {
          try {
            const httpAgent = getHttpAgent();
            const opts: Record<string, any> = {};
            if (httpAgent) opts.httpAgent = httpAgent;
            const tempCf = new Cloudflare({ apiEmail: email, apiKey, ...opts });
            await tempCf.user.get();
          } catch (e: any) {
            task.result = { email, name, status: 'error', message: `凭证验证失败: ${e.message || e}` };
            return;
          }
        }
        // 保存到数据库
        const input: AccountInput = {
          name,
          auth_type: 'global_key',
          email,
          api_key: encrypt(apiKey),
          password: password ? encrypt(password) : undefined,
        };
        const id = createAccount(input);

        // 自动获取 account_id（跳过验证模式下也尝试获取，失败不阻断）
        if (!skipVerify) {
          try {
            const saved = getAccountById(id);
            if (saved) {
              const cf = getCfClient(saved);
              const accts: any[] = [];
              for await (const acct of cf.accounts.list()) {
                accts.push(acct as any);
              }
              if (accts.length > 0) {
                updateAccountId(id, accts[0].id);
                appLogger.info(`[Account:Import] Auto-fetched account_id=${accts[0].id} for "${name}"`);
              }
              updateAccountStatus(id, true);
            }
          } catch (e) {
            appLogger.warn(`[Account:Import] Failed to auto-fetch account_id for "${name}": ${e}`);
          }
        } else {
          // 跳过验证模式：标记为未验证，后续通过「测试」按钮激活
          updateAccountStatus(id, false);
        }

        createAuditLog(id, 'import_account', name, `email=${email}${skipVerify ? ' (skipVerify)' : ''}`, 'success');
        task.result = { email, name, status: 'success' };
      } catch (e: any) {
        task.result = { email, name, status: 'error', message: `保存失败: ${e.message || e}` };
      }
    }

    // 并发批处理：每批 5 条并发，批与批之间顺序执行
    const BATCH_CONCURRENCY = skipVerify ? 20 : 5; // 跳过验证时无需控制 CF API 并发，可大幅提高
    for (let i = 0; i < pendingTasks.length; i += BATCH_CONCURRENCY) {
      const batch = pendingTasks.slice(i, i + BATCH_CONCURRENCY);
      await Promise.all(batch.map(t => processTask(t)));
      batch.forEach(t => results.push(t.result));
    }

    clearCache();
    const summary = {
      total: results.length,
      success: results.filter(r => r.status === 'success').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      error: results.filter(r => r.status === 'error').length,
    };
    appLogger.info(`[Account:Import] CSV 批量导入完成${skipVerify ? ' (skipVerify)' : ''}: 共 ${summary.total}，成功 ${summary.success}，跳过 ${summary.skipped}，失败 ${summary.error}`);
    res.json({ summary, results });
  } catch (err) { next(err); }
});

/**
* 简单 CSV 解析器：支持双引号包裹的字段和字段内的逗号/换行/双引号转义
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  while (i < normalized.length) {
    const ch = normalized[i];
    if (inQuotes) {
      if (ch === '"') {
        if (normalized[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      field = '';
      if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
        rows.push(row);
      }
      row = [];
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
      rows.push(row);
    }
  }
  return rows;
}

export default router;
