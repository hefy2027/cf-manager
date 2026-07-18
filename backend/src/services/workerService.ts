import { Account } from '../models/account';
import { getCfClient, getAuthHeaders } from './cfFactory';
import { proxyFetch, buildCurlCommand } from './proxyService';
import { fetchScriptSafely } from './ssrfGuard';
import { getAllZones } from './accountRouter';
import path from 'path';
import { File } from 'node:buffer';
import { appLogger } from './logger';
import { computeStaticAssetHash, getContentType, extractZipFiles } from './staticAssets';
export { extractZipFiles };

// Pages 项目名称校验：Cloudflare 要求 ^[a-z0-9][a-z0-9-]*$
export function validatePagesProjectName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(name);
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
  compatibilityFlags?: string[];
  enableSubdomain?: boolean;
  createDeployment?: boolean;
  deploymentAnnotation?: Record<string, string>;
}


// Worker with Assets 的静态资源来源（复用 catalog 的 #/$defs/source 形态）。
export interface WorkerAssetsInput {
  source: { kind: string; url: string; assetName?: string; subPath?: string };
  binding?: string;
  config?: { html_handling?: string; not_found_handling?: string };
}



// 构造 Workers Assets manifest：路径以 "/" 开头，hash 与后端/Worker 资产算法一致。
export async function buildAssetsManifest(
  files: Array<{ path: string; buffer: Buffer }>,
): Promise<Record<string, { hash: string; size: number }>> {
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const f of files) {
    const key = '/' + f.path.replace(/\\/g, '/').replace(/^\/+/, '');
    manifest[key] = { hash: await computeStaticAssetHash(f.buffer, f.path), size: f.buffer.length };
  }
  return manifest;
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

// 三阶段上传 Worker 静态资源（与 wrangler 同款）：
//   1) POST .../assets-upload-session 提交 manifest → 返回 { jwt, buckets }
//      - buckets 非空：jwt 是 upload token，需按 buckets 分批上传缺失文件
//      - buckets 为空：所有资源已存在，jwt 直接就是 completion token，跳过阶段 2
//   2) POST .../workers/assets/upload?base64=true 按 bucket 分批 multipart 上传（field=hash, value=base64）
//   3) 返回 completion jwt，挂到 metadata.assets.jwt
async function deployWorkerAssets(
  account: Account,
  scriptName: string,
  files: Array<{ path: string; buffer: Buffer }>,
): Promise<{ jwt: string }> {
  const authHeaders = getAuthHeaders(account);
  const accountId = account.account_id!;

  // 预计算 hash → buffer 映射，用于按 buckets 选择性上传
  const manifest = await buildAssetsManifest(files);
  const hashToBuffer = new Map<string, Buffer>();
  for (const f of files) {
    const hash = await computeStaticAssetHash(f.buffer, f.path);
    if (!hashToBuffer.has(hash)) hashToBuffer.set(hash, f.buffer);
  }

  const sessionResp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ manifest }),
  });
  const sessionJson = await sessionResp.json() as any;
  const sessionJwt: string | undefined = sessionJson?.result?.jwt;
  const buckets: string[][] = sessionJson?.result?.buckets || [];
  if (!sessionResp.ok || !sessionJson?.success || !sessionJwt) {
    throw new Error(
      `assets-upload-session failed: status=${sessionResp.status} success=${sessionJson?.success} ` +
      `hasJwt=${!!sessionJwt} errors=${JSON.stringify(sessionJson?.errors || sessionJson?.messages || '').slice(0, 400)}`,
    );
  }

  // buckets 为空 → 所有资源已存在，sessionJwt 即为 completion token，直接返回（跳过上传）
  if (buckets.length === 0) {
    appLogger.info(`[Worker Assets] All ${files.length} assets already uploaded, using completion JWT directly`);
    return { jwt: sessionJwt };
  }

  // 按 buckets 分批上传：每个 bucket 是一批需要一起上传的 hash 列表
  const totalHashes = buckets.reduce((n, b) => n + b.length, 0);
  appLogger.info(`[Worker Assets] Uploading ${totalHashes} assets in ${buckets.length} bucket(s)`);
  let completionJwt: string | undefined;
  for (let bi = 0; bi < buckets.length; bi++) {
    const bucket = buckets[bi];
    const upForm = new FormData();
    for (const hash of bucket) {
      const buf = hashToBuffer.get(hash);
      if (!buf) {
        appLogger.warn(`[Worker Assets] Hash ${hash} not found in local files, skipping`);
        continue;
      }
      upForm.append(hash, new Blob([buf.toString('base64')], { type: 'application/octet-stream' }), hash);
    }
    const upResp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/assets/upload?base64=true`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionJwt}` },
      body: upForm,
    });
    if (!upResp.ok) {
      const txt = await upResp.text();
      throw new Error(`assets upload failed (bucket ${bi + 1}/${buckets.length}): ${upResp.status} ${txt} (uploadJwtLen=${sessionJwt.length})`);
    }
    const upJson = await upResp.json() as any;
    completionJwt = upJson.jwt ?? upJson.result?.jwt;
  }
  if (!completionJwt) throw new Error(`assets upload response missing completion jwt`);
  return { jwt: completionJwt };
}

