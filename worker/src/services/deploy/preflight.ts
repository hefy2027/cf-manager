import type { Account } from '../../db/models';
import { getDeployHeaders } from './headers';
import type { CatalogTemplate } from '../catalogValidator';
import type { PreflightParams, PreflightResult } from './types';

const CF_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * 预检验证 — 在实际部署前检查 Worker 存在性、配置差异、Secrets 覆盖。
 */
export async function preflight(
  account: Account,
  encryptionKey: string,
  template: CatalogTemplate,
  params: PreflightParams,
): Promise<PreflightResult> {
  const warnings: string[] = [];
  const deployHeaders = await getDeployHeaders(account, encryptionKey);
  const accountId = account.account_id;

  // 1. 本地验证
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(params.name)) {
    return {
      workerExists: false,
      deployPath: 'legacy-put',
      secretsOverride: [],
      warnings: ['Worker 名称格式无效（只允许字母、数字、连字符）'],
      canProceed: false,
    };
  }

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
        // Settings endpoint may not be available
      }
    }
  } catch {
    // Worker doesn't exist or API error
  }

  // 3. 选择上传路径
  const deployPath: 'versions-api' | 'legacy-put' = workerExists ? 'versions-api' : 'legacy-put';

  // 4. 配置 Diff
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
        if (!params.secretValues?.[b.name]) {
          secretsOverride.push(b.name);
        }
      }
    }
  }

  if (secretsOverride.length > 0) {
    warnings.push(`以下 Secrets 需要用户提供值：${secretsOverride.join(', ')}`);
  }

  console.log(`[Preflight] Worker ${params.name}: exists=${workerExists}, path=${deployPath}, canProceed=true`);

  return {
    workerExists,
    deployPath,
    configDiff,
    secretsOverride,
    warnings,
    canProceed: true,
  };
}
