// SSRF 防护：安全抓取远程脚本 / 资源，替换裸 fetch(url)。
//
// 与 Worker 端 ssrfGuard 对称，但后端运行在 Node.js，可在抓取前对域名做 DNS 解析，
// 从而真正拦截「域名 → 私网 IP」的 DNS 重绑定类 SSRF（Worker 端受运行时限制无法做到）。
//
// 防护点：
//   1. 协议白名单：仅允许 https:
//   2. 主机/IP 校验：解析域名后逐地址拒绝环回 / 私网 / 链路本地 / 唯一本地
//   3. 可选来源白名单：环境变量 WORKER_DEPLOY_URL_ALLOWLIST（逗号分隔主机名）
//   4. 重定向防护：redirect: manual，逐跳重新解析并校验 Location
//   5. Content-Type 校验：仅接受 JavaScript / 文本类型（部署脚本场景）
//   6. 响应大小限制：最大 5 MiB

import dns from 'node:dns/promises';
import net from 'node:net';

const MAX_SCRIPT_SIZE = 5 * 1024 * 1024; // 5 MiB

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 环回
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    return false;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase().split('%')[0];
    if (norm === '::1' || norm === '::') return true;
    if (norm.startsWith('fc') || norm.startsWith('fd')) return true; // fc00::/7
    if (/^fe[8-9a-b]/.test(norm)) return true; // fe80::/10
    if (norm.startsWith('::ffff:')) return isPrivateIp(norm.slice('::ffff:'.length));
    return false;
  }
  return false;
}

export function getAllowlist(): string[] | null {
  const raw = process.env.WORKER_DEPLOY_URL_ALLOWLIST;
  if (!raw) return null;
  const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : null;
}

// 解析主机并校验所有解析到的地址均非私网；IP 字面量直接校验。
async function ensureHostAllowed(host: string, allowlist: string[] | null): Promise<void> {
  if (allowlist && !allowlist.includes(host.toLowerCase())) {
    const err: any = new Error(`URL host "${host}" is not in the allowed deploy-source allowlist`);
    err.statusCode = 403;
    throw err;
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      const err: any = new Error(`URL host "${host}" is a non-public address and is blocked`);
      err.statusCode = 403;
      throw err;
    }
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch (e: any) {
    const err: any = new Error(`Failed to resolve host "${host}": ${e.message}`);
    err.statusCode = 400;
    throw err;
  }
  if (addresses.some((a) => isPrivateIp(a.address))) {
    const err: any = new Error(`URL host "${host}" resolves to a non-public address and is blocked`);
    err.statusCode = 403;
    throw err;
  }
}

const ACCEPTED_SCRIPT_CT = /^(application\/(javascript|ecmascript|x-javascript|octet-stream)|text\/)/i;

// 仅校验 URL 安全性（协议 / 私网 / 白名单），不发起请求。供需要保留原始 fetch 行为
// （etag / 自定义头部）的场景（Catalog 源拉取）作为前置校验使用。
// 后端 Docker 部署下允许 http://localhost 与 http://127.0.0.1（本地 catalog 调试），
// 但仍拦截其它私网地址。
export async function assertUrlSafe(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    const err: any = new Error('Invalid URL');
    err.statusCode = 400;
    throw err;
  }
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(isLocal && url.protocol === 'http:')) {
    const err: any = new Error('Only HTTPS (or http://localhost for dev) URLs are allowed');
    err.statusCode = 403;
    throw err;
  }
  if (isLocal) return; // 本地调试放行
  await ensureHostAllowed(url.hostname, getAllowlist());
}

// 安全抓取 Worker 脚本内容（部署场景）。返回脚本文本；不合法抛出带 statusCode 的错误。
export async function fetchScriptSafely(raw: string): Promise<string> {
  const allowlist = getAllowlist();

  let current: URL;
  try {
    current = new URL(raw);
  } catch {
    const err: any = new Error('Invalid script URL');
    err.statusCode = 400;
    throw err;
  }
  if (current.protocol !== 'https:') {
    const err: any = new Error('Only HTTPS script URLs are allowed');
    err.statusCode = 403;
    throw err;
  }
  await ensureHostAllowed(current.hostname, allowlist);

  let hops = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const resp = await fetch(current.toString(), { redirect: 'manual' } as any);
    if (resp.status === 200) {
      const ct = resp.headers.get('content-type') || '';
      if (!ACCEPTED_SCRIPT_CT.test(ct)) {
        const err: any = new Error(`Refused script with unsupported Content-Type: ${ct || '(none)'}`);
        err.statusCode = 400;
        throw err;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.byteLength > MAX_SCRIPT_SIZE) {
        const err: any = new Error('Script exceeds maximum allowed size (5 MiB)');
        err.statusCode = 413;
        throw err;
      }
      return buf.toString('utf-8');
    }

    // 重定向：逐跳重新解析并校验
    if ([301, 302, 303, 307, 308].includes(resp.status) || resp.status === 0) {
      const loc = resp.headers.get('location');
      if (!loc) {
        const err: any = new Error(`Redirect from ${current.toString()} has no Location`);
        err.statusCode = 400;
        throw err;
      }
      hops += 1;
      if (hops > 5) {
        const err: any = new Error('Too many redirects');
        err.statusCode = 400;
        throw err;
      }
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        const err: any = new Error(`Invalid redirect location: ${loc}`);
        err.statusCode = 400;
        throw err;
      }
      if (next.protocol !== 'https:') {
        const err: any = new Error('Redirect to non-HTTPS URL is blocked');
        err.statusCode = 403;
        throw err;
      }
      await ensureHostAllowed(next.hostname, allowlist);
      current = next;
      continue;
    }

    const err: any = new Error(`Failed to fetch script: HTTP ${resp.status}`);
    err.statusCode = 400;
    throw err;
  }
}
