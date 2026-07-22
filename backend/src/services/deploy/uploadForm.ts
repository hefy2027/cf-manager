import type { CfWorkerInit, CfModuleType } from './types';

// 模块类型 → MIME 映射（对齐 wrangler moduleTypeMimeType）
const MODULE_MIME: Record<CfModuleType, string> = {
  'esm': 'application/javascript+module',
  'commonjs': 'application/javascript',
  'compiled-wasm': 'application/wasm',
  'text': 'text/plain',
  'buffer': 'application/octet-stream',
};

export function createWorkerUploadForm(
  worker: CfWorkerInit,
  bindings: Record<string, unknown>[] | undefined,
): FormData {
  const form = new FormData();

  // 1. 构建 metadata.bindings 数组
  const metadataBindings = bindings || [];

  // 2. 构建 metadata 对象
  const metadata: Record<string, unknown> = {
    main_module: worker.main.name,
    compatibility_date: worker.compatibility_date,
    compatibility_flags: worker.compatibility_flags,
    bindings: metadataBindings,
  };

  if (worker.migrations?.length) metadata.migrations = worker.migrations;
  if (worker.keepVars) metadata.keep_vars = true;
  if (worker.keepSecrets) metadata.keep_secrets = true;
  if (worker.keepBindings) metadata.keep_bindings = true;
  if (worker.placement) metadata.placement = worker.placement;
  if (worker.tail_consumers?.length) metadata.tail_consumers = worker.tail_consumers;
  if (worker.limits) metadata.limits = worker.limits;
  if (worker.logpush !== undefined) metadata.logpush = worker.logpush;
  if (worker.assets) metadata.assets = worker.assets;
  if (worker.observability) metadata.observability = worker.observability;

  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));

  // 3. 添加主模块
  const mainContent = typeof worker.main.content === 'string'
    ? new TextEncoder().encode(worker.main.content)
    : new Uint8Array(worker.main.content);
  form.append(worker.main.name, new Blob([mainContent], { type: MODULE_MIME[worker.main.type] }), worker.main.name);

  // 4. 添加附加模块
  for (const mod of worker.modules) {
    const content = typeof mod.content === 'string'
      ? new TextEncoder().encode(mod.content)
      : new Uint8Array(mod.content);
    form.append(mod.name, new Blob([content], { type: MODULE_MIME[mod.type] }), mod.name);
  }

  // 5. 添加 source maps
  for (const sm of worker.sourceMaps) {
    const content = typeof sm.content === 'string'
      ? new TextEncoder().encode(sm.content)
      : new Uint8Array(sm.content);
    form.append(sm.name, new Blob([content], { type: 'application/json' }), sm.name);
  }

  return form;
}
