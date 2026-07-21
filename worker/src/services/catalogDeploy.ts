import type { Account } from '../db/models';
import { cfFetch, cfFetchRaw, cfFetchAll } from './cfApi';
import type { CatalogTemplate, CatalogBinding } from './catalogValidator';
import { deployPages, extractZipFiles, validatePagesProjectName, ensurePagesProject } from './pagesDeploy';
import { deployWorker } from './assetsDeploy';
import { addAuditLog } from '../db/models';

export interface DeployOptions {
  account: Account;
  encryptionKey: string;
  template: CatalogTemplate;
  name: string;              // Worker/Pages name
  bindingSelections: Record<string, { mode: 'auto' | 'existing'; existingId?: string; runInitSql?: boolean }>;
  secretValues: Record<string, string>;  // for var/prompt bindings
  db?: D1Database;           // for audit log
  deployType?: 'worker' | 'pages' | 'both';
  traces?: boolean;          // Workers 跟踪（默认开启）
  logs?: boolean;            // Workers 日志（默认开启）
}

interface ResolvedBinding {
  type: string;
  name: string;
  // CF API binding format
  cfBinding: Record<string, unknown>;
  // Rollback info
  created: boolean;
  resourceType?: 'kv' | 'd1' | 'r2';
  resourceId?: string;
}

interface DeployResult {
  success: boolean;
  error?: string;
  warnings: string[];
  url?: string;
  bindings: ResolvedBinding[];
  rolledBack?: boolean;
  rollbackErrors?: string[];
}

const MAX_DOWNLOAD = 50 * 1024 * 1024; // 50MB

async function downloadArtifact(url: string, type: 'worker' | 'pages'): Promise<{ content: Uint8Array; contentType: string }> {
  const resp = await fetch(url, { redirect: 'follow' });
  if (!resp.ok) throw new Error(`产物下载失败: HTTP ${resp.status}`);

  const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_DOWNLOAD) throw new Error('产物超过 50MB 限制');

  const buffer = new Uint8Array(await resp.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD) throw new Error('产物超过 50MB 限制');

  // Content type validation
  if (type === 'worker') {
    // 允许 zip：多模块 Worker 产物是压缩包，由 deployWorker 本地解包上传（与 backend 对称）
    const firstBytes = buffer.slice(0, 4);
    const isZip = firstBytes[0] === 0x50 && firstBytes[1] === 0x4b; // PK
    if (isZip) console.log(`[Store] Worker 产物为 zip，将按多模块方式解包上传`);
  } else {
    // Pages should be zip
    const firstBytes = buffer.slice(0, 4);
    const isZip = firstBytes[0] === 0x50 && firstBytes[1] === 0x4b; // PK
    if (!isZip) throw new Error('Pages 产物应是 zip，但下载内容不是 zip 格式');
  }

  return { content: buffer, contentType: resp.headers.get('content-type') || 'application/octet-stream' };
}

