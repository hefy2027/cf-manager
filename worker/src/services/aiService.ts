import type { Account } from '../db/models';
import { cfFetch } from './cfApi';
import { logger } from './logger';

/**
 * 缓存每个 TTS 模型的 input schema（含 properties 与 required）。
 * 不同 TTS 模型的入参完全不同（如 aura-2-en 用 text+speaker+encoding、
 * aura-2-es 同前者但 speaker 枚举不同、aura-1 speaker 枚举更小、
 * melotts 用 prompt+lang 且无 speaker/encoding），因此不能写死请求体，
 * 必须从模型 schema 动态构造。
 * key = `${account_id}::${model}`
 */
export interface ModelInputSchema {
  /** 动态 schema 属性（type/enum/default/minimum/maximum/description 等，字段因模型而异） */
  properties: Record<string, any>;
  required: string[];
}
interface InputSchemaCache {
  schema: ModelInputSchema | null;
  fetchedAt: number;
}
const inputSchemaCache = new Map<string, InputSchemaCache>();
const SCHEMA_TTL_MS = 1000 * 60 * 60; // 1 小时

/**
 * 获取指定模型的 input schema。
 * CF REST API 返回 { result: { input, output } }，因此需从 result.input 读取。
 */
export async function getModelInputSchema(
  account: Account,
  model: string,
  encryptionKey: string,
  kv?: any,
): Promise<ModelInputSchema | null> {
  if (!account.account_id || !model) return null;
  const key = `${account.account_id}::${model}`;
  const cached = inputSchemaCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SCHEMA_TTL_MS) {
    return cached.schema;
  }

  // P1-13: L2 共享缓存（KV），跨 Worker 实例复用、冷启动免重复 CF 调用
  const kvKey = `model-schema:${key}`;
  if (kv) {
    try {
      const kvRaw = await kv.get(kvKey, 'json') as { schema: ModelInputSchema | null; fetchedAt: number } | null;
      if (kvRaw && kvRaw.schema !== undefined && Date.now() - kvRaw.fetchedAt < SCHEMA_TTL_MS) {
        inputSchemaCache.set(key, kvRaw);
        return kvRaw.schema;
      }
    } catch { /* KV 不可用时降级为内存/直连 CF */ }
  }

  let result: ModelInputSchema | null = null;
  try {
    const json = await cfFetch<{ result?: { input?: { properties?: Record<string, any>; required?: string[] } } }>(
      account,
      `/accounts/${account.account_id}/ai/models/schema?model=${encodeURIComponent(model)}`,
      encryptionKey,
    );
    const input = json?.result?.input;
    if (input && typeof input === 'object') {
      result = {
        properties: input.properties || {},
        required: Array.isArray(input.required) ? input.required : [],
      };
    }
  } catch (err: any) {
    logger.warn('aiService', `[AI ModelSchema] 获取模型 ${model} 的 input schema 失败: ${err?.message || err}`);
  }

  const entry = { schema: result, fetchedAt: Date.now() };
  inputSchemaCache.set(key, entry);
  if (kv) {
    try {
      await kv.put(kvKey, JSON.stringify(entry), { expirationTtl: Math.ceil(SCHEMA_TTL_MS / 1000) });
    } catch { /* KV 写入失败不影响主流程 */ }
  }
  return result;
}

/**
 * 从模型 schema 中提取 speaker 枚举。非 TTS 模型或 schema 中无 speaker 参数时返回 null。
 */
export async function getModelSpeakerEnum(
  account: Account,
  model: string,
  encryptionKey: string,
  kv?: any,
): Promise<{ speakers: string[]; defaultSpeaker?: string } | null> {
  const schema = await getModelInputSchema(account, model, encryptionKey, kv);
  const speakerProp = schema?.properties?.speaker;
  if (speakerProp && Array.isArray(speakerProp.enum)) {
    return { speakers: speakerProp.enum, defaultSpeaker: speakerProp.default };
  }
  return null;
}

/**
 * 将请求中的 voice（可能是 OpenAI 音色名，或 CF 原生 speaker 名）解析为
 * 当前模型实际支持的 speaker。若均不匹配，回退到枚举中的第一个/默认值。
 */
export function resolveTtsSpeaker(
  requestedVoice: string | undefined,
  speakerEnum: { speakers: string[]; defaultSpeaker?: string } | null,
  voiceMap: Record<string, string>,
): string | undefined {
  const speakers = speakerEnum?.speakers || [];
  if (speakers.length === 0) {
    // 无 speaker 参数的模型（如 melotts），不设置 speaker
    return undefined;
  }
  if (requestedVoice && speakers.includes(requestedVoice)) {
    return requestedVoice;
  }
  if (requestedVoice && voiceMap[requestedVoice] && speakers.includes(voiceMap[requestedVoice])) {
    return voiceMap[requestedVoice];
  }
  return speakerEnum?.defaultSpeaker || speakers[0];
}

/**
 * TTS 高级可选参数（用户可选提交，均按模型 schema 白名单过滤后写入）。
 * 不支持的字段/非法值一律忽略，保证请求体对任意模型都合法。
 */
export interface TtsAdvancedOptions {
  encoding?: string;
  container?: string;
  sample_rate?: number;
  bit_rate?: number;
  lang?: string;
}

/**
 * 提取模型 schema 中可供前端"高级设置"展示的可选参数（排除 text/prompt/speaker 主字段）。
 * 返回 { 字段名: { type, enum?, default?, min?, max? } }，供 /models 接口下发。
 */
