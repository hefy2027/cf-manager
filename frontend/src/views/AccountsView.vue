<template>
  <div class="page-view">
    <n-space justify="space-between" align="center">
      <n-h2>账号管理</n-h2>
      <n-space>
        <n-button @click="showImportModal = true">导入 CSV</n-button>
        <n-button type="primary" @click="showAddModal = true">添加账号</n-button>
      </n-space>
    </n-space>

    <n-space align="center" :size="12" style="margin: 12px 0;">
      <n-button-group size="small">
        <n-button :type="accountStore.filter === 'all' ? 'primary' : 'default'" @click="handleFilterChange('all')">全部 ({{ accountStore.counts.all }})</n-button>
        <n-button :type="accountStore.filter === 'active' ? 'primary' : 'default'" @click="handleFilterChange('active')">活跃 ({{ accountStore.counts.active }})</n-button>
        <n-button :type="accountStore.filter === 'unverified' ? 'primary' : 'default'" @click="handleFilterChange('unverified')">未验证 ({{ accountStore.counts.unverified }})</n-button>
      </n-button-group>
      <n-button
        size="small"
        type="warning"
        :loading="batchTesting"
        :disabled="accountStore.filter === 'unverified' && accountStore.counts.unverified === 0"
        @click="handleTestBatch"
      >
        批量测试{{ accountStore.filter === 'unverified' ? '未验证' : '全部' }}账户
      </n-button>
      <n-input
        v-model:value="searchInput"
        size="small"
        placeholder="搜索名称/邮箱"
        clearable
        style="width: 200px;"
        @update:value="handleSearchInput"
      />
    </n-space>

    <n-data-table
      :columns="columns"
      :data="accountStore.accounts"
      :loading="accountStore.loading"
      :bordered="false"
      :scroll-x="700"
      :pagination="paginationConfig"
      :remote="true"
      :row-key="(row: any) => row.id"
    />

    <n-modal v-model:show="showAddModal" preset="dialog" title="添加账号" style="width: 500px; max-width: 95vw">
      <n-form :model="form" label-placement="left" label-width="100">
        <n-form-item label="名称">
          <n-input v-model:value="form.name" placeholder="账号名称" />
        </n-form-item>
        <n-form-item label="认证类型">
          <n-select v-model:value="form.auth_type" :options="authTypeOptions" />
        </n-form-item>
        <n-form-item v-if="form.auth_type === 'token'" label="API Token">
          <n-input v-model:value="form.api_token" type="password" show-password-on="click" placeholder="Cloudflare API Token" />
        </n-form-item>
        <n-form-item v-if="form.auth_type === 'global_key'" label="API Key">
          <n-input v-model:value="form.api_key" type="password" show-password-on="click" placeholder="Cloudflare API Key" />
        </n-form-item>
        <n-form-item v-if="form.auth_type === 'global_key'" label="Email">
          <n-input v-model:value="form.email" placeholder="Cloudflare 账号邮箱" />
        </n-form-item>
        <n-form-item label="启用功能">
          <n-checkbox-group v-model:value="form.features">
            <n-space>
              <n-checkbox v-for="f in featureOptions" :key="f.value" :value="f.value" :label="f.label" />
            </n-space>
          </n-checkbox-group>
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showAddModal = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="handleAdd">提交</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="showFeatureModal" preset="dialog" title="编辑功能开关" style="width: 400px; max-width: 95vw">
      <n-checkbox-group v-model:value="editFeatures">
        <n-space vertical>
          <n-checkbox v-for="f in featureOptions" :key="f.value" :value="f.value" :label="f.label" />
        </n-space>
      </n-checkbox-group>
      <template #action>
        <n-button @click="showFeatureModal = false">取消</n-button>
        <n-button type="primary" :loading="submitting" @click="handleSaveFeatures">保存</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="showImportModal" preset="dialog" title="导入 CSV" style="width: 700px; max-width: 95vw">
      <n-space vertical :size="16">
        <n-alert type="info" :bordered="false">
          CSV 表头须包含 <n-text code>email</n-text> 和 <n-text code>apiKey</n-text>（可选 <n-text code>password</n-text>）。
          系统会按邮箱去重；账户名自动从邮箱提取（如 lauren.bailey2701@xx → bailey2701）；单个账户错误不影响其他账户导入。
        </n-alert>
        <n-upload
          :max="1"
          accept=".csv,text/csv,text/plain"
          :default-upload="false"
          :show-file-list="true"
          v-model:file-list="importFileList"
        >
          <n-button>选择 CSV 文件</n-button>
        </n-upload>
        <n-checkbox v-model:checked="skipVerify">
          跳过凭证验证（秒级完成，后续逐个「测试」激活；适合大批量导入）
        </n-checkbox>
        <n-alert v-if="importing" type="info" :bordered="false">
          正在处理中，请耐心等待…（并发批处理，每批 5 条；跳过验证时每批 20 条）
        </n-alert>
        <n-space v-if="importResult">
          <n-statistic label="总计" :value="importResult.summary.total" />
          <n-statistic label="成功" :value="importResult.summary.success" />
          <n-statistic label="跳过" :value="importResult.summary.skipped" />
          <n-statistic label="失败" :value="importResult.summary.error" />
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
        <n-button @click="closeImportModal">关闭</n-button>
        <n-button type="primary" :loading="importing" :disabled="!importFile" @click="handleImport">开始导入</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="showBatchResultModal" preset="dialog" title="批量测试结果" style="width: 700px; max-width: 95vw">
      <n-space vertical :size="16">
        <n-space>
          <n-statistic label="总计" :value="batchResult?.summary.total ?? 0" />
          <n-statistic label="成功" :value="batchResult?.summary.success ?? 0" />
          <n-statistic label="失败" :value="batchResult?.summary.error ?? 0" />
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
        <n-button type="primary" @click="showBatchResultModal = false">关闭</n-button>
      </template>
    </n-modal>

    <n-modal v-model:show="showCredModal" preset="dialog" title="查看 API 凭证" style="width: 560px; max-width: 95vw">
      <n-spin :show="credLoading">
        <n-space vertical :size="12" v-if="credData">
          <n-alert type="warning" :bordered="false">
            凭证信息敏感，请勿泄露。每次查看都会记录审计日志。
          </n-alert>
          <n-descriptions label-placement="left" bordered :column="1" size="small">
            <n-descriptions-item label="名称">{{ credData.name }}</n-descriptions-item>
            <n-descriptions-item label="Account ID">
              <n-text :style="{ fontFamily: 'monospace' }">{{ credData.account_id || '-' }}</n-text>
            </n-descriptions-item>
            <n-descriptions-item label="认证类型">
              <n-tag size="small" :type="credData.auth_type === 'token' ? 'info' : 'warning'">
                {{ credData.auth_type === 'token' ? 'API Token' : 'API Key + Email' }}
              </n-tag>
            </n-descriptions-item>
            <n-descriptions-item v-if="credData.auth_type === 'global_key'" label="Email">
              {{ credData.email || '-' }}
            </n-descriptions-item>
            <n-descriptions-item v-if="credData.auth_type === 'token'" label="API Token">
              <n-input
                :value="credData.api_token || ''"
                type="password"
                show-password-on="click"
                readonly
                :style="{ fontFamily: 'monospace' }"
              />
            </n-descriptions-item>
            <n-descriptions-item v-if="credData.auth_type === 'global_key'" label="API Key">
              <n-input
                :value="credData.api_key || ''"
                type="password"
                show-password-on="click"
                readonly
                :style="{ fontFamily: 'monospace' }"
              />
            </n-descriptions-item>
            <n-descriptions-item v-if="credData.password" label="登录密码">
              <n-input
                :value="credData.password"
                type="password"
                show-password-on="click"
                readonly
                :style="{ fontFamily: 'monospace' }"
              />
            </n-descriptions-item>
          </n-descriptions>
        </n-space>
      </n-spin>
      <template #action>
        <n-button @click="showCredModal = false">关闭</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, h, computed, onMounted } from 'vue';
