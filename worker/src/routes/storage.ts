import { Hono } from 'hono';
import type { Env } from '../types';
import { getAccountById, addAuditLog } from '../db/models';
import { cfFetch, cfFetchRaw } from '../services/cfApi';

const app = new Hono<{ Bindings: Env }>();

async function requireAccount(c: any) {
  const id = parseInt(c.req.param('accountId'), 10);
  const account = await getAccountById(c.env.DB, id);
  if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  return account;
}

const acctPath = (a: any) => `/accounts/${a.account_id}`;

function extractD1QueryResult(data: any): any {
  const firstResult = Array.isArray(data.result) ? data.result[0] : data;
  return firstResult?.results ?? [];
}

// ============ KV Namespaces ============
app.get('/:accountId/kv', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<{ result: any[] }>(account, `${acctPath(account)}/storage/kv/namespaces`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.post('/:accountId/kv', async (c) => {
  const account = await requireAccount(c);
  const { title } = await c.req.json();
  if (!title) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'title is required' } }, 400);
  const result = await cfFetch(account, `${acctPath(account)}/storage/kv/namespaces`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ title }),
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'create_kv', target: title, status: 'success' });
  return c.json(result, 201);
});

app.delete('/:accountId/kv/:nsId', async (c) => {
  const account = await requireAccount(c);
  await cfFetch(account, `${acctPath(account)}/storage/kv/namespaces/${c.req.param('nsId')}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'delete_kv', target: c.req.param('nsId'), status: 'success' });
  return c.json({ success: true });
});

app.get('/:accountId/kv/:nsId/keys', async (c) => {
  const account = await requireAccount(c);
  const prefix = c.req.query('prefix') || '';
  const cursor = c.req.query('cursor') || '';
  const limit = c.req.query('limit') || '1000';
  let url = `${acctPath(account)}/storage/kv/namespaces/${c.req.param('nsId')}/keys?limit=${limit}`;
  if (prefix) url += `&prefix=${encodeURIComponent(prefix)}`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  const data = await cfFetch<any>(account, url, c.env.ENCRYPTION_KEY);
  return c.json({
    keys: data.result || [],
    cursor: data.result_info?.cursor || undefined,
  });
});

app.get('/:accountId/kv/:nsId/values/:key', async (c) => {
  const account = await requireAccount(c);
  const key = decodeURIComponent(c.req.param('key'));
  const resp = await cfFetchRaw(account, `${acctPath(account)}/storage/kv/namespaces/${c.req.param('nsId')}/values/${encodeURIComponent(key)}`, c.env.ENCRYPTION_KEY);
  const value = await resp.text();
  return c.json({ value, metadata: null });
});

app.put('/:accountId/kv/:nsId/values/:key', async (c) => {
  const account = await requireAccount(c);
  const key = decodeURIComponent(c.req.param('key'));
  const { value, metadata } = await c.req.json();
  const form = new FormData();
  form.append('value', value);
  if (metadata) form.append('metadata', JSON.stringify(metadata));
  await cfFetchRaw(account, `${acctPath(account)}/storage/kv/namespaces/${c.req.param('nsId')}/values/${encodeURIComponent(key)}`, c.env.ENCRYPTION_KEY, {
    method: 'PUT', body: form,
  });
  return c.json({ success: true });
});

app.delete('/:accountId/kv/:nsId/values/:key', async (c) => {
  const account = await requireAccount(c);
  const key = decodeURIComponent(c.req.param('key'));
  await cfFetch(account, `${acctPath(account)}/storage/kv/namespaces/${c.req.param('nsId')}/values/${encodeURIComponent(key)}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  return c.json({ success: true });
});

app.post('/:accountId/kv/:nsId/bulk-delete', async (c) => {
  const account = await requireAccount(c);
  const { keys } = await c.req.json();
  if (!Array.isArray(keys)) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'keys must be an array' } }, 400);
  await cfFetch(account, `${acctPath(account)}/storage/kv/namespaces/${c.req.param('nsId')}/bulk`, c.env.ENCRYPTION_KEY, {
    method: 'DELETE', body: JSON.stringify(keys),
  });
  return c.json({ success: true });
});

// ============ D1 Databases ============
app.get('/:accountId/d1', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch<{ result: any[] }>(account, `${acctPath(account)}/d1/database`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.post('/:accountId/d1', async (c) => {
  const account = await requireAccount(c);
  const { name } = await c.req.json();
  if (!name) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } }, 400);
  const result = await cfFetch(account, `${acctPath(account)}/d1/database`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ name }),
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'create_d1', target: name, status: 'success' });
  return c.json(result, 201);
});

