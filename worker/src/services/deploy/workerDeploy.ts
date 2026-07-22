import type { Account } from '../../db/models';
import { getDeployHeaders } from './headers';
import { createWorkerUploadForm } from './uploadForm';
import { deployWorkerAssets } from './assetsUpload';
import type { CfWorkerInit } from './types';

const CF_BASE = 'https://api.cloudflare.com/client/v4';

export interface DeployWorkerOptions {
  bindings?: Record<string, unknown>[];
  enableSubdomain?: boolean;
  createDeployment?: boolean;
  traces?: boolean;
  logs?: boolean;
  assets?: {
    files: Array<{ path: string; buffer: Uint8Array }>;
    binding?: string;
    config?: { html_handling?: string; not_found_handling?: string };
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
 */
export async function deployWorker(
  account: Account,
  encryptionKey: string,
  name: string,
  scriptContent: Uint8Array | string,
  workerInit: Partial<CfWorkerInit>,
  options?: DeployWorkerOptions & {
    useVersionsApi?: boolean;
  },
): Promise<DeployWorkerResult> {
  const accountId = account.account_id;
  const deployHeaders = await getDeployHeaders(account, encryptionKey);

  // 1. 上传静态资源（如果有）
  let assetsJwt: string | undefined;
  if (options?.assets?.files?.length) {
    const result = await deployWorkerAssets(account, encryptionKey, name, options.assets.files);
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
  const contentBytes = typeof scriptContent === 'string'
    ? new TextEncoder().encode(scriptContent)
    : new Uint8Array(scriptContent);

  const worker: CfWorkerInit = {
    name,
    main: {
      name: workerInit.main?.name || 'worker.js',
      content: contentBytes,
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
    observability: undefined,
  };

  // 4. 构建上传表单
  const form = createWorkerUploadForm(worker, metadataBindings);

  // 5. 上传到 Cloudflare
  const useVersionsApi = options?.useVersionsApi ?? false;
  let respJson: any;
  let versionId: string | undefined;

  if (useVersionsApi) {
    // Path A: Versions API
    const versionResp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/versions`, {
      method: 'POST',
      headers: { ...deployHeaders },
      body: form,
    });
    const versionJson = await versionResp.json() as any;
    if (!versionResp.ok || !versionJson.success) {
      throw new Error(`Version upload failed: ${versionResp.status} ${JSON.stringify(versionJson)}`);
    }
    versionId = versionJson?.result?.id;

    if (versionId && options?.createDeployment !== false) {
      const depResp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/deployments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...deployHeaders },
        body: JSON.stringify({
          strategy: 'percentage',
          versions: [{ percentage: 100, version_id: versionId }],
        }),
      });
      if (!depResp.ok) {
        const depTxt = await depResp.text();
        console.warn(`[Worker Deploy] Deployment creation failed for ${name}: ${depResp.status} ${depTxt.slice(0, 300)}`);
      }
    }

    respJson = versionJson;
  } else {
    // Path B: Legacy PUT
    const resp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}`, {
      method: 'PUT',
      headers: { ...deployHeaders },
      body: form,
    });
    respJson = await resp.json() as any;
    if (!resp.ok || !respJson.success) {
      throw new Error(`${resp.status} ${JSON.stringify(respJson)}`);
    }
    versionId = respJson?.result?.version_id || respJson?.result?.version?.id;

    if (versionId && options?.createDeployment) {
      try {
        if (!versionId) {
          const versionsResp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/versions`, {
            headers: { ...deployHeaders },
          });
          if (versionsResp.ok) {
            const versionsJson = await versionsResp.json() as any;
            const versions = versionsJson?.result || [];
            if (versions.length > 0) {
              versionId = versions[0]?.id;
            }
          }
        }
        if (versionId) {
          const depResp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/deployments`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...deployHeaders },
            body: JSON.stringify({
              strategy: 'percentage',
              versions: [{ percentage: 100, version_id: versionId }],
            }),
          });
          if (!depResp.ok) {
            const depTxt = await depResp.text();
            console.warn(`[Worker Deploy] Deployment creation failed for ${name}: ${depResp.status} ${depTxt.slice(0, 300)}`);
          }
        }
      } catch (e: any) {
        console.warn(`[Worker Deploy] Deployment creation warning for ${name}: ${e.message}`);
      }
    }
  }

  // 6. 设置可观测性
  const tracesEnabled = options?.traces !== false;
  const logsEnabled = options?.logs !== false;
  if (tracesEnabled || logsEnabled) {
    const obsBody: Record<string, unknown> = { enabled: true, head_sampling_rate: 1 };
    if (tracesEnabled) obsBody.traces = { enabled: true, persist: true, head_sampling_rate: 1 };
    if (logsEnabled) obsBody.logs = { enabled: true, persist: true, invocation_logs: true, head_sampling_rate: 1 };
    try {
      const obsResp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/script-settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...deployHeaders },
        body: JSON.stringify({ observability: obsBody }),
      });
      if (!obsResp.ok) {
        const obsErr = await obsResp.text();
        console.warn(`[Worker Deploy] Observability setup failed (${obsResp.status}): ${obsErr}`);
      }
    } catch (e: any) {
      console.warn(`[Worker Deploy] Observability setup warning: ${e.message}`);
    }
  }

  // 7. 启用 workers.dev 子域
  let subdomain: string | undefined;
  if (options?.enableSubdomain !== false) {
    try {
      await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/subdomain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...deployHeaders },
        body: JSON.stringify({ enabled: true, previews_enabled: true }),
      });
    } catch {
      // Soft fail
    }
    try {
      const subResp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/subdomain`, {
        headers: { 'Content-Type': 'application/json', ...deployHeaders },
      });
      if (subResp.ok) {
        const subJson = await subResp.json() as any;
        subdomain = subJson?.result?.subdomain;
      }
    } catch {
      // Soft fail
    }
  }

  return { script: respJson.result, subdomain, versionId };
}
