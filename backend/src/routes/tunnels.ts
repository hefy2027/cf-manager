import { Router, Request, Response, NextFunction } from 'express';
import {
  listTunnelAccounts, getTunnelAccount, listTunnels, createTunnel,
  deleteTunnel, getTunnelToken, getTunnelConnections, getTunnelConfig,
  updateTunnelConfig, listZonesForAccount, listTunnelHostnames,
} from '../services/tunnelService';
import { createDnsRecord, deleteDnsRecord } from '../services/dnsService';
import { createAuditLog } from '../models/auditLog';
import { isDemoAccountId } from './routeUtils';

const router = Router();

router.get('/accounts', (_req, res, next) => {
  try { res.json(listTunnelAccounts()); } catch (err) { next(err); }
});

router.get('/accounts/:id/tunnels', async (req, res, next) => {
  try {
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    res.json(await listTunnels(account));
  } catch (err) { next(err); }
});

router.get('/accounts/:id/zones', async (req, res, next) => {
  try {
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    res.json(await listZonesForAccount(account));
  } catch (err) { next(err); }
});

router.post('/accounts/:id/tunnels', async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'name is required' } }); return; }
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    const tunnel = await createTunnel(account, name);
    createAuditLog(account.id, 'create_tunnel', name, `tunnel_id=${tunnel.id}`, 'success');
    res.status(201).json(tunnel);
  } catch (err) { next(err); }
});

router.delete('/accounts/:id/tunnels/:tunnelId', async (req, res, next) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    if (isDemoAccountId(accountId)) { res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可删除隧道' } }); return; }
    const account = getTunnelAccount(accountId);
    await deleteTunnel(account, req.params.tunnelId);
    createAuditLog(accountId, 'delete_tunnel', req.params.tunnelId, '', 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/accounts/:id/tunnels/:tunnelId/token', async (req, res, next) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    if (isDemoAccountId(accountId)) { res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可查看令牌' } }); return; }
    const account = getTunnelAccount(accountId);
    const token = await getTunnelToken(account, req.params.tunnelId);
    res.json({ token });
  } catch (err) { next(err); }
});

router.get('/accounts/:id/tunnels/:tunnelId/connections', async (req, res, next) => {
  try {
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    res.json(await getTunnelConnections(account, req.params.tunnelId));
  } catch (err) { next(err); }
});

router.get('/accounts/:id/tunnels/:tunnelId/hostnames', async (req, res, next) => {
  try {
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    res.json(await listTunnelHostnames(account, req.params.tunnelId));
  } catch (err) { next(err); }
});

router.get('/accounts/:id/tunnels/:tunnelId/config', async (req, res, next) => {
  try {
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    res.json(await getTunnelConfig(account, req.params.tunnelId));
  } catch (err) { next(err); }
});

router.put('/accounts/:id/tunnels/:tunnelId/config', async (req, res, next) => {
  try {
    const account = getTunnelAccount(parseInt(req.params.id, 10));
    const { ingress } = req.body;
    if (!Array.isArray(ingress)) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'ingress must be an array' } });
      return;
    }
    const result = await updateTunnelConfig(account, req.params.tunnelId, ingress);
    createAuditLog(account.id, 'update_tunnel_config', req.params.tunnelId, `${ingress.length} ingress rules`, 'success');
    res.json(result);
  } catch (err) { next(err); }
});

// ============ 一键回源向导 ============
router.post('/accounts/:id/wizard', async (req, res, next) => {
  const accountId = parseInt(req.params.id, 10);
  const { mode = 'create', tunnelId: reuseTunnelId, hostname, port, tunnelName, protocol = 'http', path } = req.body;
  if (!hostname || !port) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'hostname and port are required' } }); return; }
  if (mode === 'reuse' && !reuseTunnelId) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'mode=reuse 时 tunnelId 必填' } }); return; }

  let account: ReturnType<typeof getTunnelAccount>;
  try { account = getTunnelAccount(accountId); } catch (err) { next(err); return; }

  let createdTunnelId: string | null = null;
  let createdCnameId: string | null = null;
  let zone: { id: string; name: string } | null = null;

  try {
    if (mode === 'create') {
      const tunnel: any = await createTunnel(account, tunnelName || `tunnel-${hostname}`);
      createdTunnelId = tunnel.id;
    } else {
      const tunnels = await listTunnels(account);
      if (!tunnels.some((t: any) => t.id === reuseTunnelId)) { res.status(400).json({ error: { code: 'TUNNEL_NOT_FOUND', message: 'tunnelId 不属于该账户' } }); return; }
      createdTunnelId = reuseTunnelId;
    }
    const tunnelId: string = createdTunnelId!;

    const zones = await listZonesForAccount(account);
    zone = zones.filter((z) => hostname === z.name || hostname.endsWith('.' + z.name)).sort((a, b) => b.name.length - a.name.length)[0] || null;
    if (!zone) { res.status(400).json({ error: { code: 'ZONE_NOT_FOUND', message: '该 hostname 所属域名不在当前隧道账户下，向导要求隧道与域名属于同一账户' } }); return; }

    let cname: any;
    try {
      cname = await createDnsRecord(account, zone.id, { type: 'CNAME', name: hostname, content: `${tunnelId}.cfargotunnel.com`, ttl: 1, proxied: true });
      createdCnameId = cname?.result?.id ?? cname?.id ?? null;
    } catch (cnameErr: any) {
      if (/already exists|81053|record.*exists/i.test(String(cnameErr?.message || ''))) {
        res.status(400).json({ error: { code: 'CNAME_CONFLICT', message: 'hostname 已存在 CNAME 记录，请先在 DNS 页面删除或修改后再试' } });
        return;
      }
      throw cnameErr;
    }

    let finalIngress: Array<{ hostname?: string; service: string }>;
    if (mode === 'reuse') {
      const existing = await getTunnelConfig(account, tunnelId);
      const filtered = existing.filter((e: any) => e.hostname && e.hostname !== hostname);
      const rule: any = { hostname, service: `${protocol}://localhost:${port}` };
      if (path) rule.path = path;
      finalIngress = [...filtered, rule, { service: 'http_status:404' }];
    } else {
      const rule: any = { hostname, service: `${protocol}://localhost:${port}` };
      if (path) rule.path = path;
      finalIngress = [rule, { service: 'http_status:404' }];
    }
    await updateTunnelConfig(account, tunnelId, finalIngress);

    createAuditLog(accountId, 'wizard_origin', hostname, `mode=${mode} tunnel=${tunnelId} port=${port}`, 'success');
    res.status(201).json({ tunnelId, hostname, cnameTarget: `${tunnelId}.cfargotunnel.com`, mode });
  } catch (err: any) {
    const rollbackErrors: string[] = [];
    if (createdCnameId && zone) {
      try { await deleteDnsRecord(account, zone.id, createdCnameId); } catch (re: any) { rollbackErrors.push(`CNAME ${createdCnameId}: ${re.message}`); }
    }
    if (mode === 'create' && createdTunnelId) {
      try { await deleteTunnel(account, createdTunnelId); } catch (re: any) { rollbackErrors.push(`Tunnel ${createdTunnelId}: ${re.message}`); }
    }
    if (rollbackErrors.length > 0) {
      res.status(500).json({ error: { code: 'WIZARD_PARTIAL_FAIL', message: '向导部分步骤失败，回滚时也有错误', failedStep: 'wizard', rollbackErrors } });
    } else { next(err); }
  }
});

export default router;
