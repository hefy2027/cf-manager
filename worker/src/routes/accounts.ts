import { Hono } from 'hono';
import type { Env } from '../types';
import { getAllAccounts, getAccountById, getAccountByEmail, nameFromEmail, createAccount, updateAccount, deleteAccount, addAuditLog, listAccountsPaged, AccountListFilter, clearExhausted } from '../db/models';
import { encrypt } from '../services/encryption';
import { probeAvailableFeatures } from '../services/accountProbe';
import { cfFetch } from '../services/cfApi';
import { getQuotaSummary } from '../services/quotaTracker';
import { isDemoAccount } from '../services/demo';

const app = new Hono<{ Bindings: Env }>();

app.get('/', async (c) => {
  const db = c.env.DB;
  const demoIds = c.env.DEMO_ACCOUNT_IDS;
  const quota = await getQuotaSummary(db, c.env.ENCRYPTION_KEY);
  // 分页模式：当传入 page 或 pageSize 时启用；不传则保持原全量行为（向后兼容）
  const wantsPaged = c.req.query('page') !== undefined || c.req.query('pageSize') !== undefined;
  if (wantsPaged) {
    const filterRaw = c.req.query('filter') as string | undefined;
    const validFilters: AccountListFilter[] = ['all', 'active', 'unverified'];
    const filter: AccountListFilter = validFilters.includes(filterRaw as AccountListFilter) ? (filterRaw as AccountListFilter) : 'all';
    const paged = await listAccountsPaged(db, {
      page: parseInt(c.req.query('page') as string, 10) || 1,
      pageSize: parseInt(c.req.query('pageSize') as string, 10) || 20,
      filter,
      search: c.req.query('search') || '',
    });
    const accounts = paged.accounts.map(a => ({
      ...a,
      api_token: a.api_token ? '***encrypted***' : null,
      api_key: a.api_key ? '***encrypted***' : null,
      is_demo: isDemoAccount(a.id, demoIds),
    }));
    return c.json({ accounts, quota, total: paged.total, counts: paged.counts });
  }
  const accounts = (await getAllAccounts(db)).map(a => ({
    ...a,
    api_token: a.api_token ? '***encrypted***' : null,
    api_key: a.api_key ? '***encrypted***' : null,
    is_demo: isDemoAccount(a.id, demoIds),
  }));
  return c.json({ accounts, quota });
});

app.post('/', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json();
  const { name, auth_type, account_id, api_token, api_key, email, enabled_features } = body;

  if (!name || !auth_type) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name and auth_type are required' } }, 400);
  if (auth_type !== 'token' && auth_type !== 'global_key') return c.json({ error: { code: 'VALIDATION_ERROR', message: 'auth_type must be "token" or "global_key"' } }, 400);
  if (auth_type === 'token' && !api_token) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'api_token is required for token auth' } }, 400);
  if (auth_type === 'global_key' && (!api_key || !email)) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'api_key and email are required for global_key auth' } }, 400);

  // Verify credentials before saving
  try {
    const CF_BASE = 'https://api.cloudflare.com/client/v4';
    let headers: Record<string, string>;
    if (auth_type === 'token') {
      headers = { Authorization: `Bearer ${api_token}` };
    } else {
      headers = { 'X-Auth-Email': email, 'X-Auth-Key': api_key };
    }
    const verifyRes = await fetch(`${CF_BASE}/user`, { headers });
    if (!verifyRes.ok) {
      const body = await verifyRes.text();
      return c.json({ error: { code: 'CREDENTIAL_INVALID', message: `Cloudflare API 凭证验证失败 (${verifyRes.status}): ${body}` } }, 400);
    }
  } catch (e) {
    return c.json({ error: { code: 'CREDENTIAL_INVALID', message: `无法连接 Cloudflare API: ${e}` } }, 400);
  }

  const input: any = { name, auth_type, account_id, enabled_features };
  if (auth_type === 'token') {
    input.api_token = await encrypt(api_token, c.env.ENCRYPTION_KEY);
  } else {
    input.api_key = await encrypt(api_key, c.env.ENCRYPTION_KEY);
    input.email = email;
  }

  const id = await createAccount(db, input);

  if (!account_id) {
    try {
      const saved = await getAccountById(db, id);
      if (saved) {
        const data = await cfFetch<{ result: any[] }>(saved, '/accounts?page=1&per_page=10', c.env.ENCRYPTION_KEY);
        if (data.result?.length > 0) {
          await updateAccount(db, id, { account_id: data.result[0].id });
          console.log(`[Account] Auto-fetched account_id=${data.result[0].id} for "${name}"`);
        }
        await updateAccount(db, id, { is_active: 1 });
      }
    } catch (e) {
      console.warn(`[Account] Failed to auto-fetch account_id for "${name}": ${e}`);
    }
  }

  // 探测 R2 可用性（重新获取，account_id 可能刚被更新）
  try {
    const fresh = await getAccountById(db, id);
    if (fresh) {
      const features = await probeAvailableFeatures(fresh, encryptionKey);
      if (features) await updateAccount(db, id, { available_features: features });
    }
  } catch (e) {
    console.warn(`[Account] Failed to probe features for "${name}": ${e}`);
  }

  await addAuditLog(db, { account_id: id, action: 'create_account', target: name, detail: `auth_type=${auth_type}`, status: 'success' });
  return c.json({ id, ...input, api_token: '***', api_key: '***' }, 201);
});

