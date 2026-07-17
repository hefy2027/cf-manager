/**
 * catalogValidator.ts —— Catalog 校验的单一事实来源。
 *
 * 校验规则由 shared/catalog.schema.json（JSON Schema Draft 2020-12）定义，
 * 这里只用 ajv 编译该 schema 并做少量 JSON Schema 无法表达的跨字段检查
 * （模板 id 去重、binding 名称去重、env key 与 binding 名称冲突）。
 *
 * 注意：本文件会被 scripts/sync-shared.js 复制到
 * backend/src/services/ 与 worker/src/services/，两端共用，避免规则漂移。
 * 修改校验逻辑请改这里和 catalog.schema.json，然后重新运行同步脚本。
 */
import type { ErrorObject } from 'ajv/dist/2020';
// 校验器由 scripts/gen-catalog-validator.js 在构建期用 ajv standalone 预编译生成
// （catalogValidate.generated.ts），运行时不再调用 new Function，以兼容 Cloudflare
// Workers / Pages（其运行时禁止动态代码生成）。请勿在此处直接 ajv.compile。
import validateSchema from './catalogValidate.generated';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface SourceConfig {
  kind: 'raw' | 'release' | 'repo-archive';
  url: string;
  assetName?: string;
  subPath?: string;
  size?: number;
}

export interface CatalogBinding {
  type: 'kv' | 'd1' | 'r2' | 'ai' | 'var';
  name: string;
  title?: string;
  action?: 'create-or-reuse' | 'prompt';
  required?: boolean;
  secret?: boolean;
  value?: string;
  initSqlUrl?: string;
  initSql?: string;
}

export interface CatalogTemplate {
  id: string;
  name: string;
  description?: string;
  author?: { name: string; url?: string };
  version: string;
  tags?: string[];
  icon?: string;
  homepage?: string;
  readmeUrl?: string;
  type: 'worker' | 'pages' | 'hybrid';
  source?: SourceConfig;
  sources?: { worker?: SourceConfig; pages?: SourceConfig };
  bindings?: CatalogBinding[];
  env?: Record<string, string>;
  routes?: string[];
  assets?: {
    source: SourceConfig;
    binding?: string;
    config?: { html_handling?: string; not_found_handling?: string };
  };
}

export interface Catalog {
  version: string;
  updated?: string;
  name?: string;
  defaultLanguage?: string;
  templates: CatalogTemplate[];
}

function label(e: ErrorObject): string {
  if (e.keyword === 'required') {
    const missing = (e.params as any).missingProperty as string;
    return `${e.instancePath}/${missing}`;
  }
  return e.instancePath || '/';
}

function humanize(e: ErrorObject): string {
  // 跳过 ajv 在 if/then 不满足时附加的笼统包装错误（如 `must match "then" schema`），
  // 具体原因已由 ajv-errors 的 errorMessage 提供。注意：pattern 失败信息也是
  // "must match pattern ..."，不能误删，所以只过滤 then/if schema 包装。
  if (typeof e.message === 'string' && /^must match "(then|if)" schema$/.test(e.message)) {
    return '';
  }
  const at = label(e);
  switch (e.keyword) {
    case 'required':
      return `${at}: 缺少必填字段`;
    case 'enum':
      return `${at}: 值必须是 ${(e.params as any).allowedValues?.join(', ')} 之一`;
    case 'pattern':
      return `${at}: 格式不正确`;
    case 'format':
      return `${at}: 必须是合法的 ${(e.params as any).format}`;
    case 'type':
      return `${at}: 类型应为 ${(e.params as any).type}`;
    case 'additionalProperties':
      return `${at}: 包含未知字段 "${(e.params as any).additionalProperty}"`;
    case 'errorMessage':
      return `${at}: ${e.message}`;
    default:
      return `${at}: ${e.message}`;
  }
}

export function validateCatalog(raw: unknown): ValidationResult {
  const errors: string[] = [];

  const ok = validateSchema(raw);
  if (!ok) {
    for (const e of validateSchema.errors || []) {
      const msg = humanize(e);
      if (msg) errors.push(msg);
    }
  }

  // 跨字段检查：JSON Schema 不易表达的唯一性 / 冲突规则
  if (raw && typeof raw === 'object' && Array.isArray((raw as any).templates)) {
    const ids = new Set<string>();
    const templates = (raw as any).templates as any[];
    for (let i = 0; i < templates.length; i++) {
      const t = templates[i];
      if (!t || typeof t !== 'object') continue;

      if (Array.isArray(t.bindings)) {
        const names = new Set<string>();
        for (let j = 0; j < t.bindings.length; j++) {
          const b = t.bindings[j];
          if (b && b.name) {
            if (names.has(b.name)) {
              errors.push(`Template[${i}].bindings[${j}]: duplicate binding name "${b.name}"`);
            }
            names.add(b.name);
          }
        }
        if (t.env && typeof t.env === 'object') {
          for (const key of Object.keys(t.env)) {
            if (names.has(key)) {
              errors.push(`Template[${i}]: env key "${key}" conflicts with binding name`);
            }
          }
        }
      }

      if (t.id) {
        if (ids.has(t.id)) {
          errors.push(`Template[${i}]: duplicate id "${t.id}"`);
        }
        ids.add(t.id);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateTemplate(raw: unknown): ValidationResult {
  const res = validateCatalog({ version: '0.0.0', templates: [raw] });
  const errors = res.errors.map(e => e.replace(/^\/templates\/0/, '') || e);
  return { valid: res.valid, errors };
}
