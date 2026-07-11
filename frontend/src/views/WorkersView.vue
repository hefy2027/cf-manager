<template>
  <div class="page-view">
    <n-space justify="space-between" align="center" :wrap="true">
      <n-h2 style="margin: 0">Workers & Pages 管理</n-h2>
      <n-space>
        <n-button size="small" @click="openBatchDeploy" :disabled="!workerStore.workers.length">批量部署</n-button>
        <n-button size="small" type="primary" @click="openDeploy()" :disabled="!accountStore.accounts.length">部署</n-button>
      </n-space>
    </n-space>

    <!-- 账户卡片：只显示有部署数量的账户，点击切换加载 -->
    <div class="card-grid-scroll" style="width: 100%">
      <n-grid v-if="accountCards.length" :x-gap="8" :y-gap="8" cols="1 s:2 m:4 l:6 xl:8" responsive="screen" style="width: 100%; margin-bottom: 12px;">
        <n-gi v-for="c in accountCards" :key="c.accountId">
          <n-popover trigger="click" placement="bottom" style="display: block; width: 100%;">
            <template #trigger>
              <div
                class="worker-compact-card"
                :class="{ 'worker-compact-card--active': c.accountId === workerStore.selectedAccountId }"
                @click="selectAccount(c.accountId)"
              >
                <span class="worker-compact-card__name" :title="c.accountName">{{ c.accountName }}</span>
                <n-progress
                  type="line"
                  :percentage="calcUsagePercentage(c)"
                  :height="6"
                  :show-indicator="false"
                  :status="calcUsagePercentage(c) > 90 ? 'error' : calcUsagePercentage(c) > 70 ? 'warning' : 'success'"
                  :style="{ flex: '1 1 0', minWidth: '24px', overflow: 'hidden' }"
                />
                <span class="worker-compact-card__metric">{{ formatNumber(c.requests) }}</span>
                <span class="worker-compact-card__count">{{ c.workerCount + c.pagesCount }}</span>
              </div>
            </template>
            <div style="min-width: 220px; padding: 4px 0;">
              <div style="font-weight: bold; margin-bottom: 10px;">{{ c.accountName }}</div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px;">
                <span>部署数 (W+P)</span><span>{{ c.workerCount }}W · {{ c.pagesCount }}P（{{ c.workerCount + c.pagesCount }}）</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px;">
                <span>请求数</span><span>{{ formatNumber(c.requests) }} / 100,000</span>
              </div>
              <n-progress type="line" :percentage="calcUsagePercentage(c)" :height="12" :show-indicator="false"
                :status="calcUsagePercentage(c) > 90 ? 'error' : calcUsagePercentage(c) > 70 ? 'warning' : 'success'" style="margin-bottom: 10px;" />
              <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px;">
                <span>错误</span><span>{{ formatNumber(c.errors) }}</span>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px;">
                <span>CPU 耗时</span><span>{{ formatCpuTime(c.cpuTimeMs) }}</span>
              </div>
              <div style="display: flex; justify-content: space-between; font-size: 13px;">
                <span>子请求</span><span>{{ formatNumber(c.subrequests) }}</span>
              </div>
            </div>
          </n-popover>
        </n-gi>
      </n-grid>
      <n-empty v-else description="暂无启用 Worker / Pages 的账户" />
    </div>

    <div class="table-scroll-wrapper">
      <n-data-table
        :columns="columns"
        :data="workerStore.workers"
        :loading="workerStore.loading"
        :max-height="600"
        :bordered="false"
        :scroll-x="700"
      />
    </div>

    <!-- 部署 Modal -->
    <n-modal v-model:show="showDeployModal" preset="dialog" title="部署" style="width: 500px; max-width: 95vw">
      <n-form :model="deployForm" label-placement="left" label-width="100">
        <n-form-item label="部署类型">
          <n-radio-group v-model:value="deployType">
            <n-radio value="worker">Worker</n-radio>
            <n-radio value="pages">Pages</n-radio>
          </n-radio-group>
        </n-form-item>
        <n-form-item label="账号">
          <n-select v-model:value="deployForm.accountId" :options="accountOptions" :disabled="isRedeploy" />
        </n-form-item>
        <n-form-item label="名称">
          <n-input v-model:value="deployForm.name" :placeholder="deployType === 'pages' ? 'Pages 项目名称' : 'Worker 名称'" :disabled="isRedeploy" />
        </n-form-item>
        <template v-if="deployType === 'worker'">
          <n-form-item label="部署方式">
            <n-radio-group v-model:value="deploySource">
              <n-radio value="file">本地文件</n-radio>
              <n-radio value="url">URL 地址</n-radio>
            </n-radio-group>
          </n-form-item>
          <n-form-item v-if="deploySource === 'file'" label="脚本文件">
            <n-upload :max="1" :default-upload="false" @change="handleFileChange" accept=".js">
              <n-button>选择 .js 文件</n-button>
            </n-upload>
          </n-form-item>
          <n-form-item v-else label="JS URL">
            <n-input v-model:value="deployUrl" placeholder="https://example.com/worker.js" />
          </n-form-item>
        </template>
        <n-form-item v-else label="静态文件">
          <n-upload :max="1" :default-upload="false" @change="handleZipChange" accept=".zip">
            <n-button>选择 .zip 文件</n-button>
          </n-upload>
          <span v-if="selectedZipFile" style="margin-left: 8px; font-size: 12px; color: #999">{{ selectedZipFile.name }}</span>
          <n-text v-else-if="!isRedeploy" depth="3" style="margin-left: 8px; font-size: 12px">不选则创建空项目</n-text>
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showDeployModal = false">取消</n-button>
        <n-button type="primary" :loading="deploying" @click="handleDeploy">部署</n-button>
      </template>
    </n-modal>

    <!-- 日志 Drawer -->
    <n-drawer v-model:show="showLogDrawer" :width="drawerWidth(520)" placement="right">
      <n-drawer-content :title="`日志 - ${currentWorkerName}`" closable>
        <n-code :code="logContent" language="text" :word-wrap="true" />
        <n-empty v-if="!logContent && !logLoading" description="暂无日志" />
        <n-spin v-if="logLoading" style="display: block; text-align: center; margin: 40px auto" />
      </n-drawer-content>
    </n-drawer>

    <!-- 设置抽屉（Worker / Pages 拆分到子组件） -->
    <WorkerSettingsDrawer
      v-if="settingsWorker && settingsWorker.type === 'worker'"
      v-model:show="showSettingsDrawer"
      :worker="settingsWorker"
    />
    <WorkerPagesSettingsDrawer
      v-else-if="settingsWorker && settingsWorker.type === 'pages'"
      v-model:show="showSettingsDrawer"
      :worker="settingsWorker"
    />

    <!-- 批量部署 Modal -->
    <n-modal v-model:show="showBatchDeployModal" preset="dialog" title="批量部署" style="width: 650px; max-width: 95vw">
      <n-form label-placement="left" label-width="100">
        <n-form-item label="部署类型">
          <n-radio-group v-model:value="batchType" @update:value="batchTargets = []">
            <n-radio value="worker">Worker</n-radio>
            <n-radio value="pages">Pages</n-radio>
          </n-radio-group>
        </n-form-item>
        <n-form-item :label="batchType === 'worker' ? '目标 Workers' : '目标 Pages'">
          <n-checkbox-group v-model:value="batchTargets">
            <n-space vertical>
              <n-checkbox v-for="w in workerStore.workers.filter((w: any) => w.type === batchType)" :key="`${w.cfAccountId}-${w.name}`" :value="`${w.cfAccountId}:${w.name}`">
                {{ w.accountName }} / {{ w.name }}
              </n-checkbox>
              <n-text v-if="!workerStore.workers.filter((w: any) => w.type === batchType).length" depth="3">暂无可用的 {{ batchType === 'worker' ? 'Worker' : 'Pages' }}</n-text>
            </n-space>
          </n-checkbox-group>
        </n-form-item>
        <template v-if="batchType === 'worker'">
          <n-form-item label="脚本来源">
            <n-radio-group v-model:value="batchSource">
              <n-radio value="file">文件上传</n-radio>
              <n-radio value="url">URL</n-radio>
            </n-radio-group>
          </n-form-item>
          <n-form-item v-if="batchSource === 'file'" label="脚本文件">
            <n-upload :max="1" @change="({ file }: any) => batchFile = file.file || null"><n-button size="small">选择 .js 文件</n-button></n-upload>
          </n-form-item>
          <n-form-item v-else label="脚本 URL">
            <n-input v-model:value="batchUrl" placeholder="https://example.com/worker.js" />
          </n-form-item>
        </template>
        <template v-else>
          <n-form-item label="静态文件">
            <n-upload :max="1" @change="({ file }: any) => batchFile = file.file || null" accept=".zip"><n-button size="small">选择 .zip 文件</n-button></n-upload>
          </n-form-item>
        </template>
      </n-form>
      <div v-if="batchResults.length" style="margin-top: 12px">
        <n-tag v-for="r in batchResults" :key="`${r.accountId}-${r.workerName}`" :type="r.success ? 'success' : 'error'" size="small" style="margin: 2px">
          {{ r.workerName }}: {{ r.success ? '成功' : r.error }}
        </n-tag>
      </div>
      <template #action>
        <n-button @click="showBatchDeployModal = false">关闭</n-button>
        <n-button type="primary" :loading="batchDeploying" @click="handleBatchDeploy" :disabled="!batchTargets.length">部署</n-button>
      </template>
    </n-modal>

  </div>
