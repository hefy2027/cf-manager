<template>
  <n-modal v-model:show="visible" preset="card" :title="`部署 ${template?.name || ''}`" style="width: 600px; max-width: 95vw" :mask-closable="false">
    <n-spin :show="deploying || preflighting">
      <n-form v-if="template" label-placement="top" size="small">
        <!-- Account -->
        <n-form-item label="目标账户" required>
          <n-select v-model:value="form.accountId" :options="accountOptions" :render-label="renderAccountLabel" filterable placeholder="选择账户" @update:value="onAccountChange" />
          <template v-if="needsR2" #feedback>
            <n-text type="warning" depth="3" style="font-size: 12px">
              该模板需要 R2，仅显示已开通 R2 的账户
            </n-text>
          </template>
        </n-form-item>

        <!-- Name -->
        <n-form-item label="Worker/Pages 名称" required>
          <n-input v-model:value="form.name" placeholder="输入名称" @update:value="invalidatePreflight" />
        </n-form-item>

        <!-- Deploy type (hybrid only) -->
        <n-form-item v-if="template.type === 'hybrid'" label="部署方式" required>
          <n-radio-group v-model:value="deployType" @update:value="invalidatePreflight">
            <n-radio-button value="both">Worker + Pages</n-radio-button>
            <n-radio-button value="worker">仅 Worker</n-radio-button>
            <n-radio-button value="pages">仅 Pages</n-radio-button>
          </n-radio-group>
        </n-form-item>

        <!-- Observability: Worker 特性，hybrid 模式选「仅 Pages」时不显示 -->
        <n-form-item v-if="!isPagesOnly" label="可观测性">
          <n-space align="center" :size="24">
            <n-space align="center" :size="8">
              <n-switch v-model:value="enableLogs" size="small" />
              <n-tooltip>
                <template #trigger>
                  <span style="font-size: 13px; cursor: help">Workers 日志</span>
                </template>
                开启后可在 Workers Logs 查看 console.log 与调用日志
              </n-tooltip>
            </n-space>
            <n-space align="center" :size="8">
              <n-switch v-model:value="enableTraces" size="small" />
              <n-tooltip>
                <template #trigger>
                  <span style="font-size: 13px; cursor: help">Workers 跟踪</span>
                </template>
                开启链路追踪与指标（Workers Observability）
              </n-tooltip>
            </n-space>
          </n-space>
        </n-form-item>



        <!-- Bindings -->
        <template v-if="template.bindings?.length">
          <n-divider>绑定资源</n-divider>
          <n-form-item v-for="b in resourceBindings" :key="b.name" :label="`${b.name} (${b.type})`">
            <n-space vertical style="width: 100%">
              <n-select
                v-model:value="bindingSelections[b.name].value"
                :options="getResourceOptions(b)"
                :loading="resourceLoading[b.type]"
                placeholder="选择资源"
                @update:value="(val: string) => { onBindingSelect(b, val); invalidatePreflight(); }"
              />
              <!-- D1 init SQL checkbox -->
              <n-checkbox
                v-if="b.type === 'd1' && (b.initSqlUrl || b.initSql)"
                v-model:checked="bindingSelections[b.name].runInitSql"
                @update:checked="invalidatePreflight"
              >
                执行初始化 SQL
                <span style="color: var(--text-color-3); font-size: 12px">
                  ({{ bindingSelections[b.name].mode === 'existing' ? '复用时默认不勾' : '新建时默认勾' }})
                </span>
              </n-checkbox>
            </n-space>
          </n-form-item>
        </template>

        <!-- Secrets (var/prompt, secret !== false) -->
        <template v-if="secretBindings.length">
          <n-divider>需要填写的密钥</n-divider>
          <n-form-item v-for="b in secretBindings" :key="b.name" :label="b.name" :required="b.required">
            <n-input v-model:value="secretValues[b.name]" type="password" show-password-on="click" :placeholder="`输入 ${b.name}`" @update:value="invalidatePreflight" />
          </n-form-item>
        </template>

        <!-- Plain config (var/prompt, secret === false) -->
        <template v-if="plainBindings.length">
          <n-divider>需要填写的配置项</n-divider>
          <n-form-item v-for="b in plainBindings" :key="b.name" :label="b.name" :required="b.required">
            <n-input v-model:value="secretValues[b.name]" :placeholder="`输入 ${b.name}`" @update:value="invalidatePreflight" />
          </n-form-item>
        </template>

        <!-- Env (read-only) -->
        <template v-if="template.env && Object.keys(template.env).length">
          <n-divider>环境变量 (自动写入)</n-divider>
          <n-descriptions label-placement="left" :column="1" size="small" bordered>
            <n-descriptions-item v-for="(v, k) in template.env" :key="k" :label="k">{{ v }}</n-descriptions-item>
          </n-descriptions>
        </template>

        <!-- Crons (read-only) -->
        <template v-if="template.crons && template.crons.length">
          <n-divider>定时任务 (自动注册)</n-divider>
          <n-space>
            <n-tag v-for="cron in template.crons" :key="cron" type="warning" :bordered="false" round>{{ cron }}</n-tag>
          </n-space>
        </template>

        <!-- Preflight Results (仅在有警告或配置差异时展示) -->
        <template v-if="preflightResult && hasPreflightDetails">
          <n-divider>预检结果</n-divider>
          <n-space vertical :size="12">
            <!-- Status tags -->
            <n-space align="center" :size="8">
              <n-tag :type="preflightResult.workerExists ? 'warning' : 'success'" size="small" :bordered="false">
                {{ preflightResult.workerExists ? 'Worker 已存在（将使用版本化部署）' : '新 Worker（将使用传统部署）' }}
              </n-tag>
            </n-space>

            <!-- Config Diff -->
            <template v-if="preflightResult.configDiff">
              <n-space vertical :size="4">
                <n-text v-if="preflightResult.configDiff.added.length" depth="2" style="font-size: 13px">
                  新增绑定: {{ preflightResult.configDiff.added.map((b: any) => `${b.name}(${b.type})`).join(', ') }}
                </n-text>
                <n-text v-if="preflightResult.configDiff.removed.length" type="warning" style="font-size: 13px">
                  移除绑定: {{ preflightResult.configDiff.removed.map((b: any) => `${b.name}(${b.type})`).join(', ') }}
                </n-text>
                <n-text v-if="preflightResult.configDiff.modified.length" type="warning" style="font-size: 13px">
                  修改绑定: {{ preflightResult.configDiff.modified.map((b: any) => `${b.name}(${b.type})`).join(', ') }}
                </n-text>
              </n-space>
            </template>

            <!-- Secrets Override -->
            <n-alert v-if="preflightResult.secretsOverride.length" type="warning" :show-icon="true" style="font-size: 13px">
              以下 Secrets 需要填写值: {{ preflightResult.secretsOverride.join(', ') }}
            </n-alert>

            <!-- Warnings -->
            <n-alert
              v-for="(w, i) in preflightResult.warnings"
              :key="i"
              :type="w.includes('移除') || w.includes('无效') ? 'warning' : 'info'"
              :show-icon="true"
              style="font-size: 13px"
            >
              {{ w }}
            </n-alert>
          </n-space>
        </template>
      </n-form>
    </n-spin>

    <template #footer>
      <n-space justify="end" :size="8">
        <n-button @click="visible = false">取消</n-button>
        <!-- 预检通过且有细节需要确认时，展示「确认部署」+「返回修改」 -->
        <template v-if="preflightResult && hasPreflightDetails && preflightResult.canProceed">
          <n-button @click="invalidatePreflight">返回修改</n-button>
          <n-button type="primary" :loading="deploying" @click="handleDeploy">确认部署</n-button>
        </template>
        <!-- 正常流程：点击后自动先预检，通过则直接部署 -->
        <n-button v-else type="primary" :loading="preflighting || deploying" :disabled="!canDeploy" @click="handleDeploy">
          {{ preflighting ? '预检中...' : '确认部署' }}
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, computed, watch, h } from 'vue';
import { storeApi } from '../api/store';
import { workersApi } from '../api/workers';
import { accountsApi } from '../api/accounts';
import { NTag } from 'naive-ui';
import { message } from '../utils/discreteApi';

