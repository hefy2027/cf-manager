import { describe, it, expect } from 'vitest';
import { isPaidPlan, normalizeWorkerPlan } from '../db/models';
import { subdomainPrefix } from '../services/workerSubdomain';
import { cachePaidModelNames, isPaidModelName, modelRequiresWorkersPaid } from '../services/aiService';
import { mapWorkerPlanFromSubscriptions } from '../services/accountProbe';

/**
 * 账号计划类型（worker_plan）与付费模型判定的边界：
 * 规则是「不标就是免费」—— 只有显式 paid / enterprise 才算付费账号。
 * 与 backend/tests/workerPlan.test.ts 对称。
 */
describe('worker_plan：计划类型判定', () => {
  it('只有 paid / enterprise 视为付费计划', () => {
    expect(isPaidPlan('paid')).toBe(true);
    expect(isPaidPlan('enterprise')).toBe(true);
    expect(isPaidPlan('free')).toBe(false);
  });

  it('未标注（空串 / null / undefined）一律视为免费', () => {
    expect(isPaidPlan('')).toBe(false);
    expect(isPaidPlan(null)).toBe(false);
    expect(isPaidPlan(undefined)).toBe(false);
  });

  it('非法值一律规范化为 free', () => {
    expect(normalizeWorkerPlan('paid')).toBe('paid');
    expect(normalizeWorkerPlan('enterprise')).toBe('enterprise');
    expect(normalizeWorkerPlan('free')).toBe('free');
    expect(normalizeWorkerPlan('PAID')).toBe('free');
    expect(normalizeWorkerPlan(undefined)).toBe('free');
  });
});

describe('workers.dev 子域名前缀推导', () => {
  it('取邮箱 @ 前一段并小写、剔除非 [a-z0-9-] 字符', () => {
    expect(subdomainPrefix({ email: 'Bob.Smith+cf@example.com', name: 'x' } as any)).toBe('bobsmithcf');
  });

  it('没有邮箱时回退到账号名', () => {
    expect(subdomainPrefix({ email: null, name: 'My Account' } as any)).toBe('myaccount');
  });

  it('首尾连字符会被去掉；无可用字符时返回空串', () => {
    expect(subdomainPrefix({ email: '--a--@x.com', name: '' } as any)).toBe('a');
    expect(subdomainPrefix({ email: '???@x.com', name: '中文名' } as any)).toBe('');
  });
});

describe('付费模型名缓存（账号路由据此过滤账号）', () => {
  it('缓存未建立时不判定为付费模型（保持既有行为）', () => {
    cachePaidModelNames([]);
    expect(isPaidModelName('@cf/zai-org/glm-5.3-flash')).toBe(false);
    expect(isPaidModelName(undefined)).toBe(false);
  });

  it('按 CF 元数据的 require_workers_paid 标记（含字符串 "true"）建立缓存', () => {
    cachePaidModelNames([
      { name: 'paid-model', properties: [{ property_id: 'require_workers_paid', value: 'true' }] },
      { id: 'paid-model-2', require_workers_paid: true },
      { name: 'free-model', properties: [{ property_id: 'require_workers_paid', value: 'false' }] },
    ]);
    expect(isPaidModelName('paid-model')).toBe(true);
    expect(isPaidModelName('paid-model-2')).toBe(true);
    expect(isPaidModelName('free-model')).toBe(false);
    expect(modelRequiresWorkersPaid({ properties: [{ property_id: 'require_workers_paid', value: 'true' }] })).toBe(true);
    cachePaidModelNames([]);
    expect(isPaidModelName('paid-model')).toBe(false);
  });
});

describe('计划类型自动探测（/accounts/{id}/subscriptions 响应解析）', () => {
  // 来自真实账号的响应（已脱敏裁剪）：zone 级免费计划 + SSLSaaS + R2 Paid，且 state 也是 "Paid"、price=0
  const REAL_FREE_ACCOUNT_SUBS = {
    success: true,
    result: [
      {
        id: 'a5ebd26a5fd14edb9dbd38b8b5ea3bb2',
        rate_plan: { id: 'free', public_name: 'Cloudflare Free Plan', scope: 'zone', is_contract: false },
        zone: { id: '7f4ce4955023d2b53da85a92fbd456ee', name: 'example.cc.cd' },
        state: 'Paid', price: 0, intent: 'FREE',
        product: { name: 'prod_cloudflare', public_name: 'Cloudflare Free Plan' },
      },
      {
        id: '98bea3cb2d774cb9bbf88686ff93bd2e',
        rate_plan: { id: 'ssl_for_saas_basic', public_name: 'SSL For SAAS Basic', scope: 'account' },
        state: 'Paid', price: 0,
        product: { name: 'ssl_for_saas', public_name: 'SSL For SAAS Basic' },
      },
      {
        id: '41df7fc28f364115aa9ab2b057392af4',
        rate_plan: { id: 'r2_paid', public_name: 'R2 Paid', scope: 'account' },
        state: 'Paid', price: 0, product: { name: 'r2_paid', public_name: 'R2 Paid' },
      },
    ],
  };

  it('真实的免费账号响应（zone free + R2 Paid，无 workers 项）→ free', () => {
    expect(mapWorkerPlanFromSubscriptions(REAL_FREE_ACCOUNT_SUBS)).toBe('free');
  });

  it('订阅为空（真实账号出现过 result: []）→ free', () => {
    expect(mapWorkerPlanFromSubscriptions({ result: [] })).toBe('free');
  });

  it('订阅里有 workers 付费计划 → paid（rate_plan.id 或 product.name 任一命中）', () => {
    expect(mapWorkerPlanFromSubscriptions({
      result: [{ rate_plan: { id: 'workers_paid', public_name: 'Workers Paid', scope: 'account' } }],
    })).toBe('paid');
    expect(mapWorkerPlanFromSubscriptions({
      result: [{ rate_plan: { id: 'standard', public_name: 'Standard' }, product: { name: 'prod_workers' } }],
    })).toBe('paid');
  });

  it('workers enterprise 计划 → enterprise', () => {
    expect(mapWorkerPlanFromSubscriptions({
      result: [{ rate_plan: { id: 'workers_enterprise', public_name: 'Workers Enterprise', is_contract: true } }],
    })).toBe('enterprise');
  });

  it('workers 免费权益项（名称含 free/trial）不算付费 → free', () => {
    expect(mapWorkerPlanFromSubscriptions({
      result: [{ rate_plan: { id: 'workers_free', public_name: 'Workers Free' } }],
    })).toBe('free');
    expect(mapWorkerPlanFromSubscriptions({
      result: [{ rate_plan: { id: 'workers_paid', public_name: 'Workers Paid Trial' } }],
    })).toBe('free');
  });

  it('响应结构不符 → null（不判定，保留现有值，避免把付费账号误降级）', () => {
    expect(mapWorkerPlanFromSubscriptions({})).toBeNull();
    expect(mapWorkerPlanFromSubscriptions({ result: 'oops' })).toBeNull();
    expect(mapWorkerPlanFromSubscriptions(null)).toBeNull();
  });
});
