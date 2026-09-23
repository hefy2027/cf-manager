<template>
  <div class="ai-audio-root">
    <!-- 左侧：控制面板 -->
    <div class="ai-audio-sidebar">
      <!-- 账户 + 模型选择 -->
      <div class="sidebar-section">
        <n-select
          v-model:value="selectedAccount"
          :options="accountOptions"
          placeholder=""
          size="small"
          class="sidebar-select"
        />
        <n-select
          v-model:value="selectedModel"
          :options="modelOptions"
          :placeholder="t('aiAudio.selectModel')"
          :loading="modelsLoading"
          size="small"
          filterable
          :render-label="renderModelLabel"
        />
      </div>

      <!-- 语音/说话人选择 -->
      <div class="sidebar-section">
        <n-select
          v-model:value="selectedVoice"
          :options="voiceOptions"
          :placeholder="modelHasSpeaker ? t('aiAudio.selectVoice') : t('aiAudio.noSpeaker')"
          size="small"
          filterable
          :disabled="!modelHasSpeaker"
        />
        <p v-if="!modelHasSpeaker" class="ai-audio-hint">{{ t('aiAudio.noSpeakerHint') }}</p>
      </div>

      <!-- 高级设置（按模型 schema 动态渲染，仅展示该模型支持的参数） -->
      <div class="sidebar-section">
        <div class="advanced-header" @click="showAdvanced = !showAdvanced">
          <span>{{ t('aiAudio.showAdvanced') }}</span>
          <span class="arrow" :class="{ expanded: showAdvanced }">▶</span>
        </div>
        <n-collapse-transition :show="showAdvanced">
          <div v-if="advancedFields.length" class="advanced-body">
            <div v-for="[field, def] in advancedFields" :key="field" class="param-row">
              <span class="param-label">{{ advancedLabel(field) }}</span>
              <n-select
                v-if="fieldOptions(field, def)"
                v-model:value="advancedValues[field]"
                :options="fieldOptions(field, def) || []"
                size="small"
                style="width: 130px;"
                :placeholder="String(def.default ?? '')"
              />
              <n-input-number
                v-else-if="def.type === 'number'"
                v-model:value="advancedValues[field]"
                :min="def.min"
                :max="def.max"
                size="small"
                style="width: 130px;"
              />
              <n-input
                v-else
                v-model:value="advancedValues[field]"
                size="small"
                style="width: 130px;"
              />
            </div>
          </div>
          <p v-else class="ai-audio-hint">{{ t('aiAudio.noAdvancedHint') }}</p>
        </n-collapse-transition>
      </div>

      <!-- 文本输入 -->
      <div class="sidebar-section">
        <n-input
          v-model:value="inputText"
          type="textarea"
          :placeholder="t('aiAudio.textPlaceholder')"
          :rows="6"
          :disabled="generating"
          :maxlength="5000"
          show-count
        />
      </div>

      <!-- 生成按钮 -->
      <div class="sidebar-section sidebar-footer">
        <n-button type="primary" @click="generate" :loading="generating" :disabled="!canGenerate" block>
          {{ t('aiAudio.generate') }}
        </n-button>
      </div>
    </div>

    <!-- 右侧：结果展示 -->
    <div class="ai-audio-main">
      <!-- 生成中：顶部加载条 -->
      <div v-if="generating" class="ai-audio-generating-bar">
        <n-spin size="small" />
        <span style="margin-left: 8px; color: var(--app-text-muted); font-size: 13px;">{{ t('aiAudio.generating') }}</span>
      </div>

      <!-- 空状态 -->
      <div v-if="!generating && generatedAudios.length === 0" class="ai-audio-empty">
        <p style="color: var(--app-text-muted); font-size: 16px;">{{ t('aiAudio.emptyHint') }}</p>
      </div>

      <!-- 音频列表 -->
      <div v-if="generatedAudios.length > 0" class="ai-audio-list">
        <div v-for="(audio, idx) in generatedAudios" :key="idx" class="ai-audio-card">
          <div class="ai-audio-card-header">
            <span class="ai-audio-card-text" :title="audio.text">{{ audio.text }}</span>
            <div class="ai-audio-card-meta">
              <span v-if="audio.neurons" class="ai-audio-card-neurons">⚡ {{ audio.neurons }}</span>
              <span class="ai-audio-card-voice">{{ audio.voice }}</span>
            </div>
          </div>
          <div class="ai-audio-card-player">
            <audio
              :ref="el => { if (el) audioRefs[idx] = el as HTMLAudioElement }"
              :src="`data:${audio.contentType};base64,${audio.b64}`"
              controls
              style="width: 100%;"
            />
          </div>
          <div class="ai-audio-card-actions">
            <n-button size="tiny" quaternary @click="downloadAudio(audio)">{{ t('aiAudio.download') }}</n-button>
            <n-button size="tiny" quaternary @click="reuseText(audio)">{{ t('aiAudio.reuse') }}</n-button>
            <n-button size="tiny" quaternary type="error" @click="removeAudio(idx)">{{ t('common.delete') }}</n-button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { renderPaidModelLabel } from '../utils/paidLabel';
