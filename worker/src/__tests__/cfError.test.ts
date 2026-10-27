import { describe, it, expect } from 'vitest';
import { CfHttpError, describeCfBody, mapCfUpstreamError } from '../services/cfError';

/**
 * 与 backend/tests/cfError.test.ts 对称：上游 401 / 403 不得透传（issue #68）。
 */
describe('mapCfUpstreamError：上游状态码映射', () => {
  it('上游 401 / 403 统一映射为 502，避免被当成管理端会话失效', () => {
    expect(mapCfUpstreamError(401).statusCode).toBe(502);
    expect(mapCfUpstreamError(401).code).toBe('CF_AUTH_FAILED');
    expect(mapCfUpstreamError(403).statusCode).toBe(502);
    expect(mapCfUpstreamError(403).code).toBe('CF_PERMISSION_DENIED');
  });

  it('上游 5xx / 网络错误映射为 CF_UPSTREAM_ERROR', () => {
    expect(mapCfUpstreamError(502).statusCode).toBe(502);
    expect(mapCfUpstreamError(0).code).toBe('CF_UPSTREAM_ERROR');
  });

  it('上游 4xx 业务错误保留 400 语义', () => {
    expect(mapCfUpstreamError(400).statusCode).toBe(400);
  });
});

describe('describeCfBody', () => {
  it('优先提取 errors 数组中的 code + message', () => {
    const body = JSON.stringify({ success: false, errors: [{ code: 9109, message: 'Unauthorized to access requested resource' }] });
    expect(describeCfBody(body)).toBe('9109 Unauthorized to access requested resource');
  });

  it('非 JSON 退回原文', () => {
    expect(describeCfBody('plain text error')).toBe('plain text error');
  });
});

describe('CfHttpError', () => {
  it('保留上游状态码与响应体', () => {
    const err = new CfHttpError(403, '{"errors":[{"code":9109}]}');
    expect(err.upstreamStatus).toBe(403);
    expect(err.cfBody).toContain('9109');
  });
});
