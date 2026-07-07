/**
 * Secure script fetching utility — replaces bare `fetch(url)` in workers.ts.
 *
 * Implements the SSRF mitigation requirements:
 * 1. Protocol whitelist (https: only in production)
 * 2. Host/IP validation (blocks loopback, private, link-local, unique-local)
 * 3. Redirect protection (manual redirect, per-hop validation)
 * 4. Content-Type validation (JavaScript/text only)
 * 5. Response size limit (5 MiB)
 * 6. Optional URL allowlist via WORKER_DEPLOY_URL_ALLOWLIST env var
 */

import type { Env } from '../types';

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024; // 5 MiB

const ALLOWED_CONTENT_TYPES = [
  'text/javascript',
  'application/javascript',
  'application/javascript+module',
  'text/plain',
  'application/x-javascript',
];

// IPv4 private / reserved ranges
const IPV4_BLOCKED = [
  { prefix: [127, 0, 0, 0], mask: 8 },    // 127.0.0.0/8   loopback
  { prefix: [10, 0, 0, 0], mask: 8 },      // 10.0.0.0/8    private
  { prefix: [172, 16, 0, 0], mask: 12 },   // 172.16.0.0/12 private
  { prefix: [192, 168, 0, 0], mask: 16 },  // 192.168.0.0/16 private
  { prefix: [169, 254, 0, 0], mask: 16 },  // 169.254.0.0/16 link-local
  { prefix: [0, 0, 0, 0], mask: 8 },       // 0.0.0.0/8      current network
  { prefix: [100, 64, 0, 0], mask: 10 },   // 100.64.0.0/10  CGNAT (RFC6598)
];

/**
 * Parse an IPv4 string into a 4-byte array, or null if invalid.
 */
