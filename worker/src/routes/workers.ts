import { Hono } from 'hono';
import type { Env } from '../types';
import { getAccountById, getActiveAccountsByFeature, addAuditLog } from '../db/models';
import { cfFetch, cfFetchRaw, cfFetchAll } from '../services/cfApi';
import { getWorkersUsageToday } from '../services/quotaTracker';
import { demoDestructiveGuard } from '../services/demo';
import { deployPages, extractZipFiles, validatePagesProjectName, ensurePagesProject } from '../services/pagesDeploy';
import { fetchScriptSafely } from '../services/ssrfGuard';

const app = new Hono<{ Bindings: Env }>();

// 演示账户：拦截所有销毁/删除类操作（DELETE 等）
app.use('/:accountId/*', demoDestructiveGuard());

async function requireAccount(c: any) {
  const id = parseInt(c.req.param('accountId'), 10);
  const account = await getAccountById(c.env.DB, id);
  if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  return account;
}

// ============ List all ============
// 支持 ?accountId= 仅返回该账户的 Worker/Pages（按需加载）；不带参数返回全部（批量部署/环境同步用）
app.get('/', async (c) => {
  const accountIdQ = c.req.query('accountId');
  let accounts;
  if (accountIdQ) {
    const acc = await getAccountById(c.env.DB, parseInt(accountIdQ, 10));
    accounts = acc ? [acc] : [];
  } else {
    accounts = await getActiveAccountsByFeature(c.env.DB, 'workers');
  }
  const results = await Promise.all(accounts.map(async (account) => {
    const items: any[] = [];
    const [workersRes, pagesRes] = await Promise.allSettled([
      cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/workers/scripts`, c.env.ENCRYPTION_KEY),
      cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/pages/projects`, c.env.ENCRYPTION_KEY),
    ]);
    if (workersRes.status === 'fulfilled') {
      items.push(...(workersRes.value.result || []).map(w => ({ ...w, name: w.id, status: 'deployed', type: 'worker', cfAccountId: account.id, accountName: account.name })));
    } else { console.error(`[Workers] list failed for ${account.name}: ${workersRes.reason}`); }
    if (pagesRes.status === 'fulfilled') {
      items.push(...(pagesRes.value.result || []).map(p => ({ ...p, name: p.name ?? p.id, type: 'pages', cfAccountId: account.id, accountName: account.name })));
    } else { console.error(`[Pages] list failed for ${account.name}: ${pagesRes.reason}`); }
    return items;
  }));
  return c.json(results.flat());
});

// ============ Deploy Worker ============
app.post('/:accountId/workers', async (c) => {
  const account = await requireAccount(c);
  const contentType = c.req.header('content-type') || '';

  let name: string;
  let scriptContent: string;
  let deploySource = 'upload';

  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData();
    name = formData.get('name') as string;
    const url = formData.get('url') as string;
    const file = formData.get('script') as File | null;
    if (!name) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Worker name is required' } }, 400);
    if (url) {
      deploySource = `url=${url}`;
      try {
        scriptContent = await fetchScriptSafely(url, c.env);
      } catch (e: any) {
        const code = e.statusCode === 403 ? 'SSRF_BLOCKED' : 'FETCH_ERROR';
        return c.json({ error: { code, message: e.message } }, e.statusCode || 400);
      }
    } else if (file) {
      scriptContent = await file.text();
    } else {
      return c.json({ error: { code: 'NO_FILE', message: 'Script file or URL is required' } }, 400);
    }
  } else {
    const body = await c.req.json();
    name = body.name;
    if (!name) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Worker name is required' } }, 400);
    if (body.url) {
      deploySource = `url=${body.url}`;
      try {
        scriptContent = await fetchScriptSafely(body.url, c.env);
      } catch (e: any) {
        const code = e.statusCode === 403 ? 'SSRF_BLOCKED' : 'FETCH_ERROR';
        return c.json({ error: { code, message: e.message } }, e.statusCode || 400);
      }
    } else {
      return c.json({ error: { code: 'NO_FILE', message: 'Script URL is required' } }, 400);
    }
  }

  const metadata = JSON.stringify({ main_module: 'worker.js', compatibility_date: '2024-01-01' });
  const form = new FormData();
  form.append('metadata', new Blob([metadata], { type: 'application/json' }));
  form.append('worker.js', new Blob([scriptContent], { type: 'application/javascript+module' }), 'worker.js');

  const resp = await cfFetchRaw(account, `/accounts/${account.account_id}/workers/scripts/${name}`, c.env.ENCRYPTION_KEY, {
    method: 'PUT', body: form,
  });
  const result = await resp.json();

  // Enable workers.dev subdomain so the Worker is accessible immediately (matches backend behavior)
  try {
    await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${name}/subdomain`, c.env.ENCRYPTION_KEY, {
      method: 'POST', body: JSON.stringify({ enabled: true, previews_enabled: true }),
    });
  } catch (_) {
    // Soft fail: user can still enable manually from settings drawer
  }

  await addAuditLog(c.env.DB, { account_id: account.id, action: 'deploy_worker', target: name, detail: deploySource, status: 'success' });
  return c.json(result, 201);
});

// ============ Delete Worker/Pages ============
app.delete('/:accountId/workers/:name', async (c) => {
  const account = await requireAccount(c);
  const name = c.req.param('name');
  await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${name}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'delete_worker', target: name, status: 'success' });
  return c.json({ success: true });
});

app.delete('/:accountId/pages/:name', async (c) => {
  const account = await requireAccount(c);
  const name = c.req.param('name');
  await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${name}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'delete_pages', target: name, status: 'success' });
  return c.json({ success: true });
});

// ============ Worker Logs (Tail) ============
app.get('/:accountId/workers/:name/logs', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<any>(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/tails`, c.env.ENCRYPTION_KEY);
  return c.json(data.result ?? data);
});

