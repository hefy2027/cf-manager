/**
 * Cloudflare 上游错误的统一映射。
 *
 * 背景（issue #68）：账号的 API Token 权限不足时，Cloudflare 会返回 401 / 403。
 * 如果把上游状态码原样透传给浏览器，前端会把「某个账号的 Token 没授权」
 * 误判成「管理端会话失效」，进而清掉 api_token 并跳回登录页。
 *
 * 因此上游的 401 / 403 / 429 / 5xx 一律映射为 502（网关侧上游失败）并附
 * 独立的错误码，让「上游账号凭证问题」与「本系统鉴权失败」彻底分开。
 *
 * 本文件必须保持纯函数（不 import SDK / 数据库），便于双端复用与单测。
 */

export interface MappedCfError {
  /** 对外返回的 HTTP 状态码 */
  statusCode: number;
  /** 对外返回的错误码 */
  code: string;
  /** 面向用户的中文提示（已包含 Cloudflare 原始错误摘要） */
  message: string;
}

/** 上游错误摘要的最大保留长度，避免把整段响应塞进提示里 */
const MAX_DETAIL_LENGTH = 300;

/** 自建 fetch 封装遇到非 2xx 时抛出的错误（backend zoneService 等） */
export class CfHttpError extends Error {
  /** Cloudflare 返回的真实状态码（仅用于日志 / 诊断，不对外透传） */
  readonly upstreamStatus: number;
  /** Cloudflare 原始响应体文本 */
  readonly cfBody: string;

  constructor(upstreamStatus: number, cfBody: string) {
    super(`CF API error ${upstreamStatus}: ${cfBody}`);
    this.name = 'CfHttpError';
    this.upstreamStatus = upstreamStatus;
    this.cfBody = cfBody;
  }
}

/** 截断过长的上游响应，避免消息膨胀 */
export function truncateCfDetail(detail: string, max = MAX_DETAIL_LENGTH): string {
  const text = (detail || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * 从 Cloudflare 响应体里提取尽量有用的错误摘要。
 * CF 的失败响应形如 `{ success: false, errors: [{ code: 9109, message: '...' }] }`，
 * 直接展示整段 JSON 对用户没有帮助。
 */
export function describeCfBody(body: string): string {
  const raw = body || '';
  try {
    const json = JSON.parse(raw);
    const errors = Array.isArray(json?.errors) ? json.errors : [];
    const joined = errors
      .map((e: any) => [e?.code, e?.message].filter((v: any) => v !== undefined && v !== null && v !== '').join(' '))
      .filter(Boolean)
      .join('; ');
    if (joined) return truncateCfDetail(joined);
    if (typeof json?.message === 'string' && json.message) return truncateCfDetail(json.message);
  } catch {
    // 非 JSON（HTML 错误页 / 空响应）时退回原文
  }
  return truncateCfDetail(raw);
}

/**
 * 把 Cloudflare 上游状态码映射为本系统对外的错误响应。
 *
 * | 上游 | 对外 | code |
 * |---|---|---|
 * | 401 | 502 | `CF_AUTH_FAILED`（账号凭证失效） |
 * | 403 | 502 | `CF_PERMISSION_DENIED`（Token 缺权限） |
 * | 429 | 502 | `CF_RATE_LIMITED` |
 * | 5xx / 无状态（网络错误） | 502 | `CF_UPSTREAM_ERROR` |
 * | 其它 4xx | 400 | `CF_BAD_REQUEST` |
 */
export function mapCfUpstreamError(upstreamStatus: number, rawDetail?: string): MappedCfError {
  const detail = truncateCfDetail(rawDetail || '');
  const suffix = detail ? `（Cloudflare 返回：${detail}）` : '';
  const status = Number(upstreamStatus) || 0;

  if (status === 401) {
    return {
      statusCode: 502,
      code: 'CF_AUTH_FAILED',
      message: `Cloudflare 授权失败：该账号的 API Token / Global API Key 无效或已过期，请在「账户管理」中重新校验凭证${suffix}`,
    };
  }

  if (status === 403) {
    return {
      statusCode: 502,
      code: 'CF_PERMISSION_DENIED',
      message: `Cloudflare 拒绝访问：该账号的 API Token 缺少本次操作所需的权限（如 Zone:Read、DNS:Read、Zone Settings:Read），请到 Cloudflare 后台为该 Token 补充权限${suffix}`,
    };
  }

  if (status === 429) {
    return {
      statusCode: 502,
      code: 'CF_RATE_LIMITED',
      message: `Cloudflare 接口限流（429），请稍后重试${suffix}`,
    };
  }

  if (status >= 500 || status === 0) {
    return {
      statusCode: 502,
      code: 'CF_UPSTREAM_ERROR',
      message: `无法完成 Cloudflare 请求：上游服务异常或网络不可达${status ? `（${status}）` : ''}${suffix}`,
    };
  }

  return {
    statusCode: 400,
    code: 'CF_BAD_REQUEST',
    message: `Cloudflare 拒绝了本次请求（${status}）${suffix}`,
  };
}
