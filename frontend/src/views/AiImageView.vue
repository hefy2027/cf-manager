<template>
  <div class="ai-image-root">
    <!-- 左侧：控制面板 -->
    <div class="ai-image-sidebar">
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
          :placeholder="t('aiImage.selectModel')"
          :loading="modelsLoading"
          size="small"
          filterable
          :render-label="renderModelLabel"
          @update:value="onModelChange"
        />
      </div>

      <!-- 模式切换（仅当模型同时支持两种模式时显示） -->
      <div v-if="supportsT2I && supportsImg2Img" class="sidebar-section">
        <n-button-group size="small" style="width: 100%;">
          <n-button
            :type="mode === 'text-to-image' ? 'primary' : 'default'"
            style="flex: 1;"
            :disabled="!supportsT2I"
            @click="switchMode('text-to-image')"
          >
            {{ t('aiImage.textToImage') }}
          </n-button>
          <n-button
            :type="mode === 'image-to-image' ? 'primary' : 'default'"
            style="flex: 1;"
            :disabled="!supportsI2I"
            @click="switchMode('image-to-image')"
          >
            {{ t('aiImage.imageToImage') }}
          </n-button>
        </n-button-group>
      </div>

      <!-- 图生图：上传参考图 -->
      <div v-if="mode === 'image-to-image' && supportsImg2Img" class="sidebar-section">
        <n-upload
          v-model:file-list="uploadFileList"
          :max="1"
          accept="image/*"
          :default-upload="false"
          @change="onUploadChange"
          list-type="image-card"
        >
          {{ t('aiImage.uploadImage') }}
        </n-upload>
        <!-- 图生图强度（仅 SDXL） -->
        <div v-if="isSD" class="param-row">
          <span class="param-label">{{ t('aiImage.strength') }}</span>
          <n-slider v-model:value="strength" :min="0" :max="1" :step="0.05" :marks="{ 0: '0', 0.5: '0.5', 1: '1' }" />
        </div>
      </div>

      <!-- Prompt 输入 -->
      <div class="sidebar-section">
        <n-input
          v-model:value="prompt"
          type="textarea"
          :placeholder="t('aiImage.promptPlaceholder')"
          :rows="4"
          :disabled="generating"
        />
      </div>

      <!-- 高级参数 -->
      <div class="sidebar-section">
        <div class="advanced-header" @click="showAdvanced = !showAdvanced">
          <span>{{ t('aiImage.showAdvanced') }}</span>
          <span class="arrow" :class="{ expanded: showAdvanced }">▶</span>
        </div>
        <n-collapse-transition :show="showAdvanced">
          <div class="advanced-body">
            <!-- 步数（flux-1 用 steps；flux-2 固定 4 步不可调，故隐藏） -->
            <div v-if="supportsNumSteps" class="param-row">
              <span class="param-label">{{ t('aiImage.steps') }}</span>
              <n-input-number
                v-model:value="numSteps"
                :min="1"
                :max="maxSteps"
                size="small"
                style="width: 100px;"
              />
            </div>
            <!-- 宽高（SD / dreamshaper / flux-2 / leonardo） -->
            <template v-if="supportsSize">
              <div class="param-row">
                <span class="param-label">{{ t('aiImage.width') }}</span>
                <n-input-number v-model:value="width" :min="256" :max="2048" :step="64" size="small" style="width: 100px;" />
              </div>
              <div class="param-row">
                <span class="param-label">{{ t('aiImage.height') }}</span>
                <n-input-number v-model:value="height" :min="256" :max="2048" :step="64" size="small" style="width: 100px;" />
              </div>
            </template>
            <!-- 引导强度（SD / flux-2 / leonardo） -->
            <div v-if="supportsGuidance" class="param-row">
              <span class="param-label">{{ t('aiImage.guidance') }}</span>
              <n-input-number v-model:value="guidance" :min="0" :max="20" :step="0.5" size="small" style="width: 100px;" />
            </div>
            <!-- 反向提示词（SD / phoenix；lucid 与 flux-2 不支持） -->
            <div v-if="supportsNegativePrompt" class="param-row" style="flex-direction: column; align-items: stretch;">
              <span class="param-label">{{ t('aiImage.negativePrompt') }}</span>
              <n-input
                v-model:value="negativePrompt"
                type="textarea"
                :placeholder="t('aiImage.negativePromptPlaceholder')"
                :rows="3"
                size="small"
                style="margin-top: 4px;"
              />
            </div>
            <!-- 随机种子（除 flux-1 外均支持，用于结果可复现） -->
            <div v-if="supportsSeed" class="param-row">
              <span class="param-label">{{ t('aiImage.seed') }}</span>
              <n-input-number
                v-model:value="seed"
                :min="0"
                :max="4294967295"
                size="small"
                style="width: 140px;"
              />
            </div>
          </div>
        </n-collapse-transition>
      </div>

      <!-- 生成按钮 -->
      <div class="sidebar-section sidebar-footer">
        <n-button type="primary" @click="generate" :loading="generating" :disabled="!canGenerate" block>
          {{ t('aiImage.generate') }}
        </n-button>
      </div>
    </div>

    <!-- 右侧：结果展示 -->
    <div class="ai-image-main">
      <!-- 生成中：顶部加载条，不遮挡已有图片 -->
      <div v-if="generating" class="ai-image-generating-bar">
        <n-spin size="small" />
        <span style="margin-left: 8px; color: var(--app-text-muted); font-size: 13px;">{{ t('aiImage.generating') }}</span>
      </div>

      <!-- 空状态（仅在没有图片且不在生成中时显示） -->
      <div v-if="!generating && generatedImages.length === 0" class="ai-image-empty">
        <p style="color: var(--app-text-muted); font-size: 16px;">{{ t('aiImage.emptyHint') }}</p>
      </div>

      <!-- 图片列表（始终显示已有图片） -->
      <div v-if="generatedImages.length > 0" class="ai-image-gallery">
        <div v-for="(img, idx) in generatedImages" :key="idx" class="ai-image-card">
          <img :src="`data:image/png;base64,${img.b64}`" :alt="img.prompt" @click="previewImage(img)" />
          <div class="ai-image-card-overlay">
            <span class="ai-image-card-prompt" :title="img.prompt">{{ img.prompt }}</span>
            <div class="ai-image-card-meta">
              <span v-if="img.neurons" class="ai-image-card-neurons">⚡ {{ img.neurons }}</span>
            </div>
            <div class="ai-image-card-actions">
              <n-button size="tiny" quaternary @click="downloadImage(img)">{{ t('aiImage.download') }}</n-button>
              <n-button size="tiny" quaternary @click="reusePrompt(img)">{{ t('aiImage.reuse') }}</n-button>
              <n-button size="tiny" quaternary type="error" @click="removeImage(idx)">{{ t('common.delete') }}</n-button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 预览模态 -->
    <n-modal v-model:show="previewVisible" preset="card" style="width: auto; max-width: 90vw;">
      <template #header>{{ previewData?.prompt || t('aiImage.preview') }}</template>
      <img v-if="previewData" :src="`data:image/png;base64,${previewData.b64}`" style="max-width: 100%; max-height: 70vh; display: block; margin: 0 auto;" />
      <template #footer>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <n-button v-if="previewData" @click="downloadImage(previewData)">{{ t('aiImage.download') }}</n-button>
          <n-button @click="previewVisible = false">{{ t('common.close') }}</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { renderPaidModelLabel } from '../utils/paidLabel';