async function resolveBinding(
  account: Account,
  encryptionKey: string,
  binding: CatalogBinding,
  selection: { mode: 'auto' | 'existing'; existingId?: string; runInitSql?: boolean } | undefined,
  templateId: string,
): Promise<ResolvedBinding> {
  const title = binding.title || `${templateId}-${binding.name.toLowerCase()}`;
  const sel = selection || { mode: 'auto' };

  if (binding.type === 'ai') {
    return { type: 'ai', name: binding.name, cfBinding: { type: 'ai', name: binding.name }, created: false };
  }

  if (binding.type === 'var') {
    // secret !== false → 加密 secret_text；secret === false → 明文 plain_text
    const isSecret = binding.secret !== false;
    // 使用模板中定义的 value 作为默认值（适用于 action:create-or-reuse 或 prompt 的兇底默认值）
    const text = binding.value || '';
    return {
      type: 'var',
      name: binding.name,
      cfBinding: isSecret
        ? { type: 'secret_text', name: binding.name, text }
        : { type: 'plain_text', name: binding.name, text },
      created: false,
    };
  }

  if (binding.type === 'kv') {
    if (sel.mode === 'existing' && sel.existingId) {
      return { type: 'kv', name: binding.name, cfBinding: { type: 'kv_namespace', name: binding.name, namespace_id: sel.existingId }, created: false, resourceType: 'kv', resourceId: sel.existingId };
    }
    // Auto: list → find by title → reuse or create
    const list = await cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/storage/kv/namespaces`, encryptionKey);
    const found = (list.result || []).find(ns => ns.title === title);
    if (found) {
      return { type: 'kv', name: binding.name, cfBinding: { type: 'kv_namespace', name: binding.name, namespace_id: found.id }, created: false, resourceType: 'kv', resourceId: found.id };
    }
    const created = await cfFetch(account, `/accounts/${account.account_id}/storage/kv/namespaces`, encryptionKey, {
      method: 'POST', body: JSON.stringify({ title }),
    });
    const nsId = (created as any).result?.uuid || (created as any).result?.id;
    return { type: 'kv', name: binding.name, cfBinding: { type: 'kv_namespace', name: binding.name, namespace_id: nsId }, created: true, resourceType: 'kv', resourceId: nsId };
  }

  if (binding.type === 'd1') {
    if (sel.mode === 'existing' && sel.existingId) {
      // Existing D1 — check if user wants to run init SQL
      if ((sel.runInitSql) && (binding.initSqlUrl || binding.initSql)) {
        await executeInitSql(account, encryptionKey, sel.existingId, binding);
      }
      return { type: 'd1', name: binding.name, cfBinding: { type: 'd1', name: binding.name, id: sel.existingId }, created: false, resourceType: 'd1', resourceId: sel.existingId };
    }
    // Auto: list → find by title → reuse or create
    const list = await cfFetch<{ result: any[] }>(account, `/accounts/${account.account_id}/d1/database`, encryptionKey);
    const found = (list.result || []).find(db => db.name === title);
    if (found) {
      // Reuse — run init SQL only if user explicitly checked
      if (sel.runInitSql && (binding.initSqlUrl || binding.initSql)) {
        await executeInitSql(account, encryptionKey, found.uuid, binding);
      }
      return { type: 'd1', name: binding.name, cfBinding: { type: 'd1', name: binding.name, id: found.uuid }, created: false, resourceType: 'd1', resourceId: found.uuid };
    }
    // Create new
    const created = await cfFetch(account, `/accounts/${account.account_id}/d1/database`, encryptionKey, {
      method: 'POST', body: JSON.stringify({ name: title }),
    });
    const dbId = (created as any).result?.uuid;
    // New D1 — run init SQL by default (unless user unchecked)
    if (sel.runInitSql !== false && (binding.initSqlUrl || binding.initSql)) {
      await executeInitSql(account, encryptionKey, dbId, binding);
    }
    return { type: 'd1', name: binding.name, cfBinding: { type: 'd1', name: binding.name, id: dbId }, created: true, resourceType: 'd1', resourceId: dbId };
  }

  if (binding.type === 'r2') {
    if (sel.mode === 'existing' && sel.existingId) {
      return { type: 'r2', name: binding.name, cfBinding: { type: 'r2_bucket', name: binding.name, bucket_name: sel.existingId }, created: false, resourceType: 'r2', resourceId: sel.existingId };
    }
    // Auto: list → find by title → reuse or create
    let buckets: any[] = [];
    try {
      const list = await cfFetch<{ result: any }>(account, `/accounts/${account.account_id}/r2/buckets`, encryptionKey);
      buckets = (list.result?.buckets) || [];
    } catch { buckets = []; }
    const found = buckets.find(b => b.name === title);
    if (found) {
      return { type: 'r2', name: binding.name, cfBinding: { type: 'r2_bucket', name: binding.name, bucket_name: found.name }, created: false, resourceType: 'r2', resourceId: found.name };
    }
    await cfFetch(account, `/accounts/${account.account_id}/r2/buckets`, encryptionKey, {
      method: 'POST', body: JSON.stringify({ name: title }),
    });
    return { type: 'r2', name: binding.name, cfBinding: { type: 'r2_bucket', name: binding.name, bucket_name: title }, created: true, resourceType: 'r2', resourceId: title };
  }

  throw new Error(`Unknown binding type: ${binding.type}`);
}

async function executeInitSql(account: Account, encryptionKey: string, dbId: string, binding: CatalogBinding): Promise<void> {
  let sql = binding.initSql;
  if (!sql && binding.initSqlUrl) {
    const resp = await fetch(binding.initSqlUrl);
    if (!resp.ok) throw new Error(`initSqlUrl 下载失败: ${resp.status}`);
    sql = await resp.text();
  }
  if (!sql) return;
  // Execute SQL via D1 query API
  await cfFetch(account, `/accounts/${account.account_id}/d1/database/${dbId}/query`, encryptionKey, {
    method: 'POST', body: JSON.stringify({ sql }),
  });
}

async function rollback(account: Account, encryptionKey: string, bindings: ResolvedBinding[], workerName?: string, deleteWorker: boolean = true): Promise<string[]> {
  const errors: string[] = [];
  // Delete created resources in reverse order
  for (const b of [...bindings].reverse()) {
    if (!b.created || !b.resourceType || !b.resourceId) continue;
    try {
      if (b.resourceType === 'kv') {
        await cfFetch(account, `/accounts/${account.account_id}/storage/kv/namespaces/${b.resourceId}`, encryptionKey, { method: 'DELETE' });
      } else if (b.resourceType === 'd1') {
        await cfFetch(account, `/accounts/${account.account_id}/d1/database/${b.resourceId}`, encryptionKey, { method: 'DELETE' });
      } else if (b.resourceType === 'r2') {
        await cfFetch(account, `/accounts/${account.account_id}/r2/buckets/${b.resourceId}`, encryptionKey, { method: 'DELETE' });
      }
    } catch (e: any) {
      errors.push(`${b.resourceType}:${b.resourceId} - ${e.message}`);
    }
  }
  // 仅当 Worker 本身未成功部署时才删除；hybrid 若只是 Pages 环节失败，已部署的 Worker 应保留
  if (workerName && deleteWorker) {
    try {
      await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${workerName}`, encryptionKey, { method: 'DELETE' });
    } catch {}
  }
  return errors;
}

