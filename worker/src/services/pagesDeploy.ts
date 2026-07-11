import type { Account } from '../db/models';
import { blake3 } from '@noble/hashes/blake3';
import { cfFetch, cfFetchRaw } from './cfApi';

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

// ============ ZIP 解包（纯 Web API，兼容 workerd，无需外部 zip 库）============
export async function extractZipFiles(zipData: Uint8Array): Promise<Array<{ path: string; buffer: Uint8Array }>> {
  const rawFiles: Array<{ path: string; buffer: Uint8Array }> = [];
  const view = new DataView(zipData.buffer, zipData.byteOffset, zipData.byteLength);

  let eocdOffset = -1;
  for (let i = zipData.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) return [];

  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdEntries = view.getUint16(eocdOffset + 10, true);
  let pos = cdOffset;

  for (let i = 0; i < cdEntries; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) break;
    const compression = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const uncompSize = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(zipData.slice(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;

    let fileData: Uint8Array;
    if (compression === 0) {
      fileData = zipData.slice(dataStart, dataStart + uncompSize);
    } else if (compression === 8) {
      const compressed = zipData.slice(dataStart, dataStart + compSize);
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      const reader = ds.readable.getReader();
      writer.write(compressed);
      writer.close();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      fileData = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { fileData.set(chunk, offset); offset += chunk.length; }
    } else {
      continue;
    }

    const cleanPath = name.replace(/\\/g, '/').replace(/^\/+/, '');
    rawFiles.push({ path: cleanPath, buffer: fileData });
  }

  // 检测并剥离公共顶层目录前缀（与 backend extractZipFiles 行为一致）
  const filePaths = rawFiles.map(f => f.path);
  let prefix = '';
  if (filePaths.length > 0) {
    const parts = filePaths[0].split('/');
    if (parts.length > 1) {
      const candidate = parts[0] + '/';
      if (filePaths.every(p => p.startsWith(candidate))) {
        prefix = candidate;
      }
    }
  }

  const files: Array<{ path: string; buffer: Uint8Array }> = [];
  for (const f of rawFiles) {
    const finalPath = prefix ? f.path.slice(prefix.length) : f.path;
    if (finalPath) {
      files.push({ path: finalPath, buffer: f.buffer });
    }
  }
  return files;
}

// MIME type lookup — 四步上传法中 contentType 作为 metadata 存入资产存储，
// Cloudflare 按此值设置响应 Content-Type。若全部返回 octet-stream → 浏览器直接下载。
function getContentType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const types: Record<string, string> = {
    html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8', mjs: 'application/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8', xml: 'application/xml; charset=utf-8',
    txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8',
    svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', ico: 'image/x-icon', webp: 'image/webp', avif: 'image/avif',
    bmp: 'image/bmp', tiff: 'image/tiff',
    woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
    eot: 'application/vnd.ms-fontobject',
    mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
    pdf: 'application/pdf', wasm: 'application/wasm',
    map: 'application/json',
  };
  return types[ext] || 'application/octet-stream';
}

// ============ BLAKE3 资产哈希（与 backend workerService.computePageAssetHash / wrangler 同款）============
//   hash = blake3(base64(content) + extension).hex().slice(0, 32)
// Cloudflare 资产存储按此算法内容寻址，必须与 backend 保持一致，否则运行时按 hash 取内容失败 → 404。

function pageAssetExtname(p: string): string {
  const base = p.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot);
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

export async function computePageAssetHash(buffer: Uint8Array, filePath: string): Promise<string> {
  const base64Contents = uint8ToBase64(buffer);
  const extension = pageAssetExtname(filePath).substring(1);
  // 纯 JS BLAKE3：输入与 backend（hash-wasm blake3）完全一致 = UTF-8(base64(content) + extension)
  const input = new TextEncoder().encode(base64Contents + extension);
  const hashBytes = blake3(input);
  // 与 backend 一致：取完整 BLAKE3 哈希的前 32 个 hex 字符（= 前 16 字节）
  return bytesToHex(hashBytes.slice(0, 16));
}

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
    const hash = await computePageAssetHash(f.buffer, f.path);
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