// ============ Secrets ============
app.get('/:accountId/workers/:name/secrets', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/secrets`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.put('/:accountId/workers/:name/secrets', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  if (!body.name || !body.type) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name and type are required' } }, 400);
  const result = await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/secrets`, c.env.ENCRYPTION_KEY, {
    method: 'PUT', body: JSON.stringify(body),
  });
  return c.json(result);
});

app.delete('/:accountId/workers/:name/secrets/:secretName', async (c) => {
  const account = await requireAccount(c);
  await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/secrets/${c.req.param('secretName')}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  return c.json({ success: true });
});

// ============ Schedules ============
app.get('/:accountId/workers/:name/schedules', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<any>(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/schedules`, c.env.ENCRYPTION_KEY);
  return c.json(data.result ?? data);
});

app.put('/:accountId/workers/:name/schedules', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  if (!Array.isArray(body.crons)) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'crons must be an array' } }, 400);
  const result = await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/schedules`, c.env.ENCRYPTION_KEY, {
    method: 'PUT', body: JSON.stringify(body.crons.map((cron: string) => ({ cron }))),
  });
  return c.json(result);
});

// ============ Custom Domains ============
app.get('/:accountId/workers/:name/domains', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/workers/domains?service=${c.req.param('name')}`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.post('/:accountId/workers/:name/domains', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  if (!body.hostname) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'hostname is required' } }, 400);
  const result = await cfFetch(account, `/accounts/${account.account_id}/workers/domains`, c.env.ENCRYPTION_KEY, {
    method: 'PUT', body: JSON.stringify({ hostname: body.hostname, service: c.req.param('name'), environment: body.environment || 'production' }),
  });
  return c.json(result);
});

app.delete('/:accountId/workers/:name/domains/:domainId', async (c) => {
  const account = await requireAccount(c);
  await cfFetch(account, `/accounts/${account.account_id}/workers/domains/${c.req.param('domainId')}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  return c.json({ success: true });
});

// ============ Subdomain ============
app.get('/:accountId/workers/:name/subdomain', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<any>(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/subdomain`, c.env.ENCRYPTION_KEY);
  return c.json(data.result ?? data);
});

app.put('/:accountId/workers/:name/subdomain', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  if (typeof body.enabled !== 'boolean') return c.json({ error: { code: 'VALIDATION_ERROR', message: 'enabled must be boolean' } }, 400);
  const result = await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/subdomain`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ enabled: body.enabled }),
  });
  return c.json(result);
});

// ============ Script Settings ============
app.get('/:accountId/workers/:name/settings', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<any>(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/settings`, c.env.ENCRYPTION_KEY);
  return c.json(data.result ?? data);
});

app.patch('/:accountId/workers/:name/settings', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  const result = await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/settings`, c.env.ENCRYPTION_KEY, {
    method: 'PATCH', body: JSON.stringify(body),
  });
  return c.json(result);
});

