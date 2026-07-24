import { Hono } from 'hono';
import type { Env } from '../types';
import { getAllAccounts, getAccountById, addAuditLog } from '../db/models';
import { isDemoAccount } from '../services/demo';
import { cfFetch, cfFetchAll } from '../services/cfApi';
import {
  listTunnelAccounts, listTunnels, createTunnel, deleteTunnel,
  getTunnelToken, getTunnelConnections, getTunnelConfig, updateTunnelConfig,
  listTunnelHostnames,
} from '../services/tunnelService';

const app = new Hono<{ Bindings: Env }>();

app.get('/accounts', async (c) => {
  const accounts = await getAllAccounts(c.env.DB);
  return c.json(listTunnelAccounts(accounts));
});

app.get('/accounts/:id/tunnels', async (c) => {
  const account = await getAccountById(c.env.DB, parseInt(c.req.param('id'), 10));
  if (!account || !account.account_id) return c.json({ error: { code: 'BAD_ACCOUNT', message: '账户无效或未配置 account_id' } }, 400);
  return c.json(await listTunnels(account, c.env.ENCRYPTION_KEY));
});

app.get('/accounts/:id/zones', async (c) => {
  const account = await getAccountById(c.env.DB, parseInt(c.req.param('id'), 10));
  if (!account || !account.account_id) return c.json({ error: { code: 'BAD_ACCOUNT', message: '账户无效或未配置 account_id' } }, 400);
  const zones = await cfFetchAll<any>(account, '/zones', c.env.ENCRYPTION_KEY, 50);
  return c.json(zones.map((z) => ({ id: z.id, name: z.name })));
});

app.post('/accounts/:id/tunnels', async (c) => {
  const { name } = await c.req.json();
  if (!name) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } }, 400);
  const account = await getAccountById(c.env.DB, parseInt(c.req.param('id'), 10));
  if (!account || !account.account_id) return c.json({ error: { code: 'BAD_ACCOUNT', message: '账户无效或未配置 account_id' } }, 400);
  const tunnel = await createTunnel(account, name, c.env.ENCRYPTION_KEY);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'create_tunnel', target: name, detail: `tunnel_id=${tunnel.id}`, status: 'success' });
  return c.json(tunnel, 201);
});

app.delete('/accounts/:id/tunnels/:tunnelId', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isDemoAccount(id, c.env.DEMO_ACCOUNT_IDS)) return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可删除隧道' } }, 403);
  const account = await getAccountById(c.env.DB, id);
  if (!account || !account.account_id) return c.json({ error: { code: 'BAD_ACCOUNT', message: '账户无效或未配置 account_id' } }, 400);
  await deleteTunnel(account, c.req.param('tunnelId'), c.env.ENCRYPTION_KEY);
  await addAuditLog(c.env.DB, { account_id: id, action: 'delete_tunnel', target: c.req.param('tunnelId'), detail: '', status: 'success' });
  return c.json({ success: true });
});

app.get('/accounts/:id/tunnels/:tunnelId/token', async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (isDemoAccount(id, c.env.DEMO_ACCOUNT_IDS)) return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可查看令牌' } }, 403);
  const account = await getAccountById(c.env.DB, id);
  if (!account || !account.account_id) return c.json({ error: { code: 'BAD_ACCOUNT', message: '账户无效或未配置 account_id' } }, 400);
  const token = await getTunnelToken(account, c.req.param('tunnelId'), c.env.ENCRYPTION_KEY);
  return c.json({ token });
});

app.get('/accounts/:id/tunnels/:tunnelId/connections', async (c) => {
  const account = await getAccountById(c.env.DB, parseInt(c.req.param('id'), 10));
  if (!account || !account.account_id) return c.json({ error: { code: 'BAD_ACCOUNT', message: '账户无效或未配置 account_id' } }, 400);
  return c.json(await getTunnelConnections(account, c.req.param('tunnelId'), c.env.ENCRYPTION_KEY));
});

app.get('/accounts/:id/tunnels/:tunnelId/hostnames', async (c) => {
  const account = await getAccountById(c.env.DB, parseInt(c.req.param('id'), 10));
  if (!account || !account.account_id) return c.json({ error: { code: 'BAD_ACCOUNT', message: '账户无效或未配置 account_id' } }, 400);
  return c.json(await listTunnelHostnames(account, c.req.param('tunnelId'), c.env.ENCRYPTION_KEY));
});

app.get('/accounts/:id/tunnels/:tunnelId/config', async (c) => {
  const account = await getAccountById(c.env.DB, parseInt(c.req.param('id'), 10));
  if (!account || !account.account_id) return c.json({ error: { code: 'BAD_ACCOUNT', message: '账户无效或未配置 account_id' } }, 400);
  return c.json(await getTunnelConfig(account, c.req.param('tunnelId'), c.env.ENCRYPTION_KEY));
});

app.put('/accounts/:id/tunnels/:tunnelId/config', async (c) => {
  const account = await getAccountById(c.env.DB, parseInt(c.req.param('id'), 10));
  if (!account || !account.account_id) return c.json({ error: { code: 'BAD_ACCOUNT', message: '账户无效或未配置 account_id' } }, 400);
  const { ingress } = await c.req.json();
  if (!Array.isArray(ingress)) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'ingress must be an array' } }, 400);
  const result = await updateTunnelConfig(account, c.req.param('tunnelId'), ingress, c.env.ENCRYPTION_KEY);
  await addAuditLog(c.env.DB, { account_id: account.id, action: 'update_tunnel_config', target: c.req.param('tunnelId'), detail: `${ingress.length} ingress rules`, status: 'success' });
  return c.json(result);
});

