import { Account } from '../../models/account';
import { getDeployHeaders } from './headers';
import { computeStaticAssetHash, getContentType, extractZipFiles } from '../staticAssets';
import { appLogger } from '../logger';
import { proxyFetch } from '../proxyService';

const CF_BASE = 'https://api.cloudflare.com/client/v4';
const MAX_RETRIES = 3;
const MAX_JWT_RETRIES = 2;

// ---- JWT 工具 ----

function decodeJwtPayload(jwt: string): { exp?: number } | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'));
    return payload;
  } catch {
    return null;
  }
}

function isJwtExpired(jwt: string): boolean {
  const payload = decodeJwtPayload(jwt);
  if (!payload?.exp) return false; // 无 exp 字段时不判定过期
  // 提前 30 秒判定过期，避免边界竞态
  return Date.now() / 1000 > payload.exp - 30;
}

// ---- 重试工具 ----

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = MAX_RETRIES): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      if (i < maxAttempts - 1) await new Promise(r => setTimeout(r, 1000 * Math.pow(2, i)));
    }
  }
  throw lastErr;
}

// ---- 特殊文件 ----

const SPECIAL_FILES = new Set([
  '_worker.js', '_worker.bundle', '_headers', '_redirects',
  '_routes.json', 'functions-filepath-routing-config.json',
]);

export interface DeployPageFile { path: string; buffer: Buffer; }

export interface DeployPagesOptions {
  skipCreateProject?: boolean;
  productionBranch?: string;
  branch?: string;
  commitMessage?: string;
  deploymentConfigs?: any;
}

// ---- 部署状态轮询 ----

async function pollDeploymentStatus(
  account: Account,
  projectName: string,
  deploymentId: string,
): Promise<{ status: 'success' | 'failure'; logs?: string }> {
  const deployHeaders = getDeployHeaders(account);
  let delay = 2000;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, delay));
    const resp = await proxyFetch(`${CF_BASE}/accounts/${account.account_id}/pages/projects/${projectName}/deployments/${deploymentId}`, {
      headers: { ...deployHeaders },
    });
    if (resp.ok) {
      const json = await resp.json() as any;
      const stage = json?.result?.latest_stage;
      if (stage?.status === 'success') return { status: 'success' };
      if (stage?.status === 'failure') return { status: 'failure', logs: json?.result?.logs };
    }
    delay = Math.min(delay * 1.5, 10000);
  }
  return { status: 'failure', logs: 'Polling timeout' };
}

// ---- 确保项目存在 ----

