<template>
  <div class="page-view">
    <n-space justify="space-between" align="center">
      <n-h2>{{ t('accounts.title') }}</n-h2>
      <n-space>
        <n-button @click="showImportModal = true">{{ t('accounts.importCsv') }}</n-button>
        <n-tooltip v-if="isDemoMode" trigger="hover">
          <template #trigger>
            <span style="display: inline-block;">
              <n-button disabled>{{ t('accounts.exportCsv') }}</n-button>
            </span>
          </template>
          {{ t('accounts.exportDemoDisabled') }}
        </n-tooltip>
        <n-button v-else @click="openExportModal">{{ t('accounts.exportCsv') }}</n-button>
        <n-button type="primary" @click="showAddModal = true">{{ t('accounts.addAccount') }}</n-button>
      </n-space>
    </n-space>

    <n-space align="center" :size="12" style="margin: 12px 0;">
      <n-button-group size="small">
        <n-button :type="accountStore.filter === 'all' ? 'primary' : 'default'" @click="handleFilterChange('all')">{{ t('accounts.filterAll') }} ({{ accountStore.counts.all }})</n-button>
        <n-button :type="accountStore.filter === 'active' ? 'primary' : 'default'" @click="handleFilterChange('active')">{{ t('accounts.filterActive') }} ({{ accountStore.counts.active }})</n-button>
        <n-button :type="accountStore.filter === 'unverified' ? 'primary' : 'default'" @click="handleFilterChange('unverified')">{{ t('accounts.filterUnverified') }} ({{ accountStore.counts.unverified }})</n-button>
      </n-button-group>
      <n-button
        size="small"
        type="warning"
        :loading="batchTesting"
        :disabled="accountStore.filter === 'unverified' && accountStore.counts.unverified === 0"
        @click="handleTestBatch"
      >
        {{ t('accounts.batchTestAccounts', { filter: accountStore.filter === 'unverified' ? t('accounts.filterUnverified') : t('accounts.filterAll') }) }}
      </n-button>
      <n-input
        v-model:value="searchInput"
        size="small"
        :placeholder="t('accounts.searchPlaceholder')"
        clearable
        style="width: 200px;"
        @update:value="handleSearchInput"
      />
      <template v-if="checkedRowKeys.length > 0">
        <n-divider vertical />
        <n-text strong depth="3">{{ t('accounts.selectedItems', { count: checkedRowKeys.length }) }}</n-text>
        <n-button size="small" type="primary" ghost @click="openBatchFeatures">{{ t('accounts.batchFeatures') }}</n-button>
        <n-button v-if="!isWorkerPlatform" size="small" @click="openBatchProxy">{{ t('accounts.batchProxy') }}</n-button>
        <n-button size="small" type="error" @click="showBatchDeleteConfirm = true">{{ t('accounts.batchDelete') }}</n-button>
        <n-button size="small" quaternary @click="checkedRowKeys = []">{{ t('common.clearSelection') }}</n-button>
      </template>
    </n-space>

    <n-data-table
      :columns="columns"
      :data="accountStore.accounts"
      :loading="accountStore.loading"
      :bordered="false"
      :scroll-x="1200"
      :pagination="paginationConfig"
      :remote="true"
      :row-key="(row: any) => row.id"
      v-model:checked-row-keys="checkedRowKeys"
    />

    <n-modal v-model:show="showAddModal" preset="dialog" :title="editingId === null ? t('accounts.addModalTitle') : t('accounts.editModalTitle')" style="width: 500px; max-width: 95vw">
      <n-form :model="form" label-placement="left" label-width="100">
        <n-form-item :label="t('accounts.accountName')">
          <n-input v-model:value="form.name" :placeholder="t('accounts.accountNamePlaceholder')" />
        </n-form-item>
        <n-form-item :label="t('accounts.authType')">
          <n-select v-model:value="form.auth_type" :options="authTypeOptions" />
        </n-form-item>
        <n-form-item v-if="form.auth_type === 'token'" :label="t('accounts.apiToken')">
          <n-input v-model:value="form.api_token" type="password" show-password-on="click" :placeholder="editingId === null ? t('accounts.apiTokenPlaceholder') : t('accounts.apiTokenEditPlaceholder')" />
        </n-form-item>
        <n-form-item v-if="form.auth_type === 'global_key'" :label="t('accounts.email')">
          <n-input v-model:value="form.email" :placeholder="editingId === null ? t('accounts.emailPlaceholder') : (editingOriginalEmail ? t('accounts.emailEditWithOriginal', { email: editingOriginalEmail }) : t('accounts.emailEditPlaceholder'))" />
        </n-form-item>
        <n-form-item v-if="form.auth_type === 'global_key'" :label="t('accounts.apiKey')">
          <n-input v-model:value="form.api_key" type="password" show-password-on="click" :placeholder="editingId === null ? t('accounts.apiKeyPlaceholder') : t('accounts.apiKeyEditPlaceholder')" />
        </n-form-item>
        <n-form-item v-if="editingId === null" :label="t('accounts.enableFeatures')">
          <n-checkbox-group v-model:value="form.features">
            <n-space>
              <n-checkbox v-for="f in featureOptions" :key="f.value" :value="f.value" :label="f.label" />
            </n-space>
          </n-checkbox-group>
        </n-form-item>
        <n-form-item :label="t('accounts.workerPlan')">
          <n-select v-model:value="form.worker_plan" :options="workerPlanOptions" style="width: 180px" />
          <n-text depth="3" style="margin-left: 8px; font-size: 12px">{{ t('accounts.workerPlanHint') }}</n-text>
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showAddModal = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="submitting" @click="handleSubmit">{{ t('common.submit') }}</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="showFeatureModal" preset="dialog" :title="t('accounts.editFeatures')" style="width: 400px; max-width: 95vw">
      <n-checkbox-group v-model:value="editFeatures">
        <n-space vertical>
          <n-checkbox v-for="f in featureOptions" :key="f.value" :value="f.value" :label="f.label" />
        </n-space>
      </n-checkbox-group>
      <template #action>
        <n-button @click="showFeatureModal = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="submitting" @click="handleSaveFeatures">{{ t('common.save') }}</n-button>
      </template>
    </n-modal>

    <!-- 单个账户代理设置 -->
    <n-modal v-model:show="showProxyModal" preset="dialog" :title="t('accounts.proxyModalTitle')" style="width: 460px; max-width: 95vw">
      <n-form label-placement="left" label-width="90">
        <n-form-item :label="t('accounts.proxyUrl')">
          <n-input v-model:value="proxyForm.proxy_url" :placeholder="t('accounts.proxyUrlPlaceholder')" clearable />
        </n-form-item>
        <n-form-item :label="t('accounts.enableProxy')">
          <n-switch v-model:value="proxyForm.proxy_enabled" :disabled="!proxyForm.proxy_url" />
          <n-text depth="3" style="margin-left: 8px; font-size: 12px">
            {{ proxyForm.proxy_enabled ? t('accounts.proxyEnabledHint') : proxyForm.proxy_url ? t('accounts.proxyDisabledHint') : t('accounts.proxyUrlRequired') }}
          </n-text>
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showProxyModal = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="submitting" @click="handleSaveProxy">{{ t('common.save') }}</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="showImportModal" preset="dialog" :title="t('accounts.importModalTitle')" style="width: 700px; max-width: 95vw">
      <n-space vertical :size="16">
        <n-alert type="info" :bordered="false">
          {{ t('accounts.importInstructions') }}
        </n-alert>
        <n-upload
          :max="1"
          accept=".csv,text/csv,text/plain"
          :default-upload="false"
          :show-file-list="true"
          v-model:file-list="importFileList"
        >
          <n-button>{{ t('accounts.selectCsvFile') }}</n-button>
        </n-upload>
        <n-checkbox v-model:checked="skipVerify">
          {{ t('accounts.skipVerify') }}
        </n-checkbox>
        <n-alert v-if="importing" type="info" :bordered="false">
          {{ t('accounts.importing') }}
        </n-alert>
        <n-space v-if="importResult">
          <n-statistic :label="t('common.total')" :value="importResult.summary.total" />
          <n-statistic :label="t('common.success')" :value="importResult.summary.success" />
          <n-statistic :label="t('common.skipped')" :value="importResult.summary.skipped" />
          <n-statistic :label="t('common.error')" :value="importResult.summary.error" />
        </n-space>
        <n-data-table
          v-if="importResult"
          :columns="importResultColumns"
          :data="importResult.results"
          :bordered="false"
          size="small"
          :max-height="300"
        />
      </n-space>
      <template #action>
        <n-button @click="closeImportModal">{{ t('common.close') }}</n-button>
        <n-button type="primary" :loading="importing" :disabled="!importFile" @click="handleImport">{{ t('accounts.importCsv') }}</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="showExportModal" preset="dialog" :title="t('accounts.exportModalTitle')" style="width: 560px; max-width: 95vw">
      <n-space vertical :size="16">
        <n-form label-placement="left" label-width="70">
          <n-form-item :label="t('accounts.exportScope')">
            <n-radio-group v-model:value="exportScope">
              <n-space vertical :size="6">
                <n-radio value="all">{{ t('accounts.exportScopeAll', { count: accountStore.counts.all }) }}</n-radio>
                <n-radio value="filtered">{{ t('accounts.exportScopeFiltered', { count: accountStore.total }) }}</n-radio>
                <n-radio value="selected" :disabled="checkedRowKeys.length === 0">
                  {{ t('accounts.exportScopeSelected', { count: checkedRowKeys.length }) }}
                </n-radio>
              </n-space>
            </n-radio-group>
          </n-form-item>
          <n-form-item :label="t('accounts.exportCredentials')">
            <n-switch v-model:value="exportIncludeCredentials" />
          </n-form-item>
        </n-form>
        <n-alert v-if="exportIncludeCredentials" type="warning" :bordered="false">
          {{ t('accounts.exportCredentialsWarning') }}
        </n-alert>
        <n-alert v-if="exportIncludeCredentials" type="info" :bordered="false">
          {{ t('accounts.exportImportHint') }}
        </n-alert>
        <n-alert v-if="!exportIncludeCredentials" type="info" :bordered="false">
          {{ t('accounts.exportNoCredentialsHint') }}
        </n-alert>
      </n-space>
      <template #action>
        <n-button @click="showExportModal = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="exporting" @click="handleExport">{{ t('accounts.exportCsv') }}</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="showBatchResultModal" preset="dialog" :title="t('accounts.batchResultTitle')" style="width: 700px; max-width: 95vw">
      <n-space vertical :size="16">
        <n-space>
          <n-statistic :label="t('common.total')" :value="batchResult?.summary.total ?? 0" />
          <n-statistic :label="t('common.success')" :value="batchResult?.summary.success ?? 0" />
          <n-statistic :label="t('common.error')" :value="batchResult?.summary.error ?? 0" />
        </n-space>
        <n-data-table
          v-if="batchResult"
          :columns="batchResultColumns"
          :data="batchResult.results"
          :bordered="false"
          size="small"
          :max-height="300"
        />
      </n-space>
      <template #action>
        <n-button type="primary" @click="showBatchResultModal = false">{{ t('common.close') }}</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="showCredModal" preset="dialog" :title="t('accounts.credModalTitle')" style="width: 560px; max-width: 95vw">
      <n-spin :show="credLoading">
        <n-space vertical :size="12" v-if="credData">
          <n-alert type="warning" :bordered="false">
            {{ t('accounts.credWarning') }}
          </n-alert>
          <n-descriptions label-placement="left" bordered :column="1" size="small">
            <n-descriptions-item :label="t('accounts.accountName')">{{ credData.name }}</n-descriptions-item>
            <n-descriptions-item label="Account ID">
              <n-text :style="{ fontFamily: 'monospace' }">{{ credData.account_id || '-' }}</n-text>
            </n-descriptions-item>
            <n-descriptions-item :label="t('accounts.authType')">
              <n-tag size="small" :type="credData.auth_type === 'token' ? 'info' : 'warning'">
                {{ credData.auth_type === 'token' ? t('accounts.authTypeToken') : t('accounts.authTypeKey') }}
              </n-tag>
            </n-descriptions-item>
            <n-descriptions-item v-if="credData.auth_type === 'global_key'" :label="t('accounts.email')">
              {{ credData.email || '-' }}
            </n-descriptions-item>
            <n-descriptions-item v-if="credData.auth_type === 'token'" :label="t('accounts.apiToken')">
              <n-input
                :value="credData.api_token || ''"
                type="password"
                show-password-on="click"
                readonly
                :style="{ fontFamily: 'monospace' }"
              />
            </n-descriptions-item>
            <n-descriptions-item v-if="credData.auth_type === 'global_key'" :label="t('accounts.apiKey')">
              <n-input
                :value="credData.api_key || ''"
                type="password"
                show-password-on="click"
                readonly
                :style="{ fontFamily: 'monospace' }"
              />
            </n-descriptions-item>
            <n-descriptions-item v-if="!isWorkerPlatform" :label="t('accounts.proxyUrl')">
              <n-text :style="{ fontFamily: 'monospace' }">{{ credData.proxy_url || '—' }}</n-text>
            </n-descriptions-item>
            <n-descriptions-item v-if="!isWorkerPlatform && credData.proxy_url" :label="t('accounts.proxyStatus')">
              <n-tag :type="credData.proxy_enabled ? 'success' : 'default'" size="small">
                {{ credData.proxy_enabled ? t('common.enabled') : t('common.disabled') }}
              </n-tag>
            </n-descriptions-item>
          </n-descriptions>
        </n-space>
      </n-spin>
      <template #action>
        <n-button @click="showCredModal = false">{{ t('common.close') }}</n-button>
      </template>
    </n-modal>

    <!-- 批量设置功能 -->
    <n-modal v-model:show="showBatchFeaturesModal" preset="dialog" :title="t('accounts.batchFeaturesModalTitle')" style="width: 420px; max-width: 95vw">
      <n-checkbox-group v-model:value="batchFeatures">
        <n-space vertical>
          <n-checkbox v-for="f in featureOptions" :key="f.value" :value="f.value" :label="f.label" />
        </n-space>
      </n-checkbox-group>
      <template #action>
        <n-button @click="showBatchFeaturesModal = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="batchOperating" @click="handleBatchFeatures">{{ t('accounts.confirmSetAccounts', { count: checkedRowKeys.length }) }}</n-button>
      </template>
    </n-modal>

    <!-- 批量设置代理 -->
    <n-modal v-model:show="showBatchProxyModal" preset="dialog" :title="t('accounts.batchProxyModalTitle')" style="width: 460px; max-width: 95vw">
      <n-form label-placement="left" label-width="90">
        <n-form-item :label="t('accounts.proxyUrl')">
          <n-input v-model:value="batchProxyUrl" :placeholder="t('accounts.batchProxyHint')" clearable />
        </n-form-item>
        <n-form-item :label="t('accounts.enableProxy')">
          <n-switch v-model:value="batchProxyEnabled" />
          <n-text depth="3" style="margin-left: 8px; font-size: 12px">{{ batchProxyEnabled ? t('common.enabled') : t('common.disabled') }}</n-text>
        </n-form-item>
        <n-alert type="info" :bordered="false" style="margin-top: 8px">
          {{ t('accounts.batchProxyHint') }}
        </n-alert>
      </n-form>
      <template #action>
        <n-button @click="showBatchProxyModal = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="batchOperating" @click="handleBatchProxy">{{ t('accounts.confirmSetAccounts', { count: checkedRowKeys.length }) }}</n-button>
      </template>
    </n-modal>

    <!-- 批量删除确认 -->
    <n-modal v-model:show="showBatchDeleteConfirm" preset="dialog" :title="t('accounts.batchDeleteTitle')" type="error" style="width: 440px; max-width: 95vw">
      <n-alert type="error" :bordered="false">
        {{ t('accounts.batchDeleteConfirm', { count: checkedRowKeys.length }) }}
      </n-alert>
      <template #action>
        <n-button @click="showBatchDeleteConfirm = false">{{ t('common.cancel') }}</n-button>
        <n-button type="error" :loading="batchOperating" @click="handleBatchDelete">{{ t('accounts.confirmDelete') }}</n-button>
      </template>
    </n-modal>

    <!-- 批量操作结果 -->
    <n-modal v-model:show="showBatchOpResult" preset="dialog" :title="t('accounts.batchOpResultTitle')" style="width: 700px; max-width: 95vw">
      <n-space vertical :size="16">
        <n-space>
          <n-statistic :label="t('common.total')" :value="batchOpResult?.summary.total ?? 0" />
          <n-statistic :label="t('common.success')" :value="batchOpResult?.summary.success ?? 0" />
          <n-statistic :label="t('common.skipped')" :value="batchOpResult?.summary.skipped ?? 0" />
          <n-statistic :label="t('common.error')" :value="batchOpResult?.summary.error ?? 0" />
        </n-space>
        <n-data-table
          v-if="batchOpResult"
          :columns="batchOpResultColumns"
          :data="batchOpResult.results"
          :bordered="false"
          size="small"
          :max-height="300"
        />
      </n-space>
      <template #action>
        <n-button type="primary" @click="showBatchOpResult = false">{{ t('common.close') }}</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, h, computed, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { NButton, NSpace, NProgress, NTag, NDropdown, useMessage } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import type { UploadFileInfo } from 'naive-ui';
