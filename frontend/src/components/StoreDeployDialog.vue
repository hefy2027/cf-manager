<template>
  <n-modal v-model:show="visible" preset="card" :title="`部署 ${template?.name || ''}`" style="width: 600px; max-width: 95vw" :mask-closable="false">
    <n-spin :show="deploying">
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
          <n-input v-model:value="form.name" placeholder="输入名称" />
        </n-form-item>

        <!-- Deploy type (hybrid only) -->
        <n-form-item v-if="template.type === 'hybrid'" label="部署方式" required>
          <n-radio-group v-model:value="deployType">
            <n-radio-button value="both">Worker + Pages</n-radio-button>
            <n-radio-button value="worker">仅 Worker</n-radio-button>
            <n-radio-button value="pages">仅 Pages</n-radio-button>
          </n-radio-group>
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
                @update:value="(val: string) => onBindingSelect(b, val)"
              />
              <!-- D1 init SQL checkbox -->
              <n-checkbox
                v-if="b.type === 'd1' && (b.initSqlUrl || b.initSql)"
                v-model:checked="bindingSelections[b.name].runInitSql"
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
            <n-input v-model:value="secretValues[b.name]" type="password" show-password-on="click" :placeholder="`输入 ${b.name}`" />
          </n-form-item>
        </template>

        <!-- Plain config (var/prompt, secret === false) -->
        <template v-if="plainBindings.length">
          <n-divider>需要填写的配置项</n-divider>
          <n-form-item v-for="b in plainBindings" :key="b.name" :label="b.name" :required="b.required">
            <n-input v-model:value="secretValues[b.name]" :placeholder="`输入 ${b.name}`" />
          </n-form-item>
        </template>

        <!-- Env (read-only) -->
        <template v-if="template.env && Object.keys(template.env).length">
          <n-divider>环境变量 (自动写入)</n-divider>
          <n-descriptions label-placement="left" :column="1" size="small" bordered>
            <n-descriptions-item v-for="(v, k) in template.env" :key="k" :label="k">{{ v }}</n-descriptions-item>
          </n-descriptions>
        </template>
      </n-form>
    </n-spin>

    <template #footer>
      <n-space justify="end">
        <n-button @click="visible = false">取消</n-button>
        <n-button type="primary" :loading="deploying" :disabled="!canDeploy" @click="handleDeploy">确认部署</n-button>
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

const props = defineProps<{ show: boolean; template: any }>();
const emit = defineEmits<{ 'update:show': [boolean]; deployed: [any] }>();

const visible = computed({
  get: () => props.show,
  set: (v) => emit('update:show', v),
});

const deploying = ref(false);
const deployType = ref<'worker' | 'pages' | 'both'>('both');
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

async function onAccountChange() {
  if (!form.value.accountId) return;
  // 只拉取当前模板实际用到的资源类型，避免对未开通 R2 的账号无谓调用 R2 API 而误报 “R2 is not enabled”
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

async function handleDeploy() {
  if (!canDeploy.value) return;
  deploying.value = true;
  try {
    const selections: Record<string, any> = {};
    for (const [name, sel] of Object.entries(bindingSelections.value)) {
      selections[name] = {
        mode: sel.mode,
        existingId: sel.existingId,
        runInitSql: sel.runInitSql,
      };
    }

    const result = await storeApi.deploy({
      accountId: form.value.accountId!,
      templateId: props.template.id,
      name: form.value.name,
      bindingSelections: selections,
      secretValues: secretValues.value,
      deployType: props.template.type === 'hybrid' ? deployType.value : undefined,
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
    for (const b of (tmpl.bindings || [])) {
      if (['kv', 'd1', 'r2'].includes(b.type)) {
        bindingSelections.value[b.name] = { value: '__auto__', mode: 'auto', runInitSql: b.type === 'd1' };
      }
    }
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