// 一键回源向导
app.post('/accounts/:id/wizard', async (c) => {
  const body = await c.req.json();
  const mode = body.mode || 'create';
  const reuseTunnelId = body.tunnelId;
  const { hostname, port, tunnelName, protocol = 'http', path } = body;
  if (!hostname || !port) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'hostname and port are required' } }, 400);
  if (mode === 'reuse' && !reuseTunnelId) return c.json({ error: { code: 'VALIDATION_ERROR', message: 'mode=reuse 时 tunnelId 必填' } }, 400);

  const accountId = parseInt(c.req.param('id'), 10);
  const account = await getAccountById(c.env.DB, accountId);
  if (!account || !account.account_id) return c.json({ error: { code: 'BAD_ACCOUNT', message: '账户无效或未配置 account_id' } }, 400);

  let createdTunnelId: string | null = null;
  let createdCnameId: string | null = null;
  let zone: any = null;

  try {
    if (mode === 'create') {
      const tunnel: any = await createTunnel(account, tunnelName || `tunnel-${hostname}`, c.env.ENCRYPTION_KEY);
      createdTunnelId = tunnel.id;
    } else {
      const tunnels = await listTunnels(account, c.env.ENCRYPTION_KEY);
      if (!tunnels.some((t: any) => t.id === reuseTunnelId)) return c.json({ error: { code: 'TUNNEL_NOT_FOUND', message: 'tunnelId 不属于该账户' } }, 400);
      createdTunnelId = reuseTunnelId;
    }
    const tunnelId: string = createdTunnelId!;

    const zones: any[] = await cfFetchAll<any>(account, '/zones', c.env.ENCRYPTION_KEY, 50);
    zone = zones.filter((z) => hostname === z.name || hostname.endsWith('.' + z.name)).sort((a, b) => b.name.length - a.name.length)[0] || null;
    if (!zone) return c.json({ error: { code: 'ZONE_NOT_FOUND', message: '该 hostname 所属域名不在当前隧道账户下，向导要求隧道与域名属于同一账户' } }, 400);

    let cname: any;
    try {
      cname = await cfFetch(account, `/zones/${zone.id}/dns_records`, c.env.ENCRYPTION_KEY, {
        method: 'POST', body: JSON.stringify({ type: 'CNAME', name: hostname, content: `${tunnelId}.cfargotunnel.com`, ttl: 1, proxied: true }),
      });
      createdCnameId = cname?.result?.id ?? cname?.id ?? null;
    } catch (cnameErr: any) {
      if (/already exists|81053|record.*exists/i.test(String(cnameErr?.message || ''))) {
        return c.json({ error: { code: 'CNAME_CONFLICT', message: 'hostname 已存在 CNAME 记录，请先在 DNS 页面删除或修改后再试' } }, 400);
      }
      throw cnameErr;
    }

    let finalIngress: Array<{ hostname?: string; service: string }>;
    if (mode === 'reuse') {
      const existing = await getTunnelConfig(account, tunnelId, c.env.ENCRYPTION_KEY);
      const filtered = existing.filter((e: any) => e.hostname && e.hostname !== hostname);
      const rule: any = { hostname, service: `${protocol}://localhost:${port}` };
      if (path) rule.path = path;
      finalIngress = [...filtered, rule, { service: 'http_status:404' }];
    } else {
      const rule: any = { hostname, service: `${protocol}://localhost:${port}` };
      if (path) rule.path = path;
      finalIngress = [rule, { service: 'http_status:404' }];
    }
    await updateTunnelConfig(account, tunnelId, finalIngress, c.env.ENCRYPTION_KEY);

    await addAuditLog(c.env.DB, { account_id: accountId, action: 'wizard_origin', target: hostname, detail: `mode=${mode} tunnel=${tunnelId} port=${port}`, status: 'success' });
    return c.json({ tunnelId, hostname, cnameTarget: `${tunnelId}.cfargotunnel.com`, mode }, 201);
  } catch (err: any) {
    const rollbackErrors: string[] = [];
    if (createdCnameId && zone) {
      try { await cfFetch(account, `/zones/${zone.id}/dns_records/${createdCnameId}`, c.env.ENCRYPTION_KEY, { method: 'DELETE' }); }
      catch (re: any) { rollbackErrors.push(`CNAME ${createdCnameId}: ${re.message}`); }
    }
    if (mode === 'create' && createdTunnelId) {
      try { await deleteTunnel(account, createdTunnelId, c.env.ENCRYPTION_KEY); }
      catch (re: any) { rollbackErrors.push(`Tunnel ${createdTunnelId}: ${re.message}`); }
    }
    if (rollbackErrors.length > 0) return c.json({ error: { code: 'WIZARD_PARTIAL_FAIL', message: '向导部分步骤失败，回滚时也有错误', failedStep: 'wizard', rollbackErrors } }, 500);
    throw err;
  }
});

export default app;
