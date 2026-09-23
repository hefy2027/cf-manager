<template>
  <div class="ai-translate-view">
    <!-- 账户和模型选择 -->
    <div class="header-controls">
      <n-select
        v-model:value="selectedAccountId"
        :options="accountOptions"
        :placeholder="t('aiTranslate.selectAccount')"
        clearable
        class="account-select"
        @update:value="onAccountChange"
      />
      <n-select
        v-model:value="selectedModel"
        :options="modelOptions"
        :placeholder="t('aiTranslate.selectModel')"
        filterable
        class="model-select"
      />
    </div>

    <!-- 翻译表单 -->
    <div class="translate-form">
      <div class="lang-selector">
        <n-select
          v-model:value="sourceLang"
          :options="sourceLangOptions"
          :placeholder="t('aiTranslate.sourceLang')"
          clearable
          class="lang-select"
        />
        <n-icon class="arrow-icon">
          <ArrowForwardOutline />
        </n-icon>
        <n-select
          v-model:value="targetLang"
          :options="targetLangOptions"
          :placeholder="t('aiTranslate.targetLang')"
          class="lang-select"
        />
      </div>

      <div class="text-areas">
        <n-input
          v-model:value="sourceText"
          type="textarea"
          :placeholder="t('aiTranslate.sourcePlaceholder')"
          :rows="6"
          :maxlength="10000"
          show-count
        />
        <n-button quaternary circle size="large" @click="swapLanguages" :disabled="isIndicTrans2Model || sourceLang === 'auto'">
          <template #icon>
            <n-icon><SwapHorizontalOutline /></n-icon>
          </template>
        </n-button>
        <n-input
          v-model:value="translatedText"
          type="textarea"
          :placeholder="t('aiTranslate.resultPlaceholder')"
          :rows="6"
          readonly
          :loading="loading"
        />
      </div>

      <div class="action-bar">
        <n-space>
          <n-button
            type="primary"
            size="large"
            :disabled="!canTranslate"
            :loading="loading"
            @click="translate"
          >
            <template #icon>
              <n-icon><LanguageOutline /></n-icon>
            </template>
            {{ t('aiTranslate.translateBtn') }}
          </n-button>
          <n-button
            secondary
            :disabled="!translatedText"
            @click="copyResult"
          >
            <template #icon>
              <n-icon><CopyOutline /></n-icon>
            </template>
            {{ t('aiTranslate.copyBtn') }}
          </n-button>
        </n-space>
        <n-tag v-if="lastNeurons > 0" type="info" round>
          <template #icon>
            <n-icon><FlashOutline /></n-icon>
          </template>
          {{ t('aiTranslate.neuronsUsed', { count: lastNeurons }) }}
        </n-tag>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useMessage } from 'naive-ui';
import {
  ArrowForwardOutline,
  SwapHorizontalOutline,
  LanguageOutline,
  CopyOutline,
  FlashOutline,
} from '@vicons/ionicons5';
import apiClient from '../api/client';
import { accountsApi } from '../api/accounts';

const { t } = useI18n();
const message = useMessage();

const selectedAccountId = ref<string>('auto');
const selectedModel = ref<string>('@cf/meta/m2m100-1.2b');
const sourceLang = ref<string>('auto');
const targetLang = ref<string>('en');
const sourceText = ref('');
const translatedText = ref('');
const loading = ref(false);
const lastNeurons = ref(0);

const accountOptions = ref<{ label: string; value: string }[]>([]);

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

const M2M100_LANGUAGES = [
  { label: 'English', value: 'en' },
  { label: '中文', value: 'zh' },
  { label: '日本語', value: 'ja' },
  { label: '한국어', value: 'ko' },
  { label: 'Français', value: 'fr' },
  { label: 'Deutsch', value: 'de' },
  { label: 'Español', value: 'es' },
  { label: 'Português', value: 'pt' },
  { label: 'Русский', value: 'ru' },
  { label: 'Italiano', value: 'it' },
  { label: 'العربية', value: 'ar' },
  { label: 'हिन्दी', value: 'hi' },
];

