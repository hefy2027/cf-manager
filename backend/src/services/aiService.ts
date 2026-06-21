import { Account } from '../models/account';
import { getCfClient, getAuthHeaders } from './cfFactory';
import { proxyFetch, buildCurlCommand, type FetchResponse } from './proxyService';
import { appLogger } from './logger';

export async function getAvailableModels(account: Account, taskFilter?: string): Promise<any[]> {
  if (!account.account_id) {
    throw new Error(`账户 "${account.name}" 缺少 Cloudflare Account ID，请点击“测试连接”以获取`);
  }
  const cfAny = getCfClient(account) as any;
  const models: any[] = [];
  for await (const model of cfAny.ai.models.list({ account_id: account.account_id })) {
    const m = model as any;
    // 如果指定了任务过滤，只返回匹配的模型
    if (taskFilter) {
      const taskName = m.task?.name || '';
      if (!taskName.toLowerCase().includes(taskFilter.toLowerCase())) continue;
    }
    models.push(m);
  }
  return models;
}

export async function runInference(account: Account, model: string, prompt: string): Promise<string> {
  if (!account.account_id) {
    throw new Error(`Account "${account.name}" is missing Cloudflare Account ID`);
  }
  const cfAny = getCfClient(account) as any;
  const params: any = {
    messages: [{ role: 'user', content: prompt }],
    account_id: account.account_id,
  };
  const result = await cfAny.ai.run(model, params);

  // 处理响应 - 聊天格式: { response: '...' } 或 OpenAI 格式: { choices: [{ message: { content: '...' } }] }
  let text = '';
  if (typeof result === 'string') {
    text = result;
  } else if (result?.response) {
    text = result.response;
  } else if (result?.choices?.[0]?.message?.content) {
    text = result.choices[0].message.content;
  } else if (result?.choices?.[0]?.text) {
    text = result.choices[0].text;
  } else if (result?.text) {
    text = result.text;
  } else if (result?.content) {
    text = result.content;
  } else if (result) {
    text = JSON.stringify(result);
  }

  return text;
}

// 流式推理 - 使用 REST API 直接调用
export async function runInferenceStream(
  account: Account,
  model: string,
  prompt: string,
  historyMessages?: { role: string; content: string }[],
  onContent?: (chunk: string) => void,
  onReasoning?: (chunk: string) => void,
  onDone?: () => void,
  onError?: (err: Error) => void
): Promise<void> {
  // 兼容旧调用签名：如果第4个参数是函数，则按旧方式处理
  if (typeof historyMessages === 'function') {
    onError = onDone as any;
    onDone = onReasoning as any;
    onReasoning = onContent as any;
    onContent = historyMessages as any;
    historyMessages = undefined;
  }
  if (!account.account_id) {
    onError?.(new Error('Account ID is required for AI inference'));
    return;
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${account.account_id}/ai/run/${model}`;
  const headers = {
    'Content-Type': 'application/json',
    ...getAuthHeaders(account),
  };

  // 构建消息列表：历史对话 + 当前用户输入
  const messages: { role: string; content: string }[] = [];
  if (historyMessages && historyMessages.length > 0) {
    messages.push(...historyMessages);
  }
  messages.push({ role: 'user', content: prompt });

  const body = {
    messages,
    stream: true,
  };

  appLogger.info(`[AI] Streaming: model=${model}`);

  try {
    const response = await proxyFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      const err = new Error(`Cloudflare API error: ${response.status} ${errorText}`);
      (err as any).statusCode = response.status;
      throw err;
    }

    if (!response.body) {
      throw new Error('Response body is null');
    }

    const respBody = response.body as any;
    const decoder = new TextDecoder();
    let buffer = '';
    let chunkCount = 0;
    let earlyReturn = false;

    function processChunk(raw: any) {
      buffer += decoder.decode(raw, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            earlyReturn = true;
            onDone?.();
            return;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta;
            if (delta?.content) {
              chunkCount++;
              onContent?.(delta.content);
            } else if (delta?.reasoning || delta?.reasoning_content) {
              chunkCount++;
              onReasoning?.(delta.reasoning || delta.reasoning_content);
            } else if (parsed?.response) {
              chunkCount++;
              onContent?.(parsed.response);
            }
          } catch (e) {
            appLogger.warn(`[AI] Failed to parse SSE data: ${data}`);
          }
        }
      }
    }

    if (typeof respBody.getReader === 'function') {
      const reader = respBody.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done || earlyReturn) break;
        processChunk(value);
      }
    } else if (typeof respBody[Symbol.asyncIterator] === 'function') {
      for await (const chunk of respBody) {
        processChunk(chunk);
        if (earlyReturn) break;
      }
    }

    if (!earlyReturn) onDone?.();
  } catch (err) {
    appLogger.error(`[AI] Stream error: ${err}`);
    onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

export interface AiUsage {
  totalNeurons: number;
  models: Array<{ modelId: string; neurons: number; requests: number }>;
}

export async function getAiUsageToday(account: Account): Promise<AiUsage> {
  const accountId = account.account_id;
  if (!accountId) return { totalNeurons: 0, models: [] };

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const todayEnd = now.toISOString();

  const query = `
    query CfAiUsage($accountTag: string!, $start: Time!, $end: Time!) {
      viewer {
        accounts(filter: {accountTag: $accountTag}) {
          total: aiInferenceAdaptiveGroups(
            filter: { datetime_geq: $start, datetime_leq: $end }
            limit: 1
          ) {
            sum { totalNeurons }
          }
          byModel: aiInferenceAdaptiveGroups(
            filter: { datetime_geq: $start, datetime_leq: $end }
            limit: 100
            orderBy: [sum_totalNeurons_DESC]
          ) {
            count
            sum { totalNeurons }
            dimensions { modelId }
          }
        }
      }
    }
  `;

  const headers = getAuthHeaders(account);
  const fetchUrl = 'https://api.cloudflare.com/client/v4/graphql';
  const fetchInit = {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      variables: { accountTag: accountId, start: todayStart, end: todayEnd },
    }),
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let resp: FetchResponse;
  try {
    resp = await proxyFetch(fetchUrl, { ...fetchInit, signal: controller.signal });
  } catch (e) {
    appLogger.error(`[AI Usage] Fetch failed for ${account.name}: ${e}\n[DEBUG curl] ${buildCurlCommand(fetchUrl, fetchInit)}`);
    return { totalNeurons: 0, models: [] };
  } finally {
    clearTimeout(timeout);
  }

  if (!resp.ok) return { totalNeurons: 0, models: [] };

  const json = await resp.json() as any;
  if (json.errors) {
    appLogger.error(`[GraphQL] AI usage errors: ${JSON.stringify(json.errors)}`);
    return { totalNeurons: 0, models: [] };
  }

  const acct = json?.data?.viewer?.accounts?.[0];
  const totalRecs = acct?.total || [];
  const modelRecs = acct?.byModel || [];

  const totalNeurons = totalRecs[0]?.sum?.totalNeurons || 0;
  const models = modelRecs
    .filter((r: any) => r.dimensions?.modelId)
    .map((r: any) => ({
      modelId: r.dimensions.modelId,
      neurons: r.sum?.totalNeurons || 0,
      requests: r.count || 0,
    }));

  return { totalNeurons: Math.round(totalNeurons), models };
}
