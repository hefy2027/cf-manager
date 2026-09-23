import { Account } from '../../models/account';
import { getDeployHeaders } from './headers';
import { createWorkerUploadForm } from './uploadForm';
import { deployWorkerAssets } from './assetsUpload';
import { ensureAccountSubdomain } from '../workerSubdomain';
import type { CfWorkerInit } from './types';
import { appLogger } from '../logger';
import { proxyFetch } from '../proxyService';

const CF_BASE = 'https://api.cloudflare.com/client/v4';
const MAX_RETRIES = 3;

// 上传重试：网络抖动 / undici 响应截断时可自动重试
async function withRetry<T>(fn: () => Promise<T>, maxAttempts = MAX_RETRIES): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const isRetryable = e.code === 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH'
        || e.code === 'UND_ERR_SOCKET'
        || e.code === 'ECONNRESET'
        || e.code === 'EPIPE';
      if (!isRetryable || i >= maxAttempts - 1) throw e;
      appLogger.warn(`[Worker Deploy] Retry ${i + 1}/${maxAttempts} after: ${e.code || e.message}`);
      await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

export interface DeployWorkerOptions {
  bindings?: Record<string, unknown>[];
  enableSubdomain?: boolean;
  createDeployment?: boolean;
  traces?: boolean;
  logs?: boolean;
  assets?: {
    files: Array<{ path: string; buffer: Buffer }>;
    binding?: string;
    config?: { html_handling?: string; not_found_handling?: string; run_worker_first?: string[] };
  };
}

export interface DeployWorkerResult {
  script: any;
  subdomain?: string;
  versionId?: string;
}

/**
 * Worker 部署 — 对齐 wrangler 部署流程。
 *
 * 路径 A (Versions API): POST versions → POST deployments → PATCH settings
 * 路径 B (传统 PUT): PUT /scripts/{name}
 *
 * 两条路径的选择由调用方（preflight）决定，此处通过 useVersionsApi 参数传入。
 */
