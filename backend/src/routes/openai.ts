import { Router, Request, Response, NextFunction } from 'express';
import { Readable } from 'stream';
import { selectBestAccount } from '../services/accountRouter';
import { getActiveAccountsByFeature, hasPaidAccountByFeature } from '../models/account';
import { getAvailableModels, getModelInputSchema, extractTtsAdvancedParams, buildTtsCfBody, modelRequiresWorkersPaid } from '../services/aiService';
import { getAuthHeaders } from '../services/cfFactory';
import { createAuditLog } from '../models/auditLog';
import { proxyFetch } from '../services/proxyService';
import { appLogger } from '../services/logger';
import { setExhausted, incrementQuota } from '../models/quotaUsage';
import { safeRandomUUID } from '../utils';
import { updateAiCacheAfterUsage, removeAccountFromAiCache } from '../services/accountRouter';
import { estimateNeurons, estimateImageNeurons, estimateTtsNeurons, estimateTranslationNeurons, estimateEmbeddingsNeurons, estimateAsrNeurons } from '../services/pricing';

const router = Router();

/** Maximum retries per account before skipping it permanently in this request. */
const MAX_RETRY_PER_ACCOUNT = 1; // 每个账户最多重试 1 次，失败立即换账户

/** Upstream status codes that should trigger account rotation instead of immediate error. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

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

function writeSseDone(res: Response): void {
  if (res.writableEnded) return;
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
  }
  res.write('data: [DONE]\n\n');
}

/** Delay before first heartbeat (ms) — only send heartbeat if upstream TTFB exceeds this. */
const HEARTBEAT_DELAY_MS = 15_000;

/** SSE heartbeat interval (ms) — repeat interval after first heartbeat. */
const HEARTBEAT_INTERVAL_MS = 10_000;

/**
 * Start DELAYED SSE heartbeat to prevent client TTFB timeout.
 *
 * Does NOT send anything immediately. Only starts sending `: heartbeat\n\n`
 * comments after HEARTBEAT_DELAY_MS (15s) of silence, then every 10s.
 *
 * This avoids interfering with fast responses — most requests get a response
 * from CF within a few seconds and never need a heartbeat. Only genuinely
 * slow responses (30s+ TTFB) trigger the heartbeat.
 *
 * ONLY sends SSE comment (`: heartbeat\n\n`) — spec-compliant, all SSE
 * parsers ignore comments, zero risk of corrupting the stream.
 *
 * Returns a stop function.
 */
function startSseHeartbeat(res: Response): () => void {
  if (!res.headersSent) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }

  let intervalId: ReturnType<typeof setInterval> | null = null;

  // Delay first heartbeat — most responses arrive before this.
  const delayId = setTimeout(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n');
    }
    intervalId = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': heartbeat\n\n');
      }
    }, HEARTBEAT_INTERVAL_MS);
  }, HEARTBEAT_DELAY_MS);

  return () => {
    clearTimeout(delayId);
    if (intervalId) clearInterval(intervalId);
  };
}

/** Send an error as an SSE event (for stream mode when headers already sent). */
function sendSseError(res: Response, errorObj: Record<string, any>): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify({ error: errorObj })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

