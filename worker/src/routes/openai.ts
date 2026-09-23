import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import type { Env } from '../types';
import { setExhausted, incrementQuota, addAuditLog, getActiveAccountsByFeature, hasPaidAccountByFeature } from '../db/models';
import { getAuthHeaders, cfFetchRaw } from '../services/cfApi';
import { getModelInputSchema, extractTtsAdvancedParams, buildTtsCfBody, modelRequiresWorkersPaid, cachePaidModelNames } from '../services/aiService';
import { selectBestAccount, invalidateAiCache, clearOptimistic } from '../services/quotaTracker';
import { estimateNeurons, estimateImageNeurons, estimateTtsNeurons, estimateTranslationNeurons, estimateEmbeddingsNeurons, estimateAsrNeurons } from '../services/pricing';
import { getRequestId } from '../middleware/requestId';
import { logger } from '../services/logger';

/** Upstream status codes that should trigger account rotation. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const MAX_RETRY_PER_ACCOUNT = 1; // 每个账户最多重试 1 次，失败立即换账户

/** Delay before first heartbeat (ms) — only send heartbeat if upstream TTFB exceeds this. */
const HEARTBEAT_DELAY_MS = 15_000;

/** SSE heartbeat interval (ms) — repeat interval after first heartbeat. */
const HEARTBEAT_INTERVAL_MS = 10_000;

function isNeuronLimitError(text: string): boolean {
  // 优先解析 JSON 精确匹配 CF 错误码 4006，避免字符串 "4006" 误匹配时间戳/请求ID等
  try {
    const json = JSON.parse(text);
    const errors = json?.errors || json?.result?.errors || (Array.isArray(json) ? json : []);
    if (Array.isArray(errors) && errors.some((e: any) => e?.code === 4006)) {
      return true;
    }
  } catch { /* 非 JSON，回退到关键词匹配 */ }
  // 兜底：CF 错误格式变化时通过特异关键词识别
  return text.includes('daily free allocation') || text.includes('neuron limit');
}

function isRetryableError(status: number, errorText: string): boolean {
  if (RETRYABLE_STATUS.has(status)) return true;
  return isNeuronLimitError(errorText);
}

/** Map upstream HTTP status to an OpenAI-style semantic error code string. */
function upstreamStatusToCode(status: number): string {
  const map: Record<number, string> = {
    400: 'bad_request',
    401: 'authentication_error',
    403: 'permission_denied',
    404: 'not_found',
    413: 'request_too_large',
    429: 'rate_limit_exceeded',
  };
  return map[status] || 'upstream_error';
}

const app = new Hono<{ Bindings: Env }>();

// Helper: write [DONE] to guarantee OpenAI SDK can return
function writeSseDone(s: any): void {
  s.write('data: [DONE]\n\n');
}

/** Send an error as an SSE event (for stream mode when headers already sent). */
function writeSseError(s: any, errorObj: Record<string, any>): void {
  s.write(`data: ${JSON.stringify({ error: errorObj })}\n\n`);
  s.write('data: [DONE]\n\n');
}

/**
 * Pipe CF stream response to an existing Hono stream.
 * Extracts usage, updates quota, writes audit log.
 */
async function pipeCfStream(
  s: any, body: any, account: any, cfResp: Response, env: Env, rid: string,
): Promise<void> {
  let streamStatus: 'success' | 'upstream_error' = 'success';
  let seenDone = false;
  let finalUsage: any = null;

  try {
    const reader = cfResp.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // 写入原始 chunk（保持边界）
      const chunk = decoder.decode(value, { stream: true });
      await s.write(chunk);

      // 同时解析 usage（从累积的 buffer 中提取）
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') {
            seenDone = true;
          } else {
            try {
              const json = JSON.parse(payload);
              if (json.usage) finalUsage = json.usage;
            } catch { /* not JSON */ }
          }
        }
      }
    }
    // 处理剩余 buffer
    if (buffer) {
      if (buffer.startsWith('data: ') && buffer.slice(6).trim() === '[DONE]') seenDone = true;
    }
  } catch (err: any) {
    streamStatus = 'upstream_error';
    logger.error('openai', `[${rid}] Stream error: ${err.message}`);
  } finally {
    if (!seenDone) writeSseDone(s);

    // 估算递增 + audit log
    if (finalUsage) {
      const cachedTokens = finalUsage.prompt_tokens_details?.cached_tokens || 0;
      const neurons = estimateNeurons(body.model, finalUsage.prompt_tokens || 0, finalUsage.completion_tokens || 0, cachedTokens);
      await incrementQuota(env.DB, account.id, 'ai_neurons', neurons);
      await clearOptimistic(env, account.id);  // 清除乐观预估
      await invalidateAiCache(env);
      try {
        await addAuditLog(env.DB, {
          account_id: account.id, action: 'ai_chat_completion', target: body.model,
          detail: `[${rid}] stream tokens: in=${finalUsage.prompt_tokens || 0} out=${finalUsage.completion_tokens || 0} total=${finalUsage.total_tokens || 0} cached=${cachedTokens} neurons=${neurons}`,
          status: streamStatus === 'success' ? 'success' : 'error',
        });
      } catch {}
    } else {
      try {
        await addAuditLog(env.DB, {
          account_id: account.id, action: 'ai_chat_completion', target: body.model,
          detail: `[${rid}] stream ${streamStatus} tokens: none (no usage in SSE)`,
          status: streamStatus === 'success' ? 'success' : 'error',
        });
      } catch {}
    }
  }
}

/** Process non-stream success: normalize response, estimate neurons, audit log. */
async function processNonStreamSuccess(
  c: any, body: any, account: any, cfResp: Response, rid: string
): Promise<Response> {
  const env: Env = c.env;
  const data = await cfResp.json() as any;
  if (!data.id) data.id = `chatcmpl-${crypto.randomUUID()}`;
  if (!data.object) data.object = 'chat.completion';
  if (!data.model && body.model) data.model = body.model;
  if (!data.usage) data.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  let neurons = 0;
  if (data.usage) {
    const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens || 0;
    neurons = estimateNeurons(body.model, data.usage.prompt_tokens || 0, data.usage.completion_tokens || 0, cachedTokens);
    await incrementQuota(env.DB, account.id, 'ai_neurons', neurons);
    await clearOptimistic(env, account.id);  // 清除乐观预估
    await invalidateAiCache(env);
  }
  try {
    await addAuditLog(env.DB, {
      account_id: account.id, action: 'ai_chat_completion', target: body.model,
      detail: `[${rid}] non-stream tokens: in=${data.usage?.prompt_tokens || 0} out=${data.usage?.completion_tokens || 0} total=${data.usage?.total_tokens || 0} cached=${data.usage?.prompt_tokens_details?.cached_tokens || 0} neurons=${neurons}`,
      status: 'success',
    });
  } catch {}
  return c.json(data);
}

