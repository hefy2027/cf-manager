import type { Account } from '../db/models';
import { cfFetch, cfFetchRaw } from './cfApi';
import { computeStaticAssetHash, extractZipFiles, uint8ToBase64 } from './staticAssets';

// 递归展开 error.cause 链，拼出完整原因。fetch 失败时顶层 message 常为 "fetch failed"，
// 真正原因（ECONNRESET / ETIMEDOUT / ENOTFOUND / certificate ...）藏在 err.cause 里。
export function describeError(err: any): string {
  const parts: string[] = [];
  let cur: any = err;
  const seen = new Set<any>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const seg = [cur.code, cur.message].filter(Boolean).join(' ');
    if (seg && !parts.includes(seg)) parts.push(seg);
    cur = cur.cause;
  }
  return parts.join(' <- ') || String(err);
}



// 推断多模块入口文件名（对称于 backend resolveMainModule）
function resolveMainModule(modules: Array<{ path: string; buffer: Uint8Array }> | null, explicit?: string): string {
  if (explicit) return explicit;
  if (!modules || modules.length === 0) return 'worker.js';
  const conf = modules.find(m => /^wrangler\.(toml|jsonc|json)$/i.test(m.path));
  if (conf) {
    const txt = new TextDecoder().decode(conf.buffer);
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

const CF_API_BASE = 'https://api.cloudflare.com/client/v4';

// 构造 Workers Assets manifest：路径以 "/" 开头，hash 与 backend workerService.computeStaticAssetHash 一致。
export async function buildAssetsManifest(
  files: Array<{ path: string; buffer: Uint8Array }>,
): Promise<Record<string, { hash: string; size: number }>> {
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const f of files) {
    const key = '/' + f.path.replace(/\\/g, '/').replace(/^\/+/, '');
    manifest[key] = { hash: await computeStaticAssetHash(f.buffer, f.path), size: f.buffer.length };
  }
  return manifest;
}

// 三阶段上传之：manifest 会话 → 按 buckets 分批 base64 multipart 上传 → 取 completion jwt。
// buckets 为空时所有资源已存在，sessionJwt 即为 completion token，跳过上传阶段。
async function deployWorkerAssets(
  account: Account, encryptionKey: string, scriptName: string,
  files: Array<{ path: string; buffer: Uint8Array }>,
): Promise<{ jwt: string }> {
  const accountId = account.account_id;
  const manifest = await buildAssetsManifest(files);
  // 预计算 hash → buffer 映射，用于按 buckets 选择性上传
  const hashToBuffer = new Map<string, Uint8Array>();
  for (const f of files) {
    const hash = await computeStaticAssetHash(f.buffer, f.path);
    if (!hashToBuffer.has(hash)) hashToBuffer.set(hash, f.buffer);
  }
  const sessionResp: any = await cfFetch(account, `/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`, encryptionKey, {
    method: 'POST', body: JSON.stringify({ manifest }), headers: { 'User-Agent': 'wrangler/4.112.0' },
  });
  const sessionJwt: string | undefined = sessionResp?.result?.jwt;
  const buckets: string[][] = sessionResp?.result?.buckets || [];
  if (!sessionJwt) {
    throw new Error(`assets-upload-session failed: success=${sessionResp?.success} hasJwt=${!!sessionJwt} body=${JSON.stringify(sessionResp).slice(0, 500)}`);
  }

  // buckets 为空 → 所有资源已存在，sessionJwt 即为 completion token，直接返回（跳过上传）
  if (buckets.length === 0) {
    console.log(`[Worker Assets] All ${files.length} assets already uploaded, using completion JWT directly`);
    return { jwt: sessionJwt };
  }

  // 按 buckets 分批上传：每个 bucket 是一批需要一起上传的 hash 列表
  const totalHashes = buckets.reduce((n, b) => n + b.length, 0);
  console.log(`[Worker Assets] Uploading ${totalHashes} assets in ${buckets.length} bucket(s)`);
  let completionJwt: string | undefined;
  for (let bi = 0; bi < buckets.length; bi++) {
    const bucket = buckets[bi];
    const upForm = new FormData();
    for (const hash of bucket) {
      const buf = hashToBuffer.get(hash);
      if (!buf) { console.warn(`[Worker Assets] Hash ${hash} not found in local files, skipping`); continue; }
      upForm.append(hash, new Blob([uint8ToBase64(buf)], { type: 'application/octet-stream' }), hash);
    }
    const upResp = await fetch(`${CF_API_BASE}/accounts/${accountId}/workers/assets/upload?base64=true`, {
      method: 'POST', headers: { Authorization: `Bearer ${sessionJwt}`, 'User-Agent': 'wrangler/4.112.0' }, body: upForm,
    });
    if (!upResp.ok) { const txt = await upResp.text(); throw new Error(`assets upload failed (bucket ${bi + 1}/${buckets.length}): ${upResp.status} ${txt} (uploadJwtLen=${sessionJwt!.length})`); }
    const upJson = await upResp.json() as any;
    completionJwt = upJson.jwt ?? upJson.result?.jwt;
  }
  if (!completionJwt) throw new Error(`assets upload response missing completion jwt`);
  return { jwt: completionJwt };
}

// 对称于 backend workerService.deployWorker：PUT worker.js（或 packageZip 多模块）+ 可选 assets（三阶段注入 ASSETS 绑定）。
export async function deployWorker(
  account: Account, encryptionKey: string, name: string, content: Uint8Array,
  options?: { bindings?: any[]; env?: Record<string, string>; assets?: any; assetsBuffer?: Uint8Array; packageZip?: Uint8Array; mainModule?: string; compatibilityDate?: string; compatibilityFlags?: string[]; traces?: boolean; logs?: boolean },
): Promise<void> {
  const accountId = account.account_id;
  // 多模块：若提供 packageZip，本地解压为多个模块文件（与 wrangler 行为一致）。
  const moduleParts = options?.packageZip ? await extractZipFiles(options.packageZip) : null;
  const mainModule = resolveMainModule(moduleParts, options?.mainModule);

  // 推断需要的兼容性标志：含 CJS 互操作（__commonJS/require）或访问 process/Buffer/node:
  // 构建产物（如 React Router v7 on Workers）必须开启 nodejs_compat，否则运行时抛异常（Error 1101）。
  const flags = new Set<string>(options?.compatibilityFlags || []);
  const probe = (buf: Uint8Array | string) => {
    const s = typeof buf === 'string' ? buf : new TextDecoder().decode(buf);
    // process\. 捕获 process.env / process.platform / process.versions 等所有 process 访问；
    // global\.process 捕获打包器生成的 global.process 互操作。这些在未开启 nodejs_compat 时会抛 ReferenceError。
    return /__commonJS|function __require|\brequire\(|from ["']node:|\bprocess\.|globalThis\.process|global\.process|\bBuffer\.|node:async_hooks/.test(s);
  };
  let needsNodeCompat = false;
  if (moduleParts && moduleParts.length > 0) {
    needsNodeCompat = moduleParts.some(m => probe(m.buffer));
  } else if (content && content.length > 0) {
    needsNodeCompat = probe(content);
  }
  if (needsNodeCompat) flags.add('nodejs_compat');

  const metadata: Record<string, unknown> = {
    main_module: moduleParts && moduleParts.length > 0 ? mainModule : 'worker.js',
    compatibility_date: options?.compatibilityDate || '2024-11-01',
    bindings: options?.bindings || [],
  };
  if (flags.size > 0) metadata.compatibility_flags = [...flags];

  // Workers 跟踪 / 日志开关（缺省均开启，与 store 部署一致）。
  // 注意：Cloudflare 不会从上传脚本的 metadata 读取 observability，必须等脚本上传成功后
  // 通过独立的 settings/observability 端点设置（见下方上传成功后的调用）。
  const tracesEnabled = options?.traces !== false;   // Workers 跟踪
  const logsEnabled = options?.logs !== false;        // Workers 日志

  if (options?.env) {
    metadata.bindings = [
      ...(options.bindings || []),
      ...Object.entries(options.env).map(([k, v]) => ({ type: 'plain_text', name: k, text: v })),
    ];
  }
  if (options?.assets) {
    let assetContent: Uint8Array;
    if (options.assetsBuffer) {
      assetContent = options.assetsBuffer;
    } else {
      const r = await fetch(options.assets.source.url);
      assetContent = new Uint8Array(await r.arrayBuffer());
    }
    const assetFiles = options.assets.source.kind === 'raw'
      ? [{ path: options.assets.source.url.split('/').pop() || 'asset', buffer: assetContent }]
      : await extractZipFiles(assetContent);
    const { jwt } = await deployWorkerAssets(account, encryptionKey, name, assetFiles);
    metadata.assets = { jwt, config: options.assets.config || undefined };
    metadata.bindings = [...(metadata.bindings as any[]), { name: options.assets.binding || 'ASSETS', type: 'assets' }];
  }
  // 多模块 zip（如 React Router on Workers）解压出的每个文件都要作为 Worker 模块上传：
  // index.js 入口会 import assets/*.js 等代码分片，必须随脚本一起上传，否则 CF 报 "No such module"。
  // 静态资源（assets 绑定）由上面的 deployWorkerAssets 单独上传，是两条独立通道，不要在此排除 assets/。
  const moduleFiles = moduleParts;

  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  if (moduleFiles && moduleFiles.length > 0) {
    if (!moduleFiles.some(m => m.path === mainModule)) {
      throw new Error(`main_module "${mainModule}" 未在 zip 模块中找到（已包含: ${moduleFiles.map(m => m.path).join(', ')}）`);
    }
    for (const m of moduleFiles) {
      const isJs = /\.(m?js|cjs)$/i.test(m.path);
      form.append(m.path, new Blob([m.buffer], { type: isJs ? 'application/javascript+module' : 'application/octet-stream' }), m.path);
    }
  } else {
    form.append('worker.js', new Blob([content], { type: 'application/javascript+module' }), 'worker.js');
  }
  let resp: any;
  try {
    resp = await cfFetchRaw(account, `/accounts/${accountId}/workers/scripts/${name}`, encryptionKey, { method: 'PUT', body: form });
  } catch (err: any) {
    throw new Error(`worker-script-upload failed: ${describeError(err)}`);
  }
  if (!resp.ok) { const errBody = await resp.text(); throw new Error(`Worker 部署失败 (${resp.status}): ${errBody}`); }

  // 设置可观测性（Workers 跟踪 + 日志）。Cloudflare 不读取上传 metadata 中的 observability，
  // 必须通过独立的 PATCH script-settings 端点设置（observability 作为嵌套字段）；脚本上传成功后再调用。
  // 两者都关闭时跳过调用，避免无谓的 API 请求（及账户无权限时的报错）。
  if (tracesEnabled || logsEnabled) {
    // 顶层 enabled 是总开关，任一子项开启都必须为 true；traces/logs 需作为独立子对象发送。
    const obsBody: Record<string, unknown> = { enabled: true, head_sampling_rate: 1 };
    if (tracesEnabled) obsBody.traces = { enabled: true, persist: true, head_sampling_rate: 1 };
    if (logsEnabled) obsBody.logs = { enabled: true, persist: true, invocation_logs: true, head_sampling_rate: 1 };
    await cfFetch(account, `/accounts/${accountId}/workers/scripts/${name}/script-settings`, encryptionKey, {
      method: 'PATCH', body: JSON.stringify({ observability: obsBody }),
    });
  }

  // 从 PUT 响应中提取 version_id（版本化 API 下需要用它创建 deployment）
  // 注意：result.id 是脚本名（如 "smail"），不是 version_id，不能用作回退
  let versionId: string | undefined;
  try {
    const respJson = await resp.json() as any;
    versionId = respJson?.result?.version_id || respJson?.result?.version?.id;
  } catch { /* 响应非 JSON，跳过 */ }

  // 启用 workers.dev 子域，使 Worker 立即可访问（与 backend deployWorker 行为一致）
  try {
    await cfFetch(account, `/accounts/${accountId}/workers/scripts/${name}/subdomain`, encryptionKey, {
      method: 'POST', body: JSON.stringify({ enabled: true, previews_enabled: true }),
    });
  } catch (_) { /* soft fail */ }

  // 创建 deployment：版本化 API 下 PUT 只创建版本不部署，必须显式创建 deployment 才能上线。
  // 经典 API 下 PUT 已直接部署，createDeployment 仅用于版本追踪（非必需）。
  // 必须有 version_id 才能创建 deployment，否则 API 报 versions:[] 无效。
  try {
    // 若 PUT 响应未携带 version_id，查询版本列表获取最新版本 ID
    if (!versionId) {
      try {
        const versionsResp = await cfFetchRaw(account, `/accounts/${accountId}/workers/scripts/${name}/versions`, encryptionKey);
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
      const depResp = await cfFetchRaw(account, `/accounts/${accountId}/workers/scripts/${name}/deployments`, encryptionKey, {
        method: 'POST', body: JSON.stringify({
          strategy: 'percentage',
          versions: [{ percentage: 100, version_id: versionId }],
        }),
      });
      if (!depResp.ok) {
        const depTxt = await depResp.text();
        console.warn(`[Worker Deploy] Deployment creation failed for ${name}: ${depResp.status} ${depTxt.slice(0, 300)}`);
      }
    }
  } catch (e: any) {
    console.warn(`[Worker Deploy] Deployment creation warning for ${name}: ${e.message}`);
  }
}