router.get('/models', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const account = await selectBestAccount('ai_neurons');
    if (!account) {
      res.status(503).json({
        error: { message: 'No active AI accounts available', type: 'service_error', code: 'NO_ACCOUNTS' },
      });
      return;
    }
    const taskFilter = req.query.task as string | undefined;
    let models = await getAvailableModels(account, taskFilter);

    // 无付费计划（paid/enterprise）活跃账号时隐藏付费模型：这类模型调用必然失败，留在列表里只会误导。
    // 由用户在「账号管理」中标注计划类型（不标即视为 free）。
    if (!hasPaidAccountByFeature('ai')) {
      models = models.filter((m: any) => !modelRequiresWorkersPaid(m));
    }

    // TTS 模型：一次性获取模型 schema，下发 speaker 枚举与高级可选参数
    const ttsModelMeta: Record<string, { speakers?: string[]; default_speaker?: string; advanced_params?: Record<string, any> }> = {};
    if (taskFilter && taskFilter.toLowerCase().replace(/-/g, ' ').includes('text to speech')) {
      await Promise.all(models.map(async (m: any) => {
        const modelId = m.name || m.id;
        if (!modelId) return;
        const schema = await getModelInputSchema(account, modelId);
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
    res.json({ object: 'list', data });
  } catch (err) { next(err); }
});

router.post('/chat/completions', async (req: Request, res: Response, next: NextFunction) => {
  // Declare before try so catch block can access it for cleanup.
  let stopHeartbeat: (() => void) | null = null;
  try {
    const specifiedAccountId = req.headers['x-account-id'] as string | undefined;
    const isStream = req.body.stream === true;

    // 流式请求强制要求 CF 返回 usage，否则无法记账
    if (isStream && !req.body.stream_options?.include_usage) {
      req.body.stream_options = { ...(req.body.stream_options || {}), include_usage: true };
    }

    const rid = req.requestId || '-';

    // For streaming: send SSE headers + heartbeat IMMEDIATELY to prevent
    // client TTFB timeout. CF AI can take 30+ seconds before first byte;
    // without this, clients like Cursor disconnect after ~30s of silence.
    stopHeartbeat = isStream ? startSseHeartbeat(res) : null;

    // --- X-Account-ID specified: use that account directly, no rotation ---
    if (specifiedAccountId && specifiedAccountId !== 'auto') {
      const allAccounts = getActiveAccountsByFeature('ai');
      const account = allAccounts.find((a: any) => a.account_id === specifiedAccountId);
      if (!account) {
        if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
        if (isStream) {
          sendSseError(res, { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' });
        } else {
          res.status(404).json({
            error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
          });
        }
        return;
      }

      // Make the CF request directly (no retry for specified account)
      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/v1/chat/completions`;
      const headers = { 'Content-Type': 'application/json', ...getAuthHeaders(account) };
      try {
        const timeoutMs = isStream ? 600000 : 300000;
        const cfResp = await proxyFetch(cfUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(req.body),
        }, timeoutMs, undefined, account);

        if (!cfResp.ok) {
          const errorText = await cfResp.text();
          if (isNeuronLimitError(errorText)) {
            setExhausted(account.id, 'ai_neurons');
            removeAccountFromAiCache(account.id);
          }
          if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
          if (isStream) {
            sendSseError(res, { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) });
          } else {
            res.status(cfResp.status).json({
              error: { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) },
            });
          }
          return;
        }

        await processAccount(account, req, res, rid, isStream, cfResp, stopHeartbeat);
        stopHeartbeat = null;
      } catch (netErr: any) {
        const errMsg = `Network error: ${netErr.message || netErr}`;
        appLogger.error(`[AI][${rid}] Specified account ${account.name} ${errMsg}`);
        createAuditLog(account.id, 'ai_chat_completion', req.body.model, `[${rid}] ${errMsg}`, 'error');
        if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
        if (isStream) {
          sendSseError(res, { message: errMsg, type: 'upstream_error', code: 'NETWORK_ERROR' });
        } else {
          res.status(502).json({
            error: { message: errMsg, type: 'upstream_error', code: 'NETWORK_ERROR' },
          });
        }
      }
      return;
    }

    // --- while + selectBestAccount rotation loop ---
    const skipped = new Set<number>();
    const retryCount = new Map<number, number>();
    let lastError = '';
    let lastStatus = 502; // 兜底：上游/网络错误默认 502
    let quotaExhausted = false; // 是否因神经元额度耗尽而失败

    while (true) {
      const account = await selectBestAccount('ai_neurons', skipped, req.body.model);
      if (!account) break; // no available account

      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/v1/chat/completions`;
      const headers = { 'Content-Type': 'application/json', ...getAuthHeaders(account) };

      let cfResp: any;
      try {
        const timeoutMs = isStream ? 600000 : 300000;
        cfResp = await proxyFetch(cfUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(req.body),
        }, timeoutMs, undefined, account);
      } catch (netErr: any) {
        // Network error — retryable, increment retry count
        const errMsg = `Network error: ${netErr.message || netErr}`;
        appLogger.warn(`[AI][${rid}] Account ${account.name} ${errMsg}`);
        lastError = errMsg;
        lastStatus = 502;
        createAuditLog(account.id, 'ai_chat_completion', req.body.model, `[${rid}] ${errMsg}`, 'error');

        const retries = (retryCount.get(account.id) || 0) + 1;
        retryCount.set(account.id, retries);
        if (retries >= MAX_RETRY_PER_ACCOUNT) {
          skipped.add(account.id);
          appLogger.warn(`[AI][${rid}] Account ${account.name} exceeded max retries, skipping`);
        }
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
            // 4006 — mark exhausted, remove from cache, skip in this request loop, rotate
            appLogger.warn(`[AI][${rid}] Account ${account.name} neuron limit hit (4006), rotating`);
            setExhausted(account.id, 'ai_neurons');
            removeAccountFromAiCache(account.id);
            skipped.add(account.id);
            createAuditLog(account.id, 'ai_chat_completion', req.body.model, `[${rid}] 4006 neuron limit, switching`, 'error');
          } else {
            // Other retryable error — increment retry count
            const retries = (retryCount.get(account.id) || 0) + 1;
            retryCount.set(account.id, retries);
            if (retries >= MAX_RETRY_PER_ACCOUNT) {
              skipped.add(account.id);
              appLogger.warn(`[AI][${rid}] Account ${account.name} upstream ${cfResp.status} exceeded max retries, skipping`);
            } else {
              appLogger.warn(`[AI][${rid}] Account ${account.name} upstream ${cfResp.status}, rotating`);
            }
            createAuditLog(account.id, 'ai_chat_completion', req.body.model,
              `[${rid}] upstream ${cfResp.status}, switching`, 'error');
          }
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }

        // Non-retryable (400, 401, 403, 404, etc.) — return immediately
        if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
        if (isStream) {
          sendSseError(res, { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) });
        } else {
          res.status(cfResp.status).json({
            error: { message: errorText, type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) },
          });
        }
        return;
      }

      // Success — process response (handles both stream and non-stream)
      await processAccount(account, req, res, rid, isStream, cfResp, stopHeartbeat);
      stopHeartbeat = null;
      return;
    }

    // 区分失败原因：真配额耗尽才报 quota_exceeded；否则返回真实上游/网络错误，避免误报
    if (stopHeartbeat) { stopHeartbeat(); stopHeartbeat = null; }
    if (quotaExhausted) {
      appLogger.error(`[AI][${rid}] All accounts exhausted. Last error: ${lastError}`);
      if (isStream) {
        sendSseError(res, {
          message: 'All accounts have reached daily neuron limit',
          type: 'quota_exceeded',
          code: 'ALL_ACCOUNTS_EXHAUSTED',
          last_error: lastError || 'Unknown error',
        });
      } else {
        res.status(429).json({
          error: {
            message: 'All accounts have reached daily neuron limit',
            type: 'quota_exceeded',
            code: 'ALL_ACCOUNTS_EXHAUSTED',
            last_error: lastError || 'Unknown error',
          },
        });
      }
    } else {
      appLogger.error(`[AI][${rid}] Upstream error after retries: ${lastError}`);
      if (isStream) {
        sendSseError(res, { message: lastError || 'All accounts failed', type: 'upstream_error', code: upstreamStatusToCode(lastStatus) });
      } else {
        res.status(lastStatus).json({
          error: { message: lastError || 'All accounts failed', type: 'upstream_error', code: upstreamStatusToCode(lastStatus) },
        });
      }
    }
  } catch (err) {
    if (stopHeartbeat) stopHeartbeat();
    next(err);
  }
});

/**
 * Process a successful CF response: handle streaming vs non-streaming,
 * extract usage, do local neuron estimation, update quota/cache, write audit log.
 */
