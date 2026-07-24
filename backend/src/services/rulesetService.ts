import { Account } from '../models/account';
import { getCfClient } from './cfFactory';

export interface GenericRuleInput {
  description?: string;
  expression: string;
  action: string;
  action_parameters: any;
  enabled?: boolean;
}

// Account 级 Phase（使用 /accounts/{account_id}/rulesets，kind: 'root'）
// 其余 Phase 为 Zone 级（使用 /zones/{zone_id}/rulesets，kind: 'zone'）
const ACCOUNT_LEVEL_PHASES = new Set([
  'http_request_redirect',
  'http_request_dynamic_redirect',
]);

function isAccountLevelPhase(phase: string): boolean {
  return ACCOUNT_LEVEL_PHASES.has(phase);
}

/** 获取指定 phase 的 ruleset ID，不存在则创建 */
async function getRulesetId(account: Account, zoneId: string, phase: string, name: string): Promise<string> {
  const cf = getCfClient(account);
  const accountLevel = isAccountLevelPhase(phase);
  if (accountLevel && !account.account_id) {
    throw new Error('该规则类型为账户级，但当前账户未设置 Cloudflare Account ID');
  }
  const scope = accountLevel ? { account_id: account.account_id! } : { zone_id: zoneId };

  const list: any[] = [];
  for await (const r of cf.rulesets.list(scope as any)) { list.push(r); }
  const existing = list.find((r) => r.phase === phase);
  if (existing) return existing.id;

  const created = await cf.rulesets.create({
    ...scope,
    kind: accountLevel ? 'root' : 'zone',
    phase,
    name,
    rules: [],
  } as any);
  return created.id;
}

/** 列出指定 phase 的所有规则 */
export async function listRules(account: Account, zoneId: string, phase: string): Promise<any[]> {
  const cf = getCfClient(account);
  const accountLevel = isAccountLevelPhase(phase);
  const scope = accountLevel ? { account_id: account.account_id! } : { zone_id: zoneId };
  const rsId = await getRulesetId(account, zoneId, phase, `${phase} rules`);
  const rs: any = await cf.rulesets.get(rsId, scope as any);
  return rs.rules ?? [];
}

/** 创建规则 */
export async function createRule(account: Account, zoneId: string, phase: string, input: GenericRuleInput): Promise<any> {
  const cf = getCfClient(account);
  const accountLevel = isAccountLevelPhase(phase);
  const scope = accountLevel ? { account_id: account.account_id! } : { zone_id: zoneId };
  const rsId = await getRulesetId(account, zoneId, phase, `${phase} rules`);
  return await cf.rulesets.rules.create(rsId, {
    ...scope,
    description: input.description,
    expression: input.expression,
    action: input.action,
    action_parameters: input.action_parameters,
    enabled: input.enabled ?? true,
  } as any);
}

/** 更新规则 */
export async function updateRule(account: Account, zoneId: string, phase: string, ruleId: string, input: GenericRuleInput): Promise<any> {
  const cf = getCfClient(account);
  const accountLevel = isAccountLevelPhase(phase);
  const scope = accountLevel ? { account_id: account.account_id! } : { zone_id: zoneId };
  const rsId = await getRulesetId(account, zoneId, phase, `${phase} rules`);
  return await cf.rulesets.rules.edit(rsId, ruleId, {
    ...scope,
    description: input.description,
    expression: input.expression,
    action: input.action,
    action_parameters: input.action_parameters,
    enabled: input.enabled ?? true,
  } as any);
}

/** 删除规则 */
export async function deleteRule(account: Account, zoneId: string, phase: string, ruleId: string): Promise<any> {
  const cf = getCfClient(account);
  const accountLevel = isAccountLevelPhase(phase);
  const scope = accountLevel ? { account_id: account.account_id! } : { zone_id: zoneId };
  const rsId = await getRulesetId(account, zoneId, phase, `${phase} rules`);
  return await cf.rulesets.rules.delete(rsId, ruleId, scope as any);
}