import { useMessage } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { accountsApi } from '../api/accounts';

const { t } = useI18n();
const message = useMessage();

type Mode = 'text-to-image' | 'image-to-image';

interface GeneratedImage {
  b64: string;
  prompt: string;
  model: string;
  mode: Mode;
  neurons?: number;
}

const selectedAccount = ref('auto');
const accountOptions = ref<{ label: string; value: string }[]>([]);
const selectedModel = ref('');
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
const prompt = ref('');
const mode = ref<Mode>('text-to-image');
const uploadedImage = ref<string>('');
const uploadFileList = ref<any[]>([]);
const generating = ref(false);
const generatedImages = ref<GeneratedImage[]>([]);
const showAdvanced = ref(false);

// 高级参数（带默认值）
const width = ref(1024);
const height = ref(1024);
const numSteps = ref(4);
const guidance = ref(7.5);
const negativePrompt = ref('');
const strength = ref(0.6);
const seed = ref<number | null>(null);

// 模型能力集合（从 API 获取）
const t2iModels = ref<Set<string>>(new Set());
const i2iModels = ref<Set<string>>(new Set());

// 预览
const previewVisible = ref(false);
const previewData = ref<GeneratedImage | null>(null);

// 模型族检测
const isFlux = computed(() => selectedModel.value.includes('flux'));
const isFlux2 = computed(() => selectedModel.value.includes('flux-2'));
const isSD = computed(() => selectedModel.value.includes('stable-diffusion') || selectedModel.value.includes('dreamshaper'));
const isLeonardo = computed(() => selectedModel.value.includes('leonardo'));
const isPhoenix = computed(() => selectedModel.value.includes('phoenix'));
const isFlux1 = computed(() => isFlux.value && !isFlux2.value);
// 各高级参数按模型真实 schema 暴露（依据 Cloudflare 官方模型定义）
const supportsNumSteps = computed(() => !isFlux2.value); // flux-2 固定 4 步不可调
const supportsSize = computed(() => isSD.value || isFlux2.value || isLeonardo.value);
const supportsGuidance = computed(() => isSD.value || isFlux2.value || isLeonardo.value);
const supportsNegativePrompt = computed(() => isSD.value || isPhoenix.value); // lucid 不支持 negative_prompt
const supportsSeed = computed(() => !isFlux1.value); // flux-1 不支持 seed，其余均支持
const maxSteps = computed(() => {
  if (isFlux1.value) return 8;
  if (isSD.value) return 20;
  if (isPhoenix.value) return 50;
  if (isLeonardo.value) return 40;
  return 50;
});
// 图生图支持：优先使用 API task 数据，兜底用模型名模式匹配
// CF API 将所有图片模型归为 Text-to-Image，没有单独的 Image-to-Image task
// 已知：SDXL 支持图生图，Flux 不支持
const supportsT2I = computed(() => t2iModels.value.has(selectedModel.value) || modelOptions.value.some(o => o.value === selectedModel.value));
const supportsI2I = computed(() => {
  // 优先查 API 返回的 image-to-image 列表
  if (i2iModels.value.has(selectedModel.value)) return true;
  // 如果 API image-to-image 列表为空（CF API 不区分），用白名单兜底。
  // CF 运行时实测：仅 Flux 2（editing, multipart input_image_0）支持图像输入；
  // SDXL base / lightning / dreamshaper 与 runwayml inpainting 均无法经 base64 通道图生图
  //（前者无 image 张量 400；后者仅原生 image/mask 张量输入，inpainting 已从列表移除）。
  if (i2iModels.value.size === 0 && selectedModel.value) {
    return isFlux2.value;
  }
  return false;
});
const supportsImg2Img = computed(() => supportsI2I.value);

