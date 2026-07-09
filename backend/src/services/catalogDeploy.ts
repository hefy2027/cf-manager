import { Account } from '../models/account';
import { getCfClient } from './cfFactory';
import { proxyFetch } from './proxyService';
import { createAuditLog } from '../models/auditLog';
import type { CatalogTemplate, CatalogBinding } from './catalogValidator';
import { appLogger } from './logger';
import AdmZip from 'adm-zip';
import { deployWorker, deployPages } from './workerService';

export interface DeployOptions {
  account: Account;
  template: CatalogTemplate;
  name: string;
  bindingSelections: Record<string, { mode: 'auto' | 'existing'; existingId?: string; runInitSql?: boolean }>;
  secretValues: Record<string, string>;
  deployType?: 'worker' | 'pages' | 'both';
}

interface ResolvedBinding {
  type: string;
  name: string;
  cfBinding: Record<string, unknown>;
  created: boolean;
  resourceType?: 'kv' | 'd1' | 'r2';
  resourceId?: string;
}

interface DeployResult {
  success: boolean;
  error?: string;
  warnings: string[];
  bindings: ResolvedBinding[];
  url?: string;
  rolledBack?: boolean;
  rollbackErrors?: string[];
}

const MAX_DOWNLOAD = 50 * 1024 * 1024;

async function downloadArtifact(url: string, type: 'worker' | 'pages'): Promise<Buffer> {
  const resp = await proxyFetch(url, {}, 30000);
  if (!resp.ok) throw new Error(`产物下载失败: ${resp.status}`);

  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD) throw new Error('产物超过 50MB 限制');

  if (type === 'worker') {
    if (buffer[0] === 0x50 && buffer[1] === 0x4b) throw new Error('Worker 产物应是 JS 文本，但下载内容是 zip');
  } else {
    if (!(buffer[0] === 0x50 && buffer[1] === 0x4b)) throw new Error('Pages 产物应是 zip，但下载内容不是 zip');
  }

  return buffer;
}