</template>

<script setup lang="ts">
import { ref, h, computed, onMounted } from 'vue';
import { NButton, NSpace, NTag, useMessage, NRadio, NRadioGroup, NPopconfirm } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { useWorkerStore } from '../stores/workerStore';
import { useAccountStore } from '../stores/accountStore';
import { accountsApi } from '../api/accounts';
import { workersApi } from '../api/workers';
import { formatCN } from '../utils/dateFormat';
import { loadDemoAccounts, isDemoAccount } from '../utils/demoAccounts';
import WorkerSettingsDrawer from '../components/WorkerSettingsDrawer.vue';
import WorkerPagesSettingsDrawer from '../components/WorkerPagesSettingsDrawer.vue';

const workerStore = useWorkerStore();
const accountStore = useAccountStore();
const message = useMessage();

function drawerWidth(desktopWidth: number): number {
  return window.innerWidth <= 768 ? Math.min(window.innerWidth, desktopWidth) : desktopWidth;
}

// ============ 账户卡片（显示所有启用 workers 功能的账户，统计常驻可见） ============
const accountCards = computed(() => workerStore.summary || []);
function selectAccount(accountId: number) {
  workerStore.selectedAccountId = accountId;
  workerStore.fetchWorkers(accountId);
}
const FREE_DAILY_LIMIT = 100000;

