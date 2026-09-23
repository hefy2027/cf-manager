import type { Account, WorkerPlan } from '../db/models';
import { cfFetch, cfFetchRaw } from './cfApi';

/**
 * 探测账户可用的付费功能（首期仅 R2）。
 * 返回逗号分隔字符串：r2=支持，-r2=不支持，空串=未探测。
 */
export async function probeAvailableFeatures(account: Account, encryptionKey: string): Promise<string> {
  if (!account.account_id) return '';
  const results: string[] = [];

  // R2 探测
  try {
    await cfFetch(account, `/accounts/${account.account_id}/r2/buckets`, encryptionKey);
    results.push('r2');
  } catch (e: any) {
    const body = e?.body || e?.message || '';
    if (body.includes('10042') || body.includes('enable R2') || body.includes('Please enable R2')) {
      results.push('-r2');
    } else {
      console.warn(`[Probe] R2 check failed for account ${account.id}: ${e}`);
    }
  }

  return results.join(',');
}

/**
 * 由 GET /accounts/{id}/subscriptions 的响应推断计划类型（纯函数，便于单测）。
 *
 * - 订阅列表里存在 rate_plan 名称含 "worker" 的项 → 按名称判定 paid / enterprise
 * - 请求成功但没有任何 worker 相关订阅 → free
 *
 * 注意：只有"请求确实成功"时才应据此判定 free；请求失败（权限不足等）必须返回 null，
 * 由调用方保留现有值。
 */
export function mapWorkerPlanFromSubscriptions(json: any): WorkerPlan | null {
  // 响应结构不符（拿不到订阅数组）时不判定，避免把付费账号误降级为免费
  if (!Array.isArray(json?.result)) return null;
  const subs: any[] = json.result;
  // 真实响应里 rate_plan.id / public_name / product.name 都可能带计划标识，全部纳入匹配
  const labelOf = (s: any) => [
    s?.rate_plan?.id, s?.rate_plan?.public_name, s?.rate_plan?.name,
    s?.product?.name, s?.product?.public_name,
  ].filter(Boolean).join(' ').toLowerCase();

  // 注意：不能靠 state / price 判定 —— 实测 zone 级免费计划的 state 也是 "Paid"、price=0，
  // 只有 rate_plan / product 的名称才区分得开。
  const workerSubs = subs.filter((s) => labelOf(s).includes('worker'));
  if (workerSubs.length === 0) return 'free';
  // 某些账号可能会带上 workers 的免费权益项（名称含 free/trial），那不算付费计划
  const paidSub = workerSubs.find((s) => !/free|trial/.test(labelOf(s)));
  if (!paidSub) return 'free';
  return /enterprise/.test(labelOf(paidSub)) ? 'enterprise' : 'paid';
}

/**
 * 探测账号的 Cloudflare Workers 计划类型（free / paid / enterprise）。
 *
 * 来源：GET /accounts/{id}/subscriptions（订阅列表），需要 Account.Billing:Read 权限。
 * 权限不足 / 接口不可用 / 响应异常时返回 null —— 调用方保留现有值，也就是说
 * 「自动探测优先，探测不通才由用户在账号管理里手工标注」。
 *
 * 与 backend/src/services/accountProbe.ts 保持同构。
 */
export async function probeWorkerPlan(account: Account, encryptionKey: string): Promise<WorkerPlan | null> {
  if (!account.account_id) return null;
  try {
    const resp = await cfFetchRaw(account, `/accounts/${account.account_id}/subscriptions`, encryptionKey);
    if (!resp.ok) {
      // 最常见的是缺少 Account.Billing:Read（403）—— 不算错误，回退手工标注即可
      console.log(`[Probe] worker_plan probe skipped for account ${account.id}: HTTP ${resp.status}`);
      return null;
    }
    const json = await resp.json() as any;
    const plan = mapWorkerPlanFromSubscriptions(json);
    if (!plan) {
      console.log(`[Probe] worker_plan probe got unexpected payload for account ${account.id}`);
      return null;
    }
    console.log(`[Probe] worker_plan for account ${account.id}: ${plan}`);
    return plan;
  } catch (e: any) {
    console.warn(`[Probe] worker_plan probe failed for account ${account.id}: ${e?.message || e}`);
    return null;
  }
}