import { useAccountStore } from '../stores/accountStore';
import { accountsApi, type AccountExportParams } from '../api/accounts';
import { dialog } from '../utils/discreteApi';
import { settingsApi } from '../api/settings';

const { t } = useI18n();

type BatchOpResult = { summary: { total: number; success: number; skipped: number; error: number }; results: Array<{ id: number; name: string; status: 'success' | 'skipped' | 'error'; message?: string }> };

const accountStore = useAccountStore();
const message = useMessage();
const showAddModal = ref(false);
const editingId = ref<number | null>(null);
const editingOriginalEmail = ref<string>('');
const showFeatureModal = ref(false);
const showImportModal = ref(false);
const showBatchResultModal = ref(false);
const batchTesting = ref(false);
const batchResult = ref<{ summary: { total: number; success: number; error: number }; results: Array<{ id: number; name: string; status: 'success' | 'error'; message?: string }> } | null>(null);
const submitting = ref(false);
const importing = ref(false);
const skipVerify = ref(false);
const importFileList = ref<UploadFileInfo[]>([]);
const importResult = ref<{ summary: { total: number; success: number; skipped: number; error: number }; results: Array<{ email: string; name: string; status: 'success' | 'skipped' | 'error'; message?: string }> } | null>(null);

// 导出 CSV
const showExportModal = ref(false);
const exporting = ref(false);
const exportScope = ref<'all' | 'filtered' | 'selected'>('all');
const exportIncludeCredentials = ref(false);
const editingAccountId = ref<number | null>(null);
const editFeatures = ref<string[]>([]);

