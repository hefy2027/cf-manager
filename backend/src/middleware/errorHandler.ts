import { APIError } from 'cloudflare';
import { Request, Response, NextFunction } from 'express';
import { appLogger } from '../services/logger';
import { CfHttpError, describeCfBody, mapCfUpstreamError } from '../services/cfError';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
}

/**
 * 识别「错误来自 Cloudflare 上游」的两类表现：
 *  1. SDK（cloudflare v6）抛出的 APIError —— 带 status / errors；
 *  2. 自建 fetch 封装抛出的 CfHttpError —— 带 upstreamStatus / cfBody。
 *
 * 上游的 401 / 403 绝不能原样返回给浏览器：那会被前端当成管理端会话失效
 * （issue #68）。统一交给 mapCfUpstreamError 转成 502 + CF_* 错误码。
 */
function resolveCfFailure(err: any): { upstreamStatus: number; detail: string } | null {
  if (err instanceof CfHttpError) {
    return { upstreamStatus: err.upstreamStatus, detail: describeCfBody(err.cfBody) };
  }
  if (err instanceof APIError) {
    const errors = Array.isArray(err.errors) ? err.errors : [];
    const detail = errors.length
      ? errors
          .map((e: any) => [e?.code, e?.message].filter((v: any) => v !== undefined && v !== null && v !== '').join(' '))
          .filter(Boolean)
          .join('; ')
      : String(err.message || '');
    return { upstreamStatus: typeof err.status === 'number' ? err.status : 0, detail };
  }
  return null;
}

export function errorHandler(err: AppError, req: Request, res: Response, _next: NextFunction): void {
  const cfFailure = resolveCfFailure(err);
  const mapped = cfFailure ? mapCfUpstreamError(cfFailure.upstreamStatus, cfFailure.detail) : null;

  const statusCode = mapped?.statusCode ?? err.statusCode ?? 500;
  const code = mapped?.code ?? err.code ?? 'INTERNAL_ERROR';
  const message = mapped?.message ?? err.message;

  appLogger.error(`[${code}] ${req.method} ${req.originalUrl} - ${err.message}`);
  if (res.headersSent) {
    return;
  }
  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
    },
  });
}
