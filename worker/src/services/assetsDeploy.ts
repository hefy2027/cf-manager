import type { Account } from '../db/models';
import { cfFetch, cfFetchRaw } from './cfApi';
import { computeStaticAssetHash, extractZipFiles, uint8ToBase64 } from './staticAssets';

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

// 三阶段上传之：manifest 会话 → base64 multipart 逐文件上传 → 取 completion jwt。
async function deployWorkerAssets(
  account: Account, encryptionKey: string, scriptName: string,
  files: Array<{ path: string; buffer: Uint8Array }>,
): Promise<{ jwt: string }> {
  const accountId = account.account_id;
  const sessionResp: any = await cfFetch(account, `/accounts/${accountId}/workers/scripts/${scriptName}/assets-upload-session`, encryptionKey, {
    method: 'POST', body: JSON.stringify({ manifest: await buildAssetsManifest(files) }),
  });
  const uploadJwt: string = sessionResp?.result?.jwt;
  if (!uploadJwt) throw new Error(`assets-upload-session failed: ${JSON.stringify(sessionResp)}`);

  const upForm = new FormData();
  for (const f of files) {
    const hash = await computeStaticAssetHash(f.buffer, f.path);
    upForm.append(hash, new Blob([uint8ToBase64(f.buffer)], { type: 'application/octet-stream' }), hash);
  }
  const upResp = await fetch(`${CF_API_BASE}/accounts/${accountId}/workers/assets/upload?base64=true`, {
    method: 'POST', headers: { Authorization: `Bearer ${uploadJwt}` }, body: upForm,
  });
  if (!upResp.ok) { const txt = await upResp.text(); throw new Error(`assets upload failed: ${upResp.status} ${txt}`); }
  const upJson = await upResp.json() as any;
  const completionJwt: string = upJson.jwt ?? upJson.result?.jwt;
  if (!completionJwt) throw new Error(`assets upload missing jwt: ${JSON.stringify(upJson)}`);
  return { jwt: completionJwt };
}

// 对称于 backend workerService.deployWorker：PUT worker.js + 可选 assets（三阶段注入 ASSETS 绑定）。
export async function deployWorker(
  account: Account, encryptionKey: string, name: string, content: Uint8Array,
  options?: { bindings?: any[]; env?: Record<string, string>; assets?: any; assetsBuffer?: Uint8Array },
): Promise<void> {
  const accountId = account.account_id;
  const metadata: Record<string, unknown> = {
    main_module: 'worker.js', compatibility_date: '2024-01-01',
    bindings: options?.bindings || [],
  };
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
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('worker.js', new Blob([content], { type: 'application/javascript+module' }), 'worker.js');
  const resp = await cfFetchRaw(account, `/accounts/${accountId}/workers/scripts/${name}`, encryptionKey, { method: 'PUT', body: form });
  if (!resp.ok) { const errBody = await resp.text(); throw new Error(`Worker 部署失败 (${resp.status}): ${errBody}`); }
  // 启用 workers.dev 子域，使 Worker 立即可访问（与 backend deployWorker 行为一致）
  try {
    await cfFetch(account, `/accounts/${accountId}/workers/scripts/${name}/subdomain`, encryptionKey, {
      method: 'POST', body: JSON.stringify({ enabled: true, previews_enabled: true }),
    });
  } catch (_) { /* soft fail */ }
}