// 单账户代理设置
const showProxyModal = ref(false);
const proxyAccountId = ref<number | null>(null);
const proxyForm = ref({ proxy_url: '', proxy_enabled: false });
const searchInput = ref('');

// Worker 平台不支持代理
const isWorkerPlatform = ref(false);

// 演示（Demo）部署：配置了 DEMO_ACCOUNT_IDS 即视为演示实例，禁用导出
const isDemoMode = ref(false);

// 批量操作状态
const checkedRowKeys = ref<number[]>([]);
const batchOperating = ref(false);
const showBatchFeaturesModal = ref(false);
const batchFeatures = ref<string[]>(['ai', 'workers', 'browser_render', 'dns', 'storage']);
const showBatchProxyModal = ref(false);
const batchProxyUrl = ref('');
const batchProxyEnabled = ref(false);
const showBatchDeleteConfirm = ref(false);
const showBatchOpResult = ref(false);
const batchOpResult = ref<BatchOpResult | null>(null);
const batchOpResultColumns = computed<DataTableColumns<any>>(() => [
  { title: 'ID', key: 'id', width: 60 },
  { title: t('accounts.table.name'), key: 'name', width: 150 },
  {
    title: t('common.result'), key: 'status', width: 90,
    render: (row) => {
      const map: Record<string, { type: any; text: string }> = {
        success: { type: 'success', text: t('common.success') },
        skipped: { type: 'warning', text: t('common.skipped') },
        error: { type: 'error', text: t('common.error') },
      };
      const m = map[row.status] || { type: 'default', text: row.status };
      return h(NTag, { size: 'small', type: m.type, bordered: false }, { default: () => m.text });
    },
  },
  { title: t('common.message'), key: 'message', width: 180, minWidth: 100, ellipsis: { tooltip: true }, render: (row) => row.message || '-' },
]);