const props = defineProps<{ show: boolean; template: any }>();
const emit = defineEmits<{ 'update:show': [boolean]; deployed: [any] }>();

const visible = computed({
  get: () => props.show,
  set: (v) => emit('update:show', v),
});

const deploying = ref(false);
const preflighting = ref(false);
const preflightResult = ref<any>(null);
const deployType = ref<'worker' | 'pages' | 'both'>('both');
const enableLogs = ref(true);    // Workers 日志（默认开启）
const enableTraces = ref(true);  // Workers 跟踪（默认开启）
const accounts = ref<any[]>([]);
const form = ref({ accountId: null as number | null, name: '' });
const bindingSelections = ref<Record<string, { value: string; mode: 'auto' | 'existing'; existingId?: string; runInitSql: boolean }>>({});
const secretValues = ref<Record<string, string>>({});
const resourceLoading = ref<Record<string, boolean>>({});
const existingResources = ref<Record<string, any[]>>({ kv: [], d1: [], r2: [] });

// 模板是否需要 R2：存在 type 为 r2 的绑定
const needsR2 = computed(() =>
  (props.template?.bindings || []).some((b: any) => b.type === 'r2')
);

// 是否为「仅 Pages」部署：纯 pages 模板 或 hybrid 但选了仅 pages
// 这两种情况下 Workers 日志/跟踪不适用，需要隐藏「可观测性」区域
const isPagesOnly = computed(() =>
  props.template?.type === 'pages' ||
  (props.template?.type === 'hybrid' && deployType.value === 'pages')
);

