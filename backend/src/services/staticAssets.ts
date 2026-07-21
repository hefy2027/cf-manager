import path from 'path';
import { blake3 } from 'hash-wasm';
import AdmZip from 'adm-zip';

// 从 zip buffer 解压文件，自动检测并剥离公共顶层目录前缀。
// 例如所有条目都在 dist/ 下时，返回的 path 会去掉 dist/ 前缀。
export function extractZipFiles(zipBuffer: Buffer): Array<{ path: string; buffer: Buffer }> {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter(e => !e.isDirectory);
  const filePaths = entries.map(e => e.entryName.replace(/\\/g, '/'));

  // 检测公共前缀
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

  const files: Array<{ path: string; buffer: Buffer }> = [];
  for (const entry of entries) {
    const p = entry.entryName.replace(/\\/g, '/');
    const finalPath = prefix ? p.slice(prefix.length) : p;
    if (finalPath) { // 跳过空路径（如前缀目录本身）
      files.push({ path: finalPath, buffer: entry.getData() });
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

// 与 wrangler (@cloudflare/deploy-helpers hashFile) 完全一致：
//   hash = blake3(base64(content) + extension).hex().slice(0, 32)
// Cloudflare 资产存储按此算法做内容寻址，manifest 的 hash 必须与之匹配，否则运行时按 hash 取内容失败 → 404。
// 此函数同时供 Pages 资产与 Worker with Assets 使用。
export async function computeStaticAssetHash(buffer: Buffer, filePath: string): Promise<string> {
  const base64Contents = buffer.toString('base64');
  const extension = path.extname(filePath).substring(1);
  const fullHash = await blake3(base64Contents + extension);
  return fullHash.slice(0, 32);
}