// 下载 assets 产物（zip 或 raw 单文件），与 catalogDeploy 的 downloadArtifact 同源。
async function downloadArtifactForAssets(src: WorkerAssetsInput['source']): Promise<Buffer> {
  const resp = await proxyFetch(src.url, {}, 30000);
  if (!resp.ok) throw new Error(`assets 产物下载失败: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

// 推断多模块入口文件名：优先显式 mainModule；其次 wrangler.toml/jsonc 的 main 字段；
// 仅 1 个模块时直接用；多模块时按常见入口名优先级（worker.js → index.js/index.mjs → 根目录首个 JS）查找；最后回退 'worker.js'。
function resolveMainModule(modules: Array<{ path: string; buffer: Buffer }> | null, explicit?: string): string {
  if (explicit) return explicit;
  if (!modules || modules.length === 0) return 'worker.js';
  const conf = modules.find(m => /^wrangler\.(toml|jsonc|json)$/i.test(m.path));
  if (conf) {
    const txt = conf.buffer.toString('utf-8');
    const m = txt.match(/^\s*main\s*=\s*"([^"]+)"/m) || txt.match(/"main"\s*:\s*"([^"]+)"/m);
    if (m) return m[1].replace(/^\.\//, '');
  }
  if (modules.length === 1) return modules[0].path;
  const candidates = ['worker.js', 'index.js', 'index.mjs', 'worker.mjs', 'index.cjs', 'worker.cjs'];
  for (const c of candidates) {
    if (modules.some(m => m.path === c)) return c;
  }
  const root = modules.find(m => /^[^/\\]+\.(m?js|cjs)$/i.test(m.path));
  if (root) return root.path;
  return 'worker.js';
}

export async function deployWorker(
  account: Account,
  name: string,
  scriptContent: string | Buffer,
  options?: DeployWorkerOptions & {
    packageZip?: Buffer;        // 多模块 zip：本地解压后每个文件作为一个 files= part（与 wrangler 本地解包一致）
    mainModule?: string;        // 多模块入口文件名（默认从 zip 推断，回退 'worker.js'）
    assets?: WorkerAssetsInput;
    assetsBuffer?: Buffer;
    traces?: boolean;           // Workers 跟踪（Workers Observability，含链路追踪/指标）。默认开启
    logs?: boolean;             // Workers 日志（嵌套在 observability.logs.invocation_logs）。默认开启
  },
): Promise<DeployWorkerResult> {
  const accountId = account.account_id;
  if (!accountId) throw new Error('Account ID is required');
  const cf = getCfClient(account);
  const authHeaders = getAuthHeaders(account);

  // 多模块：若提供 packageZip，本地解压为多个模块文件（与 wrangler 行为一致）。
  const moduleParts = options?.packageZip ? extractZipFiles(options.packageZip) : null;
  const mainModule = resolveMainModule(moduleParts, options?.mainModule);

  // 推断需要的兼容性标志：含 CJS 互操作（__commonJS/require）或访问 process/Buffer/node:
  // 构建产物（如 React Router v7 on Workers）必须开启 nodejs_compat，否则运行时抛异常（Error 1101）。
  const flags = new Set<string>(options?.compatibilityFlags || []);
  const probe = (buf: Uint8Array | Buffer | string) => {
    const s = typeof buf === 'string' ? buf : Buffer.from(buf).toString('latin1');
    // process\. 捕获 process.env / process.platform / process.versions 等所有 process 访问；
    // global\.process 捕获打包器生成的 global.process 互操作。这些在未开启 nodejs_compat 时会抛 ReferenceError。
    return /__commonJS|function __require|\brequire\(|from ["']node:|\bprocess\.|globalThis\.process|global\.process|\bBuffer\.|node:async_hooks/.test(s);
  };
  let needsNodeCompat = false;
  if (moduleParts && moduleParts.length > 0) {
    needsNodeCompat = moduleParts.some(m => probe(m.buffer));
  } else if (scriptContent) {
    needsNodeCompat = probe(scriptContent);
  }
  if (needsNodeCompat) flags.add('nodejs_compat');

  // Build metadata with optional bindings and env vars
  const metadata: any = {
    main_module: moduleParts && moduleParts.length > 0 ? mainModule : 'worker.js',
    compatibility_date: options?.compatibilityDate || '2024-11-01',
  };
  if (flags.size > 0) metadata.compatibility_flags = [...flags];

  // Workers 跟踪 / 日志开关（缺省均开启，与 store 部署一致）。
  // 注意：Cloudflare 不会从上传脚本的 metadata 读取 observability，必须等脚本上传成功后
  // 通过独立的 settings/observability 端点设置（见下方提交上传后的 applyObservability）。
  const tracesEnabled = options?.traces !== false;   // Workers 跟踪
  const logsEnabled = options?.logs !== false;        // Workers 日志

  if (options?.bindings?.length) {
    metadata.bindings = options.bindings;
  }

  if (options?.env) {
    metadata.bindings = [
      ...(metadata.bindings || []),
      ...Object.entries(options.env).map(([k, v]) => ({ type: 'plain_text', name: k, text: v })),
    ];
  }

  // Worker with Assets：可选静态资源三阶段上传，并注入 ASSETS 绑定（默认 ASSETS，可覆盖）。
  if (options?.assets) {
    const assetContent: Buffer = options.assetsBuffer
      ? options.assetsBuffer
      : await downloadArtifactForAssets(options.assets.source);
    const assetFiles = options.assets.source.kind === 'raw'
      ? [{ path: options.assets.source.url.split('/').pop() || 'asset', buffer: assetContent }]
      : extractZipFiles(assetContent);
    const { jwt } = await deployWorkerAssets(account, name, assetFiles);
    metadata.assets = { jwt, config: options.assets.config || undefined };
    metadata.bindings = [...(metadata.bindings || []), { name: options.assets.binding || 'ASSETS', type: 'assets' }];
  }

  // 多模块 zip（如 React Router on Workers）解压出的每个文件都要作为 Worker 模块上传：
  // index.js 入口会 import assets/*.js 等代码分片，它们必须随脚本一起上传，否则 CF 报
  // "No such module"。注意：静态资源（assets 绑定）由下面的 deployWorkerAssets 单独上传，
  // 与这里的模块上传是两条独立通道，不要在此排除 assets/。
  const moduleFiles = moduleParts;

  // Use raw fetch + FormData (same as Cloudflare wrangler does)
  // The SDK's scripts.update can mangle the multipart form in some versions
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));

  if (moduleFiles && moduleFiles.length > 0) {
    // 多模块：zip 解压出的每个文件一个 files= part，main_module 指向入口文件
    if (!moduleFiles.some(m => m.path === mainModule)) {
      throw new Error(`main_module "${mainModule}" 未在 zip 模块中找到（已包含: ${moduleFiles.map(m => m.path).join(', ')}）`);
    }
    for (const m of moduleFiles) {
      const isJs = /\.(m?js|cjs)$/i.test(m.path);
      form.append(m.path, new Blob([bufferToBlobPart(m.buffer)], { type: isJs ? 'application/javascript+module' : 'application/octet-stream' }), m.path);
    }
  } else {
    // 单模块（默认）：兼容旧路径，脚本内容即 worker.js
    const contentBytes = typeof scriptContent === 'string'
      ? new TextEncoder().encode(scriptContent)
      : new Uint8Array(scriptContent);
    form.append('worker.js', new Blob([contentBytes], { type: 'application/javascript+module' }), 'worker.js');
  }

  const resp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}`, {
    method: 'PUT',
    headers: authHeaders,
    body: form,
  });
  const respJson = await resp.json() as any;
  if (!resp.ok || !respJson.success) {
    throw new Error(`${resp.status} ${JSON.stringify(respJson)}`);
  }

  // 设置可观测性（Workers 跟踪 + 日志）。Cloudflare 不读取上传 metadata 中的 observability，
  // 必须通过独立的 PATCH script-settings 端点设置（observability 作为嵌套字段）；脚本上传成功后再调用。
  // 两者都关闭时跳过调用，避免无谓的 API 请求（及账户无权限时的报错）。
  if (tracesEnabled || logsEnabled) {
    // 顶层 enabled 是总开关，任一子项开启都必须为 true；traces/logs 需作为独立子对象发送。
    const obsBody: Record<string, unknown> = { enabled: true, head_sampling_rate: 1 };
    if (tracesEnabled) obsBody.traces = { enabled: true, persist: true, head_sampling_rate: 1 };
    if (logsEnabled) obsBody.logs = { enabled: true, persist: true, invocation_logs: true, head_sampling_rate: 1 };
    const obsResp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/script-settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ observability: obsBody }),
    });
    if (!obsResp.ok) {
      const obsErr = await obsResp.text();
      throw new Error(`设置 Workers 可观测性失败 (${obsResp.status}): ${obsErr}`);
    }
  }

  // 从 PUT 响应中提取 version_id（版本化 API 下需要用它创建 deployment）
  // 注意：result.id 是脚本名（如 "smail"），不是 version_id，不能用作回退
  let versionId: string | undefined =
    respJson?.result?.version_id ||
    respJson?.result?.version?.id;

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

  // Create deployment：版本化 API 下 PUT 只创建版本不部署，必须显式创建 deployment 才能上线。
  // 经典 API 下 PUT 已直接部署，createDeployment 仅用于版本追踪（非必需）。
  // 必须有 version_id 才能创建 deployment，否则 API 报 versions:[] 无效。
  if (options?.createDeployment) {
    try {
      // 若 PUT 响应未携带 version_id，查询版本列表获取最新版本 ID
      if (!versionId) {
        try {
          const versionsResp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/versions`, {
            headers: authHeaders,
          });
          if (versionsResp.ok) {
            const versionsJson = await versionsResp.json() as any;
            const versions = versionsJson?.result || [];
            if (versions.length > 0) {
              versionId = versions[0]?.id; // 版本列表按 created_on 降序，首个即最新
            }
          }
        } catch {
          // 经典模式：versions 端点不可用，PUT 已直接部署
        }
      }

      // 有 version_id 才发 deployment 请求；没有则跳过（PUT 已部署，createDeployment 非必需）
      if (versionId) {
        const depResp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${name}/deployments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: JSON.stringify({
            strategy: 'percentage',
            versions: [{ percentage: 100, version_id: versionId }],
            annotations: options.deploymentAnnotation || {},
          }),
        });
        if (!depResp.ok) {
          const depTxt = await depResp.text();
          appLogger.warn(`[Worker Deploy] Deployment creation failed for ${name}: ${depResp.status} ${depTxt.slice(0, 300)}`);
        }
      }
    } catch (e: any) {
      appLogger.warn(`[Worker Deploy] Deployment creation warning for ${name}: ${e.message}`);
    }
  }

  return { script: respJson.result, subdomain };
}

// Deploy worker from URL: fetch JS from remote URL then upload
export async function deployWorkerFromUrl(
  account: Account, name: string, url: string, options?: DeployWorkerOptions & { assets?: WorkerAssetsInput; assetsBuffer?: Buffer },
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
  const raw: any = await cf.workers.scripts.subdomain.get(scriptName, { account_id: accountId! });
  // 额外拉取账户级 workers.dev 子域名，供前端拼出完整 URL：https://<script>.<accountSubdomain>.workers.dev
  const accountSubdomain = await getAccountSubdomain(account);
  const enabled = raw?.enabled;
  const previews_enabled = raw?.previews_enabled;
  const url = accountSubdomain ? `https://${scriptName}.${accountSubdomain}.workers.dev` : '';
  return { enabled, previews_enabled, accountSubdomain, url };
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
    const hash = await computeStaticAssetHash(f.buffer, f.path);
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
