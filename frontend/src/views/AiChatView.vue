<template>
  <div class="ai-view-root">
    <!-- 聊天消息区域 -->
    <div ref="chatContainer" style="flex: 1; overflow-y: auto; padding: 20px;">
      <!-- 欢迎页 -->
      <div v-if="messages.length === 0" style="text-align: center; padding: 40px 20px 40px;">
        <h1 style="font-size: 32px; margin-bottom: 36px; color: var(--app-text-heading); font-weight: 600;">{{ t('ai.welcome') }}</h1>
        <div style="display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; max-width: 820px; margin: 0 auto;">
          <div
            v-for="s in suggestions"
            :key="s"
            style="cursor: pointer; padding: 12px 20px; font-size: 14px; border: 1px solid var(--app-border); border-radius: 24px; background: var(--app-bg-card); color: var(--app-text-primary); transition: all 0.2s;"
            @mouseenter="(e: MouseEvent) => { const t = e.target as HTMLElement; t.style.borderColor = '#2080f0'; t.style.color = '#2080f0'; }"
            @mouseleave="(e: MouseEvent) => { const t = e.target as HTMLElement; t.style.borderColor = '#e0e0e0'; t.style.color = '#333'; }"
            @click="useSuggestion(s)"
          >
            {{ s }}
          </div>
        </div>
      </div>

      <!-- 消息列表 -->
      <div v-for="(msg, idx) in messages" :key="idx" style="margin-bottom: 20px; display: flex; flex-direction: column; align-items: flex-end;">
        <!-- 用户消息 -->
        <div v-if="msg.role === 'user'" style="display: flex; justify-content: flex-end; width: 100%;">
          <div style="background: #18a058; color: white; padding: 12px 16px; border-radius: 16px 16px 4px 16px; max-width: 70%; font-size: 15px; line-height: 1.6; white-space: pre-wrap;">{{ msg.content }}</div>
        </div>
        <!-- AI 消息 -->
        <div v-else style="display: flex; justify-content: flex-start; width: 100%; gap: 10px;">
          <div style="width: 36px; height: 36px; border-radius: 50%; background: #2080f0; color: white; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0;">AI</div>
          <div style="background: var(--app-bg-secondary); padding: 12px 16px; border-radius: 4px 16px 16px 16px; max-width: 70%; font-size: 15px; line-height: 1.6;">
            <!-- 思考过程 -->
            <div v-if="msg.reasoning" style="margin-bottom: 10px;">
              <div
                style="cursor: pointer; display: flex; align-items: center; gap: 6px; color: var(--app-text-muted); font-size: 13px; user-select: none;"
                @click="msg.reasoningExpanded = !msg.reasoningExpanded"
              >
                <span style="font-size: 12px; transition: transform 0.2s; display: inline-block;" :style="{ transform: msg.reasoningExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }">▶</span>
                 {{ t('ai.thinkingProcess') }}{{ msg.thinkingDone ? '' : t('ai.thinkingInProgress') }}
              </div>
              <div v-show="msg.reasoningExpanded" style="white-space: pre-wrap; color: var(--app-text-tertiary); font-size: 13px; background: var(--app-bg-tertiary); padding: 10px; border-radius: 6px; margin-top: 6px;">{{ msg.reasoning }}</div>
            </div>
            <!-- 回答内容 -->
            <div style="white-space: pre-wrap;">{{ msg.content }}</div>
            <!-- 加载中 -->
            <div v-if="msg.loading" style="color: var(--app-text-disabled);">
              <n-spin size="small" /> {{ t('ai.thinking') }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部输入区域 -->
    <div class="ai-input-bar">
      <!-- 顶部工具栏 -->
      <div class="ai-toolbar">
        <n-select
          v-model:value="selectedAccount"
          :options="accountOptions"
          placeholder=""
          class="ai-select-account"
          size="small"
        />
        <n-select
          v-model:value="selectedModel"
          :options="modelOptions"
          :placeholder="t('ai.selectModel')"
          style="flex: 1; min-width: 0;"
          :loading="modelsLoading"
          size="small"
          filterable
          :render-label="renderModelLabel"
          @update:value="onModelChange"
        />
        <n-button v-if="messages.length > 0" size="small" quaternary @click="messages = []">
          {{ t('ai.newChat') }}
        </n-button>
      </div>
      <!-- 输入框 -->
      <div style="display: flex; gap: 10px; align-items: flex-end;">
        <n-input
          v-model:value="prompt"
          type="textarea"
          :placeholder="t('ai.sendMessage')"
          :rows="2"
          :disabled="inferring"
          @keydown.enter.exact.prevent="sendMessage"
          style="flex: 1;"
        />
        <n-button type="primary" @click="sendMessage" :loading="inferring" :disabled="!selectedModel || !prompt.trim()" style="height: 40px;">
          {{ t('ai.send') }}
        </n-button>
        <n-button @click="stopInference" :disabled="!inferring" style="height: 40px;">{{ t('ai.stop') }}</n-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, watch, onMounted, onBeforeUnmount, nextTick, computed } from 'vue';
