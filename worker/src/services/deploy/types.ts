// CfModuleType — Worker 模块类型
export type CfModuleType = 'esm' | 'commonjs' | 'compiled-wasm' | 'text' | 'buffer';

// CfModule — 模块定义
export interface CfModule {
  name: string;
  content: string | Uint8Array;
  type: CfModuleType;
}

// CfWorkerSourceMap — Source map 定义
export interface CfWorkerSourceMap {
  name: string;
  content: string | Uint8Array;
}

// Migration — DO 迁移步骤
export interface Migration {
  tag: string;
  new_classes?: string[];
  renamed_classes?: Array<{ from: string; to: string }>;
  deleted_classes?: string[];
}

// Placement — 部署位置
export interface Placement {
  mode: 'smart' | 'off';
}

// TailConsumer — Tail 消费者
export interface TailConsumer {
  service: string;
  environment?: string;
}

// Limits — Worker 限制
export interface Limits {
  cpu_ms?: number;
  memory_mb?: number;
}

// AssetsUpload — 静态资源上传结果
export interface AssetsUpload {
  jwt: string;
  config?: {
    html_handling?: string;
    not_found_handling?: string;
  };
}

// Observability — 可观测性配置
export interface Observability {
  enabled: boolean;
  traces?: { enabled: boolean; persist?: boolean; head_sampling_rate?: number };
  logs?: { enabled: boolean; persist?: boolean; invocation_logs?: boolean; head_sampling_rate?: number };
}

// CfWorkerInit — 上传 Worker 所需的全部信息
export interface CfWorkerInit {
  name: string;
  main: CfModule;
  modules: CfModule[];
  sourceMaps: CfWorkerSourceMap[];
  compatibility_date: string;
  compatibility_flags: string[];
  migrations: Migration[] | undefined;
  keepVars: boolean;
  keepSecrets: boolean;
  keepBindings: boolean;
  placement: Placement | undefined;
  tail_consumers: TailConsumer[];
  limits: Limits | undefined;
  logpush: boolean | undefined;
  assets: AssetsUpload | undefined;
  observability: Observability | undefined;
}

// PreflightParams — 预检输入
export interface PreflightParams {
  templateId: string;
  accountId: number;
  name: string;
  bindingSelections: Record<string, { mode: 'auto' | 'existing'; existingId?: string }>;
  secretValues: Record<string, string>;
  deployType?: 'worker' | 'pages' | 'both';
}

// ConfigDiff — 配置差异
export interface ConfigDiff {
  added: Array<{ type: string; name: string }>;
  removed: Array<{ type: string; name: string }>;
  modified: Array<{ type: string; name: string }>;
}

// PreflightResult — 预检结果
export interface PreflightResult {
  workerExists: boolean;
  deployPath: 'versions-api' | 'legacy-put';
  configDiff?: ConfigDiff;
  secretsOverride: string[];
  warnings: string[];
  canProceed: boolean;
}

// DeployParams — 部署输入
export interface DeployParams extends PreflightParams {
  skipPreflight?: boolean;
  traces?: boolean;
  logs?: boolean;
}

// ResolvedBinding — 已解析的绑定
export interface ResolvedBinding {
  type: string;
  name: string;
  cfBinding: Record<string, unknown>;
  created: boolean;
  resourceType?: 'kv' | 'd1' | 'r2';
  resourceId?: string;
}

// DeployResult — 部署结果
export interface DeployResult {
  success: boolean;
  error?: string;
  warnings: string[];
  url?: string;
  bindings: ResolvedBinding[];
  rolledBack?: boolean;
  rollbackErrors?: string[];
}