const INDICTRANS2_LANGUAGES = [
  { label: 'Hindi (हिन्दी)', value: 'hin_Deva' },
  { label: 'Bengali (বাংলা)', value: 'ben_Beng' },
  { label: 'Tamil (தமிழ்)', value: 'tam_Taml' },
  { label: 'Telugu (తెలుగు)', value: 'tel_Telu' },
  { label: 'Marathi (मराठी)', value: 'mar_Deva' },
  { label: 'Gujarati (ગુજરાતી)', value: 'guj_Gujr' },
  { label: 'Kannada (ಕನ್ನಡ)', value: 'kan_Knda' },
  { label: 'Malayalam (മലയാളം)', value: 'mal_Mlym' },
  { label: 'Punjabi (ਪੰਜਾਬੀ)', value: 'pan_Guru' },
  { label: 'Urdu (اردو)', value: 'urd_Arab' },
  { label: 'Nepali (नेपाली)', value: 'npi_Deva' },
  { label: 'Odia (ଓଡ଼ିଆ)', value: 'ory_Orya' },
  { label: 'Assamese (অসমীয়া)', value: 'asm_Beng' },
  { label: 'Sanskrit (संस्कृत)', value: 'san_Deva' },
  { label: 'Sindhi (سنڌي)', value: 'snd_Arab' },
  { label: 'Maithili (मैथिली)', value: 'mai_Deva' },
  { label: 'Bhojpuri (भोजपुरी)', value: 'bho_Deva' },
  { label: 'Dogri (डोगरी)', value: 'doi_Deva' },
  { label: 'Konkani (कोंकणी)', value: 'gom_Deva' },
  { label: 'Manipuri (মৈতৈলোন)', value: 'mni_Mtei' },
];

const isIndicTrans2Model = computed(() => selectedModel.value.includes('indictrans2'));

const modelOptions = computed(() => {
  const models = [
    { label: 'M2M100 1.2B (Multi-language)', value: '@cf/meta/m2m100-1.2b' },
    { label: 'IndicTrans2 EN→Indic 1B', value: '@cf/ai4bharat/indictrans2-en-indic-1B' },
  ];
  return models;
});

const sourceLangOptions = computed(() => {
  if (isIndicTrans2Model.value) {
    // IndicTrans2 only supports English source
    return [{ label: 'English', value: 'en' }];
  }
  return [
    { label: t('aiTranslate.auto'), value: 'auto' },
    ...M2M100_LANGUAGES,
  ];
});

const targetLangOptions = computed(() => {
  if (isIndicTrans2Model.value) {
    return INDICTRANS2_LANGUAGES;
  }
  return M2M100_LANGUAGES;
});

const canTranslate = computed(() => {
  return !!selectedModel.value && !!sourceText.value.trim() && !!targetLang.value;
});

// 切换模型时重置语言选择
watch(selectedModel, (newModel) => {
  if (newModel.includes('indictrans2')) {
    sourceLang.value = 'en';
    targetLang.value = 'hin_Deva';
  } else {
    sourceLang.value = 'auto';
    targetLang.value = 'en';
  }
});

onMounted(() => {
  fetchAccounts();
});

async function translate() {
  if (!canTranslate.value) return;

  loading.value = true;
  lastNeurons.value = 0;

  try {
    const headers: Record<string, string> = {};
    if (selectedAccountId.value) {
      headers['X-Account-ID'] = selectedAccountId.value;
    }

    const response = await apiClient.post('/v1/translations', {
      model: selectedModel.value,
      text: sourceText.value,
      source_lang: sourceLang.value === 'auto' ? undefined : sourceLang.value,
      target_lang: targetLang.value,
    }, { headers });

    const result = response.data?.data?.[0];
    if (result?.translated_text) {
      translatedText.value = result.translated_text;
      lastNeurons.value = result.neurons || 0;
    } else {
      message.error(t('aiTranslate.translateError'));
    }
  } catch (err: any) {
    console.error('Translation error:', err);
    message.error(err.errorMessage || t('aiTranslate.translateError'));
  } finally {
    loading.value = false;
  }
}

function swapLanguages() {
  const temp = sourceLang.value;
  sourceLang.value = targetLang.value;
  targetLang.value = temp || 'auto';

  const tempText = sourceText.value;
  sourceText.value = translatedText.value;
  translatedText.value = tempText;
}

function copyResult() {
  if (!translatedText.value) return;
  navigator.clipboard.writeText(translatedText.value).then(() => {
    message.success(t('aiTranslate.copySuccess'));
  });
}

function onAccountChange() {
  // 可以在这里重置模型选择等
}
</script>

<style scoped>
.ai-translate-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
  padding: 16px;
  gap: 16px;
}

.header-controls {
  display: flex;
  gap: 12px;
  align-items: center;
}

.account-select,
.model-select {
  width: 200px;
}

.translate-form {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 0;
}

.lang-selector {
  display: flex;
  align-items: center;
  gap: 12px;
}

.lang-select {
  flex: 1;
}

.arrow-icon {
  font-size: 20px;
  color: var(--text-color-3);
}

.text-areas {
  display: flex;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

.text-areas > :first-child,
.text-areas > :last-child {
  flex: 1;
}

.text-areas > :nth-child(2) {
  align-self: center;
}

.action-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>