export function extractTtsAdvancedParams(schema: ModelInputSchema | null): Record<string, any> | undefined {
  if (!schema) return undefined;
  const excluded = new Set(['text', 'prompt', 'speaker']);
  const out: Record<string, any> = {};
  for (const [name, def] of Object.entries(schema.properties)) {
    if (excluded.has(name)) continue;
    const entry: any = { type: def.type };
    if (Array.isArray(def.enum)) entry.enum = def.enum;
    if (def.default !== undefined) entry.default = def.default;
    if (typeof def.minimum === 'number') entry.min = def.minimum;
    if (typeof def.maximum === 'number') entry.max = def.maximum;
    out[name] = entry;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * 按模型 schema 动态构造 TTS 请求体（只发送 schema 中存在的字段）：
 * - 文本字段：优先 `prompt`（melotts），否则 `text`（aura 系列）
 * - speaker：仅当 schema 含 speaker 属性时解析并设置
 * - encoding：默认 mp3（若模型支持）；用户显式提供合法值时覆盖
 * - 高级参数（container/sample_rate/bit_rate/lang）：仅当 schema 支持且值合法时写入
 * 返回 { body, speaker }，speaker 用于审计日志展示。
 */
export function buildTtsCfBody(
  schema: ModelInputSchema | null,
  input: string,
  voice: string | undefined,
  voiceMap: Record<string, string>,
  options?: TtsAdvancedOptions,
): { body: Record<string, any>; speaker: string | undefined } {
  const props = schema?.properties || {};
  const body: Record<string, any> = {};

  // 文本字段：melotts 用 prompt，aura 系列用 text
  const textKey = props.prompt ? 'prompt' : props.text ? 'text' : '';
  if (textKey) body[textKey] = input;

  // speaker（仅当模型支持）
  let speaker: string | undefined;
  if (props.speaker && Array.isArray(props.speaker.enum)) {
    speaker = resolveTtsSpeaker(
      voice,
      { speakers: props.speaker.enum, defaultSpeaker: props.speaker.default },
      voiceMap,
    );
    if (speaker) body.speaker = speaker;
  }

  // encoding：模型支持 mp3 时默认 mp3；用户显式提供的合法值覆盖
  const encodingEnum = Array.isArray(props.encoding?.enum) ? props.encoding.enum : [];
  if (encodingEnum.length > 0) {
    body.encoding = encodingEnum.includes('mp3') ? 'mp3' : encodingEnum[0];
    if (options?.encoding && encodingEnum.includes(options.encoding)) {
      body.encoding = options.encoding;
    }
  }

  // container：仅当 schema 支持且值合法时写入
  if (options?.container && Array.isArray(props.container?.enum) && props.container.enum.includes(options.container)) {
    body.container = options.container;
  }

  // sample_rate / bit_rate：仅当 schema 支持时写入，做基本数值校验
  const writeNumber = (name: 'sample_rate' | 'bit_rate', value: number | undefined) => {
    if (value == null || !props[name] || typeof props[name] !== 'object') return;
    const num = Number(value);
    if (Number.isNaN(num)) return;
    const def: any = props[name];
    if (typeof def.minimum === 'number' && num < def.minimum) return;
    if (typeof def.maximum === 'number' && num > def.maximum) return;
    body[name] = num;
  };
  writeNumber('sample_rate', options?.sample_rate);
  writeNumber('bit_rate', options?.bit_rate);

  // lang（melotts 等）：仅当 schema 支持时写入
  if (options?.lang && props.lang && typeof props.lang === 'object') {
    const def: any = props.lang;
    if (!Array.isArray(def.enum) || def.enum.includes(options.lang)) {
      body.lang = options.lang;
    }
  }

  return { body, speaker };
}

/**
 * 判断模型是否需要付费 Workers AI 计划。
 * Cloudflare 模型元数据（/ai/models/search）两种标记方式：
 *  1. properties 数组里的 { property_id: 'require_workers_paid', value: 'true' }（注意 value 是字符串而非布尔）
 *  2. 顶层字段 require_workers_paid（布尔或字符串）
 * 注意：不要用 price/价格做兜底——CF 上几乎所有模型都带价格（按 neurons 计费，
 * 超出每日免费额度才收费），价格存在 ≠ 需要付费计划账号。只有 require_workers_paid
 * 标记才表示"仅限 Workers Paid 计划账号调用"。
 */
function isTruthyValue(v: any): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

export function modelRequiresWorkersPaid(m: any): boolean {
  const props = Array.isArray(m?.properties) ? m.properties : [];
  if (props.some((p: any) => p?.property_id === 'require_workers_paid' && isTruthyValue(p?.value))) return true;
  if (isTruthyValue(m?.require_workers_paid)) return true;
  return false;
}

// ============ 付费模型名缓存 ============
// require_workers_paid 只存在于 CF /ai/models/search 的模型元数据里，而账号路由层只拿到
// 模型名字符串，所以刷新模型列表时顺带记下哪些模型是付费模型，供 selectBestAccount 过滤账号。
const paidModelNames = new Set<string>();

/** 由 /models 处理路径调用，用最新元数据重建付费模型名集合。 */
export function cachePaidModelNames(models: any[]): void {
  paidModelNames.clear();
  for (const m of models) {
    const name = m?.name || m?.id;
    if (name && modelRequiresWorkersPaid(m)) paidModelNames.add(name);
  }
}

/** 模型名是否为付费模型。缓存尚未建立时返回 false（保持既有行为，不做额外限制）。 */
export function isPaidModelName(name: string | null | undefined): boolean {
  return !!name && paidModelNames.has(name);
}

/** 清空付费模型名缓存。 */
export function clearPaidModelCache(): void {
  paidModelNames.clear();
}