async function resolveBinding(
  account: Account,
  binding: CatalogBinding,
  selection: { mode: 'auto' | 'existing'; existingId?: string; runInitSql?: boolean } | undefined,
  templateId: string,
): Promise<ResolvedBinding> {
  const title = binding.title || `${templateId}-${binding.name.toLowerCase()}`;
  const sel = selection || { mode: 'auto' };
  const cf = getCfClient(account);
  const accountId = account.account_id!;

  if (binding.type === 'ai') {
    return { type: 'ai', name: binding.name, cfBinding: { type: 'ai', name: binding.name }, created: false };
  }

  if (binding.type === 'var') {
    // secret !== false → 加密 secret_text；secret === false → 明文 plain_text
    const isSecret = binding.secret !== false;
    return {
      type: 'var',
      name: binding.name,
      cfBinding: isSecret
        ? { type: 'secret_text', name: binding.name, text: '' }
        : { type: 'plain_text', name: binding.name, text: '' },
      created: false,
    };
  }

  if (binding.type === 'kv') {
    if (sel.mode === 'existing' && sel.existingId) {
      return { type: 'kv', name: binding.name, cfBinding: { type: 'kv_namespace', name: binding.name, namespace_id: sel.existingId }, created: false, resourceType: 'kv', resourceId: sel.existingId };
    }
    const items: any[] = [];
    for await (const ns of cf.kv.namespaces.list({ account_id: accountId })) items.push(ns);
    const found = items.find(ns => ns.title === title);
    if (found) {
      return { type: 'kv', name: binding.name, cfBinding: { type: 'kv_namespace', name: binding.name, namespace_id: found.id }, created: false, resourceType: 'kv', resourceId: found.id };
    }
    const created = await cf.kv.namespaces.create({ account_id: accountId, title });
    return { type: 'kv', name: binding.name, cfBinding: { type: 'kv_namespace', name: binding.name, namespace_id: created.id }, created: true, resourceType: 'kv', resourceId: created.id };
  }

  if (binding.type === 'd1') {
    if (sel.mode === 'existing' && sel.existingId) {
      if (sel.runInitSql && (binding.initSqlUrl || binding.initSql)) {
        await executeInitSql(account, sel.existingId, binding);
      }
      return { type: 'd1', name: binding.name, cfBinding: { type: 'd1', name: binding.name, id: sel.existingId }, created: false, resourceType: 'd1', resourceId: sel.existingId };
    }
    const items: any[] = [];
    for await (const db of cf.d1.database.list({ account_id: accountId })) items.push(db);
    const found = items.find(db => db.name === title);
    if (found) {
      if (sel.runInitSql && (binding.initSqlUrl || binding.initSql)) {
        await executeInitSql(account, found.uuid, binding);
      }
      return { type: 'd1', name: binding.name, cfBinding: { type: 'd1', name: binding.name, id: found.uuid }, created: false, resourceType: 'd1', resourceId: found.uuid };
    }
    const created = await cf.d1.database.create({ account_id: accountId, name: title });
    if (sel.runInitSql !== false && (binding.initSqlUrl || binding.initSql)) {
      await executeInitSql(account, created.uuid!, binding);
    }
    return { type: 'd1', name: binding.name, cfBinding: { type: 'd1', name: binding.name, id: created.uuid }, created: true, resourceType: 'd1', resourceId: created.uuid };
  }

  if (binding.type === 'r2') {
    if (sel.mode === 'existing' && sel.existingId) {
      return { type: 'r2', name: binding.name, cfBinding: { type: 'r2_bucket', name: binding.name, bucket_name: sel.existingId }, created: false, resourceType: 'r2', resourceId: sel.existingId };
    }
    let buckets: any[] = [];
    try {
      const resp: any = await cf.r2.buckets.list({ account_id: accountId });
      buckets = resp?.buckets || [];
    } catch {}
    const found = buckets.find(b => b.name === title);
    if (found) {
      return { type: 'r2', name: binding.name, cfBinding: { type: 'r2_bucket', name: binding.name, bucket_name: found.name }, created: false, resourceType: 'r2', resourceId: found.name };
    }
    await cf.r2.buckets.create({ account_id: accountId, name: title });
    return { type: 'r2', name: binding.name, cfBinding: { type: 'r2_bucket', name: binding.name, bucket_name: title }, created: true, resourceType: 'r2', resourceId: title };
  }

  throw new Error(`Unknown binding type: ${binding.type}`);
}

async function executeInitSql(account: Account, dbId: string, binding: CatalogBinding): Promise<void> {
  let sql = binding.initSql;
  if (!sql && binding.initSqlUrl) {
    const resp = await proxyFetch(binding.initSqlUrl, {}, 30000);
    if (!resp.ok) throw new Error(`initSqlUrl 下载失败: ${resp.status}`);
    sql = await resp.text();
  }
  if (!sql) return;
  const cf = getCfClient(account);
  await cf.d1.database.query(dbId, { account_id: account.account_id!, sql });
}

async function rollback(
  account: Account, bindings: ResolvedBinding[], workerName?: string, deleteWorker: boolean = true,
): Promise<string[]> {
  const errors: string[] = [];
  const cf = getCfClient(account);
  const accountId = account.account_id!;
  for (const b of [...bindings].reverse()) {
    if (!b.created || !b.resourceType || !b.resourceId) continue;
    try {
      if (b.resourceType === 'kv') await cf.kv.namespaces.delete(b.resourceId, { account_id: accountId });
      else if (b.resourceType === 'd1') await cf.d1.database.delete(b.resourceId, { account_id: accountId });
      else if (b.resourceType === 'r2') await cf.r2.buckets.delete(b.resourceId, { account_id: accountId });
    } catch (e: any) {
      errors.push(`${b.resourceType}:${b.resourceId} - ${e.message}`);
    }
  }
  // 仅当 Worker 本身未成功部署时才删除；hybrid 模板若只是 Pages 环节失败，已部署的 Worker 应保留
  if (workerName && deleteWorker) {
    try { await cf.workers.scripts.delete(workerName, { account_id: accountId }); } catch {}
  }
  return errors;
}

// --- Deploy helpers (refactored for hybrid reuse) ---