// 查看 API 凭证
const showCredModal = ref(false);
const credLoading = ref(false);
const credData = ref<{
  id: number;
  name: string;
  auth_type: 'token' | 'global_key';
  account_id: string | null;
  email: string | null;
  api_token: string | null;
  api_key: string | null;
  proxy_url: string;
  proxy_enabled: number;
} | null>(null);

async function handleViewCredentials(row: any) {
  showCredModal.value = true;
  credLoading.value = true;
  credData.value = null;
  try {
    credData.value = await accountStore.getCredentials(row.id);
  } catch (e: any) {
    message.error(t('accounts.msg.getCredFailed', { error: e?.message || e }));
    showCredModal.value = false;
  } finally {
    credLoading.value = false;
  }
}

const importFile = computed<File | null>(() => {
  const item = importFileList.value[0];
  return item?.file ?? null;
});

// 远程分页配置：与 store 状态联动
const paginationConfig = computed(() => ({
  page: accountStore.page,
  pageSize: accountStore.pageSize,
  itemCount: accountStore.total,
  showSizePicker: true,
  pageSizes: [10, 20, 50, 100],
  prefix: ({ itemCount }: any) => t('accounts.table.totalItems', { count: itemCount }),
  onUpdatePage: (p: number) => { accountStore.setPage(p); },
  onUpdatePageSize: (ps: number) => { accountStore.setPageSize(ps); },
}));

