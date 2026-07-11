// SSRF 防护：安全抓取远程脚本 / 资源，替换裸 fetch(url)。
//
// 防护点（对应 1.1.2 安全修复，并在重构丢失后恢复）：
//   1. 协议白名单：仅允许 https:
//   2. 主机/IP 校验：拒绝环回、私网、链路本地、唯一本地地址字面量
//   3. 可选来源白名单：环境变量 WORKER_DEPLOY_URL_ALLOWLIST（逗号分隔主机名）
//   4. 重定向防护：redirect: manual，逐跳校验 Location（协议 / 主机 / 私网）
//   5. Content-Type 校验：仅接受 JavaScript / 文本类型（部署脚本场景）
//   6. 响应大小限制：最大 5 MiB
//
// 注意（Cloudflare Workers 运行时限制）：运行时无法在抓取前对域名做 DNS 解析，
// 因此域名的 DNS 重绑定防护依赖「来源白名单」。若启用白名单，则只有显式允许的
// 主机可通过；未启用白名单时仅能拦截 IP 字面量形式的私网地址。生产环境强烈建议
// 配置 WORKER_DEPLOY_URL_ALLOWLIST。

const MAX_SCRIPT_SIZE = 5 * 1024 * 1024; // 5 MiB

export type SsrfGuardEnv = Record<string, any>;

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 环回
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const norm = ip.toLowerCase().split('%')[0].replace(/^\[|\]$/g, '');
  if (norm === '::1' || norm === '::' || norm === '') return true;
  if (norm.startsWith('fc') || norm.startsWith('fd')) return true; // fc00::/7 唯一本地
  if (/^fe[8-9a-b]/.test(norm)) return true; // fe80::/10 链路本地
  if (norm.startsWith('::ffff:')) return isPrivateIpv4(norm.slice('::ffff:'.length)); // IPv4 映射
  return false;
}

// 仅对 IP 字面量做私网判定；域名交给白名单 / 运行时控制（见文件头说明）。
function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIpv4(h);
  if (h.includes(':')) return isPrivateIpv6(h);
  return false;
}

function getAllowlist(env?: SsrfGuardEnv): string[] | null {
  const raw = env?.WORKER_DEPLOY_URL_ALLOWLIST;
  if (!raw) return null;
  const list = raw.split(',').map((s: string) => s.trim().toLowerCase()).filter(Boolean);
  return list.length ? list : null;
}

function ensureHostAllowed(host: string, allowlist: string[] | null): void {
  if (allowlist && !allowlist.includes(host.toLowerCase())) {
    throw Object.assign(new Error(`URL host "${host}" is not in the allowed deploy-source allowlist`), { statusCode: 403 });
  }
  if (isPrivateHost(host)) {
    throw Object.assign(new Error(`URL host "${host}" resolves to a non-public address and is blocked`), { statusCode: 403 });
  }
}

const ACCEPTED_SCRIPT_CT = /^(application\/(javascript|ecmascript|x-javascript|octet-stream)|text\/)/i;

function makeSsrfError(message: string, statusCode: number): Error {
  return Object.assign(new Error(message), { statusCode });
}