import { NButton, NSpace, NProgress, NTag, useMessage } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import type { UploadFileInfo } from 'naive-ui';
import { useAccountStore } from '../stores/accountStore';

const accountStore = useAccountStore();
const message = useMessage();
const showAddModal = ref(false);
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
const editingAccountId = ref<number | null>(null);
const editFeatures = ref<string[]>([]);
const searchInput = ref('');

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
  password: string | null;
} | null>(null);

async function handleViewCredentials(row: any) {
  showCredModal.value = true;
  credLoading.value = true;
  credData.value = null;
  try {
    credData.value = await accountStore.getCredentials(row.id);
  } catch (e: any) {
    message.error(`获取凭证失败：${e?.message || e}`);
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
  prefix: ({ itemCount }: any) => `共 ${itemCount} 条`,
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

const featureOptions = [
  { label: 'Workers AI', value: 'ai' },
  { label: 'Workers / Pages', value: 'workers' },
  { label: '浏览器渲染', value: 'browser_render' },
  { label: 'DNS 管理', value: 'dns' },
  { label: '存储管理', value: 'storage' },
];

const featureLabelMap: Record<string, string> = {
  ai: 'AI',
  workers: 'Workers',
  browser_render: '浏览器',
  dns: 'DNS',
  storage: '存储',
};

const form = ref({
  name: '',
  auth_type: 'token',
  api_token: '',
  api_key: '',
  email: '',
  features: ['ai', 'workers', 'browser_render', 'dns', 'storage'] as string[],
});

const authTypeOptions = [
  { label: 'API Token', value: 'token' },
  { label: 'API Key + Email', value: 'global_key' },
];

function resetForm() {
  form.value = { name: '', auth_type: 'token', api_token: '', api_key: '', email: '', features: ['ai', 'workers', 'browser_render', 'dns', 'storage'] };
}

async function handleAdd() {
  if (!form.value.name) {
    message.warning('请输入账号名称');
    return;
  }
  submitting.value = true;
  try {
    const { features, ...rest } = form.value;
    await accountStore.createAccount({ ...rest, enabled_features: features.join(',') });
    message.success('账号添加成功');
    showAddModal.value = false;
    resetForm();
  } finally {
    submitting.value = false;
  }
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
    message.success('功能开关已更新');
    showFeatureModal.value = false;
  } finally {
    submitting.value = false;
  }
}

async function handleTest(row: any) {
  await accountStore.testAccount(row.id);
  message.success('连接测试成功');
}

async function handleClearExhausted(row: any) {
  try {
    await accountStore.clearExhausted(row.id);
    message.success('已清除 AI 配额耗尽标记');
  } catch (e: any) {
    message.error(`清除失败：${e?.message || e}`);
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
    message.success(`批量测试完成：成功 ${s.success}，失败 ${s.error}`);
  } catch (e: any) {
    message.error(`批量测试失败：${e?.message || e}`);
  } finally {
    batchTesting.value = false;
  }
}

const batchResultColumns: DataTableColumns<any> = [
  { title: 'ID', key: 'id', width: 60 },
  { title: '名称', key: 'name', width: 150 },
  {
    title: '结果', key: 'status', width: 90,
    render: (row) => {
      const map: Record<string, { type: any; text: string }> = {
        success: { type: 'success', text: '成功' },
        error: { type: 'error', text: '失败' },
      };
      const m = map[row.status] || { type: 'default', text: row.status };
      return h(NTag, { size: 'small', type: m.type, bordered: false }, { default: () => m.text });
    },
  },
  { title: '说明', key: 'message', width: 180, minWidth: 100, ellipsis: { tooltip: true }, render: (row) => row.message || '-' },
];

async function handleDelete(row: any) {
  await accountStore.deleteAccount(row.id);
  message.success('已删除');
}

function closeImportModal() {
  showImportModal.value = false;
  importFileList.value = [];
  importResult.value = null;
  skipVerify.value = false;
}

async function handleImport() {
  if (!importFile.value) {
    message.warning('请选择 CSV 文件');
    return;
  }
  importing.value = true;
  importResult.value = null;
  try {
    const result = await accountStore.importCsv(importFile.value, skipVerify.value);
    importResult.value = result;
    const s = result.summary;
    message.success(`导入完成：成功 ${s.success}，跳过 ${s.skipped}，失败 ${s.error}${skipVerify.value ? '（已跳过验证，请逐个测试激活）' : ''}`);
  } finally {
    importing.value = false;
  }
}

const importResultColumns: DataTableColumns<any> = [
  { title: '邮箱', key: 'email', width: 220, ellipsis: { tooltip: true } },
  { title: '账户名', key: 'name', width: 140 },
  {
    title: '结果', key: 'status', width: 90,
    render: (row) => {
      const map: Record<string, { type: any; text: string }> = {
        success: { type: 'success', text: '成功' },
        skipped: { type: 'warning', text: '跳过' },
        error: { type: 'error', text: '失败' },
      };
      const m = map[row.status] || { type: 'default', text: row.status };
      return h(NTag, { size: 'small', type: m.type, bordered: false }, { default: () => m.text });
    },
  },
  { title: '说明', key: 'message', width: 180, minWidth: 100, ellipsis: { tooltip: true }, render: (row) => row.message || '-' },
];

function parseFeatures(raw: string | undefined): string[] {
  return (raw || 'ai,workers,browser_render,dns,storage').split(',').filter(Boolean);
}

const columns: DataTableColumns<any> = [
  { title: 'ID', key: 'id', width: 60 },
  { title: '名称', key: 'name', width: 150 },
  { title: 'Account ID', key: 'account_id', width: 180, ellipsis: { tooltip: true }, render: (row) => row.account_id || '-' },
  { title: '认证类型', key: 'auth_type', width: 120, render: (row) => h(NTag, { size: 'small', type: row.auth_type === 'token' ? 'info' : 'warning' }, { default: () => row.auth_type === 'token' ? 'Token' : 'Key' }) },
  {
    title: '功能', key: 'enabled_features', width: 200,
    render: (row) => {
      const features = parseFeatures(row.enabled_features);
      return h(NSpace, { size: 4 }, {
        default: () => features.map(f =>
          h(NTag, { size: 'small', type: 'success', bordered: false }, { default: () => featureLabelMap[f] || f })
        ),
      });
    },
  },
  { title: '状态', key: 'is_active', width: 80, render: (row) => {
    if (row.is_demo) {
      return h(NTag, { size: 'small', type: 'warning', bordered: false }, { default: () => '演示' });
    }
    return h(NTag, { size: 'small', type: row.is_active ? 'success' : 'default' }, { default: () => row.is_active ? '活跃' : '未验证' });
  }},
  { title: 'AI 配额', key: 'aiQuota', width: 160, render: (row) => {
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
          ? h(NTag, { size: 'small', type: 'error', bordered: false }, { default: () => '已耗尽' })
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
    title: '操作', key: 'actions', width: 300,
    render: (row) => {
      const isExhausted = (() => {
        const quotaItem = accountStore.quota.find((q: any) => q.accountId === row.id);
        if (!quotaItem || !quotaItem.resources) return false;
        const aiResource = quotaItem.resources.find((r: any) => r.resource === 'ai_neurons');
        return aiResource?.exhausted;
      })();
      return h(NSpace, { size: 4 }, {
        default: () => [
          row.is_demo
            ? null
            : h(NButton, { size: 'small', type: 'info', ghost: true, onClick: () => handleViewCredentials(row) }, { default: () => '查看Key' }),
          h(NButton, { size: 'small', disabled: row.is_demo, onClick: () => openFeatureEditor(row) }, { default: () => '功能' }),
          h(NButton, { size: 'small', onClick: () => handleTest(row) }, { default: () => '测试' }),
          isExhausted
            ? h(NButton, { size: 'small', type: 'warning', disabled: row.is_demo, onClick: () => handleClearExhausted(row) }, { default: () => '清除耗尽' })
            : null,
          h(NButton, { size: 'small', type: 'error', disabled: row.is_demo, onClick: () => handleDelete(row) }, { default: () => '删除' }),
        ].filter(Boolean),
      });
    },
  },
];

onMounted(() => {
  accountStore.fetchAccounts();
});
</script>