function handleFilterChange(f: 'all' | 'active' | 'unverified') {
  accountStore.setFilter(f);
}

// 搜索防抖
let searchTimer: ReturnType<typeof setTimeout> | null = null;
function handleSearchInput(val: string) {
  searchInput.value = val;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    accountStore.setSearch(val);
  }, 400);
}

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer);
});

const featureOptions = computed(() => [
  { label: t('accounts.workersAi'), value: 'ai' },
  { label: t('accounts.workersPages'), value: 'workers' },
  { label: t('accounts.browserRender'), value: 'browser_render' },
  { label: t('accounts.dnsManagement'), value: 'dns' },
  { label: t('accounts.storageManagement'), value: 'storage' },
]);

const featureLabelMap = computed<Record<string, string>>(() => ({
  ai: t('common.featureLabels.ai'),
  workers: t('common.featureLabels.workers'),
  browser_render: t('common.featureLabels.browser_render'),
  dns: t('common.featureLabels.dns'),
  storage: t('common.featureLabels.storage'),
}));

const form = ref({
  name: '',
  auth_type: 'token',
  api_token: '',
  api_key: '',
  email: '',
  features: ['ai', 'workers', 'browser_render', 'dns', 'storage'] as string[],
  worker_plan: 'free',
});

const authTypeOptions = computed(() => [
  { label: t('accounts.authTypeToken'), value: 'token' },
  { label: t('accounts.authTypeKey'), value: 'global_key' },
]);

// 账号的 Cloudflare Workers 计划类型：付费模型只路由到 paid/enterprise 账号（不标即视为免费）
const workerPlanOptions = computed(() => [
  { label: t('accounts.planFree'), value: 'free' },
  { label: t('accounts.planPaid'), value: 'paid' },
  { label: t('accounts.planEnterprise'), value: 'enterprise' },
]);

function resetForm() {
  form.value = { name: '', auth_type: 'token', api_token: '', api_key: '', email: '', features: ['ai', 'workers', 'browser_render', 'dns', 'storage'], worker_plan: 'free' };
}

async function handleSubmit() {
  if (!form.value.name) {
    message.warning(t('accounts.msg.nameRequired'));
    return;
  }
  submitting.value = true;
  try {
    const { features, ...rest } = form.value;
    const payload: any = { name: rest.name, auth_type: rest.auth_type, worker_plan: rest.worker_plan };
    // 仅发送用户实际填写的凭证字段；空串一律剔除，避免覆盖原凭证
    if (rest.auth_type === 'token') {
      if (rest.api_token) payload.api_token = rest.api_token;
    } else {
    if (rest.api_key) payload.api_key = rest.api_key;
    if (rest.email) payload.email = rest.email;
  }
  if (editingId.value === null) {
      // 添加模式：凭证必填（后端校验）
      await accountStore.createAccount({ ...payload, enabled_features: features.join(',') });
      message.success(t('accounts.msg.addSuccess'));
    } else {
      await accountStore.updateAccount(editingId.value, payload);
      message.success(t('accounts.msg.updateSuccess'));
    }
    showAddModal.value = false;
    resetForm();
    editingId.value = null;
  } finally {
    submitting.value = false;
  }
}

function openAccountEditor(row: any) {
  editingId.value = row.id;
  editingOriginalEmail.value = row.email || '';
  form.value = {
    name: row.name,
    auth_type: row.auth_type,
    api_token: '',
    api_key: '',
    email: '',
    features: parseFeatures(row.enabled_features),
    worker_plan: row.worker_plan || 'free',
  };
  showAddModal.value = true;
}

function openFeatureEditor(row: any) {
  editingAccountId.value = row.id;
  const raw = row.enabled_features || 'ai,workers,browser_render,dns,storage';
  editFeatures.value = raw.split(',').filter(Boolean);
  showFeatureModal.value = true;
}

async function handleSaveFeatures() {
  if (editingAccountId.value == null) return;
  submitting.value = true;
  try {
    await accountStore.updateFeatures(editingAccountId.value, editFeatures.value.join(','));
    message.success(t('accounts.msg.featuresUpdated'));
    showFeatureModal.value = false;
  } finally {
    submitting.value = false;
  }
}

function openProxyEditor(row: any) {
  proxyAccountId.value = row.id;
  proxyForm.value = { proxy_url: row.proxy_url || '', proxy_enabled: !!row.proxy_enabled };
  showProxyModal.value = true;
}

