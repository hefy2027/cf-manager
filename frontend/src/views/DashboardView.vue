<template>
  <div class="dashboard-page">
    <n-space align="center" justify="space-between" style="width: 100%" :wrap="true">
      <n-space align="center">
        <n-h2 style="margin: 0">仪表盘</n-h2>
        <n-tag size="small" type="info">今日额度</n-tag>
      </n-space>
      <n-space align="center">
        <n-select
          v-model:value="sortBy"
          :options="sortOptions"
          style="width: 160px"
        />
        <n-input
          v-model:value="searchQuery"
          placeholder="搜索账户..."
          clearable
          style="width: 200px"
        />
      </n-space>
    </n-space>

    <n-space v-if="globalStats.totalAccounts > 0" style="margin: 12px 0; flex-shrink: 0" :wrap="true">
      <n-tag>{{ globalStats.totalAccounts }} 账户</n-tag>
      <n-tag v-if="globalStats.aiExhausted > 0" type="error">🤖 {{ globalStats.aiExhausted }}</n-tag>
      <n-tag v-if="globalStats.browserExhausted > 0" type="error">🖥️ {{ globalStats.browserExhausted }}</n-tag>
      <n-tag type="info">
        AI {{ formatCompact(globalStats.aiNeuronsTotal) }} · W {{ formatCompact(globalStats.workersRequestsTotal) }} · R {{ formatCompact(globalStats.browserRenderTotal) }}s
      </n-tag>
    </n-space>




      <n-spin :show="quotaStore.loading" style="flex-shrink: 0; width: 100%">
      <div class="card-grid-scroll" style="width: 100%" :style="{ maxHeight: isMobile ? '150px' : '200px' }">

        <n-grid
          v-if="quotaWithResources.length > 0"
          cols="1 s:2 m:5 l:6 xl:8"
          :x-gap="8"
          :y-gap="8"
          responsive="screen"
          style="width: 100%"
        >
        <n-gi v-for="acct in quotaWithResources" :key="acct.accountId">
          <CompactAccountCard :account-name="acct.accountName" :resources="acct.resources" />
        </n-gi>
      </n-grid>
      </div>
      <n-empty v-if="!quotaStore.loading && quotaWithResources.length === 0" description="暂无账户数据" />
    </n-spin>

    <n-h3 style="margin: 0; flex-shrink: 0">最近操作日志</n-h3>
    <n-space style="flex-shrink: 0" :wrap="true" align="center" :size="8">
      <n-select
        v-model:value="logFilter.action"
        :options="actionOptions"
        placeholder="操作类型"
        clearable
        filterable
        size="small"
        style="width: 160px"
      />
      <n-date-picker
        v-model:formatted-value="logFilter.startDate"
        type="date"
        value-format="yyyy-MM-dd"
        placeholder="开始日期"
        clearable
        size="small"
        style="width: 140px"
      />
      <n-date-picker
        v-model:formatted-value="logFilter.endDate"
        type="date"
        value-format="yyyy-MM-dd"
        placeholder="结束日期"
        clearable
        size="small"
        style="width: 140px"
      />
      <n-button size="small" type="primary" :loading="loadingLogs" @click="fetchLogs">查询</n-button>
    </n-space>
    <div class="log-table-wrapper" style="flex: 1; min-height: 0; overflow: auto">

        <n-data-table
        :columns="logColumns"
        :data="auditLogs"
        :loading="loadingLogs"
        size="small"
        :bordered="false"
        :scroll-x="scrollX"
        :flex-height="true"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, reactive } from 'vue';
import { useQuotaStore } from '../stores/quotaStore';
import apiClient from '../api/client';
import type { DataTableColumns } from 'naive-ui';
import { formatCN, formatCNShort } from '../utils/dateFormat';
import CompactAccountCard from '../components/CompactAccountCard.vue';

const quotaStore = useQuotaStore();
const searchQuery = ref('');
const sortBy = ref('name');
const windowWidth = ref(window.innerWidth);

function onResize() {
  windowWidth.value = window.innerWidth;
}

const sortOptions = [
  { label: '名称 A-Z', value: 'name' },
  { label: '名称 Z-A', value: 'name-desc' },
  { label: '使用率 高→低', value: 'usage-desc' },
  { label: '使用率 低→高', value: 'usage-asc' },
];

function getMaxUsage(account: any) {
  return Math.max(
    0,
    ...account.resources.map((r: any) => {
      if (!r.limit) return 0;
      return Math.min(100, Math.round(((r.count || 0) / r.limit) * 100));
    }),
  );
}

const quotaWithResources = computed(() => {
  let accounts = quotaStore.quota.filter(
    (acct: any) => acct.resources && acct.resources.length > 0,
  );

  if (searchQuery.value) {
    const query = searchQuery.value.toLowerCase();
    accounts = accounts.filter((acct: any) =>
      acct.accountName.toLowerCase().includes(query),
    );
  }

  accounts = [...accounts].sort((a: any, b: any) => {
    switch (sortBy.value) {
      case 'name':
        return a.accountName.localeCompare(b.accountName);
      case 'name-desc':
        return b.accountName.localeCompare(a.accountName);
      case 'usage-desc':
        return getMaxUsage(b) - getMaxUsage(a);
      case 'usage-asc':
        return getMaxUsage(a) - getMaxUsage(b);
      default:
        return 0;
    }
  });

  return accounts;
});

function formatCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'K';
  return n.toString();
}