// ============ Routes ============
app.get('/:accountId/workers/:name/routes', async (c) => {
  const account = await requireAccount(c);
  const zoneId = c.req.query('zone_id');
  if (!zoneId) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'zone_id is required' } }, 400);
  const data = await cfFetch<{ result: any[] }>(account, `/zones/${zoneId}/workers/routes`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.post('/:accountId/workers/:name/routes', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  if (!body.zone_id || !body.pattern) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'zone_id and pattern are required' } }, 400);
  const result = await cfFetch(account, `/zones/${body.zone_id}/workers/routes`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ pattern: body.pattern, script: body.script || c.req.param('name') }),
  });
  return c.json(result);
});

app.delete('/:accountId/workers/:name/routes/:routeId', async (c) => {
  const account = await requireAccount(c);
  const zoneId = c.req.query('zone_id');
  if (!zoneId) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'zone_id is required' } }, 400);
  await cfFetch(account, `/zones/${zoneId}/workers/routes/${c.req.param('routeId')}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  return c.json({ success: true });
});

// ============ Script Content ============
// CF 返回的是 multipart/form-data，源码在 worker.js 字段里。
// 自写解析器：按 boundary 切分，找出 name="worker.js" 的 part。
app.get('/:accountId/workers/:name/content', async (c) => {
  const account = await requireAccount(c);
  const resp = await cfFetchRaw(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}`, c.env.ENCRYPTION_KEY);
  if (!resp.ok) {
    return c.text(`Failed to fetch script content: ${resp.status}`, resp.status as any);
  }
  const contentType = resp.headers.get('content-type') || '';
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (!/multipart\/form-data/i.test(contentType)) {
    return c.text(new TextDecoder().decode(buf));
  }
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) return c.text(new TextDecoder().decode(buf));
  const delim = new TextEncoder().encode(`--${boundary}`);
  const findIndex = (hay: Uint8Array, needle: Uint8Array, from = 0): number => {
    outer: for (let i = from; i <= hay.length - needle.length; i++) {
      for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
      return i;
    }
    return -1;
  };
  let pos = findIndex(buf, delim);
  if (pos < 0) return c.text(new TextDecoder().decode(buf));
  while (pos < buf.length) {
    const next = findIndex(buf, delim, pos + delim.length);
    const seg = next < 0 ? buf.subarray(pos + delim.length) : buf.subarray(pos + delim.length, next);
    if (seg.length > 0) {
      const headerEnd = findIndex(seg, new TextEncoder().encode('\r\n\r\n'));
      if (headerEnd >= 0) {
        const headers = new TextDecoder().decode(seg.subarray(0, headerEnd));
        if (/name="worker\.js"/i.test(headers)) {
          let body = seg.subarray(headerEnd + 4);
          if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
            body = body.subarray(0, body.length - 2);
          }
          return c.text(new TextDecoder().decode(body));
        }
      }
    }
    if (next < 0) break;
    pos = next;
  }
  return c.text(new TextDecoder().decode(buf));
});

// ============ Deployments ============
app.get('/:accountId/workers/:name/deployments', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<any>(account, `/accounts/${account.account_id}/workers/scripts/${c.req.param('name')}/deployments`, c.env.ENCRYPTION_KEY);
  return c.json(data.result ?? data);
});

// ============ Pages Settings ============
app.get('/:accountId/pages/:name/project', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${c.req.param('name')}`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || data);
});

app.patch('/:accountId/pages/:name/project', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  const result = await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${c.req.param('name')}`, c.env.ENCRYPTION_KEY, {
    method: 'PATCH', body: JSON.stringify(body),
  });
  return c.json(result);
});

app.get('/:accountId/pages/:name/domains', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/pages/projects/${c.req.param('name')}/domains`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.post('/:accountId/pages/:name/domains', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  if (!body.hostname) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'hostname is required' } }, 400);
  const result = await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${c.req.param('name')}/domains`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ name: body.hostname }),
  });
  return c.json(result);
});

app.delete('/:accountId/pages/:name/domains/:hostname', async (c) => {
  const account = await requireAccount(c);
  await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${c.req.param('name')}/domains/${c.req.param('hostname')}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  return c.json({ success: true });
});

app.get('/:accountId/pages/:name/deployments', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<any>(account, `/accounts/${account.account_id}/pages/projects/${c.req.param('name')}/deployments`, c.env.ENCRYPTION_KEY);
  return c.json(data.result ?? data);
});

