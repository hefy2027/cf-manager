import type { Account } from '../db/models';
import { cfFetch, cfFetchRaw } from './cfApi';
import { computeStaticAssetHash, getContentType, extractZipFiles, uint8ToBase64 } from './staticAssets';
export { extractZipFiles };

// Pages 项目名称校验：Cloudflare 要求 ^[a-z0-9][a-z0-9-]*$
export function validatePagesProjectName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

// 确保 Pages 项目存在，已存在时忽略 409 错误
export async function ensurePagesProject(account: Account, encryptionKey: string, name: string): Promise<void> {
  try {
    await cfFetch(account, `/accounts/${account.account_id}/pages/projects`, encryptionKey, {
      method: 'POST',
      body: JSON.stringify({ name, production_branch: 'main' }),
    });
  } catch (e: any) {
    if (!e.body?.includes('already exists') && e.status !== 409) throw e;
  }
}

// 演示/特殊文件：不进 manifest，单独作为 multipart 字段上传
const SPECIAL_FILES = new Set([
  '_worker.js', '_worker.bundle', '_headers', '_redirects',
  '_routes.json', 'functions-filepath-routing-config.json',
]);

// ============ Pages 部署：wrangler 四步上传法 ============
export interface DeployPageFile { path: string; buffer: Uint8Array; }

export interface DeployPagesOptions {
  skipCreateProject?: boolean;
  productionBranch?: string;
  branch?: string;
  commitMessage?: string;
}

// 完全对照 wrangler (packages/wrangler/src/pages/upload.ts + api/pages/deploy.ts) 实现：
//   Step 1: GET  /accounts/{accountId}/pages/projects/{name}/upload-token → { jwt }
//   Step 2: POST /pages/assets/check-missing  (Bearer jwt)  body: { hashes: [...] } → 需上传的 hash 列表
//   Step 3: POST /pages/assets/upload          (Bearer jwt)  body: [{ key, value, metadata, base64 }]
//           POST /pages/assets/upsert-hashes   (Bearer jwt)  body: { hashes: [...] }
//   Step 4: POST /accounts/{accountId}/pages/projects/{name}/deployments
//           FormData: manifest(JSON) + branch + commit_* + [特殊文件]  （不含普通资源，已在 Step 3 上传）
const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

export async function deployPages(
  account: Account,
  encryptionKey: string,
  name: string,
  files: DeployPageFile[],
  opts: DeployPagesOptions = {},
): Promise<any> {
  if (!opts.skipCreateProject) {
    await ensurePagesProject(account, encryptionKey, name);
  }

  // 空文件时返回 project 对象
  if (files.length === 0) {
    const project = await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${name}`, encryptionKey);
    return project.result || project;
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

  // ---- Step 1: 获取 upload JWT ----
  const tokenResp = await cfFetch<any>(
    account,
    `/accounts/${account.account_id}/pages/projects/${name}/upload-token`,
    encryptionKey,
  );
  const jwt: string | undefined = tokenResp?.result?.jwt;
  if (!jwt) throw new Error(`Failed to get upload JWT: ${JSON.stringify(tokenResp)}`);

  // ---- Step 2: 计算 hash + check-missing ----
  const manifest: Record<string, string> = {};
  const hashToFile = new Map<string, { buffer: Uint8Array; contentType: string }>();

  for (const f of assetFiles) {
    const manifestKey = '/' + f.path; // wrangler manifest key 以 / 开头
    const hash = await computeStaticAssetHash(f.buffer, f.path);
    manifest[manifestKey] = hash;
    if (!hashToFile.has(hash)) {
      hashToFile.set(hash, { buffer: f.buffer, contentType: f.contentType });
    }
  }

  const allHashes = [...hashToFile.keys()];

  const checkResp = await fetch(`${CF_API_BASE}/pages/assets/check-missing`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify({ hashes: allHashes }),
  });
  if (!checkResp.ok) {
    const text = await checkResp.text();
    throw new Error(`check-missing failed: ${checkResp.status} ${text}`);
  }
  const checkJson = await checkResp.json() as any;
  const missingHashes: string[] = checkJson.result || [];

  // ---- Step 3: 上传缺失的资源 ----
  // wrangler: POST /pages/assets/upload, body = [{ key: hash, value: base64(content), metadata: { contentType }, base64: true }]
  // 分批上传，每批不超过 50 个文件（wrangler 用 bucket + 并发 3，这里简化为顺序分批）
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

      const uploadResp = await fetch(`${CF_API_BASE}/pages/assets/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
        },
        body: JSON.stringify(payload),
      });
      if (!uploadResp.ok) {
        const text = await uploadResp.text();
        throw new Error(`Asset upload failed (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${uploadResp.status} ${text}`);
      }
    }

    // upsert-hashes：注册已上传的 hash，加速下次部署（非致命，失败仅忽略）
    try {
      await fetch(`${CF_API_BASE}/pages/assets/upsert-hashes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
        },
        body: JSON.stringify({ hashes: allHashes }),
      });
    } catch {
      // non-fatal
    }
  }

  // ---- Step 4: 创建 deployment ----
  // FormData: manifest(JSON string) + branch + commit_message + commit_hash + commit_dirty + [特殊文件]
  // 注意：普通资源文件不在此请求中，它们已通过 /pages/assets/upload 上传
  const formData = new FormData();
  formData.append('manifest', JSON.stringify(manifest));
  formData.append('branch', opts.branch || 'main');
  formData.append('commit_message', opts.commitMessage || 'Deploy via CF Manager');
  formData.append('commit_hash', 'direct-upload');
  formData.append('commit_dirty', 'false');

  for (const sf of specialFiles) {
    formData.append(sf.name, new Blob([sf.buffer], { type: sf.contentType }), sf.name);
  }

  const deployResp = await cfFetchRaw(
    account,
    `/accounts/${account.account_id}/pages/projects/${name}/deployments`,
    encryptionKey,
    { method: 'POST', body: formData },
  );
  const result = await deployResp.json();
  if (!deployResp.ok) throw new Error(`Pages deploy failed: ${JSON.stringify(result)}`);
  return result;
}
