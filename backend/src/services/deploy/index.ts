/**
 * Deploy Service 统一入口 — 编排 preflight + workerDeploy + pagesDeploy + triggers + rollback。
 *
 * 从 catalogDeploy.ts 迁移而来，改用 deploy/ 子模块替代直接调用 workerService。
 * Binding 解析逻辑也迁移至此，避免循环依赖。
 */
import { Account } from '../../models/account';
import { getCfClient } from '../cfFactory';
import { proxyFetch } from '../proxyService';
import { createAuditLog } from '../../models/auditLog';
import type { CatalogTemplate, CatalogBinding } from '../catalogValidator';
import { appLogger } from '../logger';
import { extractZipFiles, validatePagesProjectName, ensurePagesProject } from '../workerService';

import { preflight } from './preflight';
import { deployWorker } from './workerDeploy';
import { deployPages } from './pagesDeploy';
import { deployTriggers } from './triggers';
import type { PreflightParams, PreflightResult, DeployResult, ResolvedBinding } from './types';
import type { CfModule, CfModuleType, Migration, Placement, TailConsumer, Limits } from './types';

// ---- Types ----

export interface DeployOptions {
  account: Account;
  template: CatalogTemplate;
  name: string;
  bindingSelections: Record<string, { mode: 'auto' | 'existing'; existingId?: string; runInitSql?: boolean }>;
  secretValues: Record<string, string>;
  deployType?: 'worker' | 'pages' | 'both';
  traces?: boolean;
  logs?: boolean;
}

// ---- Helpers ----

const MAX_DOWNLOAD = 50 * 1024 * 1024;