async function deployPagesArtifact(
  account: Account, accountId: string, name: string, content: Buffer,
  template: CatalogTemplate, resolvedBindings: ResolvedBinding[],
): Promise<string> {
  const cf = getCfClient(account);

  // 1. Create project if not exists
  try {
    await cf.pages.projects.create({ account_id: accountId, name, production_branch: 'main' } as any);
  } catch (e: any) {
    if (e?.status !== 409) throw e;
  }

  // 2. Set deployment_configs (bindings + env vars) BEFORE deploying
  //    This ensures the first deployment has the correct bindings available.
  //    Only set if there are actual bindings or env vars (empty arrays cause API 400 errors).
  const prodConfigs: any = {};
  const previewConfigs: any = {};

  // Add env vars from template.env
  if (template.env && Object.keys(template.env).length > 0) {
    prodConfigs.env_vars = {};
    previewConfigs.env_vars = {};
    for (const [k, v] of Object.entries(template.env)) {
      prodConfigs.env_vars[k] = { value: v };
      previewConfigs.env_vars[k] = { value: v };
    }
  }

  // Convert resolved bindings from Worker format to Pages deployment_configs format
  // Worker: { type: 'kv_namespace', name: 'XXX', namespace_id: 'yyy' }
  // Pages:  { binding: 'XXX', namespace_id: 'yyy' }
  const hasResourceBindings = resolvedBindings.some(rb => ['kv', 'd1', 'r2'].includes(rb.type));
  if (hasResourceBindings) {
    prodConfigs.kv_namespaces = [];
    prodConfigs.d1_databases = [];
    prodConfigs.r2_buckets = [];
    previewConfigs.kv_namespaces = [];
    previewConfigs.d1_databases = [];
    previewConfigs.r2_buckets = [];
  }

  for (const rb of resolvedBindings) {
    const b = rb.cfBinding as any;
    switch (rb.type) {
      case 'kv': {
        const entry = { binding: b.name, namespace_id: b.namespace_id };
        prodConfigs.kv_namespaces.push(entry);
        previewConfigs.kv_namespaces.push(entry);
        break;
      }
      case 'd1': {
        // Worker uses 'id', Pages uses 'database_id'
        const entry = { binding: b.name, database_id: b.id };
        prodConfigs.d1_databases.push(entry);
        previewConfigs.d1_databases.push(entry);
        break;
      }
      case 'r2': {
        const entry = { binding: b.name, bucket_name: b.bucket_name };
        prodConfigs.r2_buckets.push(entry);
        previewConfigs.r2_buckets.push(entry);
        break;
      }
      case 'var': {
        // secret_text → env_vars
        if (!prodConfigs.env_vars) prodConfigs.env_vars = {};
        if (!previewConfigs.env_vars) previewConfigs.env_vars = {};
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

  // Only set deployment_configs if there's something to set
  const hasConfigs = Object.keys(prodConfigs).length > 0;
  if (hasConfigs) {
    try {
      await cf.pages.projects.edit(name, { account_id: accountId, deployment_configs: { production: prodConfigs, preview: previewConfigs } } as any);
      appLogger.info(`[Store] Pages deployment_configs set for ${name}`);
    } catch (e: any) {
      appLogger.warn(`[Store] Failed to set deployment_configs for ${name}: ${e.message}`);
    }
  }

  // 3. Extract zip to files array
  const zip = new AdmZip(content);
  const entries = zip.getEntries().filter(e => !e.isDirectory);
  const files: Array<{ path: string; buffer: Buffer }> = [];
  for (const entry of entries) {
    const filePath = String(entry.entryName).replace(/\\/g, '/').replace(/^\/+/, '');
    files.push({ path: filePath, buffer: entry.getData() });
  }

  // 4. Deploy via SDK multipart form upload (handles manifest + file uploads correctly)
  //    deployPages handles special files like _worker.js, _headers, _redirects, etc.
  await deployPages(account, name, files, true); // skipCreateProject = true

  // 5. Get actual project subdomain
  try {
    const project: any = await cf.pages.projects.get(name, { account_id: accountId });
    return project?.subdomain || `${name}.pages.dev`;
  } catch {
    return `${name}.pages.dev`;
  }
}

// --- Main deploy ---

export async function deployTemplate(opts: DeployOptions): Promise<DeployResult> {
  const { account, template, name, bindingSelections, secretValues, deployType } = opts;
  const warnings: string[] = [];
  const resolvedBindings: ResolvedBinding[] = [];
  const urls: string[] = [];

  try {
    // Step 1: Determine what to deploy
    const doWorker = template.type === 'worker'
      || (template.type === 'hybrid' && (deployType === 'worker' || deployType === 'both' || !deployType));
    const doPages = template.type === 'pages'
      || (template.type === 'hybrid' && (deployType === 'pages' || deployType === 'both'));

    // Step 2: Resolve bindings (once, shared)
    for (const binding of (template.bindings || [])) {
      const selection = bindingSelections[binding.name];
      const resolved = await resolveBinding(account, binding, selection, template.id);
      if (binding.type === 'var' && binding.action === 'prompt') {
        const val = secretValues[binding.name];
        if (binding.required && !val) throw new Error(`必填项 ${binding.name} 未填写`);
        resolved.cfBinding.text = val || '';
      }
      resolvedBindings.push(resolved);
    }

  const accountId = account.account_id!;
  const cf = getCfClient(account);
  let workerDeployed = false;
  let pagesDeployed = false;

    // Step 3: Deploy worker
    if (doWorker) {
      const src = template.type === 'hybrid' ? template.sources?.worker : template.source;
      if (!src) throw new Error('No worker source configured');
      const content = await downloadArtifact(src.url, 'worker');
      const { subdomain: accountSubdomain } = await deployWorker(account, name, content, {
        bindings: resolvedBindings.map(b => b.cfBinding),
        env: template.env,
        createDeployment: true,
        deploymentAnnotation: { 'cf-manager/store': template.id },
      });
      urls.push(accountSubdomain ? `https://${name}.${accountSubdomain}.workers.dev` : `https://${name}.workers.dev`);
      appLogger.info(`[Store] Worker deployed: ${name}`);
      workerDeployed = true;
    }

    // Step 4: Deploy pages
    if (doPages) {
      const src = template.type === 'hybrid' ? template.sources?.pages : template.source;
      if (!src) throw new Error('No pages source configured');
      const content = await downloadArtifact(src.url, 'pages');
      const pagesSubdomain = await deployPagesArtifact(account, accountId, name, content, template, resolvedBindings);
      urls.push(`https://${pagesSubdomain}`);
      appLogger.info(`[Store] Pages deployed: ${name} → ${pagesSubdomain}`);
      pagesDeployed = true;
    }

    // Step 5: Routes (soft failure)
    if (template.routes && template.routes.length > 0) {
      for (const pattern of template.routes) {
        try {
          const hostname = pattern.split('/')[0];
          const zones: any[] = [];
          for await (const z of (cf.zones.list as any)({ account_id: accountId })) zones.push(z);
          const zone = zones.find(z => z.name === hostname || hostname.endsWith('.' + z.name));
          if (!zone) { warnings.push(`路由 ${pattern} 创建失败: 未找到 zone`); continue; }
          await cf.workers.routes.create({ zone_id: zone.id, pattern, script: name });
        } catch (e: any) {
          warnings.push(`路由 ${pattern} 创建失败: ${e.message}`);
        }
      }
    }

    createAuditLog(account.id!, 'store_deploy', name, `template: ${template.id}`, 'success');
    const url = urls.join(' | ') || (template.type === 'pages' ? `https://${name}.pages.dev` : `https://${name}.workers.dev`);
    return { success: true, warnings, bindings: resolvedBindings, url };

  } catch (e: any) {
    appLogger.error(`[Store] Deploy failed for ${name} (${template.id}): ${e.message}`);
    // 仅回滚本轮未成功部署的部分：已部署的 Worker/Pages 不删，避免 hybrid 一处失败连坐删除成功部分
    const rollbackErrors = await rollback(account, resolvedBindings, name, !workerDeployed);
    createAuditLog(account.id!, 'store_deploy', name, `error: ${e.message}`, 'error');
    return {
      success: false, error: e.message, warnings, bindings: resolvedBindings,
      rolledBack: true, rollbackErrors: rollbackErrors.length > 0 ? rollbackErrors : undefined,
    };
  }
}