app.put('/:id', async (c) => {
  const db = c.env.DB;
  const encryptionKey = c.env.ENCRYPTION_KEY;
  const id = parseInt(c.req.param('id'), 10);

  if (isDemoAccount(id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可编辑' } }, 403);
  }
  const existing = await getAccountById(db, id);
  if (!existing) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

  const { name, auth_type, api_token, api_key, email } = await c.req.json();
  if (!name || !auth_type) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name and auth_type are required' } }, 400);
  if (auth_type !== 'token' && auth_type !== 'global_key') return c.json({ error: { code: 'VALIDATION_ERROR', message: 'auth_type must be "token" or "global_key"' } }, 400);

  const input: any = { name, auth_type };
  const switching = existing.auth_type !== auth_type;
  const CF_BASE = 'https://api.cloudflare.com/client/v4';

  if (auth_type === 'token') {
    if (switching && !api_token) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '切换至 token 认证需提供 api_token' } }, 400);
    }
    if (api_token) {
      try {
        const verifyRes = await fetch(`${CF_BASE}/user`, { headers: { Authorization: `Bearer ${api_token}` } });
        if (!verifyRes.ok) {
          const body = await verifyRes.text();
          return c.json({ error: { code: 'CREDENTIAL_INVALID', message: `Cloudflare API 凭证验证失败 (${verifyRes.status}): ${body}` } }, 400);
        }
      } catch (e) {
        return c.json({ error: { code: 'CREDENTIAL_INVALID', message: `无法连接 Cloudflare API: ${e}` } }, 400);
      }
      input.api_token = await encrypt(api_token, encryptionKey);
    }
    if (switching) { input.api_key = null; input.email = null; }
  } else {
    const hasEmail = !!email, hasKey = !!api_key;
    if (switching && (!hasEmail || !hasKey)) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: '切换至 global_key 认证需同时提供 email 和 api_key' } }, 400);
    }
    if (hasEmail !== hasKey) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'email 与 api_key 需同时填写' } }, 400);
    }
    if (hasEmail && hasKey) {
      try {
        const verifyRes = await fetch(`${CF_BASE}/user`, { headers: { 'X-Auth-Email': email, 'X-Auth-Key': api_key } });
        if (!verifyRes.ok) {
          const body = await verifyRes.text();
          return c.json({ error: { code: 'CREDENTIAL_INVALID', message: `Cloudflare API 凭证验证失败 (${verifyRes.status}): ${body}` } }, 400);
        }
      } catch (e) {
        return c.json({ error: { code: 'CREDENTIAL_INVALID', message: `无法连接 Cloudflare API: ${e}` } }, 400);
      }
      input.api_key = await encrypt(api_key, encryptionKey);
      input.email = email;
    }
    if (switching) { input.api_token = null; }
  }

  // 先保存，再重取 saved
  await updateAccount(db, id, input);
  const saved = await getAccountById(db, id);
  if (!saved) return c.json({ error: { code: 'INTERNAL', message: '保存后账户消失' } }, 500);

  // 自动刷新 account_id
  if (!saved.account_id || input.api_token || input.api_key) {
    try {
      const data = await cfFetch<{ result: any[] }>(saved, '/accounts?page=1&per_page=10', encryptionKey);
      if (data.result?.length > 0) {
        await updateAccount(db, id, { account_id: data.result[0].id });
        console.log(`[Account] Auto-fetched account_id=${data.result[0].id} for "${name}"`);
      }
      await updateAccount(db, id, { is_active: 1 });
    } catch (e) {
      console.warn(`[Account] Failed to auto-fetch account_id for "${name}": ${e}`);
    }
  }

  await addAuditLog(db, { account_id: id, action: 'update_account', target: name, detail: `auth_type=${auth_type}`, status: 'success' });

  // 若提供了新凭证，探测 R2（重新获取，account_id 可能刚被更新）
  if (input.api_token || input.api_key) {
    try {
      const probed = await getAccountById(db, id);
      if (probed) {
        const features = await probeAvailableFeatures(probed, encryptionKey);
        await updateAccount(db, id, { available_features: features });
        console.log(`[Account] Probed features for "${name}": ${features}`);
      }
    } catch (e) {
      console.warn(`[Account] Failed to probe features for "${name}": ${e}`);
    }
  }

  return c.json({ success: true });
});