// ============ Resources ============
app.get('/:accountId/resources/kv', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/storage/kv/namespaces`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.get('/:accountId/resources/d1', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/d1/database`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.get('/:accountId/resources/r2', async (c) => {
  const account = await requireAccount(c);
  try {
    const data = await cfFetch<{ result: any }>(account, `/accounts/${account.account_id}/r2/buckets`, c.env.ENCRYPTION_KEY);
    return c.json(data.result?.buckets || []);
  } catch (e: any) {
    if (e.body?.includes('10042') || e.body?.includes('enable R2') || e.body?.includes('Please enable R2')) {
      return c.json({ r2_not_enabled: true, buckets: [] });
    }
    throw e;
  }
});

app.get('/:accountId/resources/zones', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetchAll<any>(account, '/zones', c.env.ENCRYPTION_KEY, 100);
  return c.json(data.filter(z => z.account?.id === account.account_id));
});

app.put('/:accountId/pages/:name/bindings', async (c) => {
  const account = await requireAccount(c);
  const body = await c.req.json();
  const result = await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${c.req.param('name')}`, c.env.ENCRYPTION_KEY, {
    method: 'PATCH', body: JSON.stringify({ deployment_configs: body.deployment_configs }),
  });
  return c.json(result);
});

// ============ Summary (用量 + 已部署数量) ============
app.get('/summary', async (c) => {
  const accounts = await getActiveAccountsByFeature(c.env.DB, 'workers');
  const results = await Promise.all(accounts.map(async (account) => {
    try {
      const [usageP, workersP, pagesP] = await Promise.allSettled([
        getWorkersUsageToday(account, c.env.ENCRYPTION_KEY),
        cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/workers/scripts`, c.env.ENCRYPTION_KEY),
        cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/pages/projects`, c.env.ENCRYPTION_KEY),
      ]);
      const usage = usageP.status === 'fulfilled' ? usageP.value : { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
      const workerCount = workersP.status === 'fulfilled' ? (workersP.value.result?.length || 0) : 0;
      const pagesCount = pagesP.status === 'fulfilled' ? (pagesP.value.result?.length || 0) : 0;
      return { accountId: account.id, accountName: account.name, ...usage, workerCount, pagesCount };
    } catch (err) {
      console.error(`[Summary] Failed for ${account.name}: ${err}`);
      return { accountId: account.id, accountName: account.name, requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0, workerCount: 0, pagesCount: 0 };
    }
  }));
  return c.json(results);
});

// ============ Usage ============
app.get('/usage', async (c) => {
  const accounts = await getActiveAccountsByFeature(c.env.DB, 'workers');
  const results = await Promise.all(accounts.map(async (account) => {
    try {
      const usage = await getWorkersUsageToday(account, c.env.ENCRYPTION_KEY);
      return { accountId: account.id, accountName: account.name, ...usage };
    } catch (err) {
      console.error(`[Usage] Failed for ${account.name}: ${err}`);
      return { accountId: account.id, accountName: account.name, requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
    }
  }));
  return c.json(results);
});

app.post('/:accountId/pages/deploy', async (c) => {
  const account = await requireAccount(c);
  const formData = await c.req.formData();
  const name = formData.get('name') as string;
  if (!name) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'Project name is required' } }, 400);
  if (!validatePagesProjectName(name)) return c.json({ error: { code: 'VALIDATION_ERROR', message: '项目名只能包含小写字母、数字和连字符，且以字母或数字开头' } }, 400);

  const skipCreateProject = formData.get('skipCreateProject') === 'true';
  const uploadedFiles = formData.getAll('files') as unknown as File[];

  let files: Array<{ path: string; buffer: Uint8Array }> = [];

  if (uploadedFiles.length === 1 && uploadedFiles[0].name?.toLowerCase().endsWith('.zip')) {
    const zipData = new Uint8Array(await uploadedFiles[0].arrayBuffer());
    files = await extractZipFiles(zipData);
  } else {
    for (const f of uploadedFiles) {
      const buf = new Uint8Array(await f.arrayBuffer());
      files.push({ path: f.name.replace(/\\/g, '/').replace(/^\/+/, ''), buffer: buf });
    }
  }

  if (!skipCreateProject) {
    await ensurePagesProject(account, c.env.ENCRYPTION_KEY, name);
  }

  if (files.length === 0) {
    const project = await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${name}`, c.env.ENCRYPTION_KEY);
    return c.json(project.result || project, 201);
  }

  const result = await deployPages(account, c.env.ENCRYPTION_KEY, name, files, {
    skipCreateProject: true,
    commitMessage: 'Deploy via CF Manager',
  });

  await addAuditLog(c.env.DB, { account_id: account.id, action: 'deploy_pages', target: name, detail: `${files.length} files`, status: 'success' });
  // 剥离 CF API 返回的 success 字段，避免与 responseWrapper 冲突
  const { success: _cfSuccess, ...deploymentData } = result;
  return c.json(deploymentData, 201);
});

