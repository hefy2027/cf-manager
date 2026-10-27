import { Request, Response, NextFunction } from 'express';
import { config } from '../config';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // 未配置 API_SECRET 时跳过鉴权（开发/演示场景，向后兼容已有部署）。
  // 注意：这会导致所有管理接口处于无鉴权状态，存在安全风险，仅建议本地/内网使用。
  if (!config.apiSecret) {
    console.warn('[Auth] API_SECRET 未配置，所有管理接口将处于无鉴权状态，存在安全风险。');
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid authorization header' } });
    return;
  }

  const token = authHeader.substring(7);
  if (token !== config.apiSecret) {
    // 凭证错误语义上是 401（而非 403）：403 表示「已认证但无权操作」，
    // 前端只能据 401 / UNAUTHORIZED 判断会话失效，混用会让业务 403 被误判为登出（issue #68）。
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid API secret' } });
    return;
  }

  next();
}
