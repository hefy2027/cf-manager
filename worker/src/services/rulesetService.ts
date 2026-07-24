import type { Account } from '../db/models';
import { cfFetch } from './cfApi';

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

/** 根据 phase 返回对应的 API base path */
function getRulesetBaseUrl(account: Account, zoneId: string, phase: string): string {
  return isAccountLevelPhase(phase)
    ? `/accounts/${account.account_id}/rulesets`
    : `/zones/${zoneId}/rulesets`;
}

/** 获取指定 phase 的 ruleset ID，不存在则创建 */
export async function getRulesetId(account: Account, zoneId: string, phase: string, key: string): Promise<string> {
  if (isAccountLevelPhase(phase) && !account.account_id) {
    throw new Error('该规则类型为账户级，但当前账户未设置 Cloudflare Account ID');
  }
  const baseUrl = getRulesetBaseUrl(account, zoneId, phase);
  const accountLevel = isAccountLevelPhase(phase);
  const list = await cfFetch<{ result: any[] }>(account, `${baseUrl}?per_page=100`, key);
  const existing = (list.result || []).find((r) => r.phase === phase);
  if (existing) return existing.id;
  const created = await cfFetch<{ result: any }>(account, baseUrl, key, {
    method: 'POST', body: JSON.stringify({
      kind: accountLevel ? 'root' : 'zone',
      phase,
      name: `${phase} rules`,
      rules: [],
    }),
  });
  return created.result.id;
}

export async function listRules(account: Account, zoneId: string, phase: string, key: string): Promise<any[]> {
  const baseUrl = getRulesetBaseUrl(account, zoneId, phase);
  const rsId = await getRulesetId(account, zoneId, phase, key);
  const rs = await cfFetch<{ result: any }>(account, `${baseUrl}/${rsId}`, key);
  return rs.result.rules ?? [];
}

export async function createRule(account: Account, zoneId: string, phase: string, input: GenericRuleInput, key: string): Promise<any> {
  const baseUrl = getRulesetBaseUrl(account, zoneId, phase);
  const rsId = await getRulesetId(account, zoneId, phase, key);
  const res = await cfFetch<{ result: any }>(account, `${baseUrl}/${rsId}/rules`, key, {
    method: 'POST', body: JSON.stringify({
      description: input.description, expression: input.expression,
      action: input.action, action_parameters: input.action_parameters,
      enabled: input.enabled ?? true,
    }),
  });
  return res.result;
}

export async function updateRule(account: Account, zoneId: string, phase: string, ruleId: string, input: GenericRuleInput, key: string): Promise<any> {
  const baseUrl = getRulesetBaseUrl(account, zoneId, phase);
  const rsId = await getRulesetId(account, zoneId, phase, key);
  const res = await cfFetch<{ result: any }>(account, `${baseUrl}/${rsId}/rules/${ruleId}`, key, {
    method: 'PUT', body: JSON.stringify({
      description: input.description, expression: input.expression,
      action: input.action, action_parameters: input.action_parameters,
      enabled: input.enabled ?? true,
    }),
  });
  return res.result;
}

export async function deleteRule(account: Account, zoneId: string, phase: string, ruleId: string, key: string): Promise<any> {
  const baseUrl = getRulesetBaseUrl(account, zoneId, phase);
  const rsId = await getRulesetId(account, zoneId, phase, key);
  await cfFetch(account, `${baseUrl}/${rsId}/rules/${ruleId}`, key, { method: 'DELETE' });
  return { success: true };
}