/** Helper: fetch from CF AI with abort timeout. */
async function fetchCf(account: any, body: any, env: Env, timeoutMs: number): Promise<Response> {
  const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/v1/chat/completions`;
  const headers = await getAuthHeaders(account, env.ENCRYPTION_KEY);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(cfUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return resp;
  } catch (fetchErr: any) {
    clearTimeout(timeoutId);
    if (fetchErr.name === 'AbortError') throw new Error(`Request timeout after ${timeoutMs}ms`, { cause: fetchErr });
    throw fetchErr;
  }
}

app.get('/models', async (c) => {
  const account = await selectBestAccount(c.env, 'ai_neurons');
  if (!account) return c.json({ object: 'list', data: [] });

  const taskFilter = c.req.query('task');
  const resp = await cfFetchRaw(account, `/accounts/${account.account_id}/ai/models/search`, c.env.ENCRYPTION_KEY);
  const json = await resp.json() as any;

  let models = (json.result || []);

  // 刷新付费模型名缓存（账号路由层据此把付费模型限制在付费账号上）
  cachePaidModelNames(models);

  // 无付费计划（paid/enterprise）活跃账号时隐藏付费模型：调用必然失败，留在列表里只会误导。
  // 由用户在「账号管理」中标注计划类型（不标即视为 free）。
  if (!(await hasPaidAccountByFeature(c.env.DB, 'ai'))) {
    models = models.filter((m: any) => !modelRequiresWorkersPaid(m));
  }

  // Filter by task if specified (normalize both to handle "text-generation" vs "Text Generation")
  if (taskFilter) {
    const normalizedFilter = taskFilter.toLowerCase().replace(/-/g, ' ');
    models = models.filter((m: any) => {
      const taskName = m.task?.name || m.task || '';
      const normalizedTaskName = taskName.toLowerCase().replace(/-/g, ' ');
      return normalizedTaskName.includes(normalizedFilter);
    });
  }

  // TTS 模型：一次性获取模型 schema，下发 speaker 枚举与高级可选参数
  const ttsModelMeta: Record<string, { speakers?: string[]; default_speaker?: string; advanced_params?: Record<string, any> }> = {};
  if (taskFilter && taskFilter.toLowerCase().replace(/-/g, ' ').includes('text to speech')) {
    await Promise.all(models.map(async (m: any) => {
      const modelId = m.name || m.id;
      if (!modelId) return;
      const schema = await getModelInputSchema(account, modelId, c.env.ENCRYPTION_KEY, c.env.KV);
      if (!schema) return;
      const speakerProp = schema.properties?.speaker;
      ttsModelMeta[modelId] = {
        speakers: Array.isArray(speakerProp?.enum) ? speakerProp.enum : [],
        default_speaker: speakerProp?.default,
        advanced_params: extractTtsAdvancedParams(schema),
      };
    }));
  }

  const data = models.map((m: any) => {
    const modelId = m.name || m.id;
    const meta = ttsModelMeta[modelId] || {};
    return {
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'cloudflare',
      task: m.task?.name || m.task || undefined,
      require_workers_paid: modelRequiresWorkersPaid(m),
      speakers: meta.speakers || undefined,
      default_speaker: meta.default_speaker || undefined,
      advanced_params: meta.advanced_params || undefined,
    };
  });
  return c.json({ object: 'list', data });
});

app.post('/chat/completions', async (c) => {
  const specifiedAccountId = c.req.header('X-Account-ID');
  const body = await c.req.json();
  const isStream = body.stream === true;

  // 流式请求强制要求 CF 返回 usage，否则无法记账
  if (isStream && !body.stream_options?.include_usage) {
    body.stream_options = { ...(body.stream_options || {}), include_usage: true };
  }

  const rid = getRequestId(c);
  const env = c.env;

  // ================================================================
  // STREAM MODE — start stream immediately with heartbeat to prevent
  // client TTFB timeout (CF AI can take 30+ seconds before first byte)
  // ================================================================
  if (isStream) {
    return stream(c, async (s) => {
      let intervalId: ReturnType<typeof setInterval> | null = null;

      // Delay first heartbeat — most responses arrive before this.
      const delayId = setTimeout(() => {
        s.write(': heartbeat\n\n');
        intervalId = setInterval(() => {
          s.write(': heartbeat\n\n');
        }, HEARTBEAT_INTERVAL_MS);
      }, HEARTBEAT_DELAY_MS);

      const stopHeartbeat = () => {
        clearTimeout(delayId);
        if (intervalId) clearInterval(intervalId);
      };

      try {
        let lastError = '';

        // --- X-Account-ID specified: use that account directly, no rotation ---
        if (specifiedAccountId && specifiedAccountId !== 'auto') {
          const allAccounts = await getActiveAccountsByFeature(env.DB, 'ai');
          const specified = allAccounts.find(a => a.account_id === specifiedAccountId);
          if (!specified) {
            stopHeartbeat();
            writeSseError(s, { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' });
            return;
          }

          let cfResp: Response;
          try {
            cfResp = await fetchCf(specified, body, env, 600000);
          } catch (netErr: any) {
            stopHeartbeat();
            const errMsg = `Network error: ${netErr.message}`;
            logger.error('openai', `[${rid}] ${errMsg}`);
            try { await addAuditLog(env.DB, { account_id: specified.id, action: 'ai_chat_completion', target: body.model, detail: `[${rid}] ${errMsg}`, status: 'error' }); } catch {}
            writeSseError(s, { message: errMsg, type: 'upstream_error', code: 'NETWORK_ERROR' });
            return;
          }

          if (!cfResp.ok) {
            const errorText = await cfResp.text();
            stopHeartbeat();
            if (isNeuronLimitError(errorText)) {
              await setExhausted(env.DB, specified.id, 'ai_neurons');
              await invalidateAiCache(env);
            }
            writeSseError(s, { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) });
            return;
          }

          stopHeartbeat();
          await pipeCfStream(s, body, specified, cfResp, env, rid);
          return;
        }

        // --- while + selectBestAccount rotation loop ---
        const skipped = new Set<number>();
        const retryCount = new Map<number, number>();
        let lastStatus = 502;
        let quotaExhausted = false;

        while (true) {
          const account = await selectBestAccount(env, 'ai_neurons', skipped, body.model);
          if (!account) break;
          if (!account.account_id) { skipped.add(account.id); continue; }

          let cfResp: Response;
          try {
            cfResp = await fetchCf(account, body, env, 600000);
          } catch (netErr: any) {
            const errMsg = `Network error: ${netErr.message || netErr}`;
            logger.warn('openai', `[${rid}] Account ${account.name} ${errMsg}`);
            lastError = errMsg;
            lastStatus = 502;
            try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_chat_completion', target: body.model, detail: `[${rid}] ${errMsg}`, status: 'error' }); } catch {}
            const count = (retryCount.get(account.id) || 0) + 1;
            retryCount.set(account.id, count);
            if (count >= MAX_RETRY_PER_ACCOUNT) skipped.add(account.id);
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }

          if (!cfResp.ok) {
            const errorText = await cfResp.text();
            lastError = errorText;
            lastStatus = cfResp.status;

            if (isRetryableError(cfResp.status, errorText)) {
              if (isNeuronLimitError(errorText)) {
                quotaExhausted = true;
                logger.warn('openai', `[${rid}] Account ${account.name} neuron limit hit (4006), rotating`);
                await setExhausted(env.DB, account.id, 'ai_neurons');
                await invalidateAiCache(env);
                skipped.add(account.id);
                try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_chat_completion', target: body.model, detail: `[${rid}] 4006 switching`, status: 'error' }); } catch {}
              } else {
                logger.warn('openai', `[${rid}] Account ${account.name} upstream ${cfResp.status}, rotating`);
                try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_chat_completion', target: body.model, detail: `[${rid}] upstream ${cfResp.status}, switching`, status: 'error' }); } catch {}
              }
              await new Promise(r => setTimeout(r, 1000));
              continue;
            }

            // Non-retryable — send error as SSE
            stopHeartbeat();
            writeSseError(s, { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) });
            return;
          }

          // Success — pipe stream
          stopHeartbeat();
          await pipeCfStream(s, body, account, cfResp, env, rid);
          return;
        }

        // 区分失败原因：真配额耗尽才报 quota_exceeded；否则返回真实上游/网络错误，避免误报
        stopHeartbeat();
        if (quotaExhausted) {
          logger.error('openai', `[${rid}] All accounts exhausted. Last error: ${lastError}`);
          writeSseError(s, { message: 'All accounts exhausted', type: 'quota_exceeded', code: 'ALL_ACCOUNTS_EXHAUSTED', last_error: lastError || 'Unknown error' });
        } else {
          logger.error('openai', `[${rid}] Upstream error after retries: ${lastError}`);
          writeSseError(s, { message: lastError || 'All accounts failed', type: 'upstream_error', code: upstreamStatusToCode(lastStatus) });
        }
      } finally {
        stopHeartbeat();
      }
    });
  }

  // ================================================================
  // NON-STREAM MODE — original logic (no heartbeat needed)
  // ================================================================
  let lastError = '';

  // X-Account-ID 指定账户：直接查该账户，不走循环
  if (specifiedAccountId && specifiedAccountId !== 'auto') {
    const allAccounts = await getActiveAccountsByFeature(env.DB, 'ai');
    const specified = allAccounts.find(a => a.account_id === specifiedAccountId);
    if (!specified) {
      return c.json({
        error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
      }, 404);
    }
    let cfResp: Response;
    try {
      cfResp = await fetchCf(specified, body, env, 300000);
    } catch (netErr: any) {
      return c.json({ error: { message: `Network error: ${netErr.message}`, type: 'upstream_error', code: 'NETWORK_ERROR' } }, 502);
    }
    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      if (isNeuronLimitError(errorText)) {
        await setExhausted(env.DB, specified.id, 'ai_neurons');
        await invalidateAiCache(env);
      }
      return c.json({ error: { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }
    return await processNonStreamSuccess(c, body, specified, cfResp, rid);
  }

  // while 循环路由
  const skipped = new Set<number>();
  const retryCount = new Map<number, number>();
  let lastStatus = 502;
  let quotaExhausted = false;

  while (true) {
    const account = await selectBestAccount(env, 'ai_neurons', skipped, body.model);
    if (!account) break;
    if (!account.account_id) { skipped.add(account.id); continue; }

    let cfResp: Response;
    try {
      cfResp = await fetchCf(account, body, env, 300000);
    } catch (netErr: any) {
      const errMsg = `Network error: ${netErr.message || netErr}`;
      logger.warn('openai', `[${rid}] Account ${account.name} ${errMsg}`);
      lastError = errMsg;
      lastStatus = 502;
      try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_chat_completion', target: body.model, detail: `[${rid}] ${errMsg}`, status: 'error' }); } catch {}
      const count = (retryCount.get(account.id) || 0) + 1;
      retryCount.set(account.id, count);
      if (count >= MAX_RETRY_PER_ACCOUNT) skipped.add(account.id);
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }

    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      lastError = errorText;
      lastStatus = cfResp.status;

      if (isRetryableError(cfResp.status, errorText)) {
        if (isNeuronLimitError(errorText)) {
          quotaExhausted = true;
          logger.warn('openai', `[${rid}] Account ${account.name} neuron limit hit (4006), rotating`);
          await setExhausted(env.DB, account.id, 'ai_neurons');
          await invalidateAiCache(env);
          skipped.add(account.id);
          try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_chat_completion', target: body.model, detail: `[${rid}] 4006 switching`, status: 'error' }); } catch {}
        } else {
          logger.warn('openai', `[${rid}] Account ${account.name} upstream ${cfResp.status}, rotating`);
          try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_chat_completion', target: body.model, detail: `[${rid}] upstream ${cfResp.status}, switching`, status: 'error' }); } catch {}
        }
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      return c.json({ error: { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }

    // 成功
    return await processNonStreamSuccess(c, body, account, cfResp, rid);
  }

  // 区分失败原因：真配额耗尽才报 quota_exceeded；否则返回真实上游/网络错误，避免误报
  if (quotaExhausted) {
    logger.error('openai', `[${rid}] All accounts exhausted. Last error: ${lastError}`);
    return c.json({ error: { message: 'All accounts exhausted', type: 'quota_exceeded', code: 'ALL_ACCOUNTS_EXHAUSTED', last_error: lastError || 'Unknown error' } }, 429);
  }
  logger.error('openai', `[${rid}] Upstream error after retries: ${lastError}`);
  return c.json({ error: { message: lastError || 'All accounts failed', type: 'upstream_error', code: upstreamStatusToCode(lastStatus) } }, lastStatus as any);
});

app.post('/images/generations', async (c) => {
  const specifiedAccountId = c.req.header('X-Account-ID');
  const body = await c.req.json();
  const { model, prompt, image } = body;
  const rid = getRequestId(c);
  const env = c.env;

  if (!model || !prompt) {
    return c.json({
      error: { message: 'model and prompt are required', type: 'invalid_request_error', code: 'bad_request' },
    }, 400);
  }

  // 根据模型族构建 CF 请求体（不同模型参数名不同）
  // Flux 1: steps (非 num_steps)，不支持 width/height/guidance/negative_prompt；schema 无 image 字段，不支持图生图
  // Flux 2: multipart 表单；steps 固定 4 不可调；支持 width/height/guidance/seed；图生图/editing 用 input_image_0（二进制参考图）
  // SDXL/dreamshaper: schema 有 image_b64(string)，但 CF runtime 实测对 image_b64 返回 "image tensor not present" / "unexpected shape"，REST 通道不可用
  // leonardo lucid/phoenix: schema 无 image 字段，不支持图生图
  const isFlux = model.includes('flux');
  const isFlux2 = model.includes('flux-2');
  // 仅 Flux 2 族支持图生图；其他模型收到参考图时显式拒绝，避免发到 CF 拿到模糊上游错误
  if (image && !isFlux2) {
    return c.json({ error: { message: `model ${model} does not support image-to-image via this API; only Flux 2 family (flux-2-*) supports img2img with a reference image`, type: 'invalid_request_error', code: 'img2img_unsupported' } }, 400);
  }
  // 预处理 base64 图片为 Uint8Array（用于 Flux 2 二进制附件或纯 base64 提取）
  let cleanBase64 = '';
  let imageBytes: Uint8Array | null = null;
  if (image) {
    cleanBase64 = image.replace(/^data:image\/[a-zA-Z+]+;base64,/, '').trim();
    try { imageBytes = Uint8Array.from(atob(cleanBase64), c => c.charCodeAt(0)); } catch {}
  }

  /**
   * 通过 magic bytes 检测图像真实格式。
   * CF Flux 2 multipart 接收时会校验 Blob type 与文件头 magic bytes 是否一致，
   * 硬编码 image/jpeg 但实际是 PNG 时会上游 3043。
   */
  const detectImageMime = (buf: Uint8Array): { mime: string; ext: string } => {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return { mime: 'image/jpeg', ext: 'jpg' };
    }
    if (
      buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
    ) {
      return { mime: 'image/png', ext: 'png' };
    }
    if (
      buf.length >= 12 &&
      buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) {
      return { mime: 'image/webp', ext: 'webp' };
    }
    if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
      return { mime: 'image/gif', ext: 'gif' };
    }
    return { mime: 'application/octet-stream', ext: 'bin' };
  };
  const isSD = model.includes('stable-diffusion') || model.includes('dreamshaper');
  const isLucid = model.includes('lucid'); // lucid-origin 不支持 negative_prompt
  const cfBody: Record<string, any> = { prompt };

  if (isFlux) {
    if (isFlux2) {
      // Flux 2 (klein/base/dev): multipart 表单；steps 固定为 4 不可调，不发送；图生图/editing 用 input_image_0（base64 参考图，官方字段名）
      if (body.width) cfBody.width = body.width;
      if (body.height) cfBody.height = body.height;
      if (body.guidance) cfBody.guidance = body.guidance;
      if (body.seed !== undefined) cfBody.seed = body.seed;
    } else {
      // Flux 1 (schnell 等): JSON，参数名为 steps（非 num_steps，官方已确认，仅 prompt+steps，无 seed）
      if (body.num_steps) cfBody.steps = body.num_steps;
    }
  } else if (isSD) {
    if (cleanBase64) {
      cfBody.image_b64 = cleanBase64; // SD 族 img2img：image_b64（官方 schema 字段，非 image）；纯 img2img 无需 mask
    }
    if (body.width) cfBody.width = body.width;
    if (body.height) cfBody.height = body.height;
    if (body.num_steps) cfBody.num_steps = body.num_steps;
    if (body.guidance) cfBody.guidance = body.guidance;
    if (body.negative_prompt) cfBody.negative_prompt = body.negative_prompt;
    if (body.strength) cfBody.strength = body.strength;
    if (body.seed !== undefined) cfBody.seed = body.seed;
  } else {
    if (cleanBase64) cfBody.image_b64 = cleanBase64;
    if (body.width) cfBody.width = body.width;
    if (body.height) cfBody.height = body.height;
    if (body.num_steps) cfBody.num_steps = body.num_steps;
    if (body.guidance) cfBody.guidance = body.guidance;
    if (!isLucid && body.negative_prompt) cfBody.negative_prompt = body.negative_prompt;
    if (body.seed !== undefined) cfBody.seed = body.seed;
  }

  /**
   * 构建 CF 请求体和 Content-Type
   * Flux 2 模型需要 multipart 表单格式，其他模型用 JSON
   */
  const buildRequest = (): { body: string | FormData; contentType?: string } => {
    if (isFlux2) {
      // Flux 2 模型需要 multipart/form-data，Workers fetch 原生支持 FormData；字段为 prompt + 可选 image(文件附件) / width/height/guidance/seed
      const formData = new FormData();
      formData.append('prompt', prompt);
      if (imageBytes && imageBytes.length > 0) {
        const { mime: imgMime, ext: imgExt } = detectImageMime(imageBytes);
        formData.append('input_image_0', new Blob([imageBytes], { type: imgMime }), `input.${imgExt}`);
      }
      if (cfBody.width !== undefined) formData.append('width', String(cfBody.width));
      if (cfBody.height !== undefined) formData.append('height', String(cfBody.height));
      if (cfBody.guidance !== undefined) formData.append('guidance', String(cfBody.guidance));
      if (cfBody.seed !== undefined) formData.append('seed', String(cfBody.seed));
      return { body: formData };
    }
    return { body: JSON.stringify(cfBody), contentType: 'application/json' };
  };

  /** 从 CF 错误响应中提取可读的错误消息 */
  const extractCfError = (raw: string): string => {
    try {
      const json = JSON.parse(raw);
      if (json.errors?.[0]?.message) return json.errors[0].message;
      if (json.error?.message) return json.error.message;
      if (json.message) return json.message;
    } catch {}
    return raw;
  };

  /** 处理 CF 图片生成成功响应 */
  async function handleSuccess(account: any, cfResp: Response): Promise<Response> {
    const contentType = cfResp.headers.get('content-type') || '';
    let b64Image: string;

    logger.debug('openai', `[AI Image][${rid}] CF response content-type: ${contentType}, status: ${cfResp.status}`);

    if (contentType.includes('application/json')) {
      const json = await cfResp.json() as any;
      logger.debug('openai', `[AI Image][${rid}] CF JSON response keys: ${JSON.stringify(Object.keys(json))}`);
      if (!json.success) {
        throw new Error(json.errors?.[0]?.message || 'CF image generation failed');
      }
      // 兼容多种 JSON 响应格式
      b64Image = json.result?.image || json.image || json.result?.images?.[0] || '';
    } else if (contentType.startsWith('image/') || contentType.includes('octet-stream')) {
      // 二进制图片响应 — 分块转 base64
      const buf = await cfResp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      b64Image = btoa(binary);
    } else {
      // 未知 content-type — 尝试作为文本/base64 读取
      const text = await cfResp.text();
      if (text.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(text.trim())) {
        b64Image = text.trim();
      } else {
        try {
          const json = JSON.parse(text);
          b64Image = json.result?.image || json.image || json.result?.images?.[0] || '';
        } catch {
          // 最后尝试作为二进制
          b64Image = btoa(text);
        }
      }
    }

    if (!b64Image) {
      logger.error('openai', `[AI Image][${rid}] CF returned empty image. content-type: ${contentType}`);
      throw new Error('CF returned empty image');
    }

    const neurons = estimateImageNeurons(model);
    await incrementQuota(env.DB, account.id, 'ai_neurons', neurons);
    await clearOptimistic(env, account.id);
    await invalidateAiCache(env);
    logger.debug('openai', `[AI Image][${rid}] estimated ${neurons} neurons for account ${account.name}`);
    try {
      await addAuditLog(env.DB, {
        account_id: account.id, action: 'ai_image_generation', target: model,
        detail: `[${rid}] ${image ? 'image-to-image' : 'text-to-image'} neurons=${neurons}`,
        status: 'success',
      });
    } catch {}

    return c.json({
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: b64Image, neurons }],
    });
  }

  // --- X-Account-ID 指定账户 ---
  if (specifiedAccountId && specifiedAccountId !== 'auto') {
    const allAccounts = await getActiveAccountsByFeature(env.DB, 'ai');
    const specified = allAccounts.find(a => a.account_id === specifiedAccountId);
    if (!specified) {
      return c.json({
        error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
      }, 404);
    }

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${specified.account_id}/ai/run/${model}`;
    const authHeaders = await getAuthHeaders(specified, env.ENCRYPTION_KEY);
    const { body: reqBody, contentType: reqCt } = buildRequest();
    let cfResp: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000);
      cfResp = await fetch(cfUrl, {
        method: 'POST',
        headers: { ...(reqCt ? { 'Content-Type': reqCt } : {}), ...authHeaders },
        body: reqBody,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (netErr: any) {
      const errMsg = `Network error: ${netErr.message}`;
      logger.error('openai', `[AI Image][${rid}] ${errMsg}`);
      try { await addAuditLog(env.DB, { account_id: specified.id, action: 'ai_image_generation', target: model, detail: `[${rid}] ${errMsg}`, status: 'error' }); } catch {}
      return c.json({ error: { message: errMsg, type: 'upstream_error', code: 'NETWORK_ERROR' } }, 502);
    }

    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      logger.error('openai', `[AI Image][${rid}] CF upstream error ${cfResp.status} for account ${specified.name}: ${errorText.slice(0, 1000)}`);
      if (isNeuronLimitError(errorText)) {
        await setExhausted(env.DB, specified.id, 'ai_neurons');
        await invalidateAiCache(env);
      }
      return c.json({ error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }

    return await handleSuccess(specified, cfResp);
  }

  // --- 自动轮换账户 ---
  const skipped = new Set<number>();
  let lastError = '';
  let lastStatus = 502; // 兜底：上游/网络错误默认 502
  let quotaExhaustedCount = 0; // 因 4006 配额耗尽的账户数
  let totalTriedCount = 0; // 总共尝试过的账户数

  const accountErrors: Array<{ account: string; status: number; error: string }> = [];
  while (true) {
    const account = await selectBestAccount(env, 'ai_neurons', skipped, model);
    if (!account) break;
    if (!account.account_id) { skipped.add(account.id); continue; }

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
    const authHeaders = await getAuthHeaders(account, env.ENCRYPTION_KEY);
    const { body: reqBody, contentType: reqCt } = buildRequest();
    totalTriedCount++;
    let cfResp: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000);
      cfResp = await fetch(cfUrl, {
        method: 'POST',
        headers: { ...(reqCt ? { 'Content-Type': reqCt } : {}), ...authHeaders },
        body: reqBody,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (netErr: any) {
      const errMsg = `Network error: ${netErr.message || netErr}`;
      logger.warn('openai', `[AI Image][${rid}] Account ${account.name} ${errMsg}`);
      lastError = errMsg;
      lastStatus = 502;
      accountErrors.push({ account: account.name, status: 502, error: errMsg });
      try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_image_generation', target: model, detail: `[${rid}] ${errMsg}`, status: 'error' }); } catch {}
      skipped.add(account.id);
      continue;
    }

    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      logger.warn('openai', `[AI Image][${rid}] CF upstream error ${cfResp.status} for account ${account.name}: ${errorText.slice(0, 1000)}`);
      lastError = errorText;
      lastStatus = cfResp.status;
      accountErrors.push({ account: account.name, status: cfResp.status, error: extractCfError(errorText) });

      if (isRetryableError(cfResp.status, errorText)) {
        if (isNeuronLimitError(errorText)) {
          quotaExhaustedCount++;
          logger.warn('openai', `[AI Image][${rid}] Account ${account.name} neuron limit hit (4006), rotating`);
          await setExhausted(env.DB, account.id, 'ai_neurons');
          await invalidateAiCache(env);
          skipped.add(account.id);
          try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_image_generation', target: model, detail: `[${rid}] 4006 switching`, status: 'error' }); } catch {}
        } else {
          logger.warn('openai', `[AI Image][${rid}] Account ${account.name} upstream ${cfResp.status}, rotating`);
          skipped.add(account.id);
          try { await addAuditLog(env.DB, { account_id: account.id, action: 'ai_image_generation', target: model, detail: `[${rid}] upstream ${cfResp.status}, switching`, status: 'error' }); } catch {}
        }
        continue;
      }

      return c.json({ error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status), details: accountErrors } }, cfResp.status as any);
    }

    // 成功
    return await handleSuccess(account, cfResp);
  }

  // 区分失败原因：只有所有尝试过的账户全部是 4006 配额耗尽，才报 quota_exceeded；
  // 若有账户因参数或内部错误失败，必须暴露真实上游错误和详情，避免误报耗尽
  if (quotaExhaustedCount > 0 && quotaExhaustedCount === totalTriedCount) {
    logger.error('openai', `[AI Image][${rid}] All accounts exhausted. Last error: ${lastError}`);
    return c.json({
      error: {
        message: 'All accounts have reached daily neuron limit',
        type: 'quota_exceeded',
        code: 'ALL_ACCOUNTS_EXHAUSTED',
        details: accountErrors,
        last_error: extractCfError(lastError) || 'Unknown error',
      },
    }, 429);
  }
  logger.error('openai', `[AI Image][${rid}] Upstream error after retries: ${lastError}, details: ${JSON.stringify(accountErrors)}`);
  return c.json({ error: { message: extractCfError(lastError) || 'All accounts failed', type: 'upstream_error', code: upstreamStatusToCode(lastStatus), details: accountErrors } }, lastStatus as any);
});