async function processAccount(
  account: any,
  req: Request,
  res: Response,
  rid: string,
  isStream: boolean,
  cfResp?: any,
  stopHeartbeat?: (() => void) | null,
): Promise<void> {
  if (isStream) {
    // SSE headers (skip if already sent by heartbeat)
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
    }

    let seenDone = false;
    let streamStatus: 'success' | 'client_disconnected' | 'upstream_error' = 'success';
    let finalUsage: any = null;
    let chunkIndex = 0;

    const onClose = () => {
      streamStatus = 'client_disconnected';
    };
    req.on('close', onClose);

    try {
      if (cfResp!.body) {
        const body = cfResp!.body as any;

        // --- Web Streams API (getReader) ---
        if (typeof body.getReader === 'function') {
          const reader = body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (res.writableEnded) { streamStatus = 'client_disconnected'; break; }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const payload = line.slice(6).trim();
                if (payload === '[DONE]') {
                  seenDone = true;
                } else {
                  chunkIndex++;
                  try {
                    const json = JSON.parse(payload);
                    if (json.usage) {
                      finalUsage = json.usage;
                      appLogger.debug(`[AI][${rid}] stream chunk#${chunkIndex} usage: ${JSON.stringify(json.usage)}`);
                    }
                  } catch { /* not JSON, ignore */ }
                }
              }
            }

            if (!res.write(Buffer.from(value))) {
              await new Promise<void>(r => res.once('drain', r));
            }
          }
          if (buffer) {
            if (buffer.startsWith('data: ') && buffer.slice(6).trim() === '[DONE]') seenDone = true;
            if (!res.write(buffer)) {
              await new Promise<void>(r => res.once('drain', r));
            }
          }
        }
        // --- Node.js Readable stream ---
        else if (typeof body.pipe === 'function') {
          await new Promise<void>((resolve) => {
            const nodeStream = body as Readable;
            let lineBuffer = '';
            nodeStream.on('data', (chunk: Buffer) => {
              if (res.writableEnded) { streamStatus = 'client_disconnected'; nodeStream.destroy(); return; }
              lineBuffer += chunk.toString();
              const lines = lineBuffer.split('\n');
              lineBuffer = lines.pop() || '';
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const payload = line.slice(6).trim();
                  if (payload === '[DONE]') {
                    seenDone = true;
                  } else if (payload) {
                    chunkIndex++;
                    try {
                      const json = JSON.parse(payload);
                      if (json.usage) {
                        finalUsage = json.usage;
                        appLogger.debug(`[AI][${rid}] stream chunk#${chunkIndex} usage: ${JSON.stringify(json.usage)}`);
                      }
                    } catch { /* not JSON, ignore */ }
                  }
                }
              }
              if (!res.write(chunk)) {
                nodeStream.pause();
                res.once('drain', () => nodeStream.resume());
              }
            });
            nodeStream.on('end', () => {
              if (lineBuffer) {
                if (lineBuffer.startsWith('data: ') && lineBuffer.slice(6).trim() === '[DONE]') seenDone = true;
                if (!res.write(lineBuffer)) { /* flush remaining */ }
              }
              resolve();
            });
            nodeStream.on('error', (err: Error) => {
              streamStatus = 'upstream_error';
              appLogger.error(`[AI] Stream error (pipe): ${err.message}`);
              resolve();
            });
          });
        }
      }
    } catch (err: any) {
      streamStatus = 'upstream_error';
      appLogger.error(`[AI][${rid}] Stream exception: ${err.message}`);
    } finally {
      req.off('close', onClose);
      if (stopHeartbeat) stopHeartbeat();
      if (!seenDone && !res.writableEnded) {
        writeSseDone(res);
      }
      if (!res.writableEnded) res.end();

      // Local neuron estimation from finalUsage
      if (finalUsage) {
        const cachedTokens = finalUsage.prompt_tokens_details?.cached_tokens || 0;
        const neurons = estimateNeurons(
          req.body.model,
          finalUsage.prompt_tokens || 0,
          finalUsage.completion_tokens || 0,
          cachedTokens
        );
        incrementQuota(account.id, 'ai_neurons', neurons);
        updateAiCacheAfterUsage(account.id, neurons);
        appLogger.debug(`[AI][${rid}] estimated ${neurons} neurons for account ${account.name} (cached=${cachedTokens})`);
        createAuditLog(account.id, 'ai_chat_completion', req.body.model,
          `[${rid}] stream tokens: in=${finalUsage.prompt_tokens || 0} out=${finalUsage.completion_tokens || 0} total=${finalUsage.total_tokens || 0} cached=${cachedTokens} neurons=${neurons}`,
          streamStatus === 'success' ? 'success' : 'error');
      } else {
        appLogger.warn(`[AI][${rid}] stream ended without usage, skipping local estimate`);
        createAuditLog(account.id, 'ai_chat_completion', req.body.model,
          `[${rid}] stream ${streamStatus} tokens: none (no usage in SSE)`,
          streamStatus === 'success' ? 'success' : 'error');
      }
    }
  } else {
    // Non-stream
    const data = await cfResp!.json() as any;

    // Normalize response to match OpenAI format
    if (!data.id) data.id = `chatcmpl-${safeRandomUUID()}`;
    if (!data.object) data.object = 'chat.completion';
    if (!data.model && req.body.model) data.model = req.body.model;
    if (!data.usage) data.usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

    // Local neuron estimation
    let neurons = 0;
    if (data.usage) {
      const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens || 0;
      neurons = estimateNeurons(
        req.body.model,
        data.usage.prompt_tokens || 0,
        data.usage.completion_tokens || 0,
        cachedTokens
      );
      incrementQuota(account.id, 'ai_neurons', neurons);
      updateAiCacheAfterUsage(account.id, neurons);
      appLogger.debug(`[AI][${rid}] estimated ${neurons} neurons for account ${account.name} (cached=${cachedTokens})`);
    }

    res.json(data);
    createAuditLog(account.id, 'ai_chat_completion', req.body.model,
      `[${rid}] non-stream tokens: in=${data?.usage?.prompt_tokens || 0} out=${data?.usage?.completion_tokens || 0} total=${data?.usage?.total_tokens || 0} cached=${data?.usage?.prompt_tokens_details?.cached_tokens || 0} neurons=${neurons}`,
      'success');
  }
}

function isRetryableError(status: number, errorText: string): boolean {
  if (RETRYABLE_STATUS.has(status)) return true;
  return isNeuronLimitError(errorText);
}