// 获取账号的 Worker 子域，用于拼接部署后的 Worker URL
async function getWorkerSubdomain(account: Account, encryptionKey: string): Promise<string | null> {
  try {
    const r: any = await cfFetch(account, `/accounts/${account.account_id}/workers/subdomain`, encryptionKey);
    return r?.result?.subdomain || null;
  } catch { return null; }
}

export async function deployTemplate(opts: DeployOptions): Promise<DeployResult> {
  const { account, encryptionKey, template, name, bindingSelections, secretValues, deployType, traces, logs } = opts;
  if (!validatePagesProjectName(name)) {
    return { success: false, error: '项目名只能包含小写字母、数字和连字符，且以字母或数字开头', warnings: [], bindings: [] };
  }
  const warnings: string[] = [];
  const resolvedBindings: ResolvedBinding[] = [];
  const urls: string[] = [];
  let workerDeployed = false;

  try {
    // Step 1: Resolve bindings (once, shared between worker & pages)
    for (const binding of (template.bindings || [])) {
      const selection = bindingSelections[binding.name];
      const resolved = await resolveBinding(account, encryptionKey, binding, selection, template.id);
      // Fill in secret values for var bindings
      if (binding.type === 'var' && binding.action === 'prompt') {
        const val = secretValues[binding.name] || binding.value || '';
        if (binding.required && !val) throw new Error(`必填项 ${binding.name} 未填写`);
        resolved.cfBinding.text = val;
      }
      resolvedBindings.push(resolved);
    }

    // Step 2: Determine what to deploy
    const doWorker = template.type === 'worker'
      || (template.type === 'hybrid' && (deployType === 'worker' || deployType === 'both' || !deployType));
    const doPages = template.type === 'pages'
      || (template.type === 'hybrid' && (deployType === 'pages' || deployType === 'both'));

    // Step 3: Deploy worker
    if (doWorker) {
      const src = template.type === 'hybrid' ? template.sources?.worker : template.source;
      if (!src) throw new Error('No worker source configured');
      const { content } = await downloadArtifact(src.url, 'worker');
      const isZip = content[0] === 0x50 && content[1] === 0x4b;
      await deployWorker(account, encryptionKey, name, isZip ? new Uint8Array(0) : content, {
        ...(isZip ? { packageZip: content } : {}),
        ...(src?.mainModule ? { mainModule: src.mainModule } : {}),
        bindings: resolvedBindings.map(b => b.cfBinding),
        env: template.env,
        ...(template.compatibility_date ? { compatibilityDate: template.compatibility_date } : {}),
        ...(template.compatibility_flags?.length ? { compatibilityFlags: template.compatibility_flags } : {}),
        assets: template.assets,
        traces: traces !== false,
        logs: logs !== false,
      });
      const sub = await getWorkerSubdomain(account, encryptionKey);
      urls.push(sub ? `https://${name}.${sub}.workers.dev` : `https://${name}.workers.dev`);
      workerDeployed = true;

      // 注册 Cron Triggers（仅 Worker 脚本支持）
      if (template.crons && template.crons.length > 0) {
        try {
          await cfFetch(account, `/accounts/${account.account_id}/workers/scripts/${name}/schedules`, encryptionKey, {
            method: 'PUT', body: JSON.stringify(template.crons.map((cron: string) => ({ cron }))),
          });
          console.log(`[Store] Cron triggers set for ${name}: ${template.crons.join(', ')}`);
        } catch (e: any) {
          warnings.push(`定时任务注册失败: ${e.message}`);
        }
      }
    }

    // Step 4: Deploy pages
    if (doPages) {
      const src = template.type === 'hybrid' ? template.sources?.pages : template.source;
      if (!src) throw new Error('No pages source configured');
      const { content } = await downloadArtifact(src.url, 'pages');

      // Create project if not exists
      await ensurePagesProject(account, encryptionKey, name);

      // Set deployment_configs (bindings + env vars) BEFORE deploying, keep `type` for vars.
      // Only set if there's something to set (empty arrays cause API 400 errors).
      const prodConfigs: any = {};
      const previewConfigs: any = {};
      if (template.env && Object.keys(template.env).length > 0) {
        prodConfigs.env_vars = {};
        previewConfigs.env_vars = {};
        for (const [k, v] of Object.entries(template.env)) {
          prodConfigs.env_vars[k] = { value: v };
          previewConfigs.env_vars[k] = { value: v };
        }
      }
      const hasResourceBindings = resolvedBindings.some(rb => ['kv', 'd1', 'r2'].includes(rb.type));
      if (hasResourceBindings) {
        prodConfigs.kv_namespaces = []; prodConfigs.d1_databases = []; prodConfigs.r2_buckets = [];
        previewConfigs.kv_namespaces = []; previewConfigs.d1_databases = []; previewConfigs.r2_buckets = [];
      }
      for (const rb of resolvedBindings) {
        const b = rb.cfBinding as any;
        switch (rb.type) {
          case 'kv': {
            const entry = { binding: b.name, namespace_id: b.namespace_id };
            prodConfigs.kv_namespaces.push(entry); previewConfigs.kv_namespaces.push(entry);
            break;
          }
          case 'd1': {
            const entry = { binding: b.name, database_id: b.id };
            prodConfigs.d1_databases.push(entry); previewConfigs.d1_databases.push(entry);
            break;
          }
          case 'r2': {
            const entry = { binding: b.name, bucket_name: b.bucket_name };
            prodConfigs.r2_buckets.push(entry); previewConfigs.r2_buckets.push(entry);
            break;
          }
          case 'var': {
            if (!prodConfigs.env_vars) { prodConfigs.env_vars = {}; previewConfigs.env_vars = {}; }
            prodConfigs.env_vars[b.name] = { value: b.text, type: b.type };
            previewConfigs.env_vars[b.name] = { value: b.text, type: b.type };
            break;
          }
          case 'ai': {
            prodConfigs.ai = { binding: b.name };
            previewConfigs.ai = { binding: b.name };
            break;
          }
        }
      }
      const hasConfigs = Object.keys(prodConfigs).length > 0;
      if (hasConfigs) {
        try {
          await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${name}`, encryptionKey, {
            method: 'PATCH', body: JSON.stringify({ deployment_configs: { production: prodConfigs, preview: previewConfigs } }),
          });
        } catch (e: any) {
          warnings.push(`Pages deployment_configs 设置失败: ${e.message}`);
        }
      }

      // 解包 zip 后逐文件 + manifest + BLAKE3 + "/" 上传，与 backend store 机制完全一致
      const files = await extractZipFiles(content);
      await deployPages(account, encryptionKey, name, files, { skipCreateProject: true });

      // Get actual project subdomain
      try {
        const project: any = await cfFetch(account, `/accounts/${account.account_id}/pages/projects/${name}`, encryptionKey);
        const subdomain = project?.result?.subdomain || `${name}.pages.dev`;
        urls.push(`https://${subdomain}`);
      } catch {
        urls.push(`https://${name}.pages.dev`);
      }
    }

    // Step 5: Routes (soft failure)
    if (template.routes && template.routes.length > 0) {
      for (const pattern of template.routes) {
        try {
          // Extract zone from pattern hostname
          const hostname = pattern.split('/')[0];
          const zones = await cfFetchAll<any>(account, '/zones', encryptionKey, 100);
          const zone = zones.find(z => z.name === hostname || hostname.endsWith('.' + z.name));
          if (!zone) {
            warnings.push(`路由 ${pattern} 创建失败: 未找到 zone ${hostname}`);
            continue;
          }
          await cfFetch(account, `/zones/${zone.id}/workers/routes`, encryptionKey, {
            method: 'POST', body: JSON.stringify({ pattern, script: name }),
          });
        } catch (e: any) {
          warnings.push(`路由 ${pattern} 创建失败: ${e.message}`);
        }
      }
    }

    // Step 6: Done
    if (opts.db) {
      await addAuditLog(opts.db, {
        account_id: account.id, action: 'store_deploy', target: name,
        detail: `template: ${template.id}`, status: 'success',
      });
    }

    const url = urls.join(' | ') || (template.type === 'pages' ? `https://${name}.pages.dev` : `https://${name}.workers.dev`);
    return { success: true, warnings, bindings: resolvedBindings, url };

  } catch (e: any) {
    // 展开 error.cause 链，避免 undici/cfFetch 抛的裸 "fetch failed" 吞掉真实原因
    let cur: any = e; const chain: string[] = []; const seen = new Set<any>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const seg = [cur.code, cur.message].filter(Boolean).join(' ');
      if (seg && !chain.includes(seg)) chain.push(seg);
      cur = cur.cause;
    }
    const detail = chain.join(' <- ') || String(e);
    console.error(`[Store] Deploy failed for ${name} (${template.id}): ${detail}`);
    // Hard failure — rollback only the parts that were NOT successfully deployed
    // (hybrid: if only Pages failed, the already-deployed Worker must be preserved)
    const rollbackErrors = await rollback(account, encryptionKey, resolvedBindings, name, !workerDeployed);
    if (opts.db) {
      await addAuditLog(opts.db, {
        account_id: account.id, action: 'store_deploy', target: name,
        detail: `error: ${detail}`, status: 'error',
      });
    }
    return {
      success: false, error: detail, warnings, bindings: resolvedBindings,
      rolledBack: true, rollbackErrors: rollbackErrors.length > 0 ? rollbackErrors : undefined,
    };
  }
}