// ================================================================
// POST /audio/speech — 文生语音 TTS（OpenAI-compatible）
// ================================================================
// 注意：不同 TTS 模型的 speaker 枚举完全不同（如 aura-2-en 38 个希腊名、aura-2-es 10 个西/意名、
// aura-1 12 个、melotts 无 speaker 参数），因此不能写死全局列表，须由 getModelSpeakerEnum 动态获取。
// VOICE_MAP 仅作为 OpenAI 音色名 → CF speaker 的备选映射，最终仍以模型 schema 枚举为准。
const VOICE_MAP: Record<string, string> = {
  alloy: 'luna', echo: 'mars', fable: 'athena', onyx: 'apollo', nova: 'aurora', shimmer: 'iris',
};

app.post('/audio/speech', async (c) => {
  const specifiedAccountId = c.req.header('X-Account-ID');
  const { model, input, voice, encoding, container, sample_rate, bit_rate, lang } = await c.req.json();
  const rid = getRequestId(c);
  const env = c.env;

  if (!model || !input) {
    return c.json({
      error: { message: 'model and input are required', type: 'invalid_request_error', code: 'bad_request' },
    }, 400);
  }

  /** 从 CF 错误响应中提取可读的错误消息 */
  const extractCfError = (raw: string): string => {
    try {
      const json = JSON.parse(raw);
      if (json.errors?.[0]?.message) return json.errors[0].message;
      if (json.error?.message) return json.error.message;
      if (json.message) return json.message;
    } catch {}
    return raw;
  };

  /** 按模型 schema 动态构造 CF 请求体（melotts 用 prompt+lang，aura 系列用 text+speaker+encoding） */
  let resolvedSpeaker: string | undefined;
  const buildTtsBody = async (account: any): Promise<Record<string, any>> => {
    const inputSchema = await getModelInputSchema(account, model, env.ENCRYPTION_KEY, env.KV);
    const { body, speaker } = buildTtsCfBody(inputSchema, input, voice, VOICE_MAP, {
      encoding,
      container,
      sample_rate,
      bit_rate,
      lang,
    });
    resolvedSpeaker = speaker;
    return body;
  };

  /** 处理 TTS 成功响应 — 返回二进制音频（兼容 JSON base64 响应） */
  async function handleTtsSuccess(account: any, cfResp: Response): Promise<Response> {
    const rawContentType = cfResp.headers.get('content-type') || 'audio/mpeg';
    const arrayBuffer = await cfResp.arrayBuffer();

    const toBase64 = (buf: ArrayBuffer): string => {
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      return btoa(binary);
    };

    let b64Audio: string;
    let audioContentType = rawContentType;

    if (rawContentType.includes('json')) {
      // melotts 等模型可能返回 JSON { audio: "base64..." } 或被 SDK 解包后的结构
      const text = new TextDecoder().decode(arrayBuffer);
      try {
        const json = JSON.parse(text);
        const findBase64 = (obj: any, depth = 0): string => {
          if (depth > 5 || obj == null) return '';
          if (typeof obj === 'string') {
            return obj.length > 100 && /^[A-Za-z0-9+/=]+$/.test(obj) ? obj : '';
          }
          if (typeof obj !== 'object') return '';
          if (typeof obj.audio === 'string' && obj.audio.length > 50) return obj.audio;
          for (const v of Object.values(obj)) {
            const r = findBase64(v, depth + 1);
            if (r) return r;
          }
          return '';
        };
        b64Audio = findBase64(json);
      } catch {
        b64Audio = toBase64(new TextEncoder().encode(text).buffer as ArrayBuffer);
        audioContentType = 'audio/mpeg';
      }
    } else {
      b64Audio = toBase64(arrayBuffer);
    }

    // 音频为空：明确返回 502 错误，避免前端拿到空 data URL 播放 0s
    if (!b64Audio) {
      logger.warn('openai', `[AI TTS][${rid}] ${model} 返回空音频 (content-type=${rawContentType}, bytes=${arrayBuffer.byteLength})`);
      return c.json({
        error: {
          message: `TTS 模型未返回音频数据（content-type=${rawContentType}, bytes=${arrayBuffer.byteLength}）`,
          type: 'upstream_error',
          code: 'EMPTY_AUDIO',
        },
      }, 502);
    }

    // 仅保留音频 MIME
    if (!audioContentType.startsWith('audio/')) {
      audioContentType = 'audio/mpeg';
    }

    // 估算神经元消耗
    const neurons = estimateTtsNeurons(input, model);
    await incrementQuota(env.DB, account.id, 'ai_neurons', neurons);
    await clearOptimistic(env, account.id);
    await invalidateAiCache(env);
    try {
      await addAuditLog(env.DB, {
        account_id: account.id, action: 'ai_tts_generation', target: model,
        detail: `[${rid}] chars=${input.length} speaker=${resolvedSpeaker || 'n/a'} neurons=${neurons}`,
        status: 'success',
      });
    } catch {}

    return c.json({
      created: Math.floor(Date.now() / 1000),
      data: [{ audio: b64Audio, neurons, content_type: audioContentType }],
    });
  }

  // --- X-Account-ID 指定账户 ---
  if (specifiedAccountId && specifiedAccountId !== 'auto') {
    const allAccounts = await getActiveAccountsByFeature(env.DB, 'ai');
    const specified = allAccounts.find(a => a.account_id === specifiedAccountId);
    if (!specified) {
      return c.json({
        error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
      }, 404);
    }

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${specified.account_id}/ai/run/${model}`;
    const authHeaders = await getAuthHeaders(specified, env.ENCRYPTION_KEY);
    const cfBody = await buildTtsBody(specified);
    let cfResp: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000);
      cfResp = await fetch(cfUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(cfBody),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (netErr: any) {
      logger.error('openai', `[AI TTS][${rid}] Network error: ${netErr.message}`);
      return c.json({ error: { message: `Network error: ${netErr.message}`, type: 'upstream_error', code: 'NETWORK_ERROR' } }, 502);
    }

    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      logger.error('openai', `[AI TTS][${rid}] CF upstream error ${cfResp.status}: ${errorText.slice(0, 500)}`);
      if (isNeuronLimitError(errorText)) {
        await setExhausted(env.DB, specified.id, 'ai_neurons');
        await invalidateAiCache(env);
      }
      return c.json({ error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }
    return await handleTtsSuccess(specified, cfResp);
  }

  // --- 自动轮换账户 ---
  const skipped = new Set<number>();
  let lastError = '';
  let lastStatus = 502; // 兜底：上游/网络错误默认 502
  let quotaExhausted = false; // 是否因神经元额度耗尽而失败
  while (true) {
    const account = await selectBestAccount(env, 'ai_neurons', skipped, model);
    if (!account) break;
    if (!account.account_id) { skipped.add(account.id); continue; }

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
    const authHeaders = await getAuthHeaders(account, env.ENCRYPTION_KEY);
    const cfBody = await buildTtsBody(account);
    let cfResp: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000);
      cfResp = await fetch(cfUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(cfBody),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (netErr: any) {
      lastError = `Network error: ${netErr.message}`;
      lastStatus = 502;
      skipped.add(account.id);
      continue;
    }

    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      lastError = extractCfError(errorText);
      lastStatus = cfResp.status;
      if (isRetryableError(cfResp.status, errorText)) {
        if (isNeuronLimitError(errorText)) {
          quotaExhausted = true;
          await setExhausted(env.DB, account.id, 'ai_neurons');
          await invalidateAiCache(env);
        }
        skipped.add(account.id);
        continue;
      }
      return c.json({ error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }

    return await handleTtsSuccess(account, cfResp);
  }

  // 区分失败原因：真配额耗尽才报 quota_exceeded；否则返回真实上游/网络错误，避免误报
  if (quotaExhausted) {
    logger.error('openai', `[AI TTS][${rid}] All accounts exhausted. Last error: ${lastError}`);
    return c.json({ error: { message: 'All accounts exhausted', type: 'quota_exceeded', code: 'ALL_ACCOUNTS_EXHAUSTED', last_error: lastError || 'Unknown error' } }, 429);
  }
  logger.error('openai', `[AI TTS][${rid}] Upstream error after retries: ${lastError}`);
  return c.json({ error: { message: lastError || 'All accounts failed', type: 'upstream_error', code: upstreamStatusToCode(lastStatus) } }, lastStatus as any);
});

// ================================================================
// POST /audio/transcriptions — 语音转文本 ASR（OpenAI-compatible）
// ================================================================
// 仅 whisper 系列（whisper / whisper-tiny-en / whisper-large-v3-turbo）支持同步 JSON 转写：
//   whisper、whisper-tiny-en 的 audio 为 0-255 字节数组；whisper-large-v3-turbo 的 audio 为 base64 字符串，prompt→initial_prompt。
// deepgram nova-3 / deepgram flux 为实时流式模型（realtime=true），pipecat smart-turn-v2 为 VAD 模型，
// 均无法通过同步 /ai/run JSON 端点调用，本路由直接拒绝。
// OpenAI 原版用 multipart/form-data 上传 file，本实现统一为 JSON { audio: <base64> }。
app.post('/audio/transcriptions', async (c) => {
  const specifiedAccountId = c.req.header('X-Account-ID');
  const { model, audio, file, language, prompt, response_format } = await c.req.json() as any;
  const audioB64 = audio || file;
  const rid = getRequestId(c);
  const env = c.env;

  if (!model || !audioB64) {
    return c.json({
      error: { message: 'model and audio (base64 string) are required', type: 'invalid_request_error', code: 'bad_request' },
    }, 400);
  }

  // 模型族识别：仅 whisper 系列支持同步 JSON 转写；deepgram（nova-3/flux）为实时流式模型，
  // pipecat smart-turn-v2 为 VAD（话轮检测）模型，均无法通过同步 /ai/run JSON 端点调用，直接拒绝。
  const isWhisperTurbo = model.includes('whisper-large-v3-turbo');
  const isWhisperLegacy = model.includes('whisper') && !isWhisperTurbo;
  const isSyncUnsupported = model.includes('nova-3') || model.includes('deepgram/flux') || model.includes('smart-turn') || model.includes('pipecat');
  if (isSyncUnsupported) {
    return c.json({
      error: {
        message: `模型 ${model} 为实时流式/VAD 模型，不支持同步 /audio/transcriptions 调用`,
        type: 'invalid_request_error',
        code: 'unsupported_model',
      },
    }, 400);
  }

  const extractCfError = (raw: string): string => {
    try {
      const json = JSON.parse(raw);
      if (json.errors?.[0]?.message) return json.errors[0].message;
      if (json.error?.message) return json.error.message;
      if (json.message) return json.message;
    } catch {}
    return raw;
  };

  const cfBody: Record<string, any> = {};
  if (isWhisperLegacy) {
    // whisper / whisper-tiny-en：audio 为 0-255 字节数组（非 base64），且无 language/prompt
    const binary = atob(audioB64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    cfBody.audio = Array.from(bytes);
  } else {
    // whisper-large-v3-turbo：audio 为 base64 字符串；prompt 映射为 initial_prompt
    cfBody.audio = audioB64;
    if (language) cfBody.language = language;
    if (prompt) cfBody.initial_prompt = prompt;
  }

  const handleAsrSuccess = async (account: any, cfResp: Response): Promise<Response> => {
    const json = await cfResp.json() as any;
    const rawText = json?.result?.text ?? json?.text ?? json?.result?.output;
    if (rawText === undefined || rawText === null) {
      logger.error('openai', `[AI ASR][${rid}] CF returned empty transcription`);
      return c.json({ error: { message: 'ASR 模型未返回文本', type: 'upstream_error', code: 'EMPTY_TEXT' } }, 502);
    }
    const text = String(rawText);
    // Worker 运行时无 Buffer，用 base64 长度估算原始字节数（4 字符→3 字节，去掉 padding）
    const audioBytes = Math.floor(audioB64.replace(/=+$/, '').length * 3 / 4);
    const neurons = estimateAsrNeurons(audioBytes, model);
    await incrementQuota(env.DB, account.id, 'ai_neurons', neurons);
    await clearOptimistic(env, account.id);
    await invalidateAiCache(env);
    try {
      await addAuditLog(env.DB, {
        account_id: account.id, action: 'ai_asr_transcription', target: model,
        detail: `[${rid}] bytes=${audioBytes} lang=${language || 'auto'} neurons=${neurons}`,
        status: 'success',
      });
    } catch {}

    if (response_format === 'text') {
      return c.body(text, 200, { 'Content-Type': 'text/plain; charset=utf-8' });
    }
    return c.json({ text, neurons, task: 'transcribe', language: language || null });
  };

  // --- X-Account-ID 指定账户 ---
  if (specifiedAccountId && specifiedAccountId !== 'auto') {
    const allAccounts = await getActiveAccountsByFeature(env.DB, 'ai');
    const specified = allAccounts.find(a => a.account_id === specifiedAccountId);
    if (!specified) {
      return c.json({
        error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
      }, 404);
    }
    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${specified.account_id}/ai/run/${model}`;
    const authHeaders = await getAuthHeaders(specified, env.ENCRYPTION_KEY);
    let cfResp: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000);
      cfResp = await fetch(cfUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(cfBody),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (netErr: any) {
      logger.error('openai', `[AI ASR][${rid}] Network error: ${netErr.message}`);
      return c.json({ error: { message: `Network error: ${netErr.message}`, type: 'upstream_error', code: 'NETWORK_ERROR' } }, 502);
    }
    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      logger.error('openai', `[AI ASR][${rid}] CF upstream error ${cfResp.status}: ${errorText.slice(0, 500)}`);
      if (isNeuronLimitError(errorText)) {
        await setExhausted(env.DB, specified.id, 'ai_neurons');
        await invalidateAiCache(env);
      }
      return c.json({ error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }
    return await handleAsrSuccess(specified, cfResp);
  }

  // --- 自动轮换账户 ---
  const skipped = new Set<number>();
  let lastError = '';
  let lastStatus = 502; // 兜底：上游/网络错误默认 502
  let quotaExhausted = false; // 是否因神经元额度耗尽而失败
  while (true) {
    const account = await selectBestAccount(env, 'ai_neurons', skipped, model);
    if (!account) break;
    if (!account.account_id) { skipped.add(account.id); continue; }
    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
    const authHeaders = await getAuthHeaders(account, env.ENCRYPTION_KEY);
    let cfResp: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000);
      cfResp = await fetch(cfUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(cfBody),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (netErr: any) {
      lastError = `Network error: ${netErr.message}`;
      lastStatus = 502;
      skipped.add(account.id);
      continue;
    }
    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      lastError = extractCfError(errorText);
      lastStatus = cfResp.status;
      if (isRetryableError(cfResp.status, errorText)) {
        if (isNeuronLimitError(errorText)) {
          quotaExhausted = true;
          await setExhausted(env.DB, account.id, 'ai_neurons');
          await invalidateAiCache(env);
        }
        skipped.add(account.id);
        continue;
      }
      return c.json({ error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }
    return await handleAsrSuccess(account, cfResp);
  }

  // 区分失败原因：真配额耗尽才报 quota_exceeded；否则返回真实上游/网络错误，避免误报
  if (quotaExhausted) {
    logger.error('openai', `[AI ASR][${rid}] All accounts exhausted. Last error: ${lastError}`);
    return c.json({ error: { message: 'All accounts exhausted', type: 'quota_exceeded', code: 'ALL_ACCOUNTS_EXHAUSTED', last_error: lastError || 'Unknown error' } }, 429);
  }
  logger.error('openai', `[AI ASR][${rid}] Upstream error after retries: ${lastError}`);
  return c.json({ error: { message: lastError || 'All accounts failed', type: 'upstream_error', code: upstreamStatusToCode(lastStatus) } }, lastStatus as any);
});

// ================================================================
// POST /translations — 文本翻译（OpenAI-compatible 自定义扩展）
// ================================================================
app.post('/translations', async (c) => {
  const specifiedAccountId = c.req.header('X-Account-ID');
  const { model, text, source_lang, target_lang } = await c.req.json();
  const rid = getRequestId(c);
  const env = c.env;

  if (!model || !text || !target_lang) {
    return c.json({
      error: { message: 'model, text, and target_lang are required', type: 'invalid_request_error', code: 'bad_request' },
    }, 400);
  }

  // 根据模型构建不同的 CF 请求体
  const isIndicTrans2 = model.includes('indictrans2');
  const cfBody: Record<string, any> = isIndicTrans2
    ? { text, target_language: target_lang }           // IndicTrans2: { text, target_language }
    : { text, source_lang: source_lang || 'en', target_lang }; // M2M100: { text, source_lang, target_lang }

  const extractCfError = (raw: string): string => {
    try {
      const json = JSON.parse(raw);
      if (json.errors?.[0]?.message) return json.errors[0].message;
      if (json.error?.message) return json.error.message;
      if (json.message) return json.message;
    } catch {}
    return raw;
  };

  const handleTranslationSuccess = async (account: any, cfResp: Response): Promise<Response> => {
    const json = await cfResp.json() as any;
    const translatedText = isIndicTrans2
      ? (json?.result?.translations?.[0] || '')
      : (json?.result?.translated_text || json?.result?.output || json?.translated_text || '');

    if (!translatedText) {
      logger.error('openai', `[AI Translation][${rid}] CF returned empty translation`);
      throw new Error('CF returned empty translation');
    }

    const neurons = estimateTranslationNeurons(text, model);
    await incrementQuota(env.DB, account.id, 'ai_neurons', neurons);
    await clearOptimistic(env, account.id);
    await invalidateAiCache(env);
    logger.debug('openai', `[AI Translation][${rid}] estimated ${neurons} neurons for account ${account.name}`);
    try {
      await addAuditLog(env.DB, {
        account_id: account.id, action: 'ai_translation', target: model,
        detail: `[${rid}] chars=${text.length} source=${source_lang || 'auto'} target=${target_lang} neurons=${neurons}`,
        status: 'success',
      });
    } catch {}

    return c.json({
      created: Math.floor(Date.now() / 1000),
      data: [{
        translated_text: translatedText,
        source_lang,
        target_lang,
        neurons,
      }],
    });
  };

  if (specifiedAccountId && specifiedAccountId !== 'auto') {
    const allAccounts = await getActiveAccountsByFeature(env.DB, 'ai');
    const specified = allAccounts.find(a => a.account_id === specifiedAccountId);
    if (!specified) {
      return c.json({
        error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
      }, 404);
    }

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${specified.account_id}/ai/run/${model}`;
    const authHeaders = await getAuthHeaders(specified, env.ENCRYPTION_KEY);
    let cfResp: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000);
      cfResp = await fetch(cfUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(cfBody),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (netErr: any) {
      logger.error('openai', `[AI Translation][${rid}] Network error: ${netErr.message}`);
      return c.json({ error: { message: `Network error: ${netErr.message}`, type: 'upstream_error', code: 'NETWORK_ERROR' } }, 502);
    }

    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      logger.error('openai', `[AI Translation][${rid}] CF upstream error ${cfResp.status}: ${errorText.slice(0, 500)}`);
      if (isNeuronLimitError(errorText)) {
        await setExhausted(env.DB, specified.id, 'ai_neurons');
        await invalidateAiCache(env);
      }
      return c.json({ error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }
    return await handleTranslationSuccess(specified, cfResp);
  }

  const skipped = new Set<number>();
  let lastError = '';
  let lastStatus = 502; // 兜底：上游/网络错误默认 502
  let quotaExhausted = false; // 是否因神经元额度耗尽而失败
  while (true) {
    const account = await selectBestAccount(env, 'ai_neurons', skipped, model);
    if (!account) break;
    if (!account.account_id) { skipped.add(account.id); continue; }

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
    const authHeaders = await getAuthHeaders(account, env.ENCRYPTION_KEY);
    let cfResp: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 300000);
      cfResp = await fetch(cfUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(cfBody),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (netErr: any) {
      lastError = `Network error: ${netErr.message}`;
      lastStatus = 502;
      skipped.add(account.id);
      continue;
    }

    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      lastError = extractCfError(errorText);
      lastStatus = cfResp.status;
      if (isRetryableError(cfResp.status, errorText)) {
        if (isNeuronLimitError(errorText)) {
          quotaExhausted = true;
          await setExhausted(env.DB, account.id, 'ai_neurons');
          await invalidateAiCache(env);
        }
        skipped.add(account.id);
        continue;
      }
      return c.json({ error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }

    return await handleTranslationSuccess(account, cfResp);
  }

  // 区分失败原因：真配额耗尽才报 quota_exceeded；否则返回真实上游/网络错误，避免误报
  if (quotaExhausted) {
    logger.error('openai', `[AI Translation][${rid}] All accounts exhausted. Last error: ${lastError}`);
    return c.json({ error: { message: 'All accounts exhausted', type: 'quota_exceeded', code: 'ALL_ACCOUNTS_EXHAUSTED', last_error: lastError || 'Unknown error' } }, 429);
  }
  logger.error('openai', `[AI Translation][${rid}] Upstream error after retries: ${lastError}`);
  return c.json({ error: { message: lastError || 'All accounts failed', type: 'upstream_error', code: upstreamStatusToCode(lastStatus) } }, lastStatus as any);
});

// ================================================================
// POST /embeddings — 文本嵌入（OpenAI-compatible）
// ================================================================
// Cloudflare Workers AI 嵌入模型（bge 系列、bge-m3、qwen3-embedding、plamo-embedding、embeddinggemma 等）
// 通过 /ai/run/{model} 调用，请求体 { text: string|string[] }，响应 { result: { data: number[][], shape } }。
// 经官方 schema 核验：data 直接为向量数组（每个元素是一条文本的向量），部分旧模型可能为 [{embedding,index}]。
// 这里将其转换为 OpenAI 的 /v1/embeddings 格式（object/list + data[].embedding + usage）。
const EMBEDDINGS_EXTRACT_ERROR = (raw: string): string => {
  try {
    const json = JSON.parse(raw);
    if (json.errors?.[0]?.message) return json.errors[0].message;
    if (json.error?.message) return json.error.message;
    if (json.message) return json.message;
  } catch {}
  return raw;
};

/** 将 float 数组编码为 OpenAI base64 编码格式（Float32 little-endian） */
function floatsToBase64(floats: number[]): string {
  const buf = new Float32Array(floats.length);
  for (let i = 0; i < floats.length; i++) buf[i] = floats[i];
  const bytes = new Uint8Array(buf.buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)) as any);
  }
  return btoa(binary);
}

app.post('/embeddings', async (c) => {
  const specifiedAccountId = c.req.header('X-Account-ID');
  const { model, input, encoding_format } = await c.req.json();
  const rid = getRequestId(c);
  const env = c.env;

  if (!model || input === undefined || input === null) {
    return c.json({
      error: { message: 'model and input are required', type: 'invalid_request_error', code: 'bad_request' },
    }, 400);
  }

  // 规范化 input：OpenAI 支持 string 或 string[]（token 数组极少见，统一按字符串处理）
  const texts: string[] = Array.isArray(input) ? input.map(String) : [String(input)];
  const useBase64 = encoding_format === 'base64';

  /** 处理 CF 嵌入成功响应 → 转 OpenAI 格式 */
  const handleEmbeddingsSuccess = async (account: any, cfResp: Response): Promise<Response> => {
    const json = await cfResp.json() as any;
    const result = json?.result || {};

    // 经官方 schema 核验：Workers AI 嵌入模型响应 result.data 为 number[][]（直接是向量数组，
    // 如 bge 系列 / bge-m3 / qwen3-embedding / plamo / embeddinggemma 均为此结构）；
    // 个别旧模型可能为 [{ embedding, index }] 对象数组，两者均兼容。
    let rawData: any[] = Array.isArray(result.data) ? result.data : [];
    if (rawData.length === 0 && Array.isArray(result.embeddings)) {
      rawData = result.embeddings.map((emb: any, i: number) => ({ embedding: emb, index: i }));
    }

    const firstRaw = Array.isArray(rawData[0]) ? rawData[0] : (rawData[0]?.embedding ?? []);
    const dims = firstRaw.length || 0;

    const data = rawData.map((d: any, i: number) => {
      // d 为 number[]（number[][] 情形）或 { embedding, index } 对象
      const embedding: number[] = Array.isArray(d) ? d : (d?.embedding ?? []);
      return {
        object: 'embedding',
        embedding: useBase64 ? floatsToBase64(embedding) : embedding,
        index: typeof d?.index === 'number' ? d.index : i,
      };
    });

    const neurons = estimateEmbeddingsNeurons(model, texts);
    await incrementQuota(env.DB, account.id, 'ai_neurons', neurons);
    await clearOptimistic(env, account.id);
    await invalidateAiCache(env);

    // 估算 token 用量（CF 嵌入响应不含 usage）
    const estTokens = Math.max(1, Math.ceil(texts.reduce((s, t) => s + (t?.length || 0), 0) / 4));
    try {
      await addAuditLog(env.DB, {
        account_id: account.id, action: 'ai_embeddings', target: model,
        detail: `[${rid}] inputs=${texts.length} dims=${dims} tokens≈${estTokens} neurons=${neurons}`,
        status: 'success',
      });
    } catch {}

    return c.json({
      object: 'list',
      data,
      model,
      usage: { prompt_tokens: estTokens, total_tokens: estTokens },
    });
  };

  // --- X-Account-ID 指定账户 ---
  if (specifiedAccountId && specifiedAccountId !== 'auto') {
    const allAccounts = await getActiveAccountsByFeature(env.DB, 'ai');
    const specified = allAccounts.find(a => a.account_id === specifiedAccountId);
    if (!specified) {
      return c.json({
        error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
      }, 404);
    }

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${specified.account_id}/ai/run/${model}`;
    const authHeaders = await getAuthHeaders(specified, env.ENCRYPTION_KEY);
    let cfResp: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);
      cfResp = await fetch(cfUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ text: texts }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (netErr: any) {
      logger.error('openai', `[AI Embeddings][${rid}] Network error: ${netErr.message}`);
      return c.json({ error: { message: `Network error: ${netErr.message}`, type: 'upstream_error', code: 'NETWORK_ERROR' } }, 502);
    }

    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      logger.error('openai', `[AI Embeddings][${rid}] CF upstream error ${cfResp.status}: ${errorText.slice(0, 500)}`);
      if (isNeuronLimitError(errorText)) {
        await setExhausted(env.DB, specified.id, 'ai_neurons');
        await invalidateAiCache(env);
      }
      return c.json({ error: { message: EMBEDDINGS_EXTRACT_ERROR(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }
    return await handleEmbeddingsSuccess(specified, cfResp);
  }

  // --- 自动轮换账户 ---
  const skipped = new Set<number>();
  let lastError = '';
  let lastStatus = 502; // 兜底：上游/网络错误默认 502
  let quotaExhausted = false; // 是否因神经元额度耗尽而失败
  while (true) {
    const account = await selectBestAccount(env, 'ai_neurons', skipped, model);
    if (!account) break;
    if (!account.account_id) { skipped.add(account.id); continue; }

    const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
    const authHeaders = await getAuthHeaders(account, env.ENCRYPTION_KEY);
    let cfResp: Response;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 120000);
      cfResp = await fetch(cfUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ text: texts }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (netErr: any) {
      lastError = `Network error: ${netErr.message}`;
      lastStatus = 502;
      skipped.add(account.id);
      continue;
    }

    if (!cfResp.ok) {
      const errorText = await cfResp.text();
      lastError = EMBEDDINGS_EXTRACT_ERROR(errorText);
      lastStatus = cfResp.status;
      if (isRetryableError(cfResp.status, errorText)) {
        if (isNeuronLimitError(errorText)) {
          quotaExhausted = true;
          await setExhausted(env.DB, account.id, 'ai_neurons');
          await invalidateAiCache(env);
        }
        skipped.add(account.id);
        continue;
      }
      return c.json({ error: { message: EMBEDDINGS_EXTRACT_ERROR(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } }, cfResp.status as any);
    }

    return await handleEmbeddingsSuccess(account, cfResp);
  }

  // 区分失败原因：真配额耗尽才报 quota_exceeded；否则返回真实上游/网络错误，避免误报
  if (quotaExhausted) {
    logger.error('openai', `[AI Embeddings][${rid}] All accounts exhausted. Last error: ${lastError}`);
    return c.json({ error: { message: 'All accounts exhausted', type: 'quota_exceeded', code: 'ALL_ACCOUNTS_EXHAUSTED', last_error: lastError || 'Unknown error' } }, 429);
  }
  logger.error('openai', `[AI Embeddings][${rid}] Upstream error after retries: ${lastError}`);
  return c.json({ error: { message: lastError || 'All accounts failed', type: 'upstream_error', code: upstreamStatusToCode(lastStatus) } }, lastStatus as any);
});

export default app;