// 安全抓取 Worker 脚本内容（部署场景）。返回脚本文本；不合法直接抛带 statusCode 的错误。
export async function fetchScriptSafely(raw: string, env?: SsrfGuardEnv): Promise<string> {
  const allowlist = getAllowlist(env);

  let current: URL;
  try {
    current = new URL(raw);
  } catch {
    throw makeSsrfError('Invalid script URL', 400);
  }
  if (current.protocol !== 'https:') {
    throw makeSsrfError('Only HTTPS script URLs are allowed', 403);
  }
  ensureHostAllowed(current.hostname, allowlist);

  let hops = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const resp = await fetch(current.toString(), { redirect: 'manual' } as RequestInit);
    if (resp.status === 200) {
      const ct = resp.headers.get('content-type') || '';
      if (!ACCEPTED_SCRIPT_CT.test(ct)) {
        throw makeSsrfError(`Refused script with unsupported Content-Type: ${ct || '(none)'}`, 400);
      }
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > MAX_SCRIPT_SIZE) {
        throw makeSsrfError('Script exceeds maximum allowed size (5 MiB)', 413);
      }
      return new TextDecoder().decode(buf);
    }

    // 重定向：逐跳重新校验
    if ([301, 302, 303, 307, 308].includes(resp.status) || resp.status === 0) {
      const loc = resp.headers.get('location');
      if (!loc) throw makeSsrfError(`Redirect from ${current.toString()} has no Location`, 400);
      hops += 1;
      if (hops > 5) throw makeSsrfError('Too many redirects', 400);
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        throw makeSsrfError(`Invalid redirect location: ${loc}`, 400);
      }
      if (next.protocol !== 'https:') throw makeSsrfError('Redirect to non-HTTPS URL is blocked', 403);
      ensureHostAllowed(next.hostname, allowlist);
      current = next;
      continue;
    }

    throw makeSsrfError(`Failed to fetch script: HTTP ${resp.status}`, 400);
  }
}

// 仅校验 URL 安全性（协议 / 私网 / 白名单），不发起请求。供需要保留原始 fetch 行为
// （如 etag / 304 / 自定义头部）的场景（Catalog 源拉取）作为前置校验使用。
export function assertUrlSafe(raw: string, env?: SsrfGuardEnv): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw makeSsrfError('Invalid URL', 400);
  }
  if (url.protocol !== 'https:') {
    throw makeSsrfError('Only HTTPS URLs are allowed', 403);
  }
  ensureHostAllowed(url.hostname, getAllowlist(env));
}

// 安全抓取 Catalog 源（管理场景）。接受 JSON 类型；其余防护同 fetchScriptSafely。
export async function fetchCatalogSafely(raw: string, env?: SsrfGuardEnv, maxSize = 10 * 1024 * 1024): Promise<string> {
  const allowlist = getAllowlist(env);

  let current: URL;
  try {
    current = new URL(raw);
  } catch {
    throw makeSsrfError('Invalid catalog URL', 400);
  }
  if (current.protocol !== 'https:') {
    throw makeSsrfError('Only HTTPS catalog URLs are allowed', 403);
  }
  ensureHostAllowed(current.hostname, allowlist);

  let hops = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const resp = await fetch(current.toString(), { redirect: 'manual' } as RequestInit);
    if (resp.status === 200) {
      const ct = resp.headers.get('content-type') || '';
      if (!/^(application\/(json|octet-stream)|text\/)/i.test(ct)) {
        throw makeSsrfError(`Refused catalog with unsupported Content-Type: ${ct || '(none)'}`, 400);
      }
      const buf = await resp.arrayBuffer();
      if (buf.byteLength > maxSize) {
        throw makeSsrfError('Catalog exceeds maximum allowed size (10 MiB)', 413);
      }
      return new TextDecoder().decode(buf);
    }
    if ([301, 302, 303, 307, 308].includes(resp.status) || resp.status === 0) {
      const loc = resp.headers.get('location');
      if (!loc) throw makeSsrfError(`Redirect from ${current.toString()} has no Location`, 400);
      hops += 1;
      if (hops > 5) throw makeSsrfError('Too many redirects', 400);
      let next: URL;
      try {
        next = new URL(loc, current);
      } catch {
        throw makeSsrfError(`Invalid redirect location: ${loc}`, 400);
      }
      if (next.protocol !== 'https:') throw makeSsrfError('Redirect to non-HTTPS URL is blocked', 403);
      ensureHostAllowed(next.hostname, allowlist);
      current = next;
      continue;
    }
    throw makeSsrfError(`Failed to fetch catalog: HTTP ${resp.status}`, 400);
  }
}
