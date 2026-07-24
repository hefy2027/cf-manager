import { Router, Request, Response, NextFunction } from 'express';
import { findAccountByDomain, getAllZones } from '../services/accountRouter';
import { listDnsRecords, createDnsRecord, updateDnsRecord, deleteDnsRecord } from '../services/dnsService';
import { getZoneSettings, updateProxyStatus } from '../services/zoneService';
import { createAuditLog } from '../models/auditLog';
import { isDemoAccountId } from './routeUtils';
import { listRules, createRule, updateRule, deleteRule } from '../services/rulesetService';

const router = Router();

router.get('/domains', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const zones = await getAllZones();
    res.json(zones);
  } catch (err) { next(err); }
});

router.get('/domains/:domain/records', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string);
    const records = await listDnsRecords(account, zoneId);
    res.json(records);
  } catch (err) { next(err); }
});

router.post('/domains/:domain/records', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const domain = req.params.domain as string;
    const { account, zoneId } = await findAccountByDomain(domain);
    const record = await createDnsRecord(account, zoneId, req.body);
    createAuditLog(account.id, 'create_dns', domain, `${req.body.type} ${req.body.name} → ${req.body.content}`, 'success');
    res.status(201).json(record);
  } catch (err) { next(err); }
});

router.put('/domains/:domain/records/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const domain = req.params.domain as string;
    const { account, zoneId } = await findAccountByDomain(domain);
    const record = await updateDnsRecord(account, zoneId, req.params.id as string, req.body);
    createAuditLog(account.id, 'update_dns', domain, `${req.body.type || ''} ${req.body.name || ''} → ${req.body.content || ''}`, 'success');
    res.json(record);
  } catch (err) { next(err); }
});

router.delete('/domains/:domain/records/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const domain = req.params.domain as string;
    const { account, zoneId } = await findAccountByDomain(domain);
    if (isDemoAccountId(account.id)) {
      res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可删除 DNS 记录' } });
      return;
    }
    await deleteDnsRecord(account, zoneId, req.params.id as string);
    createAuditLog(account.id, 'delete_dns', domain, `record_id=${req.params.id}`, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

router.get('/domains/:domain/settings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string);
    const settings = await getZoneSettings(account, zoneId);
    res.json(settings);
  } catch (err) { next(err); }
});

router.patch('/domains/:domain/proxy', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.body.record_id || typeof req.body.proxied !== 'boolean') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'record_id and proxied (boolean) are required' } });
      return;
    }
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string);
    await updateProxyStatus(account, zoneId, req.body.record_id, req.body.proxied);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ============ 通用规则引擎 ============

router.get('/domains/:domain/rules/:phase', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string);
    res.json(await listRules(account, zoneId, req.params.phase as string));
  } catch (err) { next(err); }
});

router.post('/domains/:domain/rules/:phase', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { description, expression, action, action_parameters, enabled } = req.body;
    if (!expression || !action) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'expression and action are required' } });
      return;
    }
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string);
    const rule = await createRule(account, zoneId, req.params.phase as string, { description, expression, action, action_parameters, enabled });
    createAuditLog(account.id, 'create_rule', req.params.domain as string, `phase=${req.params.phase} action=${action}`, 'success');
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

router.put('/domains/:domain/rules/:phase/:ruleId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { description, expression, action, action_parameters, enabled } = req.body;
    if (!expression || !action) {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'expression and action are required' } });
      return;
    }
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string);
    const rule = await updateRule(account, zoneId, req.params.phase as string, req.params.ruleId as string, { description, expression, action, action_parameters, enabled });
    createAuditLog(account.id, 'update_rule', req.params.domain as string, `phase=${req.params.phase} rule_id=${req.params.ruleId}`, 'success');
    res.json(rule);
  } catch (err) { next(err); }
});

router.delete('/domains/:domain/rules/:phase/:ruleId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { account, zoneId } = await findAccountByDomain(req.params.domain as string);
    if (isDemoAccountId(account.id)) {
      res.status(403).json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可删除规则' } });
      return;
    }
    await deleteRule(account, zoneId, req.params.phase as string, req.params.ruleId as string);
    createAuditLog(account.id, 'delete_rule', req.params.domain as string, `phase=${req.params.phase} rule_id=${req.params.ruleId}`, 'success');
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
