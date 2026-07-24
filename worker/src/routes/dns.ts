import { Hono } from 'hono';
import type { Env } from '../types';
import { getActiveAccountsByFeature, addAuditLog } from '../db/models';
import { cfFetch, cfFetchAll } from '../services/cfApi';
import { listRules, createRule, updateRule, deleteRule } from '../services/rulesetService';
import { isDemoAccount } from '../services/demo';

const app = new Hono<{ Bindings: Env }>();

async function getAllZones(db: D1Database, encryptionKey: string) {
  const accounts = await getActiveAccountsByFeature(db, 'dns');
  const results = await Promise.all(accounts.map(async (account) => {
    try {
      const zones = await cfFetchAll<any>(account, '/zones', encryptionKey, 100);
      return zones.map(z => ({ ...z, cfAccountId: account.id, accountName: account.name }));
    } catch (e) {
      console.error(`Failed to fetch zones for ${account.name}: ${e}`);
      return [];
    }
  }));
  return results.flat();
}

async function findAccountByDomain(db: D1Database, domain: string, encryptionKey: string) {
  const zones = await getAllZones(db, encryptionKey);
  const zone = zones.find(z => z.name === domain);
  if (!zone) throw Object.assign(new Error(`Domain ${domain} not found`), { statusCode: 404 });
  const accounts = await getActiveAccountsByFeature(db, 'dns');
  const account = accounts.find(a => a.id === zone.cfAccountId);
  if (!account) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  return { account, zoneId: zone.id };
}

app.get('/domains', async (c) => {
  const zones = await getAllZones(c.env.DB, c.env.ENCRYPTION_KEY);
  return c.json(zones);
});

app.get('/domains/:domain/records', async (c) => {
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.req.param('domain'), c.env.ENCRYPTION_KEY);
  const data = await cfFetch<{ result: any[] }>(account, `/zones/${zoneId}/dns_records?per_page=1000`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.post('/domains/:domain/records', async (c) => {
  const domain = c.req.param('domain');
  const { account, zoneId } = await findAccountByDomain(c.env.DB, domain, c.env.ENCRYPTION_KEY);
  const body = await c.req.json();
  const data = await cfFetch(account, `/zones/${zoneId}/dns_records`, c.env.ENCRYPTION_KEY, {
    method: 'POST', body: JSON.stringify(body),
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'create_dns', target: domain, detail: `${body.type} ${body.name} → ${body.content}`, status: 'success' });
  return c.json(data.result, 201);
});

app.put('/domains/:domain/records/:id', async (c) => {
  const domain = c.req.param('domain');
  const recordId = c.req.param('id');
  const { account, zoneId } = await findAccountByDomain(c.env.DB, domain, c.env.ENCRYPTION_KEY);
  const body = await c.req.json();
  const data = await cfFetch(account, `/zones/${zoneId}/dns_records/${recordId}`, c.env.ENCRYPTION_KEY, {
    method: 'PUT', body: JSON.stringify(body),
  });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'update_dns', target: domain, detail: `${body.type || ''} ${body.name || ''} → ${body.content || ''}`, status: 'success' });
  return c.json(data.result);
});

app.delete('/domains/:domain/records/:id', async (c) => {
  const domain = c.req.param('domain');
  const recordId = c.req.param('id');
  const { account, zoneId } = await findAccountByDomain(c.env.DB, domain, c.env.ENCRYPTION_KEY);
  await cfFetch(account, `/zones/${zoneId}/dns_records/${recordId}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' });
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'delete_dns', target: domain, detail: `record_id=${recordId}`, status: 'success' });
  return c.json({ success: true });
});

app.get('/domains/:domain/settings', async (c) => {
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.req.param('domain'), c.env.ENCRYPTION_KEY);
  const data = await cfFetch(account, `/zones/${zoneId}/settings`, c.env.ENCRYPTION_KEY);
  return c.json(data.result || []);
});

app.patch('/domains/:domain/proxy', async (c) => {
  const body = await c.req.json();
  if (!body.record_id || typeof body.proxied !== 'boolean') {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'record_id and proxied (boolean) are required' } }, 400);
  }
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.req.param('domain'), c.env.ENCRYPTION_KEY);
  await cfFetch(account, `/zones/${zoneId}/dns_records/${body.record_id}`, c.env.ENCRYPTION_KEY, {
    method: 'PATCH', body: JSON.stringify({ proxied: body.proxied }),
  });
  return c.json({ success: true });
});

// ============ 通用规则引擎 ============

app.get('/domains/:domain/rules/:phase', async (c) => {
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.env.ENCRYPTION_KEY, c.req.param('domain'));
  if (!account || !zoneId) return c.json({ error: { code: 'NOT_FOUND', message: '域名不存在' } }, 404);
  return c.json(await listRules(account, zoneId, c.req.param('phase'), c.env.ENCRYPTION_KEY));
});

app.post('/domains/:domain/rules/:phase', async (c) => {
  const body = await c.req.json();
  const { description, expression, action, action_parameters, enabled } = body;
  if (!expression || !action) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'expression and action are required' } }, 400);
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.env.ENCRYPTION_KEY, c.req.param('domain'));
  if (!account || !zoneId) return c.json({ error: { code: 'NOT_FOUND', message: '域名不存在' } }, 404);
  const rule = await createRule(account, zoneId, c.req.param('phase'), { description, expression, action, action_parameters, enabled }, c.env.ENCRYPTION_KEY);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'create_rule', target: c.req.param('domain'), detail: `phase=${c.req.param('phase')} action=${action}`, status: 'success' });
  return c.json(rule, 201);
});

app.put('/domains/:domain/rules/:phase/:ruleId', async (c) => {
  const body = await c.req.json();
  const { description, expression, action, action_parameters, enabled } = body;
  if (!expression || !action) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'expression and action are required' } }, 400);
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.env.ENCRYPTION_KEY, c.req.param('domain'));
  if (!account || !zoneId) return c.json({ error: { code: 'NOT_FOUND', message: '域名不存在' } }, 404);
  const rule = await updateRule(account, zoneId, c.req.param('phase'), c.req.param('ruleId'), { description, expression, action, action_parameters, enabled }, c.env.ENCRYPTION_KEY);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'update_rule', target: c.req.param('domain'), detail: `phase=${c.req.param('phase')} rule_id=${c.req.param('ruleId')}`, status: 'success' });
  return c.json(rule);
});

app.delete('/domains/:domain/rules/:phase/:ruleId', async (c) => {
  const { account, zoneId } = await findAccountByDomain(c.env.DB, c.env.ENCRYPTION_KEY, c.req.param('domain'));
  if (!account || !zoneId) return c.json({ error: { code: 'NOT_FOUND', message: '域名不存在' } }, 404);
  await deleteRule(account, zoneId, c.req.param('phase'), c.req.param('ruleId'), c.env.ENCRYPTION_KEY);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'delete_rule', target: c.req.param('domain'), detail: `phase=${c.req.param('phase')} rule_id=${c.req.param('ruleId')}`, status: 'success' });
  return c.json({ success: true });
});

export default app;