app.patch('/:id/features', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  if (isDemoAccount(id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可修改' } }, 403);
  }
  const account = await getAccountById(db, id);
  if (!account) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

  const { enabled_features } = await c.req.json();
  if (typeof enabled_features !== 'string') return c.json({ error: { code: 'VALIDATION_ERROR', message: 'enabled_features is required' } }, 400);

  await updateAccount(db, id, { enabled_features });
  await addAuditLog(db, { account_id: id, action: 'update_features', target: account.name, detail: enabled_features, status: 'success' });
  return c.json({ success: true });
});

app.delete('/:id', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  if (isDemoAccount(id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可删除' } }, 403);
  }
  const account = await getAccountById(db, id);
  if (!account) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

  await addAuditLog(db, { account_id: id, action: 'delete_account', target: account.name, status: 'success' });
  await deleteAccount(db, id);
  return c.json({ success: true });
});

app.post('/:id/test', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  const account = await getAccountById(db, id);
  if (!account) return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);

  const user = await cfFetch(account, '/user', c.env.ENCRYPTION_KEY);

  if (!account.account_id) {
    try {
      const data = await cfFetch<{ result: any[] }>(account, '/accounts?page=1&per_page=10', c.env.ENCRYPTION_KEY);
      if (data.result?.length > 0) {
        await updateAccount(db, id, { account_id: data.result[0].id });
      }
    } catch (e) {
      console.warn(`[Account] Failed to fetch account list: ${e}`);
    }
  }

  await updateAccount(db, id, { is_active: 1 });

  // 探测 R2 可用性（重新获取，account_id 可能刚被更新）
  try {
    const fresh = await getAccountById(db, id);
    if (fresh) {
      const features = await probeAvailableFeatures(fresh, encryptionKey);
      if (features) await updateAccount(db, id, { available_features: features });
    }
  } catch (e) {
    console.warn(`[Account] Failed to probe features for account ${id}: ${e}`);
  }

  return c.json({ user });
});

// ============ 清除 AI 配额耗尽标记 ============
app.post('/:id/clear-exhausted', async (c) => {
  const db = c.env.DB;
  const id = parseInt(c.req.param('id'), 10);
  if (isDemoAccount(id, c.env.DEMO_ACCOUNT_IDS)) {
    return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可操作' } }, 403);
  }
  const account = await getAccountById(db, id);
  if (!account) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Account not found' } }, 404);
  }
  await clearExhausted(db, id, 'ai_neurons');
  try { await addAuditLog(db, { account_id: id, action: 'clear_exhausted', target: account.name, detail: 'ai_neurons', status: 'success' }); } catch {}
  return c.json({ success: true, message: '已清除 AI 配额耗尽标记' });
});