import { useMessage } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { accountsApi } from '../api/accounts';

const { t } = useI18n();
const message = useMessage();

interface GeneratedAudio {
  b64: string;
  text: string;
  model: string;
  voice: string;
  neurons?: number;
  contentType: string;
}

const selectedAccount = ref('auto');
const accountOptions = ref<{ label: string; value: string }[]>([]);
const selectedModel = ref('');
// 保存完整模型元数据（后端下发的 speakers / default_speaker / advanced_params），供选择说话人与高级设置使用
const modelMeta = ref<Record<string, { speakers?: string[]; default_speaker?: string; advanced_params?: Record<string, any> }>>({});
const modelOptions = ref<{ label: string; value: string; requirePaid?: boolean }[]>([]);
// 付费模型 value 集合
const paidModelValues = computed(() => new Set(
  modelOptions.value.filter((o) => o.requirePaid).map((o) => o.value)
));

// naive-ui n-select 的 render-label 是函数 prop（不是 slot），须返回 VNode/字符串
function renderModelLabel(option: any) {
  return renderPaidModelLabel(option, !!option.value && paidModelValues.value.has(option.value));
}
const modelsLoading = ref(false);
const inputText = ref('');
const selectedVoice = ref('');
const generating = ref(false);
const generatedAudios = ref<GeneratedAudio[]>([]);
const audioRefs = ref<HTMLAudioElement[]>([]);

// 高级设置面板
const showAdvanced = ref(false);
// 高级参数值（按模型 schema 动态生成，key 为 CF 字段名）
const advancedValues = ref<Record<string, any>>({});

// 当前所选模型支持的说话人列表（取自模型 schema，不同模型完全不同）
const currentSpeakers = computed<string[]>(() => modelMeta.value[selectedModel.value]?.speakers || []);
const modelHasSpeaker = computed(() => currentSpeakers.value.length > 0);

// 当前所选模型的高级可选参数（encoding/container/sample_rate/bit_rate/lang 等）
const currentAdvancedParams = computed<Record<string, any>>(
  () => modelMeta.value[selectedModel.value]?.advanced_params || {},
);
const advancedFields = computed(() => Object.entries(currentAdvancedParams.value));

// 高级参数字段的本地化标签（未知字段回退为字段名）
function advancedLabel(field: string): string {
  const localized = t(`aiAudio.param.${field}`);
  return localized === `aiAudio.param.${field}` ? field : localized;
}

// lang 字段（melotts 等无枚举的语言参数）常用选项：schema 无 enum 时使用
const LANG_OPTIONS = [
  { label: 'English (en)', value: 'en' },
  { label: '中文 (zh)', value: 'zh' },
  { label: '日本語 (ja)', value: 'ja' },
  { label: '한국어 (ko)', value: 'ko' },
  { label: 'Français (fr)', value: 'fr' },
  { label: 'Español (es)', value: 'es' },
  { label: 'Deutsch (de)', value: 'de' },
  { label: 'Português (pt)', value: 'pt' },
  { label: 'Русский (ru)', value: 'ru' },
  { label: 'Italiano (it)', value: 'it' },
];