import { useMessage } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { accountsApi } from '../api/accounts';
import { renderPaidModelLabel } from '../utils/paidLabel';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  reasoningExpanded?: boolean;
  thinkingDone?: boolean;
  loading?: boolean;
}

const { t } = useI18n();
const message = useMessage();
const selectedAccount = ref<string>('auto'); // 'auto' = 自动分配
const accountOptions = ref<{ label: string; value: string }[]>([]);
const selectedModel = ref('');
const modelOptions = ref<{ label: string; value: string; requirePaid?: boolean }[]>([]);
const modelsLoading = ref(false);
const prompt = ref('');
const messages = ref<ChatMessage[]>([]);
const inferring = ref(false);
const chatContainer = ref<HTMLElement>();
let abortController: AbortController | null = null;

// 等待浏览器绘制完成一帧
function waitFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

const suggestions = computed(() => [
  t('ai.suggestions.s1'),
  t('ai.suggestions.s2'),
  t('ai.suggestions.s3'),
  t('ai.suggestions.s4'),
  t('ai.suggestions.s5'),
  t('ai.suggestions.s6'),
]);

// 付费模型 value 集合
const paidModelValues = computed(() => new Set(
  modelOptions.value.filter((o) => o.requirePaid).map((o) => o.value)
));

// naive-ui n-select 的 render-label 是函数 prop（不是 slot），须返回 VNode/字符串
function renderModelLabel(option: any) {
  return renderPaidModelLabel(option, !!option.value && paidModelValues.value.has(option.value));
}

async function fetchAccounts() {
  try {
    const { data } = await accountsApi.getAll();
    const seen = new Set<string>();
    const accounts = (data.accounts || [])
      .filter((a: any) => a.is_active && (a.enabled_features || '').includes('ai'))
      .map((a: any) => ({
        label: a.name,
        value: a.account_id || String(a.id), // Use account_id (Cloudflare ID) for AI requests
      }))
      .filter((opt: { value: string }) => {
        if (!opt.value || seen.has(opt.value)) return false;
        seen.add(opt.value);
        return true;
      });
    accountOptions.value = [
      { label: '🤖 ' + t('ai.autoAssign'), value: 'auto' },
      ...accounts,
    ];
  } catch {
    accountOptions.value = [{ label: '🤖 ' + t('ai.autoAssign'), value: 'auto' }];
  }
}

