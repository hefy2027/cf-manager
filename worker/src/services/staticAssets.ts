import { blake3 } from '@noble/hashes/blake3';

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
export function getContentType(filename: string): string {
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

// ============ BLAKE3 资产哈希（与 backend workerService.computeStaticAssetHash / wrangler 同款）============
//   hash = blake3(base64(content) + extension).hex().slice(0, 32)
// Cloudflare 资产存储按此算法内容寻址，必须与 backend 保持一致，否则运行时按 hash 取内容失败 → 404。

function pageAssetExtname(p: string): string {
  const base = p.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot);
}

export function uint8ToBase64(bytes: Uint8Array): string {
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

export async function computeStaticAssetHash(buffer: Uint8Array, filePath: string): Promise<string> {
  const base64Contents = uint8ToBase64(buffer);
  const extension = pageAssetExtname(filePath).substring(1);
  // 纯 JS BLAKE3：输入与 backend（hash-wasm blake3）完全一致 = UTF-8(base64(content) + extension)
  const input = new TextEncoder().encode(base64Contents + extension);
  const hashBytes = blake3(input);
  // 与 backend 一致：取完整 BLAKE3 哈希的前 32 个 hex 字符（= 前 16 字节）
  return bytesToHex(hashBytes.slice(0, 16));
}