// 判断高级参数字段的选项来源：优先 schema 枚举，其次 lang 常用语言
function fieldOptions(field: string, def: any): { label: string; value: string }[] | null {
  if (Array.isArray(def.enum)) return def.enum.map((v: any) => ({ label: String(v), value: v }));
  if (field === 'lang') return LANG_OPTIONS;
  return null;
}

const voiceOptions = computed(() => {
  if (!modelHasSpeaker.value) return [];
  return currentSpeakers.value.map((s) => ({ label: s, value: s }));
});

const canGenerate = computed(() => {
  return !!selectedModel.value && !!inputText.value.trim();
});

async function fetchAccounts() {
  try {
    const { data } = await accountsApi.getAll();
    const seen = new Set<string>();
    const accounts = (data.accounts || [])
      .filter((a: any) => a.is_active && (a.enabled_features || '').includes('ai'))
      .map((a: any) => ({
        label: a.name,
        value: a.account_id || String(a.id),
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

    const resp = await fetch('/api/v1/models?task=text-to-speech', { headers });
    if (resp.ok) {
      const data = await resp.json();
      const models = (data.data || []).map((m: any) => {
        if (m.id || m.name) {
          modelMeta.value[m.id || m.name] = {
            speakers: m.speakers || undefined,
            default_speaker: m.default_speaker || undefined,
            advanced_params: m.advanced_params || undefined,
          };
        }
        return {
          label: (m.id || m.name || '').replace(/^@cf\//, ''),
          value: m.id || m.name,
          requirePaid: !!m.require_workers_paid,
        };
      });
      modelOptions.value = models;
      if (models.length && !models.find((o: any) => o.value === selectedModel.value)) {
        selectedModel.value = models[0].value;
        applyDefaultVoice(models[0].value);
        applyAdvancedDefaults(models[0].value);
      }
    }
  } catch {
    // silent
  } finally {
    modelsLoading.value = false;
  }
}

// 当所选模型变化时，自动选中该模型默认/首个说话人
function applyDefaultVoice(modelId: string) {
  const meta = modelMeta.value[modelId];
  selectedVoice.value = meta?.default_speaker || meta?.speakers?.[0] || '';
}

// 按模型高级参数定义重置高级设置值（用 schema default 预填，避免误发未设置字段）
function applyAdvancedDefaults(modelId: string) {
  const params = modelMeta.value[modelId]?.advanced_params || {};
  const next: Record<string, any> = {};
  for (const [field, def] of Object.entries(params)) {
    if (def.default !== undefined) next[field] = def.default;
    else if (def.type === 'number') next[field] = null;
    else next[field] = '';
  }
  advancedValues.value = next;
}

// 监听模型切换，重置说话人与高级设置
watch(selectedModel, (id) => {
  if (id) {
    applyDefaultVoice(id);
    applyAdvancedDefaults(id);
  }
});

async function generate() {
  if (!canGenerate.value) return;

  generating.value = true;
  const currentText = inputText.value;

  try {
    const token = localStorage.getItem('api_token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const body: any = {
      model: selectedModel.value,
      input: currentText,
    };
    // 仅当该模型支持 speaker 参数且已选择说话人时才下发 voice
    if (selectedVoice.value) body.voice = selectedVoice.value;
    // 高级参数：只发送用户显式设置/改动的字段（后端会按模型 schema 白名单过滤）
    for (const [field] of advancedFields.value) {
      const v = advancedValues.value[field];
      if (v === undefined || v === null || v === '') continue;
      body[field] = v;
    }

    const response = await fetch('/api/v1/audio/speech', {
      method: 'POST',
      headers: {
        ...headers,
        ...(selectedAccount.value && selectedAccount.value !== 'auto' ? { 'X-Account-ID': selectedAccount.value } : {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMsg = errorText;
      try {
        const errorJson = JSON.parse(errorText);
        errorMsg = errorJson.error?.message
          || errorJson.errors?.[0]?.message
          || errorJson.message
          || errorText;
      } catch { /* not JSON */ }
      throw new Error(errorMsg);
    }

    const data = await response.json();
    // 兼容 responseWrapper 包装格式和原始格式
    const audioData = data.success ? data.data : data;
    const audioBase64 = audioData?.data?.[0]?.audio;
    if (!audioBase64) {
      throw new Error('No audio in response');
    }

    generatedAudios.value.unshift({
      b64: audioBase64,
      text: currentText,
      model: selectedModel.value,
      voice: selectedVoice.value,
      neurons: audioData?.data?.[0]?.neurons,
      contentType: audioData?.data?.[0]?.content_type || 'audio/mpeg',
    });

    message.success(t('aiAudio.generateSuccess'));
  } catch (e: any) {
    message.error(e?.message || t('aiAudio.generateFailed'));
  } finally {
    generating.value = false;
  }
}

function downloadAudio(audio: GeneratedAudio) {
  if (!audio) return;
  const ext = audio.contentType.includes('wav') ? 'wav' : 'mp3';
  const link = document.createElement('a');
  link.href = `data:${audio.contentType};base64,${audio.b64}`;
  link.download = `ai-audio-${Date.now()}.${ext}`;
  link.click();
}

function reuseText(audio: GeneratedAudio) {
  inputText.value = audio.text;
  selectedModel.value = audio.model;
  selectedVoice.value = audio.voice;
}

function removeAudio(idx: number) {
  generatedAudios.value.splice(idx, 1);
}

onMounted(() => {
  fetchAccounts();
  fetchModels();
});
</script>

<style scoped>
.ai-audio-root {
  display: flex;
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
  overflow: hidden;
}

.ai-audio-sidebar {
  width: 340px;
  min-width: 340px;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--app-border);
  overflow-y: auto;
  padding: 12px;
  gap: 12px;
}

.sidebar-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sidebar-select {
  margin-bottom: 4px;
}

.ai-audio-hint {
  margin: 2px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--app-text-muted);
}

/* 高级设置 */
.advanced-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  font-size: 13px;
  color: var(--app-text-secondary);
  user-select: none;
  padding: 4px 0;
}

.advanced-header:hover {
  color: var(--app-text-primary);
}

.arrow {
  font-size: 10px;
  transition: transform 0.2s;
}

.arrow.expanded {
  transform: rotate(90deg);
}

.advanced-body {
  background: var(--app-bg-tertiary);
  border-radius: 6px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.param-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.param-label {
  font-size: 12px;
  color: var(--app-text-secondary);
  flex: 1;
}

.sidebar-footer {
  margin-top: auto;
  padding-top: 8px;
}

.ai-audio-main {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  position: relative;
}

.ai-audio-generating-bar {
  position: sticky;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  padding: 8px 16px;
  background: var(--n-color-tag);
  border-bottom: 1px solid var(--app-border);
  z-index: 10;
}

.ai-audio-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  min-height: 300px;
}

.ai-audio-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 800px;
  margin: 0 auto;
}

.ai-audio-card {
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 12px 16px;
  background: var(--n-color-modal);
}

.ai-audio-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 8px;
}

.ai-audio-card-text {
  flex: 1;
  font-size: 13px;
  color: var(--app-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.ai-audio-card-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex-shrink: 0;
}

.ai-audio-card-neurons {
  font-size: 12px;
  color: var(--app-text-muted);
  background: var(--n-color-tag);
  padding: 2px 6px;
  border-radius: 4px;
}

.ai-audio-card-voice {
  font-size: 11px;
  color: var(--app-text-muted);
}

.ai-audio-card-player {
  margin: 8px 0;
}

.ai-audio-card-actions {
  display: flex;
  gap: 4px;
  justify-content: flex-end;
}

/* 移动端适配 */
@media (max-width: 768px) {
  .ai-audio-root {
    flex-direction: column;
  }
  .ai-audio-sidebar {
    width: 100%;
    min-width: 100%;
    max-height: 50vh;
    border-right: none;
    border-bottom: 1px solid var(--app-border);
  }
}
</style>