async function handleSaveProxy() {
  if (proxyAccountId.value == null) return;
  submitting.value = true;
  try {
    await accountStore.updateAccount(proxyAccountId.value, {
      proxy_url: proxyForm.value.proxy_url,
      proxy_enabled: proxyForm.value.proxy_enabled ? 1 : 0,
    });
    message.success(t('accounts.msg.proxyUpdated'));
    showProxyModal.value = false;
    await accountStore.fetchAccounts();
  } finally {
    submitting.value = false;
  }
}

async function handleTest(row: any) {
  await accountStore.testAccount(row.id);
  message.success(t('accounts.msg.testSuccess'));
}

async function handleClearExhausted(row: any) {
  try {
    await accountStore.clearExhausted(row.id);
    message.success(t('accounts.msg.clearExhaustedSuccess'));
  } catch (e: any) {
    message.error(t('accounts.msg.clearExhaustedFailed', { error: e?.message || e }));
  }
}

async function handleTestBatch() {
  batchTesting.value = true;
  batchResult.value = null;
  try {
    const onlyUnverified = accountStore.filter === 'unverified';
    const result = await accountStore.testBatch({ onlyUnverified });
    batchResult.value = result;
    showBatchResultModal.value = true;
    const s = result.summary;
    message.success(t('accounts.msg.batchTestComplete', { success: s.success, error: s.error }));
  } catch (e: any) {
    message.error(t('accounts.msg.batchTestFailed', { error: e?.message || e }));
  } finally {
    batchTesting.value = false;
  }
}

// ============ 批量操作 ============
function openBatchFeatures() {
  batchFeatures.value = ['ai', 'workers', 'browser_render', 'dns', 'storage'];
  showBatchFeaturesModal.value = true;
}

async function handleBatchFeatures() {
  batchOperating.value = true;
  try {
    const { data } = await accountsApi.batchFeatures(checkedRowKeys.value, batchFeatures.value.join(','));
    batchOpResult.value = data as BatchOpResult;
    showBatchFeaturesModal.value = false;
    showBatchOpResult.value = true;
    checkedRowKeys.value = [];
    await accountStore.fetchAccounts();
    const s = batchOpResult.value.summary;
    message.success(t('accounts.msg.batchFeaturesComplete', { success: s.success, skipped: s.skipped, error: s.error }));
  } catch (e: any) {
    message.error(t('accounts.msg.batchFeaturesFailed', { error: e?.message || e }));
  } finally {
    batchOperating.value = false;
  }
}

function openBatchProxy() {
  batchProxyUrl.value = '';
  batchProxyEnabled.value = false;
  showBatchProxyModal.value = true;
}

async function handleBatchProxy() {
  batchOperating.value = true;
  try {
    const payload: any = {};
    if (batchProxyUrl.value) payload.proxy_url = batchProxyUrl.value;
    payload.proxy_enabled = batchProxyEnabled.value ? 1 : 0;
    const { data } = await accountsApi.batchProxy(checkedRowKeys.value, payload);
    batchOpResult.value = data as BatchOpResult;
    showBatchProxyModal.value = false;
    showBatchOpResult.value = true;
    checkedRowKeys.value = [];
    await accountStore.fetchAccounts();
    const s = batchOpResult.value.summary;
    message.success(t('accounts.msg.batchProxyComplete', { success: s.success, skipped: s.skipped, error: s.error }));
  } catch (e: any) {
    message.error(t('accounts.msg.batchProxyFailed', { error: e?.message || e }));
  } finally {
    batchOperating.value = false;
  }
}

async function handleBatchDelete() {
  batchOperating.value = true;
  try {
    const { data } = await accountsApi.batchDelete(checkedRowKeys.value);
    batchOpResult.value = data as BatchOpResult;
    showBatchDeleteConfirm.value = false;
    showBatchOpResult.value = true;
    checkedRowKeys.value = [];
    await accountStore.fetchAccounts();
    const s = batchOpResult.value.summary;
    message.success(t('accounts.msg.batchDeleteComplete', { success: s.success, skipped: s.skipped, error: s.error }));
  } catch (e: any) {
    message.error(t('accounts.msg.batchDeleteFailed', { error: e?.message || e }));
  } finally {
    batchOperating.value = false;
  }
}

const batchResultColumns = computed<DataTableColumns<any>>(() => [
  { title: 'ID', key: 'id', width: 60 },
  { title: t('accounts.table.name'), key: 'name', width: 150 },
  {
    title: t('common.result'), key: 'status', width: 90,
    render: (row) => {
      const map: Record<string, { type: any; text: string }> = {
        success: { type: 'success', text: t('common.success') },
        error: { type: 'error', text: t('common.error') },
      };
      const m = map[row.status] || { type: 'default', text: row.status };
      return h(NTag, { size: 'small', type: m.type, bordered: false }, { default: () => m.text });
    },
  },
  { title: t('common.message'), key: 'message', width: 180, minWidth: 100, ellipsis: { tooltip: true }, render: (row) => row.message || '-' },
]);

async function handleDelete(row: any) {
  await accountStore.deleteAccount(row.id);
  message.success(t('accounts.msg.deleted'));
}