// ============ 批量测试 ============
// body: { ids?: number[], onlyUnverified?: boolean }
// 不传 ids 且 onlyUnverified=true 时，测试所有 is_active=0 的账户
app.post('/test-batch', async (c) => {
  const db = c.env.DB;
  const encryptionKey = c.env.ENCRYPTION_KEY;
  const body = await c.req.json().catch(() => ({}));
  const onlyUnverified = body?.onlyUnverified === true || body?.onlyUnverified === 'true';
  const ids: number[] | undefined = Array.isArray(body?.ids)
    ? body.ids.map((x: any) => parseInt(x, 10)).filter((n: number) => !isNaN(n))
    : undefined;

  let targets = await getAllAccounts(db);
  if (ids && ids.length > 0) {
    const idSet = new Set(ids);
    targets = targets.filter(a => idSet.has(a.id));
  } else if (onlyUnverified) {
    targets = targets.filter(a => a.is_active === 0);
  }
  // 跳过演示账户
  const demoIds = c.env.DEMO_ACCOUNT_IDS;
  targets = targets.filter(a => !isDemoAccount(a.id, demoIds));

  const results: Array<{ id: number; name: string; status: 'success' | 'error'; message?: string }> = [];

  async function testOne(account: { id: number; name: string }): Promise<void> {
    try {
      const full = await getAccountById(db, account.id);
      if (!full) throw new Error('Account not found');
      await cfFetch(full, '/user', encryptionKey);
      // 自动获取 account_id
      if (!full.account_id) {
        try {
          const data = await cfFetch<{ result: any[] }>(full, '/accounts?page=1&per_page=10', encryptionKey);
          if (data.result?.length > 0) {
            await updateAccount(db, account.id, { account_id: data.result[0].id });
          }
        } catch (e) {
          console.warn(`[Account:TestBatch] Failed to fetch account_id for "${account.name}": ${e}`);
        }
      }
      await updateAccount(db, account.id, { is_active: 1 });

      // 探测 R2 可用性（重新获取，account_id 可能刚被更新）
      try {
        const fresh = await getAccountById(db, account.id);
        if (fresh) {
          const features = await probeAvailableFeatures(fresh, encryptionKey);
          if (features) await updateAccount(db, account.id, { available_features: features });
        }
      } catch (e) {
        console.warn(`[Account:TestBatch] Failed to probe features for "${account.name}": ${e}`);
      }

      await addAuditLog(db, { account_id: account.id, action: 'test_account', target: account.name, detail: 'batch', status: 'success' });
      results.push({ id: account.id, name: account.name, status: 'success' });
    } catch (e: any) {
      // 测试失败：标记为未活跃
      await updateAccount(db, account.id, { is_active: 0 });
      await addAuditLog(db, { account_id: account.id, action: 'test_account', target: account.name, detail: `batch: ${e?.message || e}`, status: 'error' });
      results.push({ id: account.id, name: account.name, status: 'error', message: e?.message || String(e) });
    }
  }

  // 并发批处理：每批 5 条并发
  // Worker 注意：Free 计划 subrequest 上限 50/请求，即每次最多测试 ~25 账户
  const BATCH_CONCURRENCY = 5;
  for (let i = 0; i < targets.length; i += BATCH_CONCURRENCY) {
    const batch = targets.slice(i, i + BATCH_CONCURRENCY);
    await Promise.all(batch.map(t => testOne(t)));
  }

  const summary = {
    total: results.length,
    success: results.filter(r => r.status === 'success').length,
    error: results.filter(r => r.status === 'error').length,
  };
  console.log(`[Account:TestBatch] 批量测试完成: 共 ${summary.total}，成功 ${summary.success}，失败 ${summary.error}`);
  return c.json({ summary, results });
});