const globalStats = computed(() => {
  const accounts = quotaStore.quota.filter(
    (acct: any) => acct.resources && acct.resources.length > 0,
  );
  const totalAccounts = accounts.length;

  const aiExhausted = accounts.filter((acct: any) =>
    acct.resources.some((r: any) => r.resource === 'ai_neurons' && r.exhausted),
  ).length;

  const browserExhausted = accounts.filter((acct: any) =>
    acct.resources.some((r: any) => r.resource === 'browser_render_seconds' && r.exhausted),
  ).length;

  const aiNeuronsTotal = accounts.reduce((sum: number, acct: any) => {
    const aiResource = acct.resources.find(
      (r: any) => r.resource === 'ai_neurons',
    );
    return sum + (aiResource?.count || 0);
  }, 0);

  const workersRequestsTotal = accounts.reduce((sum: number, acct: any) => {
    const w = acct.resources.find(
      (r: any) => r.resource === 'workers_requests',
    );
    return sum + (w?.count || 0);
  }, 0);

  const browserRenderTotal = accounts.reduce((sum: number, acct: any) => {
    const r = acct.resources.find(
      (r: any) => r.resource === 'browser_render_seconds',
    );
    return sum + (r?.count || 0);
  }, 0);

  return { totalAccounts, aiExhausted, browserExhausted, aiNeuronsTotal, workersRequestsTotal, browserRenderTotal };
});

const auditLogs = ref<any[]>([]);
const loadingLogs = ref(false);
const ACTION_LABELS: Record<string, string> = {
  ai_chat_completion: 'AI 对话',
  browser_render: '浏览器渲染',
  create_account: '创建账户',
  import_account: '导入账户',
  delete_account: '删除账户',
  update_features: '更新功能',
  test_account: '测试账户',
  view_credentials: '查看凭证',
  clear_exhausted: '清除耗尽',
  create_dns: '创建DNS',
  update_dns: '更新DNS',
  delete_dns: '删除DNS',
  deploy_worker: '部署Worker',
  delete_worker: '删除Worker',
  deploy_pages: '部署Pages',
  delete_pages: '删除Pages',
  batch_deploy: '批量部署',
  batch_deploy_pages: '批量部署Pages',
  env_sync: '环境同步',
  kv_write: 'KV操作',
  task_create: '创建任务',
  task_delete: '删除任务',
  task_run: '执行任务',
};
const actionOptions = Object.entries(ACTION_LABELS).map(([value, label]) => ({ label, value }));
function actionLabel(action: string): string {
  return ACTION_LABELS[action] || action;
}
const STATUS_LABELS: Record<string, string> = { success: '成功', error: '失败' };
function statusLabel(status: string): string {
  return STATUS_LABELS[status] || status;
}
const logFilter = reactive<{ action: string | null; startDate: string | null; endDate: string | null }>({
  action: null,
  startDate: null,
  endDate: null,
});

async function fetchLogs() {
  loadingLogs.value = true;
  try {
    const params: Record<string, string> = {};
    if (logFilter.action) params.action = logFilter.action;
    if (logFilter.startDate) params.startDate = logFilter.startDate;
    if (logFilter.endDate) params.endDate = logFilter.endDate;
    const { data } = await apiClient.get('/audit-log', { params });
    auditLogs.value = data;
  } catch {
    auditLogs.value = [];
  } finally {
    loadingLogs.value = false;
  }
}

const isMobile = computed(() => windowWidth.value < 640);

const logColumns = computed<DataTableColumns<any>>(() => {
  if (isMobile.value) {
    return [
      { title: '时间', key: 'created_at', width: 70, render: (row) => formatCNShort(row.created_at) },
      { title: '账号', key: 'account_name', width: 65, render: (row) => row.account_name || '-' },
      { title: '操作', key: 'action', width: 60, render: (row) => actionLabel(row.action) },
      { title: '目标', key: 'target', width: 85, ellipsis: { tooltip: true } },
      { title: '详情', key: 'detail', width: 70, minWidth: 60, ellipsis: { tooltip: true } },
      { title: '状态', key: 'status', width: 45, render: (row) => statusLabel(row.status) },
    ];
  }
  return [
    { title: '时间', key: 'created_at', width: 150, render: (row) => formatCN(row.created_at) },
    { title: '账号', key: 'account_name', width: 120, render: (row) => row.account_name || '-' },
    { title: '操作', key: 'action', width: 150, render: (row) => actionLabel(row.action) },
    { title: '目标', key: 'target', width: 150, ellipsis: { tooltip: true } },
    { title: '详情', key: 'detail', width: 180, minWidth: 120, ellipsis: { tooltip: true } },
    { title: '状态', key: 'status', width: 80, render: (row) => statusLabel(row.status) },
  ];
});

const scrollX = computed(() => {
  const colWidths = isMobile.value ? [70, 65, 60, 85, 70, 45] : [180, 120, 150, 150, 160, 80];
  return colWidths.reduce((a, b) => a + b, 0);
});



onMounted(async () => {
  window.addEventListener('resize', onResize);
  quotaStore.fetchQuota();
  await fetchLogs();
});

onUnmounted(() => {
  window.removeEventListener('resize', onResize);
});
</script>

<style scoped>
.dashboard-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  gap: 12px;
}

.log-table-wrapper {
  max-width: 100%;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  flex: 1;
  min-height: 0;
}

.card-grid-scroll {
  max-height: 200px;
  overflow-y: auto;
  scrollbar-gutter: stable;
  -webkit-overflow-scrolling: touch;
}

:global(.n-data-table) {
  height: 100% !important;
}

:global(.n-tooltip) {
  max-width: 400px !important;
  word-break: break-all;
}

</style>
