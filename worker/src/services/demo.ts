import type { Env } from '../types';

// 判断某个账户是否为演示（Demo）保护账户
export function isDemoAccount(id: number, demoIds: string | undefined): boolean {
  if (!demoIds) return false;
  return demoIds.split(',').map(s => parseInt(s.trim(), 10)).includes(id);
}

/**
 * Hono 中间件：演示账户「毁灭性操作」保护。
 * 拦截所有针对演示账户的销毁/删除类操作，返回 403 DEMO_PROTECTED：
 *  - 所有 DELETE 请求（删 KV 命名空间/键、删 D1 库、删 R2 桶/对象、删 Worker/Pages、删 Secret/Domain/Route 等）
 *  - 批量删除类 POST 请求（KV/R2 的 bulk-delete）
 * 注：D1 写查询（INSERT/UPDATE/DELETE/DROP/ALTER 等）在 storage 路由的 query handler 内单独拦截。
 */
export function demoDestructiveGuard() {
  return async (c: any, next: any) => {
    const method = c.req.method.toUpperCase();
    const path = c.req.path || '';
    const isDestructive =
      method === 'DELETE' ||
      (method === 'POST' && /\/bulk-delete$/.test(path));

    if (isDestructive) {
      const id = parseInt(c.req.param('accountId'), 10);
      if (!isNaN(id) && isDemoAccount(id, c.env.DEMO_ACCOUNT_IDS)) {
        return c.json({ error: { code: 'DEMO_PROTECTED', message: '演示账户不可执行删除/销毁操作' } }, 403);
      }
    }
    await next();
  };
}
