import { Account } from '../models/account';
import { getCfClient, getAuthHeaders } from './cfFactory';
import { proxyFetch, buildCurlCommand } from './proxyService';
import { fetchScriptSafely } from './ssrfGuard';
import { getAllZones } from './accountRouter';
import path from 'path';
import { File } from 'node:buffer';
import { blake3 } from 'hash-wasm';
import { appLogger } from './logger';
import AdmZip from 'adm-zip';

// Pages 项目名称校验：Cloudflare 要求 ^[a-z0-9][a-z0-9-]*$
export function validatePagesProjectName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
}

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

// 与 wrangler 同款资产哈希（@cloudflare/deploy-helpers 的 hashFile，全链路唯一使用的算法）：
//   hash = blake3(base64(content) + extension).hex().slice(0, 32)
// Cloudflare 资产存储按此算法做内容寻址，manifest 的 hash 必须与之匹配，否则运行时按 hash 取内容失败 → 404。
// async function computePageAssetHash(buffer: Buffer, filePath: string): Promise<string> {
//   const base64Contents = buffer.toString('base64');
//   const extension = path.extname(filePath).substring(1);
//   const fullHash = await blake3(Buffer.from(base64Contents + extension, 'utf8'));
//   return fullHash.slice(0, 32);
// }

// 与 wrangler (@cloudflare/deploy-helpers hashFile) 完全一致：
//   hash = blake3(base64(content) + extension).hex().slice(0, 32)
// Cloudflare 资产存储按此算法做内容寻址，manifest 的 hash 必须与之匹配，否则运行时按 hash 取内容失败 → 404。
async function computePageAssetHash(buffer: Buffer, filePath: string): Promise<string> {
  const base64Contents = buffer.toString('base64');
  const extension = path.extname(filePath).substring(1);
  const fullHash = await blake3(base64Contents + extension);
  return fullHash.slice(0, 32);
}

// Node `Buffer` is not directly assignable to the DOM `BlobPart` type under strict mode
// (its backing store is typed as `ArrayBufferLike`, which may be a `SharedArrayBuffer`).
// Copy into an ArrayBuffer-backed Uint8Array so it serializes cleanly as a binary multipart field.
function bufferToBlobPart(buf: Buffer) {
  const view = new Uint8Array(buf.byteLength);
  view.set(buf);
  return view;
}

export interface WorkerScript {
  id: string;
  name?: string;
  created_on: string;
  modified_on: string;
  etag: string;
  handlers: string[];
}

export interface DeployWorkerOptions {
  bindings?: Record<string, unknown>[];
  env?: Record<string, string>;
  compatibilityDate?: string;
  enableSubdomain?: boolean;
  createDeployment?: boolean;
  deploymentAnnotation?: Record<string, string>;
}

export interface DeployWorkerResult {
  script: any;
  subdomain?: string;
}

export interface PagesProject {
  id: string;
  name: string;
  domains: string[];
  production_branch: string;
  created_on: string;
  modified_on: string;
  deployment_count: number;
  source?: { type: string };
}

export async function listWorkers(account: Account): Promise<WorkerScript[]> {
  const accountId = account.account_id;
  if (!accountId) return [];
  const cf = getCfClient(account);
  const scripts: WorkerScript[] = [];
  for await (const script of cf.workers.scripts.list({ account_id: accountId })) {
    scripts.push(script as any);
  }
  return scripts;
}

export async function listPages(account: Account): Promise<PagesProject[]> {
  const accountId = account.account_id;
  if (!accountId) return [];
  const cf = getCfClient(account);
  const projects: PagesProject[] = [];
  for await (const project of cf.pages.projects.list({ account_id: accountId })) {
    projects.push(project as any);
  }
  return projects;
}

const CF_BASE = 'https://api.cloudflare.com/client/v4';

async function getAccountSubdomain(account: Account): Promise<string> {
  const headers = getAuthHeaders(account);
  try {
    const resp = await fetch(`${CF_BASE}/accounts/${account.account_id}/workers/subdomain`, {
      headers: { 'Content-Type': 'application/json', ...headers },
    });
    if (!resp.ok) return '';
    const json = await resp.json() as any;
    return json?.result?.subdomain || '';
  } catch {
    return '';
  }
}

