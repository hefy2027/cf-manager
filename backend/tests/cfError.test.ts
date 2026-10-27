import { describe, it, expect } from 'vitest';
import { CfHttpError, describeCfBody, mapCfUpstreamError, truncateCfDetail } from '../src/services/cfError';

/**
 * issue #68 的回归防线：
 * Cloudflare 上游的 401 / 403 不得原样透传（否则前端会把某个账号的 Token 授权异常
 * 当成管理端会话失效并强制登出），必须映射为 502 + CF_* 错误码。
 */
describe('mapCfUpstreamError：上游状态码映射', () => {
  it('上游 401 映射为 502 + CF_AUTH_FAILED', () => {
    const mapped = mapCfUpstreamError(401, 'invalid api token');
    expect(mapped.statusCode).toBe(502);
    expect(mapped.code).toBe('CF_AUTH_FAILED');
    expect(mapped.message).toContain('invalid api token');
  });

  it('上游 403 映射为 502 + CF_PERMISSION_DENIED，且提示补充权限', () => {
    const mapped = mapCfUpstreamError(403, '9109 Unauthorized to access requested resource');
    expect(mapped.statusCode).toBe(502);
    expect(mapped.code).toBe('CF_PERMISSION_DENIED');
    expect(mapped.message).toContain('权限');
  });

  it('上游 429 映射为 502 + CF_RATE_LIMITED', () => {
    const mapped = mapCfUpstreamError(429, 'too many requests');
    expect(mapped.statusCode).toBe(502);
    expect(mapped.code).toBe('CF_RATE_LIMITED');
  });

  it('上游 5xx 与无状态（网络错误）映射为 502 + CF_UPSTREAM_ERROR', () => {
    expect(mapCfUpstreamError(503).code).toBe('CF_UPSTREAM_ERROR');
    expect(mapCfUpstreamError(503).statusCode).toBe(502);
    expect(mapCfUpstreamError(0).code).toBe('CF_UPSTREAM_ERROR');
    expect(mapCfUpstreamError(NaN).statusCode).toBe(502);
  });

  it('上游 4xx 业务错误保留 400 语义', () => {
    const mapped = mapCfUpstreamError(400, 'record content invalid');
    expect(mapped.statusCode).toBe(400);
    expect(mapped.code).toBe('CF_BAD_REQUEST');
  });

  it('任何情况下都不会把 401 / 403 透传给调用方', () => {
    for (const status of [400, 401, 403, 404, 429, 500, 502, 0]) {
      const { statusCode } = mapCfUpstreamError(status);
      expect(statusCode).not.toBe(401);
      expect(statusCode).not.toBe(403);
    }
  });
});

describe('describeCfBody：提取 Cloudflare 错误摘要', () => {
  it('从 errors 数组提取 code + message', () => {
    const body = JSON.stringify({
      success: false,
      errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }],
    });
    expect(describeCfBody(body)).toBe('9109 Unauthorized to access requested resource');
  });

  it('多条错误用分号连接', () => {
    const body = JSON.stringify({ errors: [{ code: 10000, message: 'Authentication error' }, { code: 9109, message: 'Unauthorized' }] });
    expect(describeCfBody(body)).toBe('10000 Authentication error; 9109 Unauthorized');
  });

  it('非 JSON 响应退回原文', () => {
    expect(describeCfBody('<html>502 Bad Gateway</html>')).toContain('502 Bad Gateway');
  });

  it('空响应不产生 undefined 文案', () => {
    expect(describeCfBody('')).toBe('');
  });
});

describe('truncateCfDetail / CfHttpError', () => {
  it('超长详情被截断并加省略号', () => {
    const long = 'x'.repeat(400);
    const out = truncateCfDetail(long);
    expect(out.length).toBeLessThanOrEqual(301);
    expect(out.endsWith('…')).toBe(true);
  });

  it('CfHttpError 保留上游状态码与原始响应体', () => {
    const err = new CfHttpError(403, '{"errors":[{"code":9109}]}');
    expect(err.upstreamStatus).toBe(403);
    expect(err.cfBody).toContain('9109');
    expect(err.name).toBe('CfHttpError');
  });
});