// 预检结果是否有需要用户确认的细节（配置差异、Secrets 覆盖、警告）
const hasPreflightDetails = computed(() => {
  if (!preflightResult.value) return false;
  return !!(
    preflightResult.value.configDiff ||
    preflightResult.value.secretsOverride?.length ||
    preflightResult.value.warnings?.length
  );
});

// 精确判断账户是否开通 R2：避免 '-r2' 被 includes('r2') 误匹配
function hasR2Feature(account: any): boolean {
  const features = (account.available_features || '').split(',').filter(Boolean);
  return features.includes('r2') && !features.includes('-r2');
}

const accountOptions = computed(() => {
  const list = accounts.value
    // 需要 R2 时只保留已开通 R2 的账户，其余不可选
    .filter((a) => !needsR2.value || hasR2Feature(a))
    .map((a) => ({ label: a.name, value: a.id }));
  return list;
});

function renderAccountLabel(option: { label: string; value: number }) {
  const account = accounts.value.find((a: any) => a.id === option.value);
  if (!account) return option.label;
  if (hasR2Feature(account)) {
    return h('span', { style: 'display: inline-flex; align-items: center; gap: 4px' }, [
      option.label,
      h(NTag, { size: 'tiny', type: 'success', bordered: false }, { default: () => 'R2' }),
    ]);
  }
  return option.label;
}

const resourceBindings = computed(() =>
  (props.template?.bindings || []).filter((b: any) => ['kv', 'd1', 'r2'].includes(b.type))
);

const secretBindings = computed(() =>
  (props.template?.bindings || []).filter((b: any) => b.type === 'var' && b.action === 'prompt' && b.secret !== false)
);

// 明文 var（需手填但作为普通环境变量写入，前端显示普通文本框）
const plainBindings = computed(() =>
  (props.template?.bindings || []).filter((b: any) => b.type === 'var' && b.action === 'prompt' && b.secret === false)
);

const canDeploy = computed(() => {
  if (!form.value.accountId || !form.value.name) return false;
  for (const b of [...secretBindings.value, ...plainBindings.value]) {
    if (b.required && !secretValues.value[b.name]) return false;
  }
  return true;
});

function getResourceOptions(binding: any) {
  const resources = existingResources.value[binding.type] || [];
  const title = binding.title || `${props.template?.id}-${binding.name.toLowerCase()}`;
  const options = [{ label: `自动创建/复用: ${title}`, value: '__auto__' }];
  for (const r of resources) {
    const label = r.title || r.name || r.id;
    options.push({ label, value: r.id || r.uuid || r.name });
  }
  return options;
}

function onBindingSelect(binding: any, value: string) {
  if (value === '__auto__') {
    bindingSelections.value[binding.name].mode = 'auto';
    bindingSelections.value[binding.name].existingId = undefined;
    bindingSelections.value[binding.name].runInitSql = true;
  } else {
    bindingSelections.value[binding.name].mode = 'existing';
    bindingSelections.value[binding.name].existingId = value;
    bindingSelections.value[binding.name].runInitSql = false;
  }
}

// 任何表单变更都需要清除预检结果
function invalidatePreflight() {
  preflightResult.value = null;
}

async function onAccountChange() {
  invalidatePreflight();
  if (!form.value.accountId) return;
  // 只拉取当前模板实际用到的资源类型，避免对未开通 R2 的账号无谓调用 R2 API 而误报 "R2 is not enabled"
  const neededTypes = (Array.from(new Set((props.template?.bindings || []).map((b: any) => b.type))))
    .filter((t: any) => t === 'kv' || t === 'd1' || t === 'r2') as ('kv' | 'd1' | 'r2')[];
  if (neededTypes.length === 0) return;
  for (const type of neededTypes) {
    resourceLoading.value[type] = true;
    try {
      if (type === 'kv') {
        const { data } = await workersApi.getKvNamespaces(form.value.accountId);
        existingResources.value.kv = data as any[];
      } else if (type === 'd1') {
        const { data } = await workersApi.getD1Databases(form.value.accountId);
        existingResources.value.d1 = data as any[];
      } else if (type === 'r2') {
        const { data } = await workersApi.getR2Buckets(form.value.accountId, { _silent: true });
        existingResources.value.r2 = data as any[];
      }
    } catch (e: any) {
      existingResources.value[type] = [];
    } finally {
      resourceLoading.value[type] = false;
    }
  }
}