// ============ Batch Deploy ============
app.post('/batch-deploy', async (c) => {
  const contentType = c.req.header('content-type') || '';
  let targets: any[];
  let scriptContent: string | null = null;
  let scriptUrl: string | null = null;

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData();
    targets = JSON.parse(form.get('targets') as string);
    scriptUrl = form.get('url') as string | null;
    const file = form.get('script') as File | null;
    if (file) scriptContent = await file.text();
  } else {
    const body = await c.req.json();
    targets = body.targets;
    scriptUrl = body.url;
    scriptContent = body.script;
  }

  if (!Array.isArray(targets) || targets.length === 0) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'targets must be a non-empty array' } }, 400);
  if (!scriptContent && !scriptUrl) return c.json({ error: { code: 'NO_FILE', message: 'Script or URL required' } }, 400);

  if (scriptUrl && !scriptContent) {
    try {
      scriptContent = await fetchScriptSafely(scriptUrl, c.env);
    } catch (e: any) {
      const code = e.statusCode === 403 ? 'SSRF_BLOCKED' : 'FETCH_ERROR';
      return c.json({ error: { code, message: e.message } }, e.statusCode || 400);
    }
  }

  const results = await Promise.all(targets.map(async (t: { accountId: number; workerName: string }) => {
    try {
      const account = await getAccountById(c.env.DB, t.accountId);
      if (!account) return { ...t, success: false, error: 'Account not found' };
      const metadata = JSON.stringify({ main_module: 'worker.js', compatibility_date: '2024-01-01' });
      const form = new FormData();
      form.append('metadata', new Blob([metadata], { type: 'application/json' }));
      form.append('worker.js', new Blob([scriptContent!], { type: 'application/javascript+module' }), 'worker.js');
      await cfFetchRaw(account, `/accounts/${account.account_id}/workers/scripts/${t.workerName}`, c.env.ENCRYPTION_KEY, { method: 'PUT', body: form });

      // Enable workers.dev subdomain so the Worker is accessible immediately (matches backend behavior)
      try {
        await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${t.workerName}/subdomain`, c.env.ENCRYPTION_KEY, {
          method: 'POST', body: JSON.stringify({ enabled: true, previews_enabled: true }),
        });
      } catch (_) {
        // Soft fail: user can still enable manually from settings drawer
      }

      await addAuditLog(c.env.DB, { account_id: account.id, action: 'batch_deploy', target: t.workerName, detail: scriptUrl ? `url=${scriptUrl}` : 'upload', status: 'success' });
      return { ...t, success: true };
    } catch (err: any) {
      return { ...t, success: false, error: err.message };
    }
  }));
  return c.json(results);
});

// ============ Batch Deploy Pages ============
app.post('/batch-deploy-pages', async (c) => {
  const form = await c.req.formData();
  const targets = JSON.parse(form.get('targets') as string);
  const zipFile = form.get('zipFile') as File | null;

  if (!Array.isArray(targets) || targets.length === 0) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'targets must be a non-empty array' } }, 400);
  if (!zipFile) return c.json({ error: { code: 'NO_FILE', message: 'Zip file is required' } }, 400);

  const zipBuffer = new Uint8Array(await zipFile.arrayBuffer());
  const files = await extractZipFiles(zipBuffer);

  if (files.length === 0) return c.json({ error: { code: 'EMPTY_ZIP', message: 'Zip file contains no files' } }, 400);

  const results: Array<{ accountId: number; workerName: string; success: boolean; error?: string }> = [];
  for (const t of targets) {
    try {
      const account = await getAccountById(c.env.DB, t.accountId);
      if (!account) { results.push({ ...t, success: false, error: 'Account not found' }); continue; }
      if (!validatePagesProjectName(t.workerName)) { results.push({ ...t, success: false, error: '项目名只能包含小写字母、数字和连字符' }); continue; }

      await deployPages(account, c.env.ENCRYPTION_KEY, t.workerName, files, {
        commitMessage: 'Batch deploy via CF Manager',
      });
      await addAuditLog(c.env.DB, { account_id: account.id, action: 'batch_deploy_pages', target: t.workerName, detail: `${files.length} files`, status: 'success' });
      results.push({ ...t, success: true });
    } catch (err: any) {
      results.push({ ...t, success: false, error: err.message });
    }
  }
  return c.json(results);
});

// ============ Environment Sync ============
app.post('/env-sync/preview', async (c) => {
  const body = await c.req.json();
  const { source, targets, syncTypes } = body;
  if (!source?.accountId || !source?.workerName || !Array.isArray(targets))
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'source and targets are required' } }, 400);

  const sourceAccount = await getAccountById(c.env.DB, source.accountId);
  if (!sourceAccount) return c.json({ error: { code: 'NOT_FOUND', message: 'Source account not found' } }, 404);

  const doSecrets = !syncTypes || syncTypes.includes('secrets');
  let sourceSecrets: any[] = [];
  if (doSecrets) {
    const data = await cfFetch<{ result: any[] }>(sourceAccount, `/accounts/${sourceAccount.account_id}/workers/scripts/${source.workerName}/secrets`, c.env.ENCRYPTION_KEY);
    sourceSecrets = data.result || [];
  }

  const diffs: any[] = [];
  for (const t of targets) {
    const tAccount = await getAccountById(c.env.DB, t.accountId);
    if (!tAccount) continue;
    let tSecrets: any[] = [];
    if (doSecrets) {
      const data = await cfFetch<{ result: any[] }>(tAccount, `/accounts/${tAccount.account_id}/workers/scripts/${t.workerName}/secrets`, c.env.ENCRYPTION_KEY);
      tSecrets = data.result || [];
    }
    const tNames = new Set(tSecrets.map((s: any) => s.name));
    const added = sourceSecrets.filter((s: any) => !tNames.has(s.name)).map((s: any) => s.name);
    const existing = sourceSecrets.filter((s: any) => tNames.has(s.name)).map((s: any) => s.name);
    diffs.push({ accountId: t.accountId, workerName: t.workerName, secrets: { added, existing } });
  }
  return c.json(diffs);
});

app.post('/env-sync/execute', async (c) => {
  const body = await c.req.json();
  const { source, targets, syncTypes, secretValues } = body;
  if (!source?.accountId || !source?.workerName || !Array.isArray(targets))
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'source and targets are required' } }, 400);
  if (!secretValues || typeof secretValues !== 'object')
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'secretValues is required' } }, 400);

  const sourceAccount = await getAccountById(c.env.DB, source.accountId);
  if (!sourceAccount) return c.json({ error: { code: 'NOT_FOUND', message: 'Source account not found' } }, 404);

  const doSecrets = !syncTypes || syncTypes.includes('secrets');
  let sourceSecrets: any[] = [];
  if (doSecrets) {
    const data = await cfFetch<{ result: any[] }>(sourceAccount, `/accounts/${sourceAccount.account_id}/workers/scripts/${source.workerName}/secrets`, c.env.ENCRYPTION_KEY);
    sourceSecrets = data.result || [];
  }

  const results: Array<{ accountId: number; workerName: string; success: boolean; synced: number; error?: string }> = [];
  for (const t of targets) {
    try {
      const tAccount = await getAccountById(c.env.DB, t.accountId);
      if (!tAccount) { results.push({ ...t, success: false, synced: 0, error: 'Account not found' }); continue; }
      let synced = 0;
      if (doSecrets) {
        for (const s of sourceSecrets) {
          const val = secretValues[s.name];
          if (val !== undefined) {
            await cfFetch(tAccount, `/accounts/${tAccount.account_id}/workers/scripts/${t.workerName}/secrets`, c.env.ENCRYPTION_KEY, {
              method: 'PUT', body: JSON.stringify({ name: s.name, type: s.type || 'secret_text', text: val }),
            });
            synced++;
          }
        }
      }
      await addAuditLog(c.env.DB, { account_id: tAccount.id, action: 'env_sync', target: t.workerName, detail: `from ${source.workerName}, ${synced} secrets`, status: 'success' });
      results.push({ ...t, success: true, synced });
    } catch (err: any) {
      results.push({ ...t, success: false, synced: 0, error: err.message });
    }
  }
  return c.json(results);
});

export default app;