export async function deployWorker(
  account: Account,
  name: string,
  scriptContent: string | Buffer,
  options?: DeployWorkerOptions,
): Promise<DeployWorkerResult> {
  const accountId = account.account_id;
  if (!accountId) throw new Error('Account ID is required');
  const cf = getCfClient(account);
  const authHeaders = getAuthHeaders(account);

  // Build metadata with optional bindings and env vars
  const metadata: any = {
    main_module: 'worker.js',
    compatibility_date: options?.compatibilityDate || '2024-01-01',
  };

  if (options?.bindings?.length) {
    metadata.bindings = options.bindings;
  }

  if (options?.env) {
    metadata.bindings = [
      ...(metadata.bindings || []),
      ...Object.entries(options.env).map(([k, v]) => ({ type: 'plain_text', name: k, text: v })),
    ];
  }

  // Convert content to Uint8Array for Blob (handles both string and Buffer)
  const contentBytes = typeof scriptContent === 'string'
    ? new TextEncoder().encode(scriptContent)
    : new Uint8Array(scriptContent);

  // Use raw fetch + FormData (same as Cloudflare wrangler does)
  // The SDK's scripts.update can mangle the multipart form in some versions
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.js', new Blob([contentBytes], { type: 'application/javascript+module' }), 'worker.js');

  const resp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}`, {
    method: 'PUT',
    headers: authHeaders,
    body: form,
  });
  const respJson = await resp.json() as any;
  if (!resp.ok || !respJson.success) {
    throw new Error(`${resp.status} ${JSON.stringify(respJson)}`);
  }

  // Enable workers.dev subdomain so the Worker is accessible immediately
  let subdomain: string | undefined;
  const shouldEnableSubdomain = options?.enableSubdomain !== false; // default true
  if (shouldEnableSubdomain) {
    try {
      await cf.workers.scripts.subdomain.create(name, { account_id: accountId, enabled: true, previews_enabled: true } as any);
    } catch (_) {
      // Soft fail: user can still enable manually from settings drawer
    }

    // Get account-level subdomain for URL construction
    subdomain = await getAccountSubdomain(account);
  }

  // Create deployment (for version tracking)
  if (options?.createDeployment) {
    try {
      await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/deployments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ annotations: options.deploymentAnnotation || {} }),
      });
    } catch (e: any) {
      appLogger.warn(`[Worker Deploy] Deployment creation warning for ${name}: ${e.message}`);
    }
  }

  return { script: respJson.result, subdomain };
}

// Deploy worker from URL: fetch JS from remote URL then upload
export async function deployWorkerFromUrl(
  account: Account, name: string, url: string, options?: DeployWorkerOptions,
): Promise<DeployWorkerResult> {
  const scriptContent = await fetchScriptSafely(url);
  return deployWorker(account, name, scriptContent, options);
}

export async function deleteWorker(account: Account, name: string): Promise<void> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  await cf.workers.scripts.delete(name, { account_id: accountId! } as any);
}

export async function deletePagesProject(account: Account, name: string): Promise<void> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  await cf.pages.projects.delete(name, { account_id: accountId! } as any);
}

export async function getWorkerLogs(account: Account, name: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const result = await cf.workers.scripts.tail.get(name, { account_id: accountId! } as any);
  return result;
}

// ============ Worker Settings ============

// --- Secrets ---
export async function listSecrets(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const secrets: any[] = [];
  for await (const s of cf.workers.scripts.secrets.list(scriptName, { account_id: accountId! })) {
    secrets.push(s);
  }
  return secrets;
}

export async function updateSecret(account: Account, scriptName: string, secretName: string, type: string, text?: string, keyBase64?: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const params: any = { account_id: accountId!, name: secretName, type };
  if (type === 'secret_text') params.text = text;
  if (type === 'secret_key') params.key_base64 = keyBase64;
  return await cf.workers.scripts.secrets.update(scriptName, params);
}

export async function deleteSecret(account: Account, scriptName: string, secretName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.secrets.delete(scriptName, secretName, { account_id: accountId! });
}

// --- Cron Schedules ---
export async function getSchedules(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.schedules.get(scriptName, { account_id: accountId! });
}

export async function updateSchedules(account: Account, scriptName: string, crons: string[]): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.schedules.update(scriptName, {
    account_id: accountId!,
    body: crons.map(c => ({ cron: c })),
  });
}

// --- Custom Domains ---
export async function listDomains(account: Account, serviceName?: string): Promise<any[]> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const domains: any[] = [];
  const params: any = { account_id: accountId! };
  if (serviceName) params.service = serviceName;
  for await (const d of cf.workers.domains.list(params)) {
    domains.push(d);
  }
  return domains;
}

export async function createDomain(account: Account, hostname: string, service: string, environment?: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const params: any = { account_id: accountId!, hostname, service };
  if (environment) params.environment = environment;
  return await cf.workers.domains.update(params);
}

export async function deleteDomain(account: Account, domainId: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.domains.delete(domainId, { account_id: accountId! });
}

// --- Subdomain (workers.dev) ---
export async function getSubdomain(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.subdomain.get(scriptName, { account_id: accountId! });
}

export async function setSubdomain(account: Account, scriptName: string, enabled: boolean): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.subdomain.create(scriptName, { account_id: accountId!, enabled });
}

// --- Script Settings ---
export async function getScriptSettings(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.settings.get(scriptName, { account_id: accountId! });
}

export async function updateScriptSettings(account: Account, scriptName: string, settings: any): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.settings.edit(scriptName, { account_id: accountId!, ...settings });
}

// --- Routes ---
export async function listRoutes(account: Account, zoneId: string): Promise<any[]> {
  const cf = getCfClient(account);
  const routes: any[] = [];
  for await (const r of cf.workers.routes.list({ zone_id: zoneId })) {
    routes.push(r);
  }
  return routes;
}

export async function createRoute(account: Account, zoneId: string, pattern: string, script?: string): Promise<any> {
  const cf = getCfClient(account);
  return await cf.workers.routes.create({ zone_id: zoneId, pattern, script });
}

export async function deleteRoute(account: Account, zoneId: string, routeId: string): Promise<any> {
  const cf = getCfClient(account);
  return await cf.workers.routes.delete(routeId, { zone_id: zoneId });
}

// --- Script Content ---
// Cloudflare GET /accounts/{id}/workers/scripts/{name} 返回 multipart/form-data，
// 真正的脚本内容在 `worker.js` 字段里。SDK 拿到的就是原始 multipart body，
// 这里用原生 fetch + 自写解析器抠出 worker.js。
export async function getScriptContent(account: Account, scriptName: string): Promise<string> {
  const accountId = account.account_id;
  if (!accountId) throw new Error('Account ID is required');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`;
  const resp = await fetch(url, { headers: { ...getAuthHeaders(account), Accept: '*/*' } });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to fetch script content: ${resp.status} ${text.slice(0, 200)}`);
  }
  const contentType = resp.headers.get('content-type') || '';
  const buf = Buffer.from(await resp.arrayBuffer());
  // 如果不是 multipart，直接当文本返回（兼容未来 CF 改为纯文本的情况）
  if (!/multipart\/form-data/i.test(contentType)) {
    return buf.toString('utf-8');
  }
  // 解析 multipart：取 boundary，按 boundary 切片，每段查找 Content-Disposition 含 worker.js 的
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) return buf.toString('utf-8');
  const delim = Buffer.from(`--${boundary}`);
  const start = buf.indexOf(delim);
  if (start < 0) return buf.toString('utf-8');
  const parts: Buffer[] = [];
  let pos = start;
  while (pos < buf.length) {
    const next = buf.indexOf(delim, pos + delim.length);
    const seg = next < 0 ? buf.subarray(pos + delim.length) : buf.subarray(pos + delim.length, next);
    if (seg.length > 0) parts.push(seg);
    if (next < 0) break;
    pos = next;
  }
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const headers = part.subarray(0, headerEnd).toString('utf-8');
    if (!/name="worker\.js"/i.test(headers)) continue;
    // body 是 headerEnd+4 到末尾，去掉尾部 \r\n
    let body = part.subarray(headerEnd + 4);
    if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
      body = body.subarray(0, body.length - 2);
    }
    return body.toString('utf-8');
  }
  return buf.toString('utf-8');
}

// --- Deployments ---
export async function listDeployments(account: Account, scriptName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.workers.scripts.deployments.list(scriptName, { account_id: accountId! });
}

// ============ Pages Settings ============

export async function getPagesProject(account: Account, projectName: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.pages.projects.get(projectName, { account_id: accountId! });
}

export async function editPagesProject(account: Account, projectName: string, params: any): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  return await cf.pages.projects.edit(projectName, { account_id: accountId!, ...params });
}

export async function listPagesDomains(account: Account, projectName: string): Promise<any[]> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const domains: any[] = [];
  for await (const d of cf.pages.projects.domains.list(projectName, { account_id: accountId! })) {
    domains.push(d);
  }
  return domains;
}

export async function addPagesDomain(account: Account, projectName: string, hostname: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);

  // 1. Get Pages project info to find the real subdomain
  let pagesSubdomain: string;
  try {
    const projectInfo = await cf.pages.projects.get(projectName, { account_id: accountId! }) as any;
    // Real subdomain format: {projectName}.{accountSubdomain}.pages.dev
    pagesSubdomain = projectInfo.subdomain || `${projectName}.pages.dev`;
    appLogger.info(`[Pages Domain] Real subdomain: ${pagesSubdomain}`);
  } catch (e) {
    // Fallback to old format if API fails
    pagesSubdomain = `${projectName}.pages.dev`;
    appLogger.warn(`[Pages Domain] Failed to get project info, using fallback: ${pagesSubdomain}`);
  }

  // 2. Create the Pages domain association
  const result = await cf.pages.projects.domains.create(projectName, { account_id: accountId!, name: hostname });

  // 3. Automatically create CNAME DNS record if zone is in the same account
  try {
    const allZones = await getAllZones();
    const accountZones = allZones.filter(z => z.cfAccountId === account.id);
    const matchingZone = accountZones.find((z: any) => hostname.endsWith('.' + z.name) || hostname === z.name);

    if (matchingZone) {
      const existing: any[] = [];
      for await (const r of cf.dns.records.list({ zone_id: matchingZone.id, type: 'CNAME', name: { exact: hostname } })) {
        existing.push(r);
      }

      if (existing.length === 0) {
        await cf.dns.records.create({
          zone_id: matchingZone.id,
          type: 'CNAME',
          name: hostname,
          content: pagesSubdomain,
          proxied: true,
          ttl: 1,
        } as any);
        appLogger.info(`[Pages Domain] Created CNAME: ${hostname} → ${pagesSubdomain} (proxied)`);
      } else {
        appLogger.info(`[Pages Domain] CNAME already exists for ${hostname}, skipping`);
      }
    } else {
      appLogger.warn(`[Pages Domain] No matching zone found for ${hostname}, DNS record not created`);
    }
  } catch (dnsErr) {
    appLogger.error(`[Pages Domain] Failed to create DNS record: ${dnsErr}`);
  }

  return result;
}

export async function removePagesDomain(account: Account, projectName: string, hostname: string): Promise<any> {
  const accountId = account.account_id;
  const cf = getCfClient(account);

  // 1. Remove the Pages domain association
  const result = await cf.pages.projects.domains.delete(projectName, hostname, { account_id: accountId! });

  // 2. Clean up CNAME DNS record
  try {
    const allZones = await getAllZones();
    const accountZones = allZones.filter(z => z.cfAccountId === account.id);
    const matchingZone = accountZones.find((z: any) => hostname.endsWith('.' + z.name) || hostname === z.name);
    if (matchingZone) {
      const records: any[] = [];
      for await (const r of cf.dns.records.list({ zone_id: matchingZone.id, type: 'CNAME', name: { exact: hostname } })) {
        records.push(r);
      }
      for (const r of records) {
        if (r.content?.endsWith('.pages.dev')) {
          await cf.dns.records.delete(r.id, { zone_id: matchingZone.id });
          appLogger.info(`[Pages Domain] Deleted CNAME: ${hostname} → ${r.content}`);
        }
      }
    }
  } catch (dnsErr) {
    appLogger.error(`[Pages Domain] Failed to delete DNS record: ${dnsErr}`);
  }

  return result;
}

export async function listPagesDeployments(account: Account, projectName: string): Promise<any[]> {
  const accountId = account.account_id;
  const cf = getCfClient(account);
  const deps: any[] = [];
  for await (const d of cf.pages.projects.deployments.list(projectName, { account_id: accountId! })) {
    deps.push(d);
  }
  return deps;
}

// ============ Cloudflare Resources (for Pages bindings) ============
export async function listKvNamespaces(account: Account): Promise<any[]> {
  const cf = getCfClient(account);
  const items: any[] = [];
  for await (const ns of cf.kv.namespaces.list({ account_id: account.account_id! })) {
    items.push(ns);
  }
  return items;
}

export async function listD1Databases(account: Account): Promise<any[]> {
  const cf = getCfClient(account);
  const items: any[] = [];
  for await (const db of cf.d1.database.list({ account_id: account.account_id! })) {
    items.push(db);
  }
  return items;
}

export async function listR2Buckets(account: Account): Promise<any[]> {
  const cf = getCfClient(account);
  const resp: any = await cf.r2.buckets.list({ account_id: account.account_id! });
  return resp?.buckets || [];
}

// Update Pages project bindings via deployment_configs
export async function updatePagesBindings(account: Account, projectName: string, deploymentConfigs: any): Promise<any> {
  return await editPagesProject(account, projectName, { deployment_configs: deploymentConfigs });
}

// ============ Workers Usage (GraphQL) ============
export interface WorkersUsage {
  requests: number;
  errors: number;
  subrequests: number;
  cpuTimeMs: number;
}

function getTodayMidnightUTC(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export async function getWorkersUsageToday(account: Account): Promise<WorkersUsage> {
  const accountId = account.account_id;
  if (!accountId) return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };

  const now = new Date();
  const todayDate = now.toISOString().substring(0, 10);
  const datetimeStart = getTodayMidnightUTC();
  const datetimeEnd = now.toISOString();

  const query = `
    query CfWorkersUsage($accountTag: string!, $datetimeStart: Time!, $datetimeEnd: Time!, $todayDate: Date!) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          workers: workersInvocationsAdaptive(
            filter: {
              datetime_geq: $datetimeStart,
              datetime_leq: $datetimeEnd
            }
            limit: 10000
          ) {
            sum {
              requests
              errors
              subrequests
              cpuTimeUs
            }
          }
          pages: pagesFunctionsInvocationsAdaptiveGroups(
            filter: {
              date: $todayDate
            }
            limit: 1
          ) {
            sum {
              requests
              errors
            }
          }
        }
      }
    }
  `;

  const headers = getAuthHeaders(account);
  const fetchUrl = 'https://api.cloudflare.com/client/v4/graphql';
  const fetchInit = {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { accountTag: accountId, datetimeStart, datetimeEnd, todayDate },
    }),
  };
  let resp;
  try {
    resp = await proxyFetch(fetchUrl, fetchInit);
  } catch (e) {
    appLogger.error(`[Workers Usage] Fetch failed for ${account.name}: ${e}\n[DEBUG curl] ${buildCurlCommand(fetchUrl, fetchInit)}`);
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  }

  if (!resp.ok) {
    const text = await resp.text();
    appLogger.error(`[GraphQL] Workers usage query failed: ${resp.status} ${text}\n[DEBUG curl] ${buildCurlCommand(fetchUrl, fetchInit)}`);
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  }

  const json = await resp.json() as any;
  if (json.errors) {
    appLogger.error(`[GraphQL] Errors: ${JSON.stringify(json.errors)}`);
    return { requests: 0, errors: 0, subrequests: 0, cpuTimeMs: 0 };
  }

  const acct = json?.data?.viewer?.accounts?.[0];
  const workerRecords = acct?.workers || [];
  const pagesRecords = acct?.pages || [];

  let totalRequests = 0, totalErrors = 0, totalSubrequests = 0, totalCpuUs = 0;
  for (const rec of workerRecords) {
    const s = rec.sum || {};
    totalRequests += s.requests || 0;
    totalErrors += s.errors || 0;
    totalSubrequests += s.subrequests || 0;
    totalCpuUs += s.cpuTimeUs || 0;
  }
  for (const rec of pagesRecords) {
    const s = rec.sum || {};
    totalRequests += s.requests || 0;
    totalErrors += s.errors || 0;
  }

  return {
    requests: totalRequests,
    errors: totalErrors,
    subrequests: totalSubrequests,
    cpuTimeMs: Math.round(totalCpuUs / 1000),
  };
}

// 确保 Pages 项目存在，已存在时忽略 409 错误
export async function ensurePagesProject(account: Account, projectName: string): Promise<void> {
  const accountId = account.account_id;
  if (!accountId) throw new Error('Account ID is required');
  const cf = getCfClient(account);
  try {
    await cf.pages.projects.create({ account_id: accountId, name: projectName, production_branch: 'main' } as any);
  } catch (e: any) {
    if (e?.status !== 409) throw e;  // 409 = already exists, ignore
  }
}

// ============ Pages 部署：wrangler 四步上传法 ============
export async function deployPages(
  account: Account,
  projectName: string,
  files: Array<{ path: string; buffer: Buffer }>,
  skipCreateProject = false,
): Promise<any> {
  const accountId = account.account_id;
  if (!accountId) throw new Error('Account ID is required');

  const authHeaders = getAuthHeaders(account);
  const cf = getCfClient(account);

  if (!skipCreateProject) {
    await ensurePagesProject(account, projectName);
  }

  if (!files || files.length === 0) {
    appLogger.info(`[Pages Deploy V2] Created empty project: ${projectName}`);
    return await cf.pages.projects.get(projectName, { account_id: accountId! });
  }

  // 特殊文件：不进 manifest，作为 multipart 字段随 deployment 请求上传（与 wrangler 一致）
  const SPECIAL_FILES = new Set([
    '_worker.js', '_worker.bundle', '_headers', '_redirects', '_routes.json',
    'functions-filepath-routing-config.json',
  ]);

  const normalizedFiles = files.map(f => ({
    ...f,
    path: f.path.replace(/\\/g, '/').replace(/^\/+/, ''),
  }));

  const specialFiles: Array<{ path: string; buffer: Buffer }> = [];
  const assetFiles: Array<{ path: string; buffer: Buffer }> = [];

  for (const f of normalizedFiles) {
    const basename = f.path.split('/').pop() || f.path;
    if (!f.path.includes('/') && SPECIAL_FILES.has(basename)) {
      specialFiles.push(f);
    } else {
      assetFiles.push(f);
    }
  }

  appLogger.info(`[Pages Deploy V2] Total: ${files.length} files | Assets: ${assetFiles.length} | Special: ${specialFiles.length}`);

  // ---- Step 1: 获取 upload JWT ----
  // wrangler: fetchResult(`/accounts/${accountId}/pages/projects/${projectName}/upload-token`)
  appLogger.info(`[Pages Deploy V2] Step 1: Fetching upload JWT...`);
  let jwt: string;
  {
    const resp = await proxyFetch(`${CF_BASE}/accounts/${accountId}/pages/projects/${projectName}/upload-token`, {
      method: 'GET',
      headers: { ...authHeaders },
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`[Pages Deploy V2] Failed to get upload token: ${resp.status} ${text}`);
    }
    const json = await resp.json();
    jwt = json?.result?.jwt;
    if (!jwt) throw new Error(`[Pages Deploy V2] Upload token response missing jwt: ${JSON.stringify(json)}`);
  }
  appLogger.info(`[Pages Deploy V2] Got upload JWT`);

  // ---- Step 2: 计算 hash + check-missing ----
  // wrangler: validate() 计算 hash → upload() 内部先 check-missing
  appLogger.info(`[Pages Deploy V2] Step 2: Computing hashes & checking missing assets...`);
  const manifest: Record<string, string> = {};
  const hashToFile = new Map<string, { buffer: Buffer; contentType: string }>();

  for (const f of assetFiles) {
    const manifestKey = '/' + f.path; // wrangler manifest key 以 / 开头
    const hash = await computePageAssetHash(f.buffer, f.path);
    manifest[manifestKey] = hash;
    // 同 hash 的文件只上传一次（内容寻址去重）
    if (!hashToFile.has(hash)) {
      hashToFile.set(hash, { buffer: f.buffer, contentType: getContentType(f.path) });
    }
  }

  const allHashes = [...hashToFile.keys()];
  appLogger.info(`[Pages Deploy V2] Manifest: ${Object.keys(manifest).length} entries, unique hashes: ${allHashes.length}`);

  let missingHashes: string[];
  {
    const resp = await proxyFetch(`${CF_BASE}/pages/assets/check-missing`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${jwt}`,
      },
      body: JSON.stringify({ hashes: allHashes }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`[Pages Deploy V2] check-missing failed: ${resp.status} ${text}`);
    }
    const json = await resp.json();
    missingHashes = json.result || [];
  }
  appLogger.info(`[Pages Deploy V2] Missing assets: ${missingHashes.length}/${allHashes.length} (need upload)`);

  // ---- Step 3: 上传缺失的资源 ----
  // wrangler: POST /pages/assets/upload, body = [{ key: hash, value: base64(content), metadata: { contentType }, base64: true }]
  // 分批上传，每批不超过 50 个文件或 ~20MB（wrangler 用 bucket 策略 + 并发 3，这里简化为顺序分批）
  if (missingHashes.length > 0) {
    appLogger.info(`[Pages Deploy V2] Step 3: Uploading ${missingHashes.length} missing assets...`);
    const BATCH_SIZE = 50;
    const BATCH_BYTES = 20 * 1024 * 1024;

    for (let i = 0; i < missingHashes.length; i += BATCH_SIZE) {
      const batch = missingHashes.slice(i, i + BATCH_SIZE);
      const payload: Array<{ key: string; value: string; metadata: { contentType: string }; base64: boolean }> = [];
      let batchBytes = 0;

      for (const hash of batch) {
        const fileInfo = hashToFile.get(hash);
        if (!fileInfo) continue;
        const base64Content = fileInfo.buffer.toString('base64');
        batchBytes += base64Content.length;
        payload.push({
          key: hash,
          value: base64Content,
          metadata: { contentType: fileInfo.contentType },
          base64: true,
        });
      }

      appLogger.info(`[Pages Deploy V2] Uploading batch ${Math.floor(i / BATCH_SIZE) + 1}: ${payload.length} files, ~${Math.round(batchBytes / 1024)}KB`);

      const resp = await proxyFetch(`${CF_BASE}/pages/assets/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
        },
        body: JSON.stringify(payload),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`[Pages Deploy V2] Asset upload failed (batch ${Math.floor(i / BATCH_SIZE) + 1}): ${resp.status} ${text}`);
      }

      // 超过单批大小限制时提前进入下一批（防止 payload 过大）
      if (batchBytes >= BATCH_BYTES) {
        appLogger.info(`[Pages Deploy V2] Batch exceeded ${BATCH_BYTES / 1024 / 1024}MB limit, continuing to next batch`);
      }
    }

    // upsert-hashes：注册已上传的 hash，加速下次部署（非致命，失败仅告警）
    // wrangler: POST /pages/assets/upsert-hashes, body = { hashes: [...] }
    try {
      await proxyFetch(`${CF_BASE}/pages/assets/upsert-hashes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
        },
        body: JSON.stringify({ hashes: allHashes }),
      });
    } catch (e: any) {
      appLogger.warn(`[Pages Deploy V2] upsert-hashes failed (non-fatal): ${e.message}`);
    }
  }

  // ---- Step 4: 创建 deployment ----
  // wrangler: POST /accounts/{accountId}/pages/projects/{projectName}/deployments
  // FormData: manifest(JSON string) + branch + commit_message + commit_hash + commit_dirty + [特殊文件]
  // 注意：普通资源文件不在此请求中，它们已通过 /pages/assets/upload 上传
  appLogger.info(`[Pages Deploy V2] Step 4: Creating deployment...`);
  const formData = new FormData();
  formData.append('manifest', JSON.stringify(manifest));
  formData.append('branch', 'main');
  formData.append('commit_message', 'Deploy via CF Manager');
  formData.append('commit_hash', 'direct-upload');
  formData.append('commit_dirty', 'false');

  for (const f of specialFiles) {
    const basename = f.path.split('/').pop() || f.path;
    formData.append(basename, new File([bufferToBlobPart(f.buffer)], basename, { type: getContentType(f.path) }));
    appLogger.info(`[Pages Deploy V2] Special file: ${basename} (${f.buffer.length} bytes)`);
  }

  appLogger.info(`[Pages Deploy V2] POST deployments | manifest: ${Object.keys(manifest).length} entries | special: ${specialFiles.length}`);
  // FormData 请求使用原生 fetch（与 deployWorker 一致，避免 node-fetch v2 对原生 FormData 的兼容问题）
  const deployResp = await fetch(`${CF_BASE}/accounts/${accountId}/pages/projects/${projectName}/deployments`, {
    method: 'POST',
    headers: { ...authHeaders },
    body: formData,
  });
  const deployJson = await deployResp.json() as any;
  if (!deployResp.ok || !deployJson.success) {
    throw new Error(`[Pages Deploy V2] Deployment failed: ${deployResp.status} ${JSON.stringify(deployJson)}`);
  }

  const depResult = deployJson.result;
  appLogger.info(`[Pages Deploy V2] Deployment created: ${depResult?.url || '(no url)'}`);
  appLogger.info(`[Pages Deploy V2] Deployment env: ${depResult?.environment} | id: ${depResult?.id}`);
  return depResult;
}