export async function deployWorker(
  account: Account,
  name: string,
  scriptContent: string | Buffer | null,
  workerInit: Partial<CfWorkerInit>,
  options?: DeployWorkerOptions & {
    useVersionsApi?: boolean;
  },
): Promise<DeployWorkerResult> {
  const accountId = account.account_id;
  if (!accountId) throw new Error('Account ID is required');
  const deployHeaders = getDeployHeaders(account);

  // 1. 上传静态资源（如果有）
  let assetsJwt: string | undefined;
  if (options?.assets?.files?.length) {
    const result = await deployWorkerAssets(account, name, options.assets.files);
    assetsJwt = result.jwt;
  }

  // 2. 构建 bindings 数组
  const metadataBindings = [...(options?.bindings || [])];
  if (options?.assets && assetsJwt) {
    metadataBindings.push({
      name: options.assets.binding || 'ASSETS',
      type: 'assets',
    });
  }

  // 3. 组装 CfWorkerInit
  // 若 workerInit.main 已由上层设置（zip 多模块场景），直接使用；否则用 scriptContent
  if (!workerInit.main?.content && scriptContent === null) {
    throw new Error('Either workerInit.main.content or scriptContent must be provided');
  }
  const fallbackContent = typeof scriptContent === 'string'
    ? new TextEncoder().encode(scriptContent)
    : scriptContent ? new Uint8Array(scriptContent) : new Uint8Array(0);

  const worker: CfWorkerInit = {
    name,
    main: {
      name: workerInit.main?.name || 'worker.js',
      content: workerInit.main?.content ?? fallbackContent,
      type: workerInit.main?.type || 'esm',
    },
    modules: workerInit.modules || [],
    sourceMaps: workerInit.sourceMaps || [],
    compatibility_date: workerInit.compatibility_date || '2024-11-01',
    compatibility_flags: workerInit.compatibility_flags || [],
    migrations: workerInit.migrations,
    keepVars: workerInit.keepVars ?? true,
    keepSecrets: workerInit.keepSecrets ?? true,
    keepBindings: workerInit.keepBindings ?? true,
    placement: workerInit.placement,
    tail_consumers: workerInit.tail_consumers || [],
    limits: workerInit.limits,
    logpush: workerInit.logpush,
    assets: assetsJwt ? {
      jwt: assetsJwt,
      config: options?.assets?.config,
    } : undefined,
    // 对标 wrangler：observability 在上传 metadata 中一并设置，不依赖后续 PATCH
    observability: { enabled: true },
  };

  // 4. 构建上传表单（手动 multipart，避免 undici FormData Content-Length 计算不准）
  const { body: formBody, contentType: formContentType } = createWorkerUploadForm(worker, metadataBindings);
  const mainSize = typeof worker.main.content === 'string' ? worker.main.content.length : worker.main.content.byteLength;
  appLogger.info(`[Worker Deploy] Upload form: ${formBody.length} bytes, main=${worker.main.name} (${mainSize} bytes), modules=${worker.modules.length}`);

  // 5. 上传到 Cloudflare
  const useVersionsApi = options?.useVersionsApi ?? false;
  let respJson: any;
  let versionId: string | undefined;

  if (useVersionsApi) {
    // Path A: Versions API（对标 wrangler：先检查 script 是否存在）
    // Versions API 只能对已存在的 script 创建版本，首次部署必须先 PUT 创建
    const checkResp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}`, {
      method: 'GET',
      headers: { ...deployHeaders },
    }, 30000, undefined, account);
    if (checkResp.status === 404) {
      // Script 不存在，首次 PUT 创建（对标 wrangler 首次部署）
      appLogger.info(`[Worker Deploy] Script ${name} does not exist, creating via PUT`);
      const createResp = await withRetry(() =>
        proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}`, {
          method: 'PUT',
          headers: { ...deployHeaders, 'Content-Type': formContentType },
          body: formBody,
        }, 300000, undefined, account),
      );
      respJson = await createResp.json() as any;
      if (!createResp.ok || !respJson.success) {
        throw new Error(`Script creation failed: ${createResp.status} ${JSON.stringify(respJson)}`);
      }
      versionId = respJson?.result?.version_id;
      // 首次创建后也尝试创建 deployment（如果有 version_id）
      if (versionId && options?.createDeployment) {
        try {
          const depResp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/deployments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...deployHeaders },
            body: JSON.stringify({
              strategy: 'percentage',
              versions: [{ percentage: 100, version_id: versionId }],
            }),
          }, 30000, undefined, account);
          if (!depResp.ok) {
            const depTxt = await depResp.text();
            appLogger.warn(`[Worker Deploy] Deployment creation failed for ${name}: ${depResp.status} ${depTxt.slice(0, 300)}`);
          }
        } catch (e: any) {
          appLogger.warn(`[Worker Deploy] Deployment creation warning for ${name}: ${e.message}`);
        }
      }
    } else if (!checkResp.ok) {
      // 非 404 的错误状态（401/403/500 等），不应继续部署
      const errBody = await checkResp.text();
      throw new Error(`Script existence check failed: ${checkResp.status} ${errBody.slice(0, 300)}`);
    } else {
      // Script 已存在，用 Versions API 创建新版本
      const versionResp = await withRetry(() =>
        proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/versions?bindings_inherit=strict`, {
          method: 'POST',
          headers: { ...deployHeaders, 'Content-Type': formContentType },
          body: formBody,
        }, 300000, undefined, account),
      );
      const versionJson = await versionResp.json() as any;
      if (!versionResp.ok || !versionJson.success) {
        throw new Error(`Version upload failed: ${versionResp.status} ${JSON.stringify(versionJson)}`);
      }
      versionId = versionJson?.result?.id;

      // Create deployment with 100% traffic
      if (versionId && options?.createDeployment !== false) {
        const depResp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/deployments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...deployHeaders },
          body: JSON.stringify({
            strategy: 'percentage',
            versions: [{ percentage: 100, version_id: versionId }],
          }),
        }, 30000, undefined, account);
        if (!depResp.ok) {
          const depTxt = await depResp.text();
          appLogger.warn(`[Worker Deploy] Deployment creation failed for ${name}: ${depResp.status} ${depTxt.slice(0, 300)}`);
        }
      }
      respJson = versionJson;
    }
  } else {
    // Path B: Legacy PUT（PUT 已自动部署脚本，无需再创建 deployment）
    const resp = await withRetry(() =>
      proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}`, {
        method: 'PUT',
        headers: { ...deployHeaders, 'Content-Type': formContentType },
        body: formBody,
      }, 300000, undefined, account),
    );
    respJson = await resp.json() as any;
    if (!resp.ok || !respJson.success) {
      throw new Error(`${resp.status} ${JSON.stringify(respJson)}`);
    }
    versionId = respJson?.result?.version_id || respJson?.result?.version?.id;
  }

  // 6. 设置可观测性
  const tracesEnabled = options?.traces !== false;
  const logsEnabled = options?.logs !== false;
  if (tracesEnabled || logsEnabled) {
    const obsBody: Record<string, unknown> = { enabled: true, head_sampling_rate: 1 };
    if (tracesEnabled) obsBody.traces = { enabled: true, persist: true, head_sampling_rate: 1 };
    if (logsEnabled) obsBody.logs = { enabled: true, persist: true, invocation_logs: true, head_sampling_rate: 1 };
    try {
      const obsResp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/script-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...deployHeaders },
        body: JSON.stringify({ observability: obsBody }),
      }, 30000, undefined, account);
      if (!obsResp.ok) {
        const obsErr = await obsResp.text();
        appLogger.warn(`[Worker Deploy] Observability setup failed (${obsResp.status}): ${obsErr}`);
      }
    } catch (e: any) {
      appLogger.warn(`[Worker Deploy] Observability setup warning: ${e.message}`);
    }
  }

  // 7. 启用 workers.dev 子域
  let subdomain: string | undefined;
  if (options?.enableSubdomain !== false) {
    try {
      await proxyFetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/subdomain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...deployHeaders },
        body: JSON.stringify({ enabled: true }),
      }, 30000, undefined, account);
    } catch {
      // Soft fail
    }
    // 账号级 workers.dev 子域名：账号没注册过就自动注册（全局唯一，撞名会自动回退随机后缀）。
    // 失败不阻断部署，但必须记日志 —— 否则用户会碰到"部署成功但 *.workers.dev 打不开"。
    const ensured = await ensureAccountSubdomain(account);
    if (ensured.subdomain) {
      subdomain = ensured.subdomain;
    } else if (ensured.error) {
      appLogger.warn(`[Worker Deploy] workers.dev subdomain unavailable for "${account.name}": ${ensured.error}`);
    }
  }

  return { script: respJson.result, subdomain, versionId };
}