// 操作列「更多」下拉菜单路由
function handleActionMenu(key: string, row: any) {
  switch (key) {
    case 'cred':
      handleViewCredentials(row);
      break;
    case 'features':
      openFeatureEditor(row);
      break;
    case 'proxy':
      openProxyEditor(row);
      break;
    case 'clearExhausted':
      handleClearExhausted(row);
      break;
    case 'delete':
      dialog.warning({
        title: t('accounts.msg.deleteAccountTitle'),
        content: t('accounts.msg.deleteAccountConfirm', { name: row.name }),
        positiveText: t('common.delete'),
        negativeText: t('common.cancel'),
        onPositiveClick: () => handleDelete(row),
      });
      break;
  }
}

function closeImportModal() {
  showImportModal.value = false;
  importFileList.value = [];
  importResult.value = null;
  skipVerify.value = false;
}

async function handleImport() {
  if (!importFile.value) {
    message.warning(t('accounts.msg.csvFileRequired'));
    return;
  }
  importing.value = true;
  importResult.value = null;
  try {
    const result = await accountStore.importCsv(importFile.value, skipVerify.value);
    importResult.value = result;
    const s = result.summary;
    message.success(t('accounts.msg.importComplete', { success: s.success, skipped: s.skipped, error: s.error, skipNote: skipVerify.value ? t('accounts.msg.importSkipNote') : '' }));
  } finally {
    importing.value = false;
  }
}

function openExportModal() {
  if (isDemoMode.value) {
    message.warning(t('accounts.exportDemoDisabled'));
    return;
  }
  // 有选中项时默认导出选中，否则默认全量
  exportScope.value = checkedRowKeys.value.length > 0 ? 'selected' : 'all';
  showExportModal.value = true;
}

function exportFilenameStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function handleExport() {
  const scope = exportScope.value;
  if (scope === 'selected' && checkedRowKeys.value.length === 0) {
    message.warning(t('accounts.msg.exportNoSelection'));
    return;
  }
  if (scope === 'filtered' && accountStore.total === 0) {
    message.warning(t('accounts.msg.exportEmpty'));
    return;
  }
  if (scope === 'all' && accountStore.counts.all === 0) {
    message.warning(t('accounts.msg.exportEmpty'));
    return;
  }

  exporting.value = true;
  try {
    const params: AccountExportParams = { includeCredentials: exportIncludeCredentials.value };
    if (scope === 'selected') {
      params.ids = checkedRowKeys.value.slice();
    } else if (scope === 'filtered') {
      params.filter = accountStore.filter;
      params.search = accountStore.search;
    }
    const blob = await accountStore.exportCsv(params);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cf-manager-accounts-${exportFilenameStamp()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showExportModal.value = false;
    message.success(t('accounts.msg.exportSuccess'));
  } catch (e: any) {
    // 请求标记了 _silent，此处统一提示；失败响应为 JSON Blob，需解析出真实错误信息
    let msg = e?.errorMessage || t('accounts.msg.exportFailed');
    const data = e?.response?.data;
    if (data instanceof Blob) {
      try {
        const parsed = JSON.parse(await data.text());
        msg = parsed?.error?.message || parsed?.message || msg;
      } catch { /* 非 JSON 响应，保留原提示 */ }
    }
    message.error(msg);
  } finally {
    exporting.value = false;
  }
}

const importResultColumns = computed<DataTableColumns<any>>(() => [
  { title: t('accounts.table.email'), key: 'email', width: 220, ellipsis: { tooltip: true } },
  { title: t('accounts.table.accountNameShort'), key: 'name', width: 140 },
  {
    title: t('common.result'), key: 'status', width: 90,
    render: (row) => {
      const map: Record<string, { type: any; text: string }> = {
        success: { type: 'success', text: t('common.success') },
        skipped: { type: 'warning', text: t('common.skipped') },
        error: { type: 'error', text: t('common.error') },
      };
      const m = map[row.status] || { type: 'default', text: row.status };
      return h(NTag, { size: 'small', type: m.type, bordered: false }, { default: () => m.text });
    },
  },
  { title: t('common.message'), key: 'message', width: 180, minWidth: 100, ellipsis: { tooltip: true }, render: (row) => row.message || '-' },
]);

function parseFeatures(raw: string | undefined): string[] {
  return (raw || 'ai,workers,browser_render,dns,storage').split(',').filter(Boolean);
}

const columns = computed<DataTableColumns<any>>(() => {
  const cols: DataTableColumns<any> = [
  { type: 'selection', width: 40, fixed: 'left' },
  { title: 'ID', key: 'id', width: 60 },
  { title: t('accounts.table.name'), key: 'name', width: 150 },
  { title: 'Account ID', key: 'account_id', width: 180, ellipsis: { tooltip: true }, render: (row) => row.account_id || '-' },
  { title: t('accounts.table.authType'), key: 'auth_type', width: 120, render: (row) => h(NTag, { size: 'small', type: row.auth_type === 'token' ? 'info' : 'warning' }, { default: () => row.auth_type === 'token' ? 'Token' : 'Key' }) },
  { title: t('accounts.workerPlan'), key: 'worker_plan', width: 90, render: (row) => {
    // 未标注（空）与 'free' 都按免费处理；付费模型只会路由到「付费/企业」账号
    const plan = row.worker_plan === 'paid' || row.worker_plan === 'enterprise' ? row.worker_plan : 'free';
    const labelKey = plan === 'paid' ? 'accounts.planPaid' : plan === 'enterprise' ? 'accounts.planEnterprise' : 'accounts.planFree';
    return h(NTag, { size: 'small', type: plan === 'free' ? 'default' : 'success', bordered: false }, { default: () => t(labelKey) });
  }},
  ];
  // Worker 平台不支持代理，隐藏代理列
  if (!isWorkerPlatform.value) {
    cols.push({ title: t('accounts.table.proxy'), key: 'proxy_url', width: 80, align: 'center', render: (row) => {
      if (!row.proxy_url) return h('span', { style: { color: '#999', fontSize: '12px' } }, '—');
      return row.proxy_enabled
        ? h(NTag, { size: 'small', type: 'success', bordered: false }, { default: () => t('common.enabled') })
        : h(NTag, { size: 'small', type: 'default', bordered: false }, { default: () => t('common.disabled') });
    }});
  }
  cols.push(
  {
    title: t('accounts.table.features'), key: 'enabled_features', width: 220,
    render: (row) => {
      const features = parseFeatures(row.enabled_features);
      const tags = features.map(f =>
        h(NTag, { size: 'small', type: 'success', bordered: false }, { default: () => featureLabelMap.value[f] || f })
      );
      // R2 付费能力标识（与 enabled_features 区分）
      const af = (row.available_features || '').split(',').filter(Boolean);
      if (af.includes('r2')) {
        tags.push(h(NTag, { size: 'small', type: 'info', bordered: false }, { default: () => 'R2' }));
      } else if (af.includes('-r2')) {
        tags.push(h(NTag, { size: 'small', type: 'default', bordered: false, style: 'text-decoration: line-through; opacity: 0.5' }, { default: () => 'R2' }));
      }
      return h(NSpace, { size: 4 }, { default: () => tags });
    },
  },
  { title: t('accounts.table.status'), key: 'is_active', width: 80, render: (row) => {
    if (row.is_demo) {
      return h(NTag, { size: 'small', type: 'warning', bordered: false }, { default: () => t('common.demo') });
    }
    return h(NTag, { size: 'small', type: row.is_active ? 'success' : 'default' }, { default: () => row.is_active ? t('common.active') : t('common.inactive') });
  }},
  { title: t('accounts.table.aiQuota'), key: 'aiQuota', width: 160, render: (row) => {
    const quotaItem = accountStore.quota.find((q: any) => q.accountId === row.id);
    if (!quotaItem || !quotaItem.resources) return h('span', { style: { color: '#999', fontSize: '12px' } }, '—');
    const aiResource = quotaItem.resources.find((r: any) => r.resource === 'ai_neurons');
    if (!aiResource) return h('span', { style: { color: '#999', fontSize: '12px' } }, '—');
    const exhausted = aiResource.exhausted;
    const pct = Math.min(100, Math.round(((aiResource.count || 0) / (aiResource.limit || 1)) * 100));
    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: '100px' } }, [
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px' } }, [
        h('span', { style: { fontSize: '12px', color: exhausted ? '#e03050' : '#666' } }, `${pct}%`),
        exhausted
          ? h(NTag, { size: 'small', type: 'error', bordered: false }, { default: () => t('accounts.table.exhausted') })
          : null,
      ].filter(Boolean)),
      h(NProgress, {
        type: 'line',
        percentage: pct,
        height: 6,
        showIndicator: false,
        status: exhausted ? 'error' : (pct > 90 ? 'warning' : 'success'),
      }),
    ]);
  }},
  {
    title: t('accounts.table.actions'), key: 'actions', width: 200, fixed: 'right',
    render: (row) => {
      const isExhausted = (() => {
        const quotaItem = accountStore.quota.find((q: any) => q.accountId === row.id);
        if (!quotaItem || !quotaItem.resources) return false;
        const aiResource = quotaItem.resources.find((r: any) => r.resource === 'ai_neurons');
        return aiResource?.exhausted;
      })();
      const moreOptions = [
        { label: t('accounts.table.viewCred'), key: 'cred', disabled: !!row.is_demo },
        { label: t('accounts.table.featureSwitch'), key: 'features', disabled: !!row.is_demo },
        ...(isWorkerPlatform.value ? [] : [{ label: t('accounts.table.setProxy'), key: 'proxy', disabled: !!row.is_demo }]),
        ...(isExhausted ? [{ label: t('accounts.table.clearExhausted'), key: 'clearExhausted', disabled: !!row.is_demo }] : []),
        { type: 'divider' as const, key: 'd' },
        { label: t('accounts.table.deleteAccount'), key: 'delete', disabled: !!row.is_demo, props: { style: 'color: var(--n-error-color)' } },
      ];
      return h(NSpace, { size: 4 }, {
        default: () => [
          h(NButton, { size: 'small', type: 'primary', ghost: true, disabled: row.is_demo, onClick: () => openAccountEditor(row) }, { default: () => t('common.edit') }),
          h(NButton, { size: 'small', onClick: () => handleTest(row) }, { default: () => t('common.test') }),
          h(NDropdown, { options: moreOptions, trigger: 'click', onSelect: (key: string) => handleActionMenu(key, row) }, {
            default: () => h(NButton, { size: 'small' }, { default: () => t('accounts.table.more') }),
          }),
        ],
      });
    },
  });
  return cols;
});

onMounted(async () => {
  accountStore.fetchAccounts();
  // 检测运行平台（Worker 平台不支持代理功能）与演示模式（禁用导出）
  try {
    const { data } = await settingsApi.get();
    isWorkerPlatform.value = data.platform === 'cloudflare-workers';
    isDemoMode.value = !!data.demo_account_ids;
  } catch { /* 忽略 */ }
});
</script>