const canGenerate = computed(() => {
  if (!selectedModel.value || !prompt.value.trim()) return false;
  if (mode.value === 'image-to-image' && !uploadedImage.value) return false;
  return true;
});

function onModelChange() {
  // 根据模型能力自动切换模式
  if (!supportsT2I.value && supportsI2I.value) {
    // 仅支持图生图
    mode.value = 'image-to-image';
  } else if (supportsT2I.value && !supportsI2I.value) {
    // 仅支持文生图
    mode.value = 'text-to-image';
  }

  // 根据模型族设置默认参数
  if (isFlux.value) {
    numSteps.value = isFlux2.value ? 4 : 4; // Flux 默认 4 步
  } else if (isSD.value) {
    numSteps.value = 20; // SDXL 默认 20 步，最大 20
    width.value = 1024;
    height.value = 1024;
    guidance.value = 7.5;
  } else if (isLeonardo.value) {
    numSteps.value = isPhoenix.value ? 25 : 40; // phoenix 默认 25 / lucid 默认 40
    width.value = 1024;
    height.value = 1024;
    guidance.value = isPhoenix.value ? 2 : 4.5; // phoenix 默认 2 / lucid 默认 4.5
  }
}

function switchMode(m: Mode) {
  mode.value = m;
  uploadedImage.value = '';
  uploadFileList.value = [];
}

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

    const [resp1, resp2] = await Promise.all([
      fetch('/api/v1/models?task=text-to-image', { headers }),
      fetch('/api/v1/models?task=image-to-image', { headers }),
    ]);

    const models: { label: string; value: string; requirePaid?: boolean }[] = [];
    const seen = new Set<string>();
    const t2iSet = new Set<string>();
    const i2iSet = new Set<string>();

    // 解析文生图模型
    if (resp1.ok) {
      const data = await resp1.json();
      for (const m of (data.data || [])) {
        const fullName = m.id || m.name;
        // runwayml sd-v1-5-inpainting：CF 仅支持原生 image/mask 张量输入，OpenAI 兼容 base64 通道不可用，不展示
        if (fullName.includes('inpainting')) continue;
        t2iSet.add(fullName);
        if (!seen.has(fullName)) {
          seen.add(fullName);
          models.push({ label: fullName.replace(/^@cf\//, ''), value: fullName, requirePaid: !!m.require_workers_paid });
        }
      }
    }

    // 解析图生图模型
    if (resp2.ok) {
      const data = await resp2.json();
      for (const m of (data.data || [])) {
        const fullName = m.id || m.name;
        // inpainting 不展示（同上：CF 原生张量通道，无 OpenAI 兼容 base64 mask）
        if (fullName.includes('inpainting')) continue;
        i2iSet.add(fullName);
        if (!seen.has(fullName)) {
          seen.add(fullName);
          models.push({ label: fullName.replace(/^@cf\//, ''), value: fullName, requirePaid: !!m.require_workers_paid });
        }
      }
    }

    t2iModels.value = t2iSet;
    i2iModels.value = i2iSet;
    modelOptions.value = models;
    if (models.length && !models.find(o => o.value === selectedModel.value)) {
      selectedModel.value = models[0].value;
      onModelChange();
    }
  } catch {
    // silent
  } finally {
    modelsLoading.value = false;
  }
}

function onUploadChange(options: { fileList: any[] }) {
  const file = options.fileList?.[0];
  if (!file) {
    uploadedImage.value = '';
    return;
  }
  // 如果有 File 对象，读取文件
  if (file.file) {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      uploadedImage.value = result.split(',')[1] || '';
    };
    reader.readAsDataURL(file.file);
  } else if (file.url) {
    // 程序设置的文件条目（如复用），直接从 data URL 提取 base64
    uploadedImage.value = file.url.split(',')[1] || '';
  } else {
    uploadedImage.value = '';
  }
}

/**
 * 压缩参考图为 JPEG 并保证 base64 体积 ≤ maxBytes。
 * 目的：CF Workers AI 的 multipart/form-data 单 part 上限 1MB（flux-2 editing input_image_0 等），
 * 上传原图 base64 易超限导致 400。压缩保持长宽比，按需缩放最长边到 1024 并调整 JPEG 质量。
 */
async function compressForUpload(b64: string, maxBytes = 900 * 1024): Promise<string> {
  const approxBytes = Math.floor(b64.length * 0.75);
  if (approxBytes <= maxBytes) return b64;
  return new Promise<string>((resolve) => {
    const img = new Image();
    img.onload = () => {
      const MAX_SIDE = 1024;
      let { width: w, height: h } = img;
      if (w > MAX_SIDE || h > MAX_SIDE) {
        if (w >= h) { h = Math.round(h * (MAX_SIDE / w)); w = MAX_SIDE; }
        else { w = Math.round(w * (MAX_SIDE / h)); h = MAX_SIDE; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return resolve(b64);
      ctx.drawImage(img, 0, 0, w, h);
      const sizeOf = (s: string) => Math.floor(s.length * 0.75);
      let q = 0.85;
      let out = canvas.toDataURL('image/jpeg', q);
      while (sizeOf(out) > maxBytes && q > 0.35) {
        q = Math.max(0.35, q - 0.1);
        out = canvas.toDataURL('image/jpeg', q);
      }
      resolve(out.split(',')[1] || b64);
    };
    img.onerror = () => resolve(b64);
    img.src = `data:image/png;base64,${b64}`;
  });
}



async function generate() {
  if (!canGenerate.value) return;

  generating.value = true;
  const currentPrompt = prompt.value;

  try {
    const token = localStorage.getItem('api_token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const body: Record<string, any> = {
      model: selectedModel.value,
      prompt: currentPrompt,
    };

    if (mode.value === 'image-to-image' && uploadedImage.value) {
      // CF multipart 单 part 1MB 上限：参考图过大时缩放到最长边 1024 + JPEG 压缩
      body.image = await compressForUpload(uploadedImage.value);
      if (isSD.value) body.strength = strength.value;
    }

    // 高级参数（按模型真实 schema 发送，后端按模型族二次过滤）
    if (supportsNumSteps.value && numSteps.value) body.num_steps = numSteps.value;
    if (supportsSize.value) {
      if (width.value) body.width = width.value;
      if (height.value) body.height = height.value;
    }
    if (supportsGuidance.value && guidance.value) body.guidance = guidance.value;
    if (supportsNegativePrompt.value && negativePrompt.value.trim()) body.negative_prompt = negativePrompt.value.trim();
    if (supportsSeed.value && seed.value !== null && seed.value !== undefined) body.seed = seed.value;

    const response = await fetch('/api/v1/images/generations', {
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
        // 兼容多种错误格式：{ error: { message } } / { errors: [{ message }] } / { message }
        errorMsg = errorJson.error?.message
          || errorJson.errors?.[0]?.message
          || errorJson.message
          || errorText;
      } catch { /* not JSON */ }
      throw new Error(errorMsg);
    }

    const data = await response.json();
    // 兼容 responseWrapper 包装格式 { success, data: { data: [...] } } 和原始格式 { data: [...] }
    const imageData = data.success ? data.data : data;
    const b64 = imageData?.data?.[0]?.b64_json;
    if (!b64) {
      console.error('[AiImage] Empty image in response:', JSON.stringify(data).slice(0, 500));
      throw new Error(data.error?.message || imageData?.error?.message || `No image in response (keys: ${Object.keys(data).join(', ')})`);
    }

    generatedImages.value.unshift({
      b64,
      prompt: currentPrompt,
      model: selectedModel.value,
      mode: mode.value,
      neurons: imageData?.data?.[0]?.neurons,
    });

    message.success(t('aiImage.generateSuccess'));
  } catch (e: any) {
    message.error(e?.message || t('aiImage.generateFailed'));
  } finally {
    generating.value = false;
  }
}

function previewImage(img: GeneratedImage) {
  previewData.value = img;
  previewVisible.value = true;
}

function downloadImage(img: GeneratedImage) {
  if (!img) return;
  const link = document.createElement('a');
  link.href = `data:image/png;base64,${img.b64}`;
  link.download = `ai-image-${Date.now()}.png`;
  link.click();
}

function reusePrompt(img: GeneratedImage) {
  prompt.value = img.prompt;
  selectedModel.value = img.model;

  // 如果模型支持图生图，自动切换到图生图模式并使用生成的图片作为参考图
  // 使用与 supportsI2I 相同的白名单（仅 Flux 2 editing 支持图像输入；SD 系 / inpainting / leonardo 不支持）
  const modelIsFlux2 = img.model.includes('flux-2');
  const modelSupportsImg2Img = i2iModels.value.has(img.model)
    || (i2iModels.value.size === 0 && modelIsFlux2);
  if (modelSupportsImg2Img) {
    mode.value = 'image-to-image';
    uploadedImage.value = img.b64;
    // 设置 n-upload 文件列表以显示参考图预览
    uploadFileList.value = [{
      id: `reuse-${Date.now()}`,
      name: 'reuse.png',
      status: 'finished',
      url: `data:image/png;base64,${img.b64}`,
      thumbnailUrl: `data:image/png;base64,${img.b64}`,
    }];
  } else {
    mode.value = 'text-to-image';
    uploadedImage.value = '';
    uploadFileList.value = [];
  }
  onModelChange();
}

function removeImage(idx: number) {
  generatedImages.value.splice(idx, 1);
}

onMounted(() => {
  fetchAccounts();
  fetchModels();
});
</script>

<style scoped>
.ai-image-root {
  display: flex;
  flex: 1;
  min-height: 0;
  box-sizing: border-box;
  padding: 12px;
  gap: 12px;
}

/* 左侧侧栏 */
.ai-image-sidebar {
  width: 340px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  overflow-y: auto;
  background: var(--app-bg-card);
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 12px;
}

.sidebar-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.sidebar-select {
  width: 100%;
}

.sidebar-footer {
  margin-top: auto;
}

/* 高级参数 */
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
  margin-top: 4px;
}

.param-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.param-label {
  font-size: 12px;
  color: var(--app-text-secondary);
  white-space: nowrap;
  min-width: 60px;
}

/* 右侧主区域 */
.ai-image-main {
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  padding: 16px;
  background: var(--app-bg-secondary);
}

.ai-image-generating-bar {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  margin-bottom: 12px;
  background: var(--app-bg-tertiary);
  border-radius: 6px;
}

.ai-image-loading,
.ai-image-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
}

/* 图片画廊 */
.ai-image-gallery {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 12px;
}

.ai-image-card {
  position: relative;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  overflow: hidden;
  background: var(--app-bg-card);
  aspect-ratio: 1;
}

.ai-image-card img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  cursor: pointer;
  transition: transform 0.2s;
}

.ai-image-card img:hover {
  transform: scale(1.03);
}

.ai-image-card-overlay {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.8));
  color: white;
  padding: 24px 8px 6px;
  opacity: 0;
  transition: opacity 0.2s;
}

.ai-image-card:hover .ai-image-card-overlay {
  opacity: 1;
}

.ai-image-card-prompt {
  font-size: 12px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}

.ai-image-card-meta {
  margin-top: 2px;
}

.ai-image-card-neurons {
  font-size: 11px;
  color: rgba(255, 255, 255, 0.8);
  background: rgba(0, 0, 0, 0.3);
  padding: 1px 6px;
  border-radius: 8px;
}

.ai-image-card-actions {
  display: flex;
  gap: 2px;
  margin-top: 4px;
}

.ai-image-card-actions .n-button {
  color: white;
}

@media (max-width: 768px) {
  .ai-image-root {
    flex-direction: column;
    padding: 8px;
  }

  .ai-image-sidebar {
    width: 100%;
  }

  .ai-image-main {
    min-height: 400px;
  }

  .ai-image-gallery {
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 8px;
  }
}
</style>