async function downloadArtifact(url: string, type: 'worker' | 'pages'): Promise<Buffer> {
  const resp = await proxyFetch(url, {}, 30000);
  if (!resp.ok) throw new Error(`产物下载失败: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > MAX_DOWNLOAD) throw new Error('产物超过 50MB 限制');
  if (type === 'pages' && !(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    throw new Error('Pages 产物应是 zip，但下载内容不是 zip');
  }
  return buffer;
}

async function resolveBinding(
  account: Account,
  binding: CatalogBinding,
  selection: { mode: 'auto' | 'existing'; existingId?: string; runInitSql?: boolean } | undefined,
  templateId: string,
): Promise<ResolvedBinding> {
  const title = binding.resourceName || `${templateId}-${binding.name.toLowerCase()}`;
  const sel = selection || { mode: 'auto' };
  const cf = getCfClient(account);
  const accountId = account.account_id!;

  if (binding.type === 'ai') {
    return { type: 'ai', name: binding.name, cfBinding: { type: 'ai', name: binding.name }, created: false };
  }

  if (binding.type === 'var') {
    const isSecret = binding.secret !== false;
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

  // New binding types: durable_object, service, queue — declare only, no resource creation
  if (binding.type === 'durable_object') {
    const cfBinding: Record<string, unknown> = {
      type: 'durable_object_namespace',
      name: binding.name,
      class_name: binding.className,
    };
    if (binding.scriptName) cfBinding.script_name = binding.scriptName;
    if (binding.environment) cfBinding.environment = binding.environment;
    return { type: 'durable_object', name: binding.name, cfBinding, created: false };
  }

  if (binding.type === 'service') {
    const cfBinding: Record<string, unknown> = {
      type: 'service',
      name: binding.name,
      service: binding.service,
    };
    if (binding.environment) cfBinding.environment = binding.environment;
    if (binding.entrypoint) cfBinding.entrypoint = binding.entrypoint;
    return { type: 'service', name: binding.name, cfBinding, created: false };
  }

  if (binding.type === 'queue') {
    const cfBinding: Record<string, unknown> = {
      type: 'queue',
      name: binding.name,
      queue_name: binding.queueName,
    };
    if (binding.deliveryDelay !== undefined) cfBinding.delivery_delay = binding.deliveryDelay;
    return { type: 'queue', name: binding.name, cfBinding, created: false };
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
  if (workerName && deleteWorker) {
    try { await cf.workers.scripts.delete(workerName, { account_id: accountId }); } catch {}
  }
  return errors;
}

// ---- Pages deployment configs builder ----

function buildPagesDeploymentConfigs(template: CatalogTemplate, resolvedBindings: ResolvedBinding[]) {
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

  const hasConfigs = Object.keys(prodConfigs).length > 0;
  return hasConfigs ? { production: prodConfigs, preview: previewConfigs } : undefined;
}

// ---- Preflight wrapper ----

export async function preflightDeploy(opts: {
  account: Account;
  template: CatalogTemplate;
  name: string;
  bindingSelections: Record<string, { mode: 'auto' | 'existing'; existingId?: string }>;
  secretValues: Record<string, string>;
  deployType?: 'worker' | 'pages' | 'both';
}): Promise<PreflightResult> {
  const params: PreflightParams = {
    templateId: opts.template.id,
    accountId: opts.account.id!,
    name: opts.name,
    bindingSelections: opts.bindingSelections,
    secretValues: opts.secretValues,
    deployType: opts.deployType,
  };
  return preflight(opts.account, opts.template, params);
}

// ---- Main deploy ----

export async function deployTemplate(opts: DeployOptions): Promise<DeployResult> {
  const { account, template, name, bindingSelections, secretValues, deployType, traces, logs } = opts;
  if (!validatePagesProjectName(name)) {
    return { success: false, error: '项目名只能包含小写字母、数字和连字符，且以字母或数字开头', warnings: [], bindings: [] };
  }
  const warnings: string[] = [];
  const resolvedBindings: ResolvedBinding[] = [];
  const urls: string[] = [];
  let workerDeployed = false;

  try {
    const doWorker = template.type === 'worker'
      || (template.type === 'hybrid' && (deployType === 'worker' || deployType === 'both' || !deployType));
    const doPages = template.type === 'pages'
      || (template.type === 'hybrid' && (deployType === 'pages' || deployType === 'both'));

    // Step 1: Resolve bindings
    for (const binding of (template.bindings || [])) {
      const selection = bindingSelections[binding.name];
      const resolved = await resolveBinding(account, binding, selection, template.id);
      if (binding.type === 'var' && binding.action === 'prompt') {
        const val = secretValues[binding.name] || binding.value || '';
        if (binding.required && !val) throw new Error(`必填项 ${binding.name} 未填写`);
        resolved.cfBinding.text = val;
      }
      resolvedBindings.push(resolved);
    }

    // Step 2: Deploy worker
    if (doWorker) {
      const src = template.type === 'hybrid' ? template.sources?.worker : template.source;
      if (!src) throw new Error('No worker source configured');
      const content = await downloadArtifact(src.url, 'worker');
      const isZip = content[0] === 0x50 && content[1] === 0x4b;

      // Build CfWorkerInit from template
      const workerInit: Partial<import('./types').CfWorkerInit> = {
        compatibility_date: template.compatibility_date || '2024-11-01',
        compatibility_flags: template.compatibility_flags || [],
        migrations: template.migrations as Migration[] | undefined,
        keepVars: template.keep_vars ?? true,
        keepSecrets: template.keep_secrets ?? true,
        keepBindings: template.keep_bindings ?? true,
        placement: template.placement as Placement | undefined,
        tail_consumers: template.tail_consumers as TailConsumer[] | undefined,
        limits: template.limits as Limits | undefined,
        logpush: template.logpush,
      };

      // Handle assets
      let assetsOpts: DeployWorkerOptions['assets'];
      if (template.assets) {
        const assetContent = template.assets.source.url
          ? await downloadArtifact(template.assets.source.url, 'worker')
          : undefined;
        if (assetContent) {
          const assetFiles = template.assets.source.kind === 'raw'
            ? [{ path: template.assets.source.url.split('/').pop() || 'asset', buffer: assetContent }]
            : extractZipFiles(assetContent);
          assetsOpts = {
            files: assetFiles,
            binding: template.assets.binding,
            config: template.assets.config as any,
          };
        }
      }

      const result = await deployWorker(account, name, isZip ? '' : content, workerInit, {
        ...(isZip ? {} : {}),
        bindings: resolvedBindings.map(b => b.cfBinding),
        traces: traces !== false,
        logs: logs !== false,
        createDeployment: true,
        enableSubdomain: true,
        assets: assetsOpts,
        useVersionsApi: false, // Use legacy PUT for now; preflight will determine this
      });

      urls.push(result.subdomain ? `https://${name}.${result.subdomain}.workers.dev` : `https://${name}.workers.dev`);
      appLogger.info(`[Store] Worker deployed: ${name}`);
      workerDeployed = true;

      // Step 2.5: Deploy triggers (cron + routes)
      const triggerResult = await deployTriggers(account, name, template.crons || [], template.routes || []);
      warnings.push(...triggerResult.warnings);
    }

    // Step 3: Deploy pages
    if (doPages) {
      const src = template.type === 'hybrid' ? template.sources?.pages : template.source;
      if (!src) throw new Error('No pages source configured');
      const content = await downloadArtifact(src.url, 'pages');
      const files = extractZipFiles(content);

      // Build deployment_configs
      const deploymentConfigs = buildPagesDeploymentConfigs(template, resolvedBindings);

      await deployPages(account, name, files, {
        skipCreateProject: false,
        deploymentConfigs,
        branch: 'main',
        commitMessage: '',
      });

      // Get subdomain
      const cf = getCfClient(account);
      try {
        const project: any = await cf.pages.projects.get(name, { account_id: account.account_id! });
        const subdomain = project?.subdomain || `${name}.pages.dev`;
        urls.push(`https://${subdomain}`);
      } catch {
        urls.push(`https://${name}.pages.dev`);
      }
      appLogger.info(`[Store] Pages deployed: ${name}`);
    }

    createAuditLog(account.id!, 'store_deploy', name, `template: ${template.id}`, 'success');
    const url = urls.join(' | ') || (template.type === 'pages' ? `https://${name}.pages.dev` : `https://${name}.workers.dev`);
    return { success: true, warnings, bindings: resolvedBindings, url };

  } catch (e: any) {
    let cur: any = e; const chain: string[] = []; const seen = new Set<any>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const seg = [cur.code, cur.message].filter(Boolean).join(' ');
      if (seg && !chain.includes(seg)) chain.push(seg);
      cur = cur.cause;
    }
    const detail = chain.join(' <- ') || String(e);
    appLogger.error(`[Store] Deploy failed for ${name} (${template.id}): ${detail}`);
    appLogger.error((e && e.stack) ? e.stack : String(e));
    const rollbackErrors = await rollback(account, resolvedBindings, name, !workerDeployed);
    createAuditLog(account.id!, 'store_deploy', name, `error: ${detail}`, 'error');
    return {
      success: false, error: detail, warnings, bindings: resolvedBindings,
      rolledBack: true, rollbackErrors: rollbackErrors.length > 0 ? rollbackErrors : undefined,
    };
  }
}

// Re-export DeployWorkerOptions type for external use
import type { DeployWorkerOptions } from './workerDeploy';
