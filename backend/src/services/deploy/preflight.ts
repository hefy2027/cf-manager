import { Account } from '../../models/account';
import { getDeployHeaders } from './headers';
import type { CatalogTemplate } from '../catalogValidator';
import type { PreflightParams, PreflightResult } from './types';
import { appLogger } from '../logger';

const CF_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * 预检验证 — 在实际部署前检查 Worker 存在性、配置差异、Secrets 覆盖。
 *
 * 流程：
 * 1. 本地验证：Worker 名称格式、compatibility_date 存在性
 * 2. API 验证：GET worker services 检查存在性，下载远程配置做 Diff
 * 3. 选择上传路径：Versions API vs 传统 PUT
 * 4. Secrets 覆盖检查
 */
export async function preflight(
  account: Account,
  template: CatalogTemplate,
  params: PreflightParams,
): Promise<PreflightResult> {
  const warnings: string[] = [];
  const deployHeaders = getDeployHeaders(account);
  const accountId = account.account_id!;

  // 1. 本地验证
  // Worker 名称格式：字母数字和连字符
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(params.name)) {
    return {
      workerExists: false,
      deployPath: 'legacy-put',
      secretsOverride: [],
      warnings: ['Worker 名称格式无效（只允许字母、数字、连字符）'],
      canProceed: false,
    };
  }

  // compatibility_date 检查
  if (!template.compatibility_date && !params.deployType) {
    warnings.push('模板未指定 compatibility_date，将使用默认值 2024-11-01');
  }

  // 2. API 验证：检查 Worker 是否已存在
  let workerExists = false;
  let remoteConfig: any = null;
  try {
    const resp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/services/${params.name}`, {
      headers: { ...deployHeaders },
    });
    if (resp.ok) {
      workerExists = true;
      const json = await resp.json() as any;
      remoteConfig = json?.result;

      // 尝试下载远程脚本配置（bindings 等）
      try {
        const settingsResp = await fetch(`${CF_BASE}/accounts/${accountId}/workers/scripts/${params.name}/settings`, {
          headers: { ...deployHeaders },
        });
        if (settingsResp.ok) {
          const settingsJson = await settingsResp.json() as any;
          remoteConfig = { ...remoteConfig, ...settingsJson?.result };
        }
      } catch {
        // Settings endpoint may not be available for all Workers
      }
    }
  } catch {
    // Worker doesn't exist or API error
  }

  // 3. 选择上传路径
  // Versions API: Worker 已存在 + modules 格式
  // Legacy PUT: 新 Worker 或不满足 Versions API 条件
  const deployPath: 'versions-api' | 'legacy-put' = workerExists ? 'versions-api' : 'legacy-put';

  // 4. 配置 Diff（如果 Worker 已存在）
  let configDiff: PreflightResult['configDiff'] | undefined;
  if (workerExists && remoteConfig) {
    const remoteBindings: Array<{ type: string; name: string }> = [];
    if (Array.isArray(remoteConfig.bindings)) {
      for (const b of remoteConfig.bindings) {
        if (b?.name && b?.type) {
          remoteBindings.push({ type: b.type, name: b.name });
        }
      }
    }

    const localBindings: Array<{ type: string; name: string }> = [];
    if (template.bindings) {
      for (const b of template.bindings) {
        localBindings.push({ type: b.type, name: b.name });
      }
    }
    // env vars also become bindings
    if (template.env) {
      for (const [k] of Object.entries(template.env)) {
        localBindings.push({ type: 'plain_text', name: k });
      }
    }

    const remoteNames = new Set(remoteBindings.map(b => b.name));
    const localNames = new Set(localBindings.map(b => b.name));

    const added = localBindings.filter(b => !remoteNames.has(b.name));
    const removed = remoteBindings.filter(b => !localNames.has(b.name));
    const modified = localBindings.filter(b => {
      const remote = remoteBindings.find(rb => rb.name === b.name);
      return remote && remote.type !== b.type;
    });

    if (added.length || removed.length || modified.length) {
      configDiff = { added, removed, modified };
      if (removed.length > 0) {
        warnings.push(`以下绑定将从远程 Worker 移除：${removed.map(b => `${b.name}(${b.type})`).join(', ')}`);
      }
    }
  }

  // 5. Secrets 覆盖检查
  const secretsOverride: string[] = [];
  if (template.bindings) {
    for (const b of template.bindings) {
      if (b.type === 'var' && (b.secret === undefined || b.secret === true)) {
        // This is a secret binding — check if user provided a value
        if (!params.secretValues?.[b.name]) {
          secretsOverride.push(b.name);
        }
      }
    }
  }

  if (secretsOverride.length > 0) {
    warnings.push(`以下 Secrets 需要用户提供值：${secretsOverride.join(', ')}`);
  }

  // 6. 判定是否可以继续
  const canProceed = warnings.filter(w => w.includes('移除') || w.includes('无效')).length === 0;

  appLogger.info(`[Preflight] Worker ${params.name}: exists=${workerExists}, path=${deployPath}, canProceed=${canProceed}`);

  return {
    workerExists,
    deployPath,
    configDiff,
    secretsOverride,
    warnings,
    canProceed: true, // Allow proceeding even with warnings; UI will show confirmation
  };
}