// ================================================================
// POST /images/generations — 文生图 / 图生图（OpenAI-compatible）
// ================================================================
router.post('/images/generations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const specifiedAccountId = req.headers['x-account-id'] as string | undefined;
    const { model, prompt, image } = req.body;
    const rid = req.requestId || '-';

    if (!model || !prompt) {
      res.status(400).json({
        error: { message: 'model and prompt are required', type: 'invalid_request_error', code: 'bad_request' },
      });
      return;
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
      res.status(400).json({
        error: {
          message: `model ${model} does not support image-to-image via this API; only Flux 2 family (flux-2-*) supports img2img with a reference image`,
          type: 'invalid_request_error',
          code: 'img2img_unsupported',
        },
      });
      return;
    }
    // 预处理 base64 图片为 Buffer（用于 Flux 2 二进制附件或纯 base64 提取）
    let cleanBase64 = '';
    let imageBuffer: Buffer | null = null;
    if (image) {
      if (typeof image === 'string') {
        cleanBase64 = image.replace(/^data:image\/[a-zA-Z+]+;base64,/, '').trim();
        try { imageBuffer = Buffer.from(cleanBase64, 'base64'); } catch {}
      } else if (Buffer.isBuffer(image)) {
        imageBuffer = image;
        cleanBase64 = image.toString('base64');
      }
    }

    /**
     * 通过 magic bytes 检测图像真实格式。
     * CF Flux 2 multipart 接收时会校验 part Content-Type 与文件头 magic bytes 是否一致，
     * 硬编码 image/jpeg 但实际是 PNG 时会上游 3043。
     */
    const detectImageMime = (buf: Buffer): { mime: string; ext: string } => {
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
        // Flux 2 (klein/base/dev): multipart 表单；steps 固定为 4 不可调，不发送。
        // 支持可选 width/height/guidance/seed；图生图使用二进制文件附件（字段名为 image，带文件名与 MIME 类型）
        if (req.body.width) cfBody.width = req.body.width;
        if (req.body.height) cfBody.height = req.body.height;
        if (req.body.guidance) cfBody.guidance = req.body.guidance;
        if (req.body.seed !== undefined) cfBody.seed = req.body.seed;
      } else {
        // Flux 1 (schnell 等): JSON，参数名为 steps（非 num_steps，官方已确认，仅 prompt+steps，无 seed）
        if (req.body.num_steps) cfBody.steps = req.body.num_steps;
      }
    } else if (isSD) {
      // Stable Diffusion / dreamshaper: 完整参数支持（含 seed）
      if (cleanBase64) {
        cfBody.image_b64 = cleanBase64; // SD 族 img2img：image_b64（官方 schema 字段，非 image）；纯 img2img 无需 mask
      }
      if (req.body.width) cfBody.width = req.body.width;
      if (req.body.height) cfBody.height = req.body.height;
      if (req.body.num_steps) cfBody.num_steps = req.body.num_steps;
      if (req.body.guidance) cfBody.guidance = req.body.guidance;
      if (req.body.negative_prompt) cfBody.negative_prompt = req.body.negative_prompt;
      if (req.body.strength) cfBody.strength = req.body.strength;
      if (req.body.seed !== undefined) cfBody.seed = req.body.seed;
    } else {
      // 其他模型（leonardo phoenix/lucid 等）：透传参数；lucid 不支持 negative_prompt
      if (cleanBase64) cfBody.image_b64 = cleanBase64;
      if (req.body.width) cfBody.width = req.body.width;
      if (req.body.height) cfBody.height = req.body.height;
      if (req.body.num_steps) cfBody.num_steps = req.body.num_steps;
      if (req.body.guidance) cfBody.guidance = req.body.guidance;
      if (!isLucid && req.body.negative_prompt) cfBody.negative_prompt = req.body.negative_prompt;
      if (req.body.seed !== undefined) cfBody.seed = req.body.seed;
    }

    /**
     * 构建 CF 请求体和 Content-Type
     * Flux 2 模型需要 multipart 表单格式，其他模型用 JSON
     */
    const buildRequest = (): { body: string | Buffer; contentType: string } => {
      // Flux 2 模型必须使用 multipart/form-data（CF 官方 schema 要求根对象为 multipart 格式）
      if (isFlux2) {
        // Flux 2 模型需要 multipart/form-data；字段为 prompt + 可选 image(文件附件) / width/height/guidance/seed
        const boundary = '----CFBoundary' + Math.random().toString(36).slice(2);
        const chunks: Buffer[] = [];
        const addField = (name: string, value: any) => {
          chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
        };
        addField('prompt', prompt);
        if (imageBuffer && imageBuffer.length > 0) {
          // CF Flux 2 官方图生图/参考图字段名为 input_image_0（二进制文件附件）
          // 必须按真实图像格式声明 Content-Type，否则上游 magic-bytes 校验失败 (3043)
          const { mime: imgMime, ext: imgExt } = detectImageMime(imageBuffer);
          chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="input_image_0"; filename="input.${imgExt}"\r\nContent-Type: ${imgMime}\r\n\r\n`, 'utf8'));
          chunks.push(imageBuffer);
          chunks.push(Buffer.from('\r\n', 'utf8'));
        }
        if (cfBody.width !== undefined) addField('width', String(cfBody.width));
        if (cfBody.height !== undefined) addField('height', String(cfBody.height));
        if (cfBody.guidance !== undefined) addField('guidance', String(cfBody.guidance));
        if (cfBody.seed !== undefined) addField('seed', String(cfBody.seed));
        chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
        const fullMultipartBuffer = Buffer.concat(chunks);
        appLogger.info(`[AI Image][${rid}] Built multipart payload for ${model}, imageBuffer: ${imageBuffer ? imageBuffer.length : 0}B, total body: ${fullMultipartBuffer.length}B`);
        return { body: fullMultipartBuffer, contentType: `multipart/form-data; boundary=${boundary}` };
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

    /** 处理 CF 图片生成响应 */
    const handleSuccess = async (account: any, cfResp: any) => {
      const contentType = cfResp.headers.get('content-type') || '';
      let b64Image: string;

      appLogger.debug(`[AI Image][${rid}] CF response content-type: ${contentType}, status: ${cfResp.status}`);

      if (contentType.includes('application/json')) {
        const json = await cfResp.json() as any;
        appLogger.debug(`[AI Image][${rid}] CF JSON response keys: ${JSON.stringify(Object.keys(json))}`);
        if (!json.success) {
          throw new Error(json.errors?.[0]?.message || 'CF image generation failed');
        }
        // 兼容多种 JSON 响应格式
        b64Image = json.result?.image || json.image || json.result?.images?.[0] || '';
      } else if (contentType.startsWith('image/') || contentType.includes('octet-stream')) {
        // 二进制图片响应 — 转 base64
        const buf = Buffer.from(await cfResp.arrayBuffer());
        b64Image = buf.toString('base64');
      } else {
        // 未知 content-type — 尝试作为文本/base64 读取
        const text = await cfResp.text();
        // 如果响应体看起来是纯 base64 字符串
        if (text.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(text.trim())) {
          b64Image = text.trim();
        } else {
          // 尝试解析为 JSON
          try {
            const json = JSON.parse(text);
            b64Image = json.result?.image || json.image || json.result?.images?.[0] || '';
          } catch {
            // 最后尝试作为二进制
            b64Image = Buffer.from(text).toString('base64');
          }
        }
      }

      if (!b64Image) {
        appLogger.error(`[AI Image][${rid}] CF returned empty image. content-type: ${contentType}`);
        throw new Error('CF returned empty image');
      }

      // 估算神经元消耗
      const neurons = estimateImageNeurons(model);
      incrementQuota(account.id, 'ai_neurons', neurons);
      updateAiCacheAfterUsage(account.id, neurons);
      appLogger.debug(`[AI Image][${rid}] estimated ${neurons} neurons for account ${account.name}`);
      createAuditLog(account.id, 'ai_image_generation', model,
        `[${rid}] ${image ? 'image-to-image' : 'text-to-image'} neurons=${neurons}`, 'success');

      res.json({
        created: Math.floor(Date.now() / 1000),
        data: [{ b64_json: b64Image, neurons }],
      });
    };

    // --- X-Account-ID 指定账户 ---
    if (specifiedAccountId && specifiedAccountId !== 'auto') {
      const allAccounts = getActiveAccountsByFeature('ai');
      const account = allAccounts.find((a: any) => a.account_id === specifiedAccountId);
      if (!account) {
        res.status(404).json({
          error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
        });
        return;
      }

      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
      const { body: reqBody, contentType: reqCt } = buildRequest();
      const headers = { 'Content-Type': reqCt, ...getAuthHeaders(account) };
      try {
        const cfResp = await proxyFetch(cfUrl, {
          method: 'POST',
          headers,
          body: reqBody,
        }, 300000, undefined, account);

        if (!cfResp.ok) {
          const errorText = await cfResp.text();
          appLogger.error(`[AI Image][${rid}] CF upstream error ${cfResp.status} for account ${account.name} (reqCt=${reqCt}, bodyLen=${reqBody ? reqBody.length : 0}): ${errorText.slice(0, 1000)}`);
          if (isNeuronLimitError(errorText)) {
            setExhausted(account.id, 'ai_neurons');
            removeAccountFromAiCache(account.id);
          }
          res.status(cfResp.status).json({
            error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) },
          });
          return;
        }

        await handleSuccess(account, cfResp);
      } catch (netErr: any) {
        const errMsg = `Network error: ${netErr.message || netErr}`;
        appLogger.error(`[AI Image][${rid}] ${errMsg}`);
        createAuditLog(account.id, 'ai_image_generation', model, `[${rid}] ${errMsg}`, 'error');
        res.status(502).json({
          error: { message: errMsg, type: 'upstream_error', code: 'NETWORK_ERROR' },
        });
      }
      return;
    }

    // --- 自动轮换账户 ---
    const skipped = new Set<number>();
    let lastError = '';
    let lastStatus = 502; // 兜底：上游/网络错误默认 502
    let quotaExhaustedCount = 0; // 因 4006 配额耗尽的账户数
    let totalTriedCount = 0; // 总共尝试过的账户数

    const accountErrors: Array<{ account: string; status: number; error: string }> = [];
    while (true) {
      const account = await selectBestAccount('ai_neurons', skipped, model);
      if (!account) break;

      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
      const { body: reqBody, contentType: reqCt } = buildRequest();
      const headers = { 'Content-Type': reqCt, ...getAuthHeaders(account) };
      totalTriedCount++;

      let cfResp: any;
      try {
        cfResp = await proxyFetch(cfUrl, {
          method: 'POST',
          headers,
          body: reqBody,
        }, 300000, undefined, account);
      } catch (netErr: any) {
        const errMsg = `Network error: ${netErr.message || netErr}`;
        appLogger.warn(`[AI Image][${rid}] Account ${account.name} ${errMsg}`);
        lastError = errMsg;
        lastStatus = 502;
        accountErrors.push({ account: account.name, status: 502, error: errMsg });
        createAuditLog(account.id, 'ai_image_generation', model, `[${rid}] ${errMsg}`, 'error');
        skipped.add(account.id);
        continue;
      }

      if (!cfResp.ok) {
        const errorText = await cfResp.text();
        appLogger.warn(`[AI Image][${rid}] CF upstream error ${cfResp.status} for account ${account.name}: ${errorText.slice(0, 1000)}`);
        lastError = errorText;
        lastStatus = cfResp.status;
        accountErrors.push({ account: account.name, status: cfResp.status, error: extractCfError(errorText) });

        if (isRetryableError(cfResp.status, errorText)) {
          if (isNeuronLimitError(errorText)) {
            quotaExhaustedCount++;
            appLogger.warn(`[AI Image][${rid}] Account ${account.name} neuron limit hit (4006), rotating`);
            setExhausted(account.id, 'ai_neurons');
            removeAccountFromAiCache(account.id);
            skipped.add(account.id);
            createAuditLog(account.id, 'ai_image_generation', model, `[${rid}] 4006 switching`, 'error');
          } else {
            appLogger.warn(`[AI Image][${rid}] Account ${account.name} upstream ${cfResp.status}, rotating`);
            skipped.add(account.id);
            createAuditLog(account.id, 'ai_image_generation', model, `[${rid}] upstream ${cfResp.status}, switching`, 'error');
          }
          continue;
        }

        // Non-retryable
        res.status(cfResp.status).json({
          error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) },
        });
        return;
      }

      // Success
      await handleSuccess(account, cfResp);
      return;
    }

    // 区分失败原因：只有所有尝试过的账户全部是 4006 配额耗尽，才报 quota_exceeded；
    // 若有账户因参数或内部错误失败，必须暴露真实上游错误和详情，避免误报耗尽
    if (quotaExhaustedCount > 0 && quotaExhaustedCount === totalTriedCount) {
      appLogger.error(`[AI Image][${rid}] All accounts exhausted. Last error: ${lastError}`);
      res.status(429).json({
        error: {
          message: 'All accounts have reached daily neuron limit',
          type: 'quota_exceeded',
          code: 'ALL_ACCOUNTS_EXHAUSTED',
          details: accountErrors,
          last_error: extractCfError(lastError) || 'Unknown error',
        },
      });
    } else {
      appLogger.error(`[AI Image][${rid}] Upstream error after retries: ${lastError}, details: ${JSON.stringify(accountErrors)}`);
      res.status(lastStatus).json({
        error: { message: extractCfError(lastError) || 'All accounts failed', type: 'upstream_error', code: upstreamStatusToCode(lastStatus), details: accountErrors },
      });
    }
  } catch (err) {
    next(err);
  }
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

router.post('/audio/speech', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const specifiedAccountId = req.headers['x-account-id'] as string | undefined;
    const { model, input, voice, encoding, container, sample_rate, bit_rate, lang } = req.body;
    const rid = req.requestId || '-';

    if (!model || !input) {
      res.status(400).json({
        error: { message: 'model and input are required', type: 'invalid_request_error', code: 'bad_request' },
      });
      return;
    }

    // 选定用于解析 speaker 枚举 / 兜底的目标账户
    let targetAccount: any = null;
    if (specifiedAccountId && specifiedAccountId !== 'auto') {
      targetAccount = getActiveAccountsByFeature('ai').find((a: any) => a.account_id === specifiedAccountId) || null;
    } else {
      targetAccount = await selectBestAccount('ai_neurons', undefined, model);
    }
    if (!targetAccount) {
      res.status(503).json({
        error: { message: 'No active AI accounts available', type: 'service_error', code: 'NO_ACCOUNTS' },
      });
      return;
    }

    // 按模型 schema 动态构造 CF 请求体（melotts 用 prompt+lang，aura 系列用 text+speaker+encoding）
    const inputSchema = await getModelInputSchema(targetAccount, model);
    const { body: cfBody, speaker } = buildTtsCfBody(inputSchema, input, voice, VOICE_MAP, {
      encoding,
      container,
      sample_rate,
      bit_rate,
      lang,
    });

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

    /** 处理 TTS 成功响应 — 返回 JSON（base64 音频，与 Worker 端一致） */
    const handleTtsSuccess = async (account: any, cfResp: any) => {
      const rawContentType = cfResp.headers.get('content-type') || 'audio/mpeg';
      const arrayBuffer = await cfResp.arrayBuffer();
      let b64Audio: string;
      let audioContentType = rawContentType;

      if (rawContentType.includes('json')) {
        // melotts 等模型可能返回 JSON { audio: "base64..." } 或被 SDK 解包后的结构
        const text = Buffer.from(arrayBuffer).toString('utf8');
        try {
          const json = JSON.parse(text);
          // 递归查找最像 base64 字符串的字段（兼容 audio / result.audio / data.audio / 单字符串等多种结构）
          const findBase64 = (obj: any, depth = 0): string => {
            if (depth > 5 || obj == null) return '';
            if (typeof obj === 'string') {
              // base64 通常长度 > 100 且字符集为 [A-Za-z0-9+/=]
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
          b64Audio = Buffer.from(text).toString('base64');
          audioContentType = 'audio/mpeg';
        }
      } else {
        b64Audio = Buffer.from(arrayBuffer).toString('base64');
      }

      // 音频为空：明确返回 502 错误，避免前端拿到空 data URL 播放 0s
      if (!b64Audio) {
        appLogger.warn(`[AI TTS][${rid}] ${model} 返回空音频 (content-type=${rawContentType}, bytes=${arrayBuffer.byteLength})`);
        return res.status(502).json({
          error: {
            message: `TTS 模型未返回音频数据（content-type=${rawContentType}, bytes=${arrayBuffer.byteLength}）`,
            type: 'upstream_error',
            code: 'EMPTY_AUDIO',
          },
        });
      }

      // 仅保留音频 MIME；若 CF 返回的是 application/json（JSON base64 响应），用 audio/mpeg 占位（MeloTTS 实际输出 wav，
      // 浏览器对 wav 需 audio/wav，若仍 0s 可在高级设置通过转换或后端推断调整）
      if (!audioContentType.startsWith('audio/')) {
        audioContentType = 'audio/mpeg';
      }

      // 估算神经元消耗
      const neurons = estimateTtsNeurons(input, model);
      incrementQuota(account.id, 'ai_neurons', neurons);
      updateAiCacheAfterUsage(account.id, neurons);
      createAuditLog(account.id, 'ai_tts_generation', model,
        `[${rid}] chars=${input.length} speaker=${speaker} neurons=${neurons}`, 'success');

      res.json({
        created: Math.floor(Date.now() / 1000),
        data: [{ audio: b64Audio, neurons, content_type: audioContentType }],
      });
    };

    // --- X-Account-ID 指定账户 ---
    if (specifiedAccountId && specifiedAccountId !== 'auto') {
      const allAccounts = getActiveAccountsByFeature('ai');
      const account = allAccounts.find((a: any) => a.account_id === specifiedAccountId);
      if (!account) {
        res.status(404).json({
          error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
        });
        return;
      }

      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
      const headers = { 'Content-Type': 'application/json', ...getAuthHeaders(account) };
      try {
        const cfResp = await proxyFetch(cfUrl, {
          method: 'POST', headers, body: JSON.stringify(cfBody),
        }, 300000, undefined, account);

        if (!cfResp.ok) {
          const errorText = await cfResp.text();
          appLogger.error(`[AI TTS][${rid}] CF upstream error ${cfResp.status}: ${errorText.slice(0, 500)}`);
          res.status(cfResp.status).json({
            error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) },
          });
          return;
        }
        await handleTtsSuccess(account, cfResp);
      } catch (netErr: any) {
        res.status(502).json({ error: { message: `Network error: ${netErr.message}`, type: 'upstream_error', code: 'NETWORK_ERROR' } });
      }
      return;
    }

    // --- 自动轮换账户 ---
    const skipped = new Set<number>();
    let lastError = '';
    let lastStatus = 502; // 兜底：上游/网络错误默认 502
    let quotaExhausted = false; // 是否因神经元额度耗尽而失败
    while (true) {
      const account = await selectBestAccount('ai_neurons', skipped, model);
      if (!account) break;

      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
      const headers = { 'Content-Type': 'application/json', ...getAuthHeaders(account) };
      let cfResp: any;
      try {
        cfResp = await proxyFetch(cfUrl, {
          method: 'POST', headers, body: JSON.stringify(cfBody),
        }, 300000, undefined, account);
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
            setExhausted(account.id, 'ai_neurons');
            removeAccountFromAiCache(account.id);
          }
          skipped.add(account.id);
          continue;
        }
        res.status(cfResp.status).json({
          error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) },
        });
        return;
      }

      await handleTtsSuccess(account, cfResp);
      return;
    }

    // 区分失败原因：真配额耗尽才报 quota_exceeded；否则返回真实上游/网络错误，避免误报
    if (quotaExhausted) {
      res.status(429).json({
        error: { message: 'All accounts exhausted', type: 'quota_exceeded', code: 'ALL_ACCOUNTS_EXHAUSTED', last_error: lastError },
      });
    } else {
      res.status(lastStatus).json({
        error: { message: lastError || 'All accounts failed', type: 'upstream_error', code: upstreamStatusToCode(lastStatus) },
      });
    }
  } catch (err) { next(err); }
});

// ================================================================
// POST /audio/transcriptions — 语音转文本 ASR（OpenAI-compatible）
// ================================================================
// 仅 whisper 系列（whisper / whisper-tiny-en / whisper-large-v3-turbo）支持同步 JSON 转写：
//   whisper、whisper-tiny-en 的 audio 为 0-255 字节数组；whisper-large-v3-turbo 的 audio 为 base64 字符串，prompt→initial_prompt。
// deepgram nova-3 / deepgram flux 为实时流式模型（realtime=true），pipecat smart-turn-v2 为 VAD 模型，
// 均无法通过同步 /ai/run JSON 端点调用，本路由直接拒绝。
// OpenAI 原版用 multipart/form-data 上传 file，本实现统一为 JSON { audio: <base64> }。
router.post('/audio/transcriptions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const specifiedAccountId = req.headers['x-account-id'] as string | undefined;
    const { model, audio, file, language, prompt, response_format } = req.body as any;
    const audioB64 = audio || file;
    const rid = req.requestId || '-';

    if (!model || !audioB64) {
      res.status(400).json({
        error: { message: 'model and audio (base64 string) are required', type: 'invalid_request_error', code: 'bad_request' },
      });
      return;
    }

    // 模型族识别：仅 whisper 系列支持同步 JSON 转写；deepgram（nova-3/flux）为实时流式模型，
    // pipecat smart-turn-v2 为 VAD（话轮检测）模型，均无法通过同步 /ai/run JSON 端点调用，直接拒绝。
    const isWhisperTurbo = model.includes('whisper-large-v3-turbo');
    const isWhisperLegacy = model.includes('whisper') && !isWhisperTurbo;
    const isSyncUnsupported = model.includes('nova-3') || model.includes('deepgram/flux') || model.includes('smart-turn') || model.includes('pipecat');
    if (isSyncUnsupported) {
      res.status(400).json({
        error: {
          message: `模型 ${model} 为实时流式/VAD 模型，不支持同步 /audio/transcriptions 调用`,
          type: 'invalid_request_error',
          code: 'unsupported_model',
        },
      });
      return;
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
      cfBody.audio = Array.from(Buffer.from(audioB64, 'base64'));
    } else {
      // whisper-large-v3-turbo：audio 为 base64 字符串；prompt 映射为 initial_prompt
      cfBody.audio = audioB64;
      if (language) cfBody.language = language;
      if (prompt) cfBody.initial_prompt = prompt;
    }

    const handleAsrSuccess = async (account: any, cfResp: any) => {
      const json = await cfResp.json() as any;
      const rawText = json?.result?.text ?? json?.text ?? json?.result?.output;
      if (rawText === undefined || rawText === null) {
        appLogger.error(`[AI ASR][${rid}] CF returned empty transcription`);
        res.status(502).json({ error: { message: 'ASR 模型未返回文本', type: 'upstream_error', code: 'EMPTY_TEXT' } });
        return;
      }
      const text = String(rawText);
      const audioBytes = Buffer.from(audioB64, 'base64').length;
      const neurons = estimateAsrNeurons(audioBytes, model);
      incrementQuota(account.id, 'ai_neurons', neurons);
      updateAiCacheAfterUsage(account.id, neurons);
      createAuditLog(account.id, 'ai_asr_transcription', model,
        `[${rid}] bytes=${audioBytes} lang=${language || 'auto'} neurons=${neurons}`, 'success');

      if (response_format === 'text') {
        res.set('Content-Type', 'text/plain; charset=utf-8');
        res.send(text);
        return;
      }
      res.json({ text, neurons, task: 'transcribe', language: language || null });
    };

    // --- X-Account-ID 指定账户 ---
    if (specifiedAccountId && specifiedAccountId !== 'auto') {
      const allAccounts = getActiveAccountsByFeature('ai');
      const account = allAccounts.find((a: any) => a.account_id === specifiedAccountId);
      if (!account) {
        res.status(404).json({
          error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
        });
        return;
      }
      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
      const headers = { 'Content-Type': 'application/json', ...getAuthHeaders(account) };
      try {
        const cfResp = await proxyFetch(cfUrl, { method: 'POST', headers, body: JSON.stringify(cfBody) }, 300000, undefined, account);
        if (!cfResp.ok) {
          const errorText = await cfResp.text();
          res.status(cfResp.status).json({ error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } });
          return;
        }
        await handleAsrSuccess(account, cfResp);
      } catch (netErr: any) {
        res.status(502).json({ error: { message: `Network error: ${netErr.message}`, type: 'upstream_error', code: 'NETWORK_ERROR' } });
      }
      return;
    }

    // --- 自动轮换账户 ---
    const skipped = new Set<number>();
    let lastError = '';
    let lastStatus = 502; // 兜底：上游/网络错误默认 502
    let quotaExhausted = false; // 是否因神经元额度耗尽而失败
    while (true) {
      const account = await selectBestAccount('ai_neurons', skipped, model);
      if (!account) break;
      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
      const headers = { 'Content-Type': 'application/json', ...getAuthHeaders(account) };
      let cfResp: any;
      try {
        cfResp = await proxyFetch(cfUrl, { method: 'POST', headers, body: JSON.stringify(cfBody) }, 300000, undefined, account);
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
            setExhausted(account.id, 'ai_neurons');
            removeAccountFromAiCache(account.id);
          }
          skipped.add(account.id);
          continue;
        }
        res.status(cfResp.status).json({ error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) } });
        return;
      }
      await handleAsrSuccess(account, cfResp);
      return;
    }

    // 区分失败原因：真配额耗尽才报 quota_exceeded；否则返回真实上游/网络错误，避免误报
    if (quotaExhausted) {
      res.status(429).json({
        error: { message: 'All accounts exhausted', type: 'quota_exceeded', code: 'ALL_ACCOUNTS_EXHAUSTED', last_error: lastError },
      });
    } else {
      res.status(lastStatus).json({
        error: { message: lastError || 'All accounts failed', type: 'upstream_error', code: upstreamStatusToCode(lastStatus) },
      });
    }
  } catch (err) { next(err); }
});

// ================================================================
// POST /translations — 文本翻译（OpenAI-compatible 自定义扩展）
// ================================================================
router.post('/translations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const specifiedAccountId = req.headers['x-account-id'] as string | undefined;
    const { model, text, source_lang, target_lang } = req.body;
    const rid = req.requestId || '-';

    if (!model || !text || !target_lang) {
      res.status(400).json({
        error: { message: 'model, text, and target_lang are required', type: 'invalid_request_error', code: 'bad_request' },
      });
      return;
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

    const handleTranslationSuccess = async (account: any, cfResp: any) => {
      const json = await cfResp.json() as any;
      const translatedText = isIndicTrans2
        ? (json?.result?.translations?.[0] || '')
        : (json?.result?.translated_text || json?.result?.output || json?.translated_text || '');

      if (!translatedText) {
        appLogger.error(`[AI Translation][${rid}] CF returned empty translation`);
        throw new Error('CF returned empty translation');
      }

      const neurons = estimateTranslationNeurons(text, model);
      incrementQuota(account.id, 'ai_neurons', neurons);
      updateAiCacheAfterUsage(account.id, neurons);
      appLogger.debug(`[AI Translation][${rid}] estimated ${neurons} neurons for account ${account.name}`);
      createAuditLog(account.id, 'ai_translation', model,
        `[${rid}] chars=${text.length} source=${source_lang || 'auto'} target=${target_lang} neurons=${neurons}`, 'success');

      res.json({
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
      const allAccounts = getActiveAccountsByFeature('ai');
      const account = allAccounts.find((a: any) => a.account_id === specifiedAccountId);
      if (!account) {
        res.status(404).json({
          error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
        });
        return;
      }

      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
      const headers = { 'Content-Type': 'application/json', ...getAuthHeaders(account) };
      try {
        const cfResp = await proxyFetch(cfUrl, {
          method: 'POST', headers, body: JSON.stringify(cfBody),
        }, 300000, undefined, account);

        if (!cfResp.ok) {
          const errorText = await cfResp.text();
          appLogger.error(`[AI Translation][${rid}] CF upstream error ${cfResp.status}: ${errorText.slice(0, 500)}`);
          res.status(cfResp.status).json({
            error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) },
          });
          return;
        }
        await handleTranslationSuccess(account, cfResp);
      } catch (netErr: any) {
        res.status(502).json({ error: { message: `Network error: ${netErr.message}`, type: 'upstream_error', code: 'NETWORK_ERROR' } });
      }
      return;
    }

    const skipped = new Set<number>();
    let lastError = '';
    let lastStatus = 502; // 兜底：上游/网络错误默认 502
    let quotaExhausted = false; // 是否因神经元额度耗尽而失败
    while (true) {
      const account = await selectBestAccount('ai_neurons', skipped, model);
      if (!account) break;

      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
      const headers = { 'Content-Type': 'application/json', ...getAuthHeaders(account) };
      let cfResp: any;
      try {
        cfResp = await proxyFetch(cfUrl, {
          method: 'POST', headers, body: JSON.stringify(cfBody),
        }, 300000, undefined, account);
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
            setExhausted(account.id, 'ai_neurons');
            removeAccountFromAiCache(account.id);
          }
          skipped.add(account.id);
          continue;
        }
        res.status(cfResp.status).json({
          error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) },
        });
        return;
      }

      await handleTranslationSuccess(account, cfResp);
      return;
    }

    // 区分失败原因：真配额耗尽才报 quota_exceeded；否则返回真实上游/网络错误，避免误报
    if (quotaExhausted) {
      res.status(429).json({
        error: { message: 'All accounts exhausted', type: 'quota_exceeded', code: 'ALL_ACCOUNTS_EXHAUSTED', last_error: lastError },
      });
    } else {
      res.status(lastStatus).json({
        error: { message: lastError || 'All accounts failed', type: 'upstream_error', code: upstreamStatusToCode(lastStatus) },
      });
    }
  } catch (err) { next(err); }
});

// ================================================================
// POST /embeddings — 文本嵌入（OpenAI-compatible）
// ================================================================
// Cloudflare Workers AI 嵌入模型（bge 系列、bge-m3、qwen3-embedding、plamo-embedding、embeddinggemma 等）
// 通过 /ai/run/{model} 调用，请求体 { text: string|string[] }，响应 { result: { data: number[][], shape } }。
// 经官方 schema 核验：data 直接为向量数组（每个元素是一条文本的向量），部分旧模型可能为 [{embedding,index}]。
// 这里将其转换为 OpenAI 的 /v1/embeddings 格式（object/list + data[].embedding + usage）。
router.post('/embeddings', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const specifiedAccountId = req.headers['x-account-id'] as string | undefined;
    const { model, input, encoding_format } = req.body;
    const rid = req.requestId || '-';

    if (!model || input === undefined || input === null) {
      res.status(400).json({
        error: { message: 'model and input are required', type: 'invalid_request_error', code: 'bad_request' },
      });
      return;
    }

    // 规范化 input：OpenAI 支持 string 或 string[]（token 数组极少见，统一按字符串处理）
    const texts: string[] = Array.isArray(input) ? input.map(String) : [String(input)];
    const useBase64 = encoding_format === 'base64';

    /** 将 float 数组编码为 OpenAI base64 编码格式（Float32 little-endian） */
    const floatsToBase64 = (floats: number[]): string => {
      const buf = new Float32Array(floats.length);
      for (let i = 0; i < floats.length; i++) buf[i] = floats[i];
      return Buffer.from(buf.buffer).toString('base64');
    };

    /** 处理 CF 嵌入成功响应 → 转 OpenAI 格式 */
    const handleEmbeddingsSuccess = async (account: any, cfResp: any) => {
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
      incrementQuota(account.id, 'ai_neurons', neurons);
      updateAiCacheAfterUsage(account.id, neurons);

      // 估算 token 用量（CF 嵌入响应不含 usage）
      const estTokens = Math.max(1, Math.ceil(texts.reduce((s, t) => s + (t?.length || 0), 0) / 4));
      createAuditLog(account.id, 'ai_embeddings', model,
        `[${rid}] inputs=${texts.length} dims=${dims} tokens≈${estTokens} neurons=${neurons}`, 'success');

      res.json({
        object: 'list',
        data,
        model,
        usage: { prompt_tokens: estTokens, total_tokens: estTokens },
      });
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

    // --- X-Account-ID 指定账户 ---
    if (specifiedAccountId && specifiedAccountId !== 'auto') {
      const allAccounts = getActiveAccountsByFeature('ai');
      const account = allAccounts.find((a: any) => a.account_id === specifiedAccountId);
      if (!account) {
        res.status(404).json({
          error: { message: `Account ${specifiedAccountId} not found or inactive`, type: 'invalid_request_error', code: 'ACCOUNT_NOT_FOUND' },
        });
        return;
      }

      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
      const headers = { 'Content-Type': 'application/json', ...getAuthHeaders(account) };
      try {
        const cfResp = await proxyFetch(cfUrl, {
          method: 'POST', headers, body: JSON.stringify({ text: texts }),
        }, 120000, undefined, account);

        if (!cfResp.ok) {
          const errorText = await cfResp.text();
          appLogger.error(`[AI Embeddings][${rid}] CF upstream error ${cfResp.status}: ${errorText.slice(0, 500)}`);
          if (isNeuronLimitError(errorText)) {
            setExhausted(account.id, 'ai_neurons');
            removeAccountFromAiCache(account.id);
          }
          res.status(cfResp.status).json({
            error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) },
          });
          return;
        }
        await handleEmbeddingsSuccess(account, cfResp);
      } catch (netErr: any) {
        res.status(502).json({ error: { message: `Network error: ${netErr.message}`, type: 'upstream_error', code: 'NETWORK_ERROR' } });
      }
      return;
    }

    // --- 自动轮换账户 ---
    const skipped = new Set<number>();
    let lastError = '';
    let lastStatus = 502; // 兜底：上游/网络错误默认 502
    let quotaExhausted = false; // 是否因神经元额度耗尽而失败
    while (true) {
      const account = await selectBestAccount('ai_neurons', skipped, model);
      if (!account) break;

      const cfUrl = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
      const headers = { 'Content-Type': 'application/json', ...getAuthHeaders(account) };
      let cfResp: any;
      try {
        cfResp = await proxyFetch(cfUrl, {
          method: 'POST', headers, body: JSON.stringify({ text: texts }),
        }, 120000, undefined, account);
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
            setExhausted(account.id, 'ai_neurons');
            removeAccountFromAiCache(account.id);
          }
          skipped.add(account.id);
          continue;
        }
        res.status(cfResp.status).json({
          error: { message: extractCfError(errorText), type: 'upstream_error', code: upstreamStatusToCode(cfResp.status) },
        });
        return;
      }

      await handleEmbeddingsSuccess(account, cfResp);
      return;
    }

    // 区分失败原因：真配额耗尽才报 quota_exceeded；否则返回真实上游/网络错误，避免误报
    if (quotaExhausted) {
      res.status(429).json({
        error: { message: 'All accounts exhausted', type: 'quota_exceeded', code: 'ALL_ACCOUNTS_EXHAUSTED', last_error: lastError },
      });
    } else {
      res.status(lastStatus).json({
        error: { message: lastError || 'All accounts failed', type: 'upstream_error', code: upstreamStatusToCode(lastStatus) },
      });
    }
  } catch (err) { next(err); }
});

export default router;