function buildSelections(): Record<string, any> {
  const selections: Record<string, any> = {};
  for (const [name, sel] of Object.entries(bindingSelections.value)) {
    const entry: any = {
      mode: sel.mode,
      existingId: sel.existingId,
    };
    // auto 模式下不发送 runInitSql，让后端自行判断：
    // 新建 DB 默认执行 init SQL，已有 DB 不执行（除非用户显式勾选）
    if (sel.mode === 'existing') {
      entry.runInitSql = sel.runInitSql;
    }
    selections[name] = entry;
  }
  return selections;
}

/**
 * 统一部署入口 — 点击「确认部署」时自动先预检：
 *
 * 1. 已有预检结果且 canProceed=true 且有需要确认的细节 → 直接部署（用户已点过「确认部署」）
 * 2. 其他情况 → 先调用 preflight API
 *    a. 预检通过且无警告/diff → 自动继续部署（无缝体验）
 *    b. 预检有警告/diff → 展示结果，等用户再次点「确认部署」
 *    c. 预检失败 → message.error 提示，不继续部署
 */
async function handleDeploy() {
  if (!canDeploy.value) return;

  // 情况 1：已有预检结果且用户已确认
  if (preflightResult.value?.canProceed && hasPreflightDetails.value) {
    await doDeploy();
    return;
  }

  // 情况 2：先预检
  preflighting.value = true;
  try {
    const selections = buildSelections();
    const { data: pfData } = await storeApi.preflight({
      accountId: form.value.accountId!,
      templateId: props.template.id,
      name: form.value.name,
      bindingSelections: selections,
      secretValues: secretValues.value,
      deployType: props.template.type === 'hybrid' ? deployType.value : undefined,
    });
    preflightResult.value = pfData;

    if (!pfData.canProceed) {
      message.error('预检未通过，请检查上方提示');
      return;
    }

    // 预检通过且无需要确认的细节 → 自动继续部署
    if (!hasPreflightDetails.value) {
      preflighting.value = false;
      await doDeploy();
    }
    // 否则展示预检结果，等用户确认
  } catch (e: any) {
    preflightResult.value = null;
    message.error(`预检失败: ${e.errorMessage || e.message || '未知错误'}`);
  } finally {
    preflighting.value = false;
  }
}

async function doDeploy() {
  deploying.value = true;
  try {
    const selections = buildSelections();

    const result = await storeApi.deploy({
      accountId: form.value.accountId!,
      templateId: props.template.id,
      name: form.value.name,
      bindingSelections: selections,
      secretValues: secretValues.value,
      deployType: props.template.type === 'hybrid' ? deployType.value : undefined,
      logs: enableLogs.value,
      traces: enableTraces.value,
    });

    emit('deployed', result);
  } catch (e: any) {
    const errData = e?.response?.data?.error;
    emit('deployed', {
      success: false,
      error: e.errorMessage || e.message,
      rolledBack: errData?.rolledBack,
      rollbackErrors: errData?.rollbackErrors,
    });
  } finally {
    deploying.value = false;
  }
}

// Reset form when template changes
watch(() => props.template, (tmpl) => {
  if (tmpl) {
    form.value.name = tmpl.id;
    form.value.accountId = null;
    secretValues.value = {};
    bindingSelections.value = {};
    existingResources.value = { kv: [], d1: [], r2: [] };
    enableLogs.value = true;
    enableTraces.value = true;
    preflightResult.value = null;
    const prefilledSecrets: Record<string, string> = {};
    for (const b of (tmpl.bindings || [])) {
      if (['kv', 'd1', 'r2'].includes(b.type)) {
        bindingSelections.value[b.name] = { value: '__auto__', mode: 'auto', runInitSql: b.type === 'd1' };
      } else if (b.type === 'var' && b.action === 'prompt' && b.value) {
        // var 绑定有默认值时预填到输入框
        prefilledSecrets[b.name] = b.value;
      }
    }
    secretValues.value = prefilledSecrets;
    loadAccounts();
  }
}, { immediate: true });

async function loadAccounts() {
  try {
    const { data } = await accountsApi.getAll();
    accounts.value = Array.isArray(data) ? data : ((data as any).accounts || []);
  } catch {}
}
</script>