function calcUsagePercentage(u: { requests: number }) {
  return Math.min(100, Math.round((u.requests / FREE_DAILY_LIMIT) * 100));
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatCpuTime(ms: number): string {
  if (!ms) return '0ms';
  if (ms >= 1000000) return (ms / 1000000).toFixed(1) + 'Ks';
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return ms.toLocaleString() + 'ms';
}

// Deploy state
const showDeployModal = ref(false);
const deployType = ref<'worker' | 'pages'>('worker');
const deploying = ref(false);
const showLogDrawer = ref(false);
const logContent = ref('');
const logLoading = ref(false);
const currentWorkerName = ref('');
const selectedFile = ref<File | null>(null);
const selectedZipFile = ref<File | null>(null);
const deployForm = ref({ accountId: null as number | null, name: '' });
const deploySource = ref<'file' | 'url'>('file');
const deployUrl = ref('');

// 设置抽屉（具体逻辑拆分到 WorkerSettingsDrawer / WorkerPagesSettingsDrawer 子组件）
const settingsWorker = ref<any>(null);
const showSettingsDrawer = ref(false);
function openSettings(row: any) {
  settingsWorker.value = row;
  showSettingsDrawer.value = true;
}

const accountOptions = computed(() =>
  allAccounts.value
    .filter((a: any) => a.is_active && (a.enabled_features || 'ai,workers,browser_render,dns,storage').includes('workers'))
    .map((a: any) => ({ label: a.name, value: a.id }))
);

// 部署对话框需要全部账户（不分页），accountStore.accounts 仅含当前页
const allAccounts = ref<any[]>([]);
async function loadAllAccounts() {
  try {
    const { data } = await accountsApi.getAll({ pageSize: 10000 });
    allAccounts.value = data.accounts || [];
  } catch { allAccounts.value = []; }
}

// ============ Deploy ============
const isRedeploy = ref(false);
function openDeploy(type?: 'worker' | 'pages', prefillName?: string, prefillAccountId?: number) {
  deployType.value = type || 'worker';
  selectedFile.value = null;
  selectedZipFile.value = null;
  deploySource.value = 'file';
  deployUrl.value = '';
  isRedeploy.value = !!prefillName;
  deployForm.value = {
    accountId: prefillAccountId || accountStore.accounts[0]?.id || null,
    name: prefillName || '',
  };
  showDeployModal.value = true;
}

function handleFileChange({ file }: any) { selectedFile.value = file.file || null; }
function handleZipChange({ file }: any) { selectedZipFile.value = file.file || null; }
async function handleDeploy() {
  if (!deployForm.value.accountId || !deployForm.value.name) { message.warning('请填写完整信息'); return; }
  if (deployType.value === 'worker' && deploySource.value === 'file' && !selectedFile.value) { message.warning('请选择脚本文件'); return; }
  if (deployType.value === 'worker' && deploySource.value === 'url' && !deployUrl.value) { message.warning('请输入 JS URL'); return; }
  if (deployType.value === 'pages' && isRedeploy.value && !selectedZipFile.value) { message.warning('重新部署必须上传 ZIP 文件'); return; }
  deploying.value = true;
  try {
    if (deployType.value === 'worker') {
      if (deploySource.value === 'url') {
        await workersApi.deployFromUrl(deployForm.value.accountId, deployForm.value.name, deployUrl.value);
      } else {
        await workersApi.deploy(deployForm.value.accountId, deployForm.value.name, selectedFile.value!);
      }
      message.success('Worker 部署成功');
    } else {
      const files = selectedZipFile.value ? [selectedZipFile.value] : [];
      await workersApi.deployPages(deployForm.value.accountId, deployForm.value.name, files, isRedeploy.value);
      message.success(selectedZipFile.value ? 'Pages 部署成功' : 'Pages 项目创建成功');
    }
    showDeployModal.value = false;
    workerStore.fetchWorkers();
  } finally { deploying.value = false; }
}

// ============ Logs ============
async function handleViewLogs(row: any) {
  currentWorkerName.value = row.name;
  showLogDrawer.value = true;
  logLoading.value = true;
  logContent.value = '';
  try {
    const { data } = await workersApi.getLogs(row.cfAccountId || row.account_id, row.name);
    logContent.value = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  } catch (e: any) {
    logContent.value = '获取日志失败: ' + (e?.errorMessage || e?.message || '未知错误');
  } finally { logLoading.value = false; }
}

// ============ Delete ============
async function handleDelete(row: any) {
  if (row.type === 'pages') await workersApi.deletePages(row.cfAccountId, row.name);
  else await workersApi.delete(row.cfAccountId, row.name);
  message.success(row.type === 'pages' ? 'Pages 项目已删除' : 'Worker 已删除');
  workerStore.fetchWorkers();
}

// ============ Table Columns ============
const columns = computed<DataTableColumns<any>>(() => {
  const hasModifiedOn = workerStore.workers.some((w: any) => w.modified_on);
  const cols: DataTableColumns<any> = [
    { title: '类型', key: 'type', width: 80, render: (row) => h(NTag, { size: 'small', type: row.type === 'pages' ? 'info' : 'success' }, { default: () => row.type === 'pages' ? 'Pages' : 'Worker' }) },
    { title: '名称', key: 'name', width: 180 },
    { title: '账号', key: 'accountName', width: 120, render: (row) => row.accountName || row.cfAccountId },
    { title: '状态', key: 'status', width: 100, render: (row) => h(NTag, { size: 'small', type: row.status === 'deployed' || row.status === 'enabled' ? 'success' : 'default' }, { default: () => row.status || (row.type === 'pages' ? 'active' : '已部署') }) },
  ];
  if (hasModifiedOn) {
    cols.push({ title: '修改时间', key: 'modified_on', width: 180, render: (row) => row.modified_on ? formatCN(row.modified_on) : '-' });
  }
  cols.push({
    title: '操作', key: 'actions', width: 280,
    render: (row) => h(NSpace, null, {
      default: () => [
        h(NButton, { size: 'small', type: 'success', onClick: () => openDeploy(row.type, row.name, row.cfAccountId) }, { default: () => '部署' }),
        h(NButton, { size: 'small', onClick: () => openSettings(row) }, { default: () => '设置' }),
        ...(row.type === 'worker' ? [
          h(NButton, { size: 'small', onClick: () => handleViewLogs(row) }, { default: () => '日志' }),
        ] : []),
        ...(isDemoAccount(row.cfAccountId) ? [] : [
          h(NPopconfirm, {
            positiveText: '删除',
            negativeText: '取消',
            positiveButtonProps: { type: 'error' },
            onPositiveClick: () => handleDelete(row),
          }, {
            trigger: () => h(NButton, { size: 'small', type: 'error' }, { default: () => '删除' }),
            default: () => `确认删除 ${row.type === 'pages' ? 'Pages 项目' : 'Worker'}「${row.name}」？此操作不可恢复。`,
          }),
        ]),
      ],
    }),
  });
  return cols;
});

// ============ Batch Deploy ============
const showBatchDeployModal = ref(false);
const batchType = ref<'worker' | 'pages'>('worker');
const batchTargets = ref<string[]>([]);
const batchSource = ref<'file' | 'url'>('file');
const batchFile = ref<File | null>(null);
const batchUrl = ref('');
const batchDeploying = ref(false);
const batchResults = ref<any[]>([]);

function openBatchDeploy() {
  batchType.value = workerStore.workers.some((w: any) => w.type === 'worker') ? 'worker' : 'pages';
  batchTargets.value = [];
  batchFile.value = null;
  batchUrl.value = '';
  batchResults.value = [];
  showBatchDeployModal.value = true;
}

async function handleBatchDeploy() {
  const targets = batchTargets.value.map(t => {
    const [accountId, workerName] = t.split(':');
    return { accountId: Number(accountId), workerName };
  });
  batchDeploying.value = true;
  try {
    if (batchType.value === 'worker') {
      const { data } = await workersApi.batchDeploy(targets, batchFile.value || undefined, batchSource.value === 'url' ? batchUrl.value : undefined);
      batchResults.value = Array.isArray(data) ? data : [];
    } else {
      if (!batchFile.value) { message.warning('请选择 zip 文件'); return; }
      const { data } = await workersApi.batchDeployPages(targets, batchFile.value);
      batchResults.value = Array.isArray(data) ? data : [];
    }
    const successCount = batchResults.value.filter((r: any) => r.success).length;
    message.success(`批量部署完成: ${successCount}/${targets.length} 成功`);
    workerStore.fetchWorkers();
  } finally { batchDeploying.value = false; }
}

onMounted(async () => {
  await loadDemoAccounts();
  accountStore.fetchAccounts();
  loadAllAccounts();
  await workerStore.fetchSummary();
  const list = workerStore.summary || [];
  // 默认优先加载第一个有部署数量的账户；都没有则加载第一个账户；若没有任何账户则加载全部
  const firstDeployed = list.find((c: any) => (c.workerCount || 0) + (c.pagesCount || 0) > 0);
  if (firstDeployed) selectAccount(firstDeployed.accountId);
  else if (list.length) selectAccount(list[0].accountId);
  else workerStore.fetchWorkers();
});
</script>

<style scoped>
.worker-compact-card {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  height: 28px;
  padding: 0 8px;
  border: 1px solid #e0e0e6;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
  background-color: #fff;
  box-sizing: border-box;
}
.worker-compact-card:hover { background-color: #f5f5f5; }
.worker-compact-card__count {
  font-size: 10px;
  color: #999;
  font-weight: 500;
  flex-shrink: 0;
  white-space: nowrap;
}
.worker-compact-card--active {
  background-color: #e8f0fe;
  border-color: #4098fc;
}
.worker-compact-card__name {
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 0 1 auto;
  min-width: 0;
}
.worker-compact-card__metric {
  font-size: 11px;
  color: #333;
  font-weight: 500;
  flex-shrink: 0;
  white-space: nowrap;
  min-width: 32px;
  text-align: right;
}

.table-scroll-wrapper {
  max-width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.card-grid-scroll {
  max-height: 200px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  -webkit-overflow-scrolling: touch;
}

@media (max-width: 768px) {
  .worker-compact-card {
    width: 100%;
    min-width: 100px;
  }
  .worker-compact-card__name {
    min-width: 0;
  }
  .worker-compact-card__metric {
    font-size: 10px;
  }
}
</style>