// ============ 批量导入 CSV ============
// CSV 表头: email,password,apiKey
// 按邮箱去重；账户名按规则从邮箱提取；单个账户错误不影响批量导入
app.post('/import-csv', async (c) => {
  const db = c.env.DB;
  const encryptionKey = c.env.ENCRYPTION_KEY;

  const formData = await c.req.formData();
  const file = formData.get('file') as Blob | null;
  if (!file) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: '未提供 CSV 文件' } }, 400);
  }

  const raw = await file.text();
  const cleaned = raw.replace(/^\uFEFF/, ''); // 去除 BOM
  const rows = parseCsv(cleaned);
  if (rows.length === 0) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'CSV 文件为空或无有效数据行' } }, 400);
  }

  const header = rows[0].map(h => h.trim().toLowerCase());
  const emailIdx = header.findIndex(h => h === 'email');
  const apiKeyIdx = header.findIndex(h => h === 'apikey' || h === 'api_key');

  if (emailIdx === -1 || apiKeyIdx === -1) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'CSV 必须包含 email 和 apiKey 列' } }, 400);
  }

  // skipVerify=1 跳过凭证验证（秒级完成），适合大批量导入 + 后续手动测试
  const skipVerify = formData.get('skipVerify') === '1' || formData.get('skipVerify') === 'true' || c.req.query('skipVerify') === '1';

  const dataRows = rows.slice(1);
  const results: Array<{ email: string; name: string; status: 'success' | 'skipped' | 'error'; message?: string }> = [];
  const seenEmails = new Set<string>();

  // 预过滤：解析 + 去重 + 数据库去重，生成待处理任务列表
  interface ImportTask {
    email: string;
    apiKey: string;
    name: string;
    result: { email: string; name: string; status: 'success' | 'skipped' | 'error'; message?: string };
  }
  const pendingTasks: ImportTask[] = [];
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const email = (row[emailIdx] || '').trim();
    const apiKey = (row[apiKeyIdx] || '').trim();

    if (!email || !apiKey) {
      results.push({ email: email || '(空)', name: '', status: 'error', message: '邮箱或 apiKey 为空' });
      continue;
    }
    if (seenEmails.has(email)) {
      results.push({ email, name: nameFromEmail(email), status: 'skipped', message: 'CSV 内重复邮箱' });
      continue;
    }
    seenEmails.add(email);
    if (await getAccountByEmail(db, email)) {
      results.push({ email, name: nameFromEmail(email), status: 'skipped', message: '数据库已存在该邮箱' });
      continue;
    }
    pendingTasks.push({
      email, apiKey, name: nameFromEmail(email),
      result: { email, name: nameFromEmail(email), status: 'success' },
    });
  }

  // 处理单个任务：验证凭证 + 入库 + 自动获取 account_id
  async function processTask(task: ImportTask): Promise<void> {
    const { email, apiKey, name } = task;
    try {
      // 验证 Cloudflare 凭证（可跳过）
      if (!skipVerify) {
        try {
          const verifyRes = await fetch('https://api.cloudflare.com/client/v4/user', {
            headers: { 'X-Auth-Email': email, 'X-Auth-Key': apiKey },
          });
          if (!verifyRes.ok) {
            const body = await verifyRes.text();
            task.result = { email, name, status: 'error', message: `凭证验证失败 (${verifyRes.status}): ${body.slice(0, 200)}` };
            return;
          }
        } catch (e: any) {
          task.result = { email, name, status: 'error', message: `凭证验证请求失败: ${e?.message || e}` };
          return;
        }
      }
      // 保存到数据库
      const input: any = {
        name,
        auth_type: 'global_key',
        email,
        api_key: await encrypt(apiKey, encryptionKey),
      };
      const id = await createAccount(db, input);

      // 自动获取 account_id
      if (!skipVerify) {
        try {
          const saved = await getAccountById(db, id);
          if (saved) {
            const data = await cfFetch<{ result: any[] }>(saved, '/accounts?page=1&per_page=10', encryptionKey);
            if (data.result?.length > 0) {
              await updateAccount(db, id, { account_id: data.result[0].id });
              console.log(`[Account:Import] Auto-fetched account_id=${data.result[0].id} for "${name}"`);
            }
            await updateAccount(db, id, { is_active: 1 });
          }
        } catch (e) {
          console.warn(`[Account:Import] Failed to auto-fetch account_id for "${name}": ${e}`);
        }
      } else {
        // 跳过验证模式：标记为未验证，后续通过「测试」按钮激活
        await updateAccount(db, id, { is_active: 0 });
      }

      await addAuditLog(db, { account_id: id, action: 'import_account', target: name, detail: `email=${email}${skipVerify ? ' (skipVerify)' : ''}`, status: 'success' });
      task.result = { email, name, status: 'success' };
    } catch (e: any) {
      task.result = { email, name, status: 'error', message: `保存失败: ${e?.message || e}` };
    }
  }

  // 并发批处理：每批 5 条并发，批与批之间顺序执行
  // Worker 注意：Free 计划 subrequest 上限 50/请求，即每批最多 ~25 账户
  // 跳过验证模式不调用 CF API，可大幅提高并发（20）
  const BATCH_CONCURRENCY = skipVerify ? 20 : 5;
  for (let i = 0; i < pendingTasks.length; i += BATCH_CONCURRENCY) {
    const batch = pendingTasks.slice(i, i + BATCH_CONCURRENCY);
    await Promise.all(batch.map(t => processTask(t)));
    batch.forEach(t => results.push(t.result));
  }

  const summary = {
    total: results.length,
    success: results.filter(r => r.status === 'success').length,
    skipped: results.filter(r => r.status === 'skipped').length,
    error: results.filter(r => r.status === 'error').length,
  };
  console.log(`[Account:Import] CSV 批量导入完成${skipVerify ? ' (skipVerify)' : ''}: 共 ${summary.total}，成功 ${summary.success}，跳过 ${summary.skipped}，失败 ${summary.error}`);
  return c.json({ summary, results });
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

export default app;