async function fetchModels() {
  modelsLoading.value = true;
  try {
    const token = localStorage.getItem('api_token');
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    
    // Filter to only text-generation models (chat/completions compatible)
    const response = await fetch('/api/v1/models?task=text-generation', { headers });
    if (!response.ok) throw new Error(`Failed to fetch models: ${response.status}`);
    
    const data = await response.json();
    modelOptions.value = (data.data || []).map((m: any) => {
      const fullName = m.id || m.name;
      const shortName = fullName.replace(/^@cf\//, '');
      return { label: shortName, value: fullName, requirePaid: !!m.require_workers_paid };
    });
    
    if (modelOptions.value.length && !modelOptions.value.find(o => o.value === selectedModel.value)) {
      selectedModel.value = modelOptions.value[0].value;
    }
  } catch {
    // models fetch may fail silently
  } finally {
    modelsLoading.value = false;
  }
}

function onModelChange() {
  // 模型改变时不需要额外操作
}

function useSuggestion(s: string) {
  prompt.value = s;
  sendMessage();
}

async function sendMessage() {
  if (!selectedModel.value || !prompt.value.trim()) return;

  const userMsg: ChatMessage = { role: 'user', content: prompt.value };
  messages.value.push(userMsg);

  const aiMsg = reactive<ChatMessage>({ role: 'assistant', content: '', reasoning: '', reasoningExpanded: false, thinkingDone: false, loading: true });
  messages.value.push(aiMsg);

  const currentPrompt = prompt.value;
  prompt.value = '';
  inferring.value = true;
  abortController = new AbortController();

  scrollToBottom();

  try {
    const token = localStorage.getItem('api_token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    
    // Build messages array (exclude loading messages)
    const historyMessages = messages.value
      .filter(m => !m.loading)
      .slice(0, -1) // exclude current user message, will be added below
      .map(m => ({ role: m.role, content: m.content }));
    
    const response = await fetch('/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        ...headers,
        ...(selectedAccount.value && selectedAccount.value !== 'auto' ? { 'X-Account-ID': selectedAccount.value } : {}),
      },
      body: JSON.stringify({
        model: selectedModel.value,
        messages: [...historyMessages, { role: 'user', content: currentPrompt }],
        stream: true,
      }),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '[DONE]') {
            aiMsg.thinkingDone = true;
            break;
          }
          try {
            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta;
            
            if (delta?.reasoning_content || delta?.reasoning) {
              // Reasoning/thinking content
              const reasoningText = delta.reasoning_content || delta.reasoning;
              aiMsg.reasoning = (aiMsg.reasoning || '') + reasoningText;
              aiMsg.reasoningExpanded = true;
              await nextTick();
              await waitFrame(); // 等浏览器绘制
            }
            
            if (delta?.content) {
              // Actual response content
              aiMsg.thinkingDone = true;
              aiMsg.content += delta.content;
              await nextTick();
              await waitFrame(); // 等浏览器绘制
            }
            
            if (parsed.error) {
              message.error(parsed.error.message || JSON.stringify(parsed.error));
            }
          } catch (_e) {
            console.warn('Failed to parse SSE:', data);
          }
        }
      }
      scrollToBottom();
    }

    aiMsg.loading = false;
    if (!aiMsg.content && !aiMsg.reasoning) {
      aiMsg.content = t('ai.emptyResponse');
    }
  } catch (e: any) {
    if (e.name !== 'AbortError') {
      aiMsg.content = t('ai.error', { error: e?.errorMessage || e?.message || t('ai.inferenceFailed') });
    } else {
      aiMsg.content += '\n\n' + t('ai.stopped');
    }
    aiMsg.loading = false;
  } finally {
    inferring.value = false;
    abortController = null;
    scrollToBottom();
  }
}

function stopInference() {
  if (abortController) {
    abortController.abort();
    abortController = null;
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (chatContainer.value) {
      chatContainer.value.scrollTop = chatContainer.value.scrollHeight;
    }
  });
}

onBeforeUnmount(() => {
  stopInference();
});

onMounted(() => {
  fetchAccounts();
  fetchModels();
});

watch(selectedAccount, () => {
  fetchModels();
});
</script>

<style scoped>
.ai-view-root {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
}

.ai-input-bar {
  border-top: 1px solid var(--app-border-input);
  padding: 12px 20px;
  background: var(--app-input-bg);
}

.ai-toolbar {
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.ai-select-account {
  width: 180px;
}

.ai-compact-card {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid var(--app-border);
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
  background-color: var(--app-bg-card);
  box-sizing: border-box;
}
.ai-compact-card:hover { background-color: var(--app-bg-hover); }
.ai-compact-card__name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 0 1 auto;
  min-width: 0;
}
.ai-compact-card__metric {
  font-size: 11px;
  color: var(--app-text-primary);
  font-weight: 500;
  flex-shrink: 0;
  white-space: nowrap;
  min-width: 32px;
  text-align: right;
}

.card-grid-scroll {
  max-height: 200px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  -webkit-overflow-scrolling: touch;
}

@media (max-width: 768px) {
  .ai-input-bar {
    padding: 8px 12px;
  }
  .ai-toolbar {
    flex-wrap: wrap;
    gap: 6px;
  }
  .ai-select-account {
    width: 100%;
  }
  .ai-compact-card {
    width: 100%;
    min-width: 100px;
  }
  .ai-compact-card__name {
    min-width: 0;
  }
  .ai-compact-card__metric {
    font-size: 10px;
  }
  .ai-message-bubble-user,
  .ai-message-bubble-assistant {
    max-width: 90%;
  }
}
</style>
