import type { Account } from '../../db/models';
import { getDeployHeaders } from './headers';
import { computeStaticAssetHash, getContentType, extractZipFiles, uint8ToBase64 } from '../staticAssets';

const CF_BASE = 'https://api.cloudflare.com/client/v4';
const MAX_RETRIES = 3;
const MAX_JWT_RETRIES = 2;

// ---- JWT 工具 ----

function decodeJwtPayload(jwt: string): { exp?: number } | null {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    // Workers 运行时不支持 Buffer，使用 atob
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload;
  } catch {
    return null;
  }
}

function isJwtExpired(jwt: string): boolean {
  const payload = decodeJwtPayload(jwt);
  if (!payload?.exp) return false;
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

export interface DeployPageFile { path: string; buffer: Uint8Array; }

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
  encryptionKey: string,
  projectName: string,
  deploymentId: string,
): Promise<{ status: 'success' | 'failure'; logs?: string }> {
  const deployHeaders = await getDeployHeaders(account, encryptionKey);
  let delay = 2000;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, delay));
    const resp = await fetch(`${CF_BASE}/accounts/${account.account_id}/pages/projects/${projectName}/deployments/${deploymentId}`, {
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

async function ensurePagesProject(account: Account, encryptionKey: string, name: string): Promise<void> {
  const deployHeaders = await getDeployHeaders(account, encryptionKey);
  try {
    const resp = await fetch(`${CF_BASE}/accounts/${account.account_id}/pages/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...deployHeaders },
      body: JSON.stringify({ name, production_branch: 'main' }),
    });
    if (!resp.ok && resp.status !== 409) {
      const body = await resp.text();
      if (!body.includes('already exists')) throw new Error(`ensurePagesProject: ${resp.status} ${body}`);
    }
  } catch (e: any) {
    if (!e.message?.includes('already exists')) throw e;
  }
}

// ---- 主部署函数 ----

export async function deployPages(
  account: Account,
  encryptionKey: string,
  name: string,
  files: DeployPageFile[],
  opts: DeployPagesOptions = {},
): Promise<any> {
  const accountId = account.account_id;
  const deployHeaders = await getDeployHeaders(account, encryptionKey);

  // Step 0: 确保项目存在
  if (!opts.skipCreateProject) {
    await ensurePagesProject(account, encryptionKey, name);
  }

  // Step 0.5: 设置 deployment_configs — 修复双端不对称
  if (opts.deploymentConfigs) {
    try {
      await fetch(`${CF_BASE}/accounts/${accountId}/pages/projects/${name}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...deployHeaders },
        body: JSON.stringify({ deployment_configs: opts.deploymentConfigs }),
      });
    } catch (e: any) {
      console.warn(`[Pages Deploy] Failed to set deployment_configs: ${e.message}`);
    }
  }

  // 空文件时返回 project 对象
  if (!files || files.length === 0) {
    const resp = await fetch(`${CF_BASE}/accounts/${accountId}/pages/projects/${name}`, {
      headers: { ...deployHeaders },
    });
    const json = await resp.json() as any;
    return json.result || json;
  }

  // 分类文件
  const specialFiles: Array<{ name: string; buffer: Uint8Array; contentType: string }> = [];
  const assetFiles: Array<{ path: string; buffer: Uint8Array; contentType: string }> = [];

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
    const resp = await fetch(`${CF_BASE}/accounts/${accountId}/pages/projects/${name}/upload-token`, {
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
  const hashToFile = new Map<string, { buffer: Uint8Array; contentType: string }>();

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
    const resp = await fetch(`${CF_BASE}/pages/assets/check-missing`, {
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
        console.log(`[Pages Deploy] JWT expired during check-missing, refreshing...`);
        currentJwt = await fetchJwt();
      } else {
        throw e;
      }
    }
  }

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
          value: uint8ToBase64(fileInfo.buffer),
          metadata: { contentType: fileInfo.contentType },
          base64: true,
        });
      }

      const uploadBatch = async (jwtToUse: string) => {
        const resp = await fetch(`${CF_BASE}/pages/assets/upload`, {
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
            console.log(`[Pages Deploy] JWT expired during upload, refreshing...`);
            currentJwt = await fetchJwt();
          } else {
            throw e;
          }
        }
      }
    }

    // upsert-hashes (non-fatal)
    try {
      await fetch(`${CF_BASE}/pages/assets/upsert-hashes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${currentJwt}`,
          'User-Agent': 'wrangler/4.112.0',
        },
        body: JSON.stringify({ hashes: allHashes }),
      });
    } catch {
      // non-fatal
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
    formData.append(sf.name, new Blob([sf.buffer], { type: sf.contentType }), sf.name);
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
    const pollResult = await pollDeploymentStatus(account, encryptionKey, name, deploymentId);
    if (pollResult.status === 'failure') {
      console.warn(`[Pages Deploy] Deployment may have failed: ${pollResult.logs || 'unknown'}`);
    }
  }

  return deployJson.result;
}