app.delete('/:accountId/d1/:dbId', async (c) => {
  const account = await requireAccount(c);
  await cfFetch(account, `${acctPath(account)}/d1/database/${c.req.param('dbId')}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'delete_d1', target: c.req.param('dbId'), status: 'success' });
  return c.json({ success: true });
});

app.get('/:accountId/d1/:dbId/tables', async (c) => {
  const account = await requireAccount(c);
  const data = await cfFetch(account, `${acctPath(account)}/d1/database/${c.req.param('dbId')}/query`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ sql: "SELECT name, type FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name" }),
  });
  return c.json(extractD1QueryResult(data));
});

app.get('/:accountId/d1/:dbId/tables/:tableName/schema', async (c) => {
  const account = await requireAccount(c);
  const safeName = c.req.param('tableName').replace(/[^a-zA-Z0-9_]/g, '');
  const data = await cfFetch(account, `${acctPath(account)}/d1/database/${c.req.param('dbId')}/query`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ sql: `PRAGMA table_info(${safeName})` }),
  });
  return c.json(extractD1QueryResult(data));
});

app.post('/:accountId/d1/:dbId/query', async (c) => {
  const account = await requireAccount(c);
  const { sql, params } = await c.req.json();
  if (!sql) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'sql is required' } }, 400);
  const data = await cfFetch(account, `${acctPath(account)}/d1/database/${c.req.param('dbId')}/query`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ sql, params: params || [] }),
  });
  const qr = Array.isArray(data.result) ? data.result[0] : data;
  return c.json({ results: qr?.results ?? [], meta: qr?.meta ?? {} });
});

// ============ R2 Buckets ============
app.get('/:accountId/r2', async (c) => {
  const account = await requireAccount(c);
  try {
    const data = await cfFetch<{ result: any }>(account, `${acctPath(account)}/r2/buckets`, c.env.ENCRYPTION_KEY);
    return c.json(data.result?.buckets || []);
  } catch (e: any) {
    if (e.body?.includes('10042') || e.body?.includes('enable R2')) {
      return c.json({ success: false, error: { code: 'R2_NOT_ENABLED', message: 'R2 is not enabled for this account' } }, 403);
    }
    throw e;
  }
});

app.post('/:accountId/r2', async (c) => {
  const account = await requireAccount(c);
  const { name } = await c.req.json();
  if (!name) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } }, 400);
  const result = await cfFetch(account, `${acctPath(account)}/r2/buckets`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify({ name }),
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'create_r2', target: name, status: 'success' });
  return c.json(result, 201);
});

app.delete('/:accountId/r2/:bucket', async (c) => {
  const account = await requireAccount(c);
  await cfFetch(account, `${acctPath(account)}/r2/buckets/${c.req.param('bucket')}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'delete_r2', target: c.req.param('bucket'), status: 'success' });
  return c.json({ success: true });
});

app.get('/:accountId/r2/:bucket/objects', async (c) => {
  const account = await requireAccount(c);
  const prefix = c.req.query('prefix') || '';
  const delimiter = c.req.query('delimiter') || '/';
  const cursor = c.req.query('cursor') || '';
  let url = `${acctPath(account)}/r2/buckets/${c.req.param('bucket')}/objects?delimiter=${encodeURIComponent(delimiter)}`;
  if (prefix) url += `&prefix=${encodeURIComponent(prefix)}`;
  if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
  const data = await cfFetch<any>(account, url, c.env.ENCRYPTION_KEY);
  const raw = data.result || {};
  return c.json({
    objects: raw.objects || [],
    delimited_prefixes: raw.delimited_prefixes || raw.delimited || [],
    cursor: raw.cursor || data.result_info?.cursor || undefined,
  });
});

app.delete('/:accountId/r2/:bucket/objects', async (c) => {
  const account = await requireAccount(c);
  const key = c.req.query('key');
  if (!key) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'key is required' } }, 400);
  await cfFetch(account, `${acctPath(account)}/r2/buckets/${c.req.param('bucket')}/objects/${encodeURIComponent(key)}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  return c.json({ success: true });
});

app.post('/:accountId/r2/:bucket/bulk-delete', async (c) => {
  const account = await requireAccount(c);
  const { keys } = await c.req.json();
  if (!Array.isArray(keys)) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'keys must be an array' } }, 400);
  await Promise.all(keys.map(key =>
    cfFetch(account, `${acctPath(account)}/r2/buckets/${c.req.param('bucket')}/objects/${encodeURIComponent(key)}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' })
  ));
  return c.json({ success: true });
});

app.get('/:accountId/r2/:bucket/download', async (c) => {
  const account = await requireAccount(c);
  const key = c.req.query('key');
  if (!key) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'object key is required (query param)' } }, 400);
  const resp = await cfFetchRaw(account, `${acctPath(account)}/r2/buckets/${c.req.param('bucket')}/objects/${encodeURIComponent(key)}`, c.env.ENCRYPTION_KEY);
  if (!resp.ok) {
    const body = await resp.text();
    return c.json({ error: { code: 'R2_ERROR', message: body } }, resp.status as any);
  }
  const ct = resp.headers.get('content-type') || 'application/octet-stream';
  const inline = c.req.query('inline') === '1' || c.req.query('inline') === 'true';
  const filename = key.split('/').pop() || 'download';
  return new Response(resp.body, {
    headers: {
      'Content-Type': ct,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${filename}"`,
    },
  });
});

app.put('/:accountId/r2/:bucket/upload', async (c) => {
  const account = await requireAccount(c);
  const form = await c.req.formData();
  const key = form.get('key') as string;
  const file = form.get('file') as File | null;
  if (!key) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'key is required' } }, 400);
  if (!file) return c.json({ error: { code: 'NO_FILE', message: 'file is required' } }, 400);
  const buffer = await file.arrayBuffer();
  await cfFetchRaw(account, `${acctPath(account)}/r2/buckets/${c.req.param('bucket')}/objects/${encodeURIComponent(key)}`, c.env.ENCRYPTION_KEY, {
    method: 'PUT',
    body: buffer,
    headers: { 'Content-Type': file.type || 'application/octet-stream' } as any,
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'r2_upload', target: `${c.req.param('bucket')}/${key}`, detail: `${buffer.byteLength} bytes`, status: 'success' });
  return c.json({ success: true });
});

export default app;