async function ensurePagesProject(account: Account, name: string): Promise<void> {
  const deployHeaders = getDeployHeaders(account);
  try {
    await proxyFetch(`${CF_BASE}/accounts/${account.account_id}/pages/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deployHeaders },
      body: JSON.stringify({ name, production_branch: 'main' }),
    });
  } catch (e: any) {
    if (!e.body?.includes('already exists') && e.status !== 409) throw e;
  }
}

// ---- 主部署函数 ----

export async function deployPages(
  account: Account,
  name: string,
  files: DeployPageFile[],
  opts: DeployPagesOptions = {},
): Promise<any> {
  const accountId = account.account_id;
  if (!accountId) throw new Error('Account ID is required');
  const deployHeaders = getDeployHeaders(account);

  // Step 0: 确保项目存在
  if (!opts.skipCreateProject) {
    await ensurePagesProject(account, name);
  }

  // Step 0.5: 设置 deployment_configs（bindings + env）— 修复双端不对称
  if (opts.deploymentConfigs) {
    try {
      await proxyFetch(`${CF_BASE}/accounts/${accountId}/pages/projects/${name}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...deployHeaders },
        body: JSON.stringify({ deployment_configs: opts.deploymentConfigs }),
      });
    } catch (e: any) {
      appLogger.warn(`[Pages Deploy] Failed to set deployment_configs: ${e.message}`);
    }
  }

  // 空文件时返回 project 对象
  if (!files || files.length === 0) {
    const resp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/pages/projects/${name}`, {
      headers: { ...deployHeaders },
    });
    const json = await resp.json() as any;
    return json.result || json;
  }

  // 分类文件
  const specialFiles: Array<{ name: string; buffer: Buffer; contentType: string }> = [];
  const assetFiles: Array<{ path: string; buffer: Buffer; contentType: string }> = [];

  for (const f of files) {
    const cleanPath = f.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const basename = cleanPath.split('/').pop() || cleanPath;
    if (!cleanPath.includes('/') && SPECIAL_FILES.has(basename)) {
      specialFiles.push({ name: basename, buffer: f.buffer, contentType: getContentType(basename) });
    } else {
      assetFiles.push({ path: cleanPath, buffer: f.buffer, contentType: getContentType(cleanPath) });
    }
  }

  // Step 1: 获取 upload JWT
  let jwt: string = '';
  const fetchJwt = async () => {
    const resp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/pages/projects/${name}/upload-token`, {
      headers: { ...deployHeaders },
    });
    if (!resp.ok) throw new Error(`Failed to get upload token: ${resp.status}`);
    const json = await resp.json() as any;
    if (!json?.result?.jwt) throw new Error(`Upload token response missing jwt: ${JSON.stringify(json)}`);
    return json.result.jwt as string;
  };
  jwt = await fetchJwt();

  // Step 2: 计算 hash + check-missing
  const manifest: Record<string, string> = {};
  const hashToFile = new Map<string, { buffer: Buffer; contentType: string }>();

  for (const f of assetFiles) {
    const manifestKey = '/' + f.path;
    const hash = await computeStaticAssetHash(f.buffer, f.path);
    manifest[manifestKey] = hash;
    if (!hashToFile.has(hash)) {
      hashToFile.set(hash, { buffer: f.buffer, contentType: f.contentType });
    }
  }

  const allHashes = [...hashToFile.keys()];

  // check-missing with JWT refresh
  const checkMissing = async (currentJwt: string): Promise<string[]> => {
    const resp = await proxyFetch(`${CF_BASE}/pages/assets/check-missing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentJwt}`,
        'User-Agent': 'wrangler/4.112.0',
      },
      body: JSON.stringify({ hashes: allHashes }),
    });
    if (!resp.ok) throw new Error(`check-missing failed: ${resp.status}`);
    const json = await resp.json() as any;
    return json.result || [];
  };

  let missingHashes: string[] = [];
  let currentJwt = jwt;
  for (let attempt = 0; attempt <= MAX_JWT_RETRIES; attempt++) {
    try {
      missingHashes = await withRetry(() => checkMissing(currentJwt));
      break;
    } catch (e: any) {
      if (attempt < MAX_JWT_RETRIES && isJwtExpired(currentJwt)) {
        appLogger.info(`[Pages Deploy] JWT expired during check-missing, refreshing...`);
        currentJwt = await fetchJwt();
      } else {
        throw e;
      }
    }
  }

  appLogger.info(`[Pages Deploy] Missing assets: ${missingHashes.length}/${allHashes.length}`);

  // Step 3: 上传缺失的资源
  if (missingHashes.length > 0) {
    const BATCH_SIZE = 50;

    for (let i = 0; i < missingHashes.length; i += BATCH_SIZE) {
      const batch = missingHashes.slice(i, i + BATCH_SIZE);
      const payload: Array<{ key: string; value: string; metadata: { contentType: string }; base64: boolean }> = [];

      for (const hash of batch) {
        const fileInfo = hashToFile.get(hash);
        if (!fileInfo) continue;
        payload.push({
          key: hash,
          value: fileInfo.buffer.toString('base64'),
          metadata: { contentType: fileInfo.contentType },
          base64: true,
        });
      }

      // Upload with retry + JWT refresh
      const uploadBatch = async (jwtToUse: string) => {
        const resp = await proxyFetch(`${CF_BASE}/pages/assets/upload`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${jwtToUse}`,
            'User-Agent': 'wrangler/4.112.0',
          },
          body: JSON.stringify(payload),
        });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`Asset upload failed (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${resp.status} ${text}`);
        }
      };

      for (let attempt = 0; attempt <= MAX_JWT_RETRIES; attempt++) {
        try {
          await withRetry(() => uploadBatch(currentJwt));
          break;
        } catch (e: any) {
          if (attempt < MAX_JWT_RETRIES && isJwtExpired(currentJwt)) {
            appLogger.info(`[Pages Deploy] JWT expired during upload, refreshing...`);
            currentJwt = await fetchJwt();
          } else {
            throw e;
          }
        }
      }
    }

    // upsert-hashes (non-fatal)
    try {
      await proxyFetch(`${CF_BASE}/pages/assets/upsert-hashes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentJwt}`,
          'User-Agent': 'wrangler/4.112.0',
        },
        body: JSON.stringify({ hashes: allHashes }),
      });
    } catch (e: any) {
      appLogger.warn(`[Pages Deploy] upsert-hashes failed (non-fatal): ${e.message}`);
    }
  }

  // Step 4: 创建 deployment
  const formData = new FormData();
  formData.append('manifest', JSON.stringify(manifest));
  formData.append('branch', opts.branch || 'main');
  formData.append('commit_message', opts.commitMessage || '');
  formData.append('commit_hash', 'direct-upload');
  formData.append('commit_dirty', 'false');

  for (const sf of specialFiles) {
    // Buffer → Uint8Array to satisfy BlobPart type under strict mode
    const view = new Uint8Array(sf.buffer.byteLength);
    view.set(sf.buffer);
    formData.append(sf.name, new Blob([view], { type: sf.contentType }), sf.name);
  }

  const deployResp = await withRetry(() =>
    fetch(`${CF_BASE}/accounts/${accountId}/pages/projects/${name}/deployments`, {
      method: 'POST',
      headers: { ...deployHeaders },
      body: formData,
    }),
  );
  const deployJson = await deployResp.json() as any;
  if (!deployResp.ok || !deployJson.success) {
    throw new Error(`Pages deploy failed: ${deployResp.status} ${JSON.stringify(deployJson)}`);
  }

  // Step 5: 轮询部署状态
  const deploymentId = deployJson?.result?.id;
  if (deploymentId) {
    const pollResult = await pollDeploymentStatus(account, name, deploymentId);
    if (pollResult.status === 'failure') {
      appLogger.warn(`[Pages Deploy] Deployment may have failed: ${pollResult.logs || 'unknown'}`);
    }
  }

  return deployJson.result;
}