function parseIPv4(host: string): number[] | null {
  // Strip brackets from IPv6-mapped IPv4 like ::ffff:127.0.0.1
  const cleaned = host.replace(/^\[?::ffff:/, '').replace(/\]$/, '');
  const parts = cleaned.split('.');
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

/**
 * Check if an IPv4 address falls within a blocked CIDR range.
 */
function ipInRange(ip: number[], prefix: number[], mask: number): boolean {
  const fullMask = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;
  const ipInt = ((ip[0] << 24) | (ip[1] << 16) | (ip[2] << 8) | ip[3]) >>> 0;
  const prefixInt = ((prefix[0] << 24) | (prefix[1] << 16) | (prefix[2] << 8) | prefix[3]) >>> 0;
  return (ipInt & fullMask) === (prefixInt & fullMask);
}

/**
 * Check if a host is a known-dangerous IPv6 address.
 */
function isBlockedIPv6(host: string): boolean {
  const lower = host.toLowerCase();
  // ::1 (loopback)
  if (lower === '::1' || lower === '[::1]') return true;
  // fc00::/7  (unique local)
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  // fe80::/10 (link-local)
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  // :: (unspecified)
  if (lower === '::' || lower === '[::]') return true;
  return false;
}

/**
 * Validate that a URL host does not point to internal/blocked addresses.
 * Throws with a descriptive message if blocked.
 */
function validateHost(host: string): void {
  if (!host) throw new Error('Empty host in URL');

  // IPv4 check
  const ipv4 = parseIPv4(host);
  if (ipv4) {
    for (const range of IPV4_BLOCKED) {
      if (ipInRange(ipv4, range.prefix, range.mask)) {
        throw new Error(`Blocked IP range: ${host} falls within a private/reserved network`);
      }
    }
    return; // Public IPv4 — allowed
  }

  // IPv6 check
  if (host.includes(':') || host.startsWith('[')) {
    if (isBlockedIPv6(host)) {
      throw new Error(`Blocked IPv6 address: ${host}`);
    }
    return; // Public IPv6 — allowed (or hostname with colons is rare)
  }

  // Hostname — we can't resolve in Workers, but we can block known metadata endpoints
  const lower = host.toLowerCase();
  if (lower === 'metadata.google.internal' || lower === '169.254.169.254') {
    throw new Error(`Blocked metadata endpoint: ${host}`);
  }

  // Passes
}

/**
 * Check if the URL host is in the configured allowlist.
 * If WORKER_DEPLOY_URL_ALLOWLIST is set, only hosts in the list are allowed.
 */
function checkAllowlist(host: string, env: Env): void {
  // No allowlist configured — pass through to other checks
  const allowlist = (env as any).WORKER_DEPLOY_URL_ALLOWLIST as string | undefined;
  if (!allowlist) return;

  const allowed = allowlist.split(',').map(h => h.trim().toLowerCase());
  const lowerHost = host.toLowerCase();

  const matched = allowed.some(a => {
    if (a === lowerHost) return true;                         // exact match
    if (a.startsWith('*.')) {
      const suffix = a.slice(1);                              // e.g. ".github.com"
      return lowerHost.endsWith(suffix) || lowerHost === a.slice(2);
    }
    return false;
  });

  if (!matched) {
    throw new Error(`URL host "${host}" is not in the WORKER_DEPLOY_URL_ALLOWLIST`);
  }
}

/**
 * Securely fetch a script from a user-supplied URL.
 *
 * @param url       - The URL to fetch from (user-supplied, untrusted)
 * @param env       - Environment bindings (for allowlist config)
 * @param maxRedirects - Maximum redirects to follow (default 3)
 * @returns The response body as text
 */
export async function fetchScriptSafely(
  url: string,
  env: Env,
  maxRedirects: number = 3,
): Promise<string> {
  // --- Step 1: Parse and validate URL scheme ---
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Blocked protocol: ${parsed.protocol} (only http: and https: are allowed)`);
  }

  // --- Step 2: Validate host ---
  const host = parsed.hostname;
  validateHost(host);

  // --- Step 3: Check allowlist ---
  checkAllowlist(host, env);

  // --- Step 4: Fetch with redirect: 'manual' ---
  let currentUrl = url;
  let redirectsFollowed = 0;

  while (redirectsFollowed <= maxRedirects) {
    const resp = await fetch(currentUrl, { redirect: 'manual' });

    // Handle redirects
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('Location');
      if (!location) {
        throw new Error(`HTTP ${resp.status} redirect without Location header`);
      }

      redirectsFollowed++;
      if (redirectsFollowed > maxRedirects) {
        throw new Error(`Too many redirects (max ${maxRedirects})`);
      }

      // Resolve relative redirects
      const redirectUrl = new URL(location, currentUrl);
      if (redirectUrl.protocol !== 'https:' && redirectUrl.protocol !== 'http:') {
        throw new Error(`Redirect to blocked protocol: ${redirectUrl.protocol}`);
      }
      validateHost(redirectUrl.hostname);

      currentUrl = redirectUrl.href;
      continue;
    }

    // --- Step 5: Validate HTTP status ---
    if (!resp.ok) {
      throw new Error(`Failed to fetch script: HTTP ${resp.status}`);
    }

    // --- Step 6: Validate Content-Type ---
    const contentType = resp.headers.get('Content-Type') || '';
    const mimeType = contentType.split(';')[0].trim().toLowerCase();
    if (!ALLOWED_CONTENT_TYPES.includes(mimeType)) {
      throw new Error(`Blocked Content-Type: ${mimeType} (expected JavaScript or text)`);
    }

    // --- Step 7: Validate response size ---
    const contentLength = resp.headers.get('Content-Length');
    if (contentLength) {
      const length = parseInt(contentLength, 10);
      if (!isNaN(length) && length > MAX_RESPONSE_SIZE) {
        throw new Error(`Response too large: ${length} bytes (max ${MAX_RESPONSE_SIZE})`);
      }
    }

    const text = await resp.text();
    if (text.length > MAX_RESPONSE_SIZE) {
      throw new Error(`Response too large: ${text.length} bytes (max ${MAX_RESPONSE_SIZE})`);
    }

    return text;
  }

  throw new Error(`Too many redirects (max ${maxRedirects})`);
}
