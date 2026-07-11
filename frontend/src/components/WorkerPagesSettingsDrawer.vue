<template>
  <n-drawer v-model:show="visible" :width="drawerWidth(860)" placement="right">
    <n-drawer-content :title="`设置 - ${workerName} (pages)`" closable>
      <n-tabs type="line" animated>
        <!-- Pages 项目信息 -->
        <n-tab-pane name="pagesInfo" tab="项目信息">
          <n-space vertical>
            <n-text depth="3">Pages 项目基本信息</n-text>
            <n-spin :show="pagesProjectLoading">
              <n-card size="small" v-if="pagesProject">
                <n-descriptions label-placement="left" :column="1" bordered>
                  <n-descriptions-item label="名称">{{ pagesProject.name }}</n-descriptions-item>
                  <n-descriptions-item label="ID">{{ pagesProject.id }}</n-descriptions-item>
                  <n-descriptions-item label="生产分支">{{ pagesProject.production_branch }}</n-descriptions-item>
                  <n-descriptions-item label="框架">{{ pagesProject.framework || '-' }}</n-descriptions-item>
                  <n-descriptions-item label="子域名">{{ pagesProject.subdomain || '-' }}</n-descriptions-item>
                  <n-descriptions-item label="创建时间">{{ pagesProject.created_on ? formatCN(pagesProject.created_on) : '-' }}</n-descriptions-item>
                  <n-descriptions-item label="Functions">{{ pagesProject.uses_functions ? '是' : '否' }}</n-descriptions-item>
                </n-descriptions>
              </n-card>
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Pages 自定义域名 -->
        <n-tab-pane name="pagesDomains" tab="自定义域名">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">绑定自定义域名到 Pages 项目</n-text>
              <n-button size="small" type="primary" @click="openPagesDomainModal">添加域名</n-button>
            </n-space>
            <n-spin :show="pagesDomainsLoading">
              <n-data-table :columns="pagesDomainColumns" :data="pagesDomains" :bordered="false" size="small" :scroll-x="500" />
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Pages 环境变量 -->
        <n-tab-pane name="pagesEnvVars" tab="环境变量">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">生产环境变量</n-text>
              <n-button size="small" type="primary" @click="pagesEnvEditing = false; pagesEnvForm = { name: '', value: '', type: 'plain_text' }; showPagesEnvModal = true">添加变量</n-button>
            </n-space>
            <n-spin :show="pagesProjectLoading">
              <n-data-table :columns="pagesEnvColumns" :data="pagesEnvVars" :bordered="false" size="small" :scroll-x="500" />
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Pages 绑定 -->
        <n-tab-pane name="pagesBindings" tab="绑定">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">Pages Functions 可用资源绑定</n-text>
              <n-button size="small" type="primary" @click="openBindingModal">添加绑定</n-button>
            </n-space>
            <n-spin :show="bindingsLoading">
              <n-data-table :columns="bindingsColumns" :data="bindingsList" :bordered="false" size="small" :scroll-x="500" />
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Pages 部署历史 -->
        <n-tab-pane name="pagesDeployments" tab="部署历史">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">查看 Pages 部署记录</n-text>
              <n-button size="small" @click="loadPagesDeployments">刷新</n-button>
            </n-space>
            <n-spin :show="pagesDeploymentsLoading">
              <n-data-table :columns="pagesDeploymentColumns" :data="pagesDeployments" :bordered="false" size="small" :scroll-x="900" :pagination="{ pageSize: 10 }" />
            </n-spin>
          </n-space>
        </n-tab-pane>
      </n-tabs>
    </n-drawer-content>
  </n-drawer>

  <!-- Pages Domain Modal -->
  <n-modal v-model:show="showPagesDomainModal" preset="dialog" title="添加 Pages 域名" style="width: 450px; max-width: 95vw">
    <n-form label-placement="left" label-width="80">
      <n-form-item label="域名">
        <n-select
          v-model:value="pagesDomainHostname"
          :options="managedDomainOptions"
          filterable
          tag
          placeholder="选择或输入域名"
          :loading="managedDomainsLoading"
        />
      </n-form-item>
    </n-form>
    <template #action>
      <n-button @click="showPagesDomainModal = false">取消</n-button>
      <n-button type="primary" :loading="pagesDomainSaving" @click="handleAddPagesDomain">保存</n-button>
    </template>
  </n-modal>

  <!-- Pages Env Var Modal -->
  <n-modal v-model:show="showPagesEnvModal" preset="dialog" :title="pagesEnvEditing ? '编辑 Pages 环境变量' : '添加 Pages 环境变量'" style="width: 450px; max-width: 95vw">
    <n-form :model="pagesEnvForm" label-placement="left" label-width="80">
      <n-form-item label="名称">
        <n-input v-model:value="pagesEnvForm.name" placeholder="环境变量名" :disabled="pagesEnvEditing" />
      </n-form-item>
      <n-form-item label="值">
        <n-input v-model:value="pagesEnvForm.value" placeholder="变量值" />
      </n-form-item>
      <n-form-item label="类型">
        <n-select v-model:value="pagesEnvForm.type" :options="[{label:'明文',value:'plain_text'},{label:'加密',value:'secret_text'}]" />
      </n-form-item>
    </n-form>
    <template #action>
      <n-button @click="showPagesEnvModal = false">取消</n-button>
      <n-button type="primary" :loading="pagesEnvSaving" @click="handleAddPagesEnv">保存</n-button>
    </template>
  </n-modal>

  <!-- Pages Binding Modal -->
  <n-modal v-model:show="showBindingModal" preset="dialog" title="添加资源绑定" style="width: 500px; max-width: 95vw">
    <n-form :model="bindingForm" label-placement="left" label-width="80">
      <n-form-item label="类型">
        <n-select v-model:value="bindingForm.type" :options="bindingTypeOptions" @update:value="onBindingTypeChange" />
      </n-form-item>
      <n-form-item label="变量名">
        <n-input v-model:value="bindingForm.name" placeholder="代码中引用的变量名，如 MY_KV" />
      </n-form-item>
      <n-form-item label="资源">
        <n-select v-model:value="bindingForm.value" :options="bindingResourceOptions" :loading="bindingResourcesLoading" filterable placeholder="选择资源" />
      </n-form-item>
    </n-form>
    <template #action>
      <n-button @click="showBindingModal = false">取消</n-button>
      <n-button type="primary" :loading="bindingSaving" @click="handleAddBinding">保存</n-button>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, computed, watch, h } from 'vue';
import { NTag, NSpace, NButton, useMessage } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { workersApi } from '../api/workers';
import { formatCN } from '../utils/dateFormat';
import { isDemoAccount } from '../utils/demoAccounts';

interface WorkerProp {
  name: string;
  cfAccountId: number;
  type: 'worker' | 'pages';
}

const props = defineProps<{ show: boolean; worker: WorkerProp | null }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();

const message = useMessage();

const visible = computed({
  get: () => props.show,
  set: (v: boolean) => emit('update:show', v),
});
const workerName = computed(() => props.worker?.name || '');
const accountId = computed(() => props.worker?.cfAccountId || 0);

function drawerWidth(desktopWidth: number): number {
  return window.innerWidth <= 768 ? Math.min(window.innerWidth, desktopWidth) : desktopWidth;
}

// Pages Settings
const pagesProject = ref<any>(null);
const pagesProjectLoading = ref(false);
const pagesDomains = ref<any[]>([]);
const pagesDomainsLoading = ref(false);
const showPagesDomainModal = ref(false);
const pagesDomainHostname = ref('');
const pagesDomainSaving = ref(false);
const managedDomains = ref<any[]>([]);
const managedDomainsLoading = ref(false);
const managedDomainOptions = computed(() =>
  managedDomains.value.map((z: any) => ({ label: `${z.name} (${z.status})`, value: z.name }))
);
const pagesEnvVars = ref<any[]>([]);
const showPagesEnvModal = ref(false);
const pagesEnvEditing = ref(false);
const pagesEnvForm = ref({ name: '', value: '', type: 'plain_text' });
const pagesEnvSaving = ref(false);

// ============ Pages Bindings ============
const bindingsLoading = ref(false);
const bindingsList = ref<any[]>([]);
const showBindingModal = ref(false);
const bindingSaving = ref(false);
const bindingForm = ref({ type: 'kv_namespaces', name: '', value: '' });
const bindingResources = ref<any[]>([]);
const bindingResourcesLoading = ref(false);
const r2Available = ref(true);
const bindingTypeOptions = computed(() => {
  const options = [
    { label: 'KV 命名空间', value: 'kv_namespaces' },
    { label: 'D1 数据库', value: 'd1_databases' },
  ];
  if (r2Available.value) {
    options.push({ label: 'R2 存储桶', value: 'r2_buckets' });
  }
  return options;
});

const bindingResourceOptions = computed(() =>
  bindingResources.value.map((r: any) => ({
    label: r.title || r.name || r.id,
    value: bindingForm.value.type === 'kv_namespaces' ? r.id : bindingForm.value.type === 'd1_databases' ? r.uuid || r.id : r.name,
  }))
);

function parseBindings(configs: any): any[] {
  if (!configs) return [];
  const production = configs.production || {};
  const list: any[] = [];
  const typeLabels: Record<string, string> = { kv_namespaces: 'KV', d1_databases: 'D1', r2_buckets: 'R2', services: 'Service', queue_producers: 'Queue', durable_object_namespaces: 'DO', browsers: 'Browser', analytics_engine_datasets: 'Analytics' };
  for (const [typeKey, label] of Object.entries(typeLabels)) {
    const bindings = production[typeKey];
    if (!bindings) continue;
    if (Array.isArray(bindings)) {
      for (const item of bindings) {
        const name = item.name || item.binding || '';
        const value = item.namespace_id || item.id || item.bucket_name || item.dataset || item.service || JSON.stringify(item);
        list.push({ type: label, typeKey, name, value });
      }
    } else if (typeof bindings === 'object') {
      for (const [name, val] of Object.entries(bindings as Record<string, any>)) {
        const value = val?.namespace_id || val?.id || val?.name || val?.dataset || val?.service || JSON.stringify(val);
        list.push({ type: label, typeKey, name, value });
      }
    }
  }
  return list;
}

// Resource name lookup map (id -> name)
const resourceNameMap = ref<Record<string, string>>({});

async function buildResourceNameMap() {
  const map: Record<string, string> = {};
  try {
    const promises = [
      workersApi.getKvNamespaces(accountId.value).catch(() => null),
      workersApi.getD1Databases(accountId.value).catch(() => null),
    ];
    if (r2Available.value) {
      promises.push(workersApi.getR2Buckets(accountId.value, { _silent: true } as any).catch((err: any) => {
        const msg = err?.response?.data?.error?.message || err?.message || '';
        if (msg.includes('10042') || msg.includes('Please enable R2')) {
          r2Available.value = false;
        }
        return null;
      }));
    } else {
      promises.push(Promise.resolve(null));
    }
    const [kvResp, d1Resp, r2Resp] = await Promise.all(promises);
    const kvList = Array.isArray(kvResp?.data) ? kvResp.data : [];
    const d1List = Array.isArray(d1Resp?.data) ? d1Resp.data : [];
    const r2List = Array.isArray(r2Resp?.data) ? r2Resp.data : [];
    for (const ns of kvList) { if (ns.id) map[ns.id] = ns.title || ns.id; }
    for (const db of d1List) { const key = db.uuid || db.id; if (key) map[key] = db.name || key; }
    for (const b of r2List) { if (b.name) map[b.name] = b.name; }
  } catch {
    resourceNameMap.value = {};
    return;
  }
  resourceNameMap.value = map;
}

function resolveResourceName(id: string): { id: string; name: string } {
  return { id, name: resourceNameMap.value[id] || '' };
}

async function loadBindings() {
  bindingsLoading.value = true;
  try {
    const [{ data }, _] = await Promise.all([
      workersApi.getPagesProject(accountId.value, workerName.value),
      buildResourceNameMap(),
    ]);
    console.log('[Bindings] deployment_configs:', JSON.stringify(data?.deployment_configs));
    bindingsList.value = parseBindings(data?.deployment_configs);
  } catch (e) {
    console.error('[Bindings] loadBindings failed:', e);
    bindingsList.value = [];
  }
  finally { bindingsLoading.value = false; }
}

async function openBindingModal() {
  bindingForm.value = { type: 'kv_namespaces', name: '', value: '' };
  showBindingModal.value = true;
  await loadBindingResources('kv_namespaces');
}

async function onBindingTypeChange(type: string) {
  bindingForm.value.value = '';
  if (type === 'r2_buckets' && !r2Available.value) {
    message.warning('当前账户未启用 R2，请先在 Cloudflare 控制台启用');
    bindingForm.value.type = 'kv_namespaces';
    return;
  }
  await loadBindingResources(type);
}

async function loadBindingResources(type: string) {
  bindingResourcesLoading.value = true;
  bindingResources.value = [];
  try {
    let resp: any;
    if (type === 'kv_namespaces') resp = await workersApi.getKvNamespaces(accountId.value);
    else if (type === 'd1_databases') resp = await workersApi.getD1Databases(accountId.value);
    else if (type === 'r2_buckets') {
      resp = await workersApi.getR2Buckets(accountId.value, { _silent: true } as any);
    }
    bindingResources.value = Array.isArray(resp?.data) ? resp.data : [];
  } catch (err: any) {
    const msg = err?.response?.data?.error?.message || err?.message || '';
    if (type === 'r2_buckets' && (msg.includes('10042') || msg.includes('Please enable R2'))) {
      message.warning('当前账户未启用 R2，请先在 Cloudflare 控制台启用');
      r2Available.value = false;
    }
    bindingResources.value = [];
  }
  finally { bindingResourcesLoading.value = false; }
}

async function handleAddBinding() {
  if (!bindingForm.value.name) { message.warning('请填写变量名'); return; }
  if (!bindingForm.value.value) { message.warning('请选择资源'); return; }
  bindingSaving.value = true;
  try {
    const { data } = await workersApi.getPagesProject(accountId.value, workerName.value);
    const configs = data?.deployment_configs || {};
    const production = configs.production || {};
    const existing = production[bindingForm.value.type] || {};
    const type = bindingForm.value.type;
    let bindingValue: any;
    if (type === 'kv_namespaces') bindingValue = { namespace_id: bindingForm.value.value };
    else if (type === 'd1_databases') bindingValue = { id: bindingForm.value.value };
    else if (type === 'r2_buckets') bindingValue = { name: bindingForm.value.value };
    const updated = { ...existing, [bindingForm.value.name]: bindingValue };
    const preview = configs.preview || {};
    await workersApi.updatePagesBindings(accountId.value, workerName.value, {
      production: { ...production, [type]: updated },
      preview: { ...preview, [type]: updated },
    });
    message.success('绑定已添加');
    showBindingModal.value = false;
    loadBindings();
  } finally { bindingSaving.value = false; }
}

async function handleDeleteBinding(row: any) {
  const { data } = await workersApi.getPagesProject(accountId.value, workerName.value);
  const configs = data?.deployment_configs || {};
  const production = configs.production || {};
  const existing = { ...(production[row.typeKey] || {}) };
  delete existing[row.name];
  const preview = configs.preview || {};
  const val = Object.keys(existing).length > 0 ? existing : null;
  await workersApi.updatePagesBindings(accountId.value, workerName.value, {
    production: { ...production, [row.typeKey]: val },
    preview: { ...preview, [row.typeKey]: val },
  });
  message.success('绑定已删除');
  loadBindings();
}
const pagesDeployments = ref<any[]>([]);
const pagesDeploymentsLoading = ref(false);

async function checkR2Availability() {
  try {
    const { data } = await workersApi.getR2Buckets(accountId.value, { _silent: true });
    if (data?.r2_not_enabled) {
      r2Available.value = false;
    } else {
      r2Available.value = true;
    }
  } catch (err: any) {
    const msg = err?.response?.data?.error?.message || err?.errorMessage || err?.message || '';
    if (msg.includes('10042') || msg.includes('enable R2') || msg.includes('R2_NOT_ENABLED')) {
      r2Available.value = false;
    } else {
      r2Available.value = true;
    }
  }
}

async function loadPagesProject() {
  pagesProjectLoading.value = true;
  try {
    const { data } = await workersApi.getPagesProject(accountId.value, workerName.value);
    pagesProject.value = data;
    const envVars = data?.deployment_configs?.production?.env_vars || {};
    pagesEnvVars.value = Object.entries(envVars).map(([key, val]: [string, any]) => ({
      name: key,
      type: val?.type || 'plain_text',
      value: val?.type === 'plain_text' ? val?.value : '******',
    }));
  } catch { pagesProject.value = null; pagesEnvVars.value = []; }
  finally { pagesProjectLoading.value = false; }
}

async function loadPagesDomains() {
  pagesDomainsLoading.value = true;
  try {
    const { data } = await workersApi.getPagesDomains(accountId.value, workerName.value);
    pagesDomains.value = Array.isArray(data) ? data : [];
  } catch { pagesDomains.value = []; }
  finally { pagesDomainsLoading.value = false; }
}

async function openPagesDomainModal() {
  pagesDomainHostname.value = '';
  showPagesDomainModal.value = true;
  managedDomainsLoading.value = true;
  try {
    const { data } = await workersApi.getZones(accountId.value);
    managedDomains.value = Array.isArray(data) ? data : [];
  } catch { managedDomains.value = []; }
  finally { managedDomainsLoading.value = false; }
}

async function handleAddPagesDomain() {
  if (!pagesDomainHostname.value) { message.warning('请填写域名'); return; }
  pagesDomainSaving.value = true;
  try {
    await workersApi.addPagesDomain(accountId.value, workerName.value, pagesDomainHostname.value);
    message.success('域名已添加');
    showPagesDomainModal.value = false;
    pagesDomainHostname.value = '';
    loadPagesDomains();
  } finally { pagesDomainSaving.value = false; }
}

async function handleRemovePagesDomain(row: any) {
  await workersApi.removePagesDomain(accountId.value, workerName.value, row.name || row.hostname);
  message.success('域名已删除');
  loadPagesDomains();
}

async function handleAddPagesEnv() {
  if (!pagesEnvForm.value.name) { message.warning('请填写名称'); return; }
  pagesEnvSaving.value = true;
  try {
    const existingProd = pagesProject.value?.deployment_configs?.production || {};
    const existingPreview = pagesProject.value?.deployment_configs?.preview || {};
    const envVars = { ...(existingProd.env_vars || {}) };
    envVars[pagesEnvForm.value.name] = { type: pagesEnvForm.value.type, value: pagesEnvForm.value.value };
    await workersApi.editPagesProject(accountId.value, workerName.value, {
      deployment_configs: {
        production: { ...existingProd, env_vars: envVars },
        preview: { ...existingPreview, env_vars: envVars },
      },
    });
    message.success('环境变量已保存');
    showPagesEnvModal.value = false;
    pagesEnvForm.value = { name: '', value: '', type: 'plain_text' };
    loadPagesProject();
  } finally { pagesEnvSaving.value = false; }
}

function handleEditPagesEnv(row: any) {
  pagesEnvEditing.value = true;
  pagesEnvForm.value = { name: row.name, value: row.type === 'secret_text' ? '' : (row.value || ''), type: row.type || 'plain_text' };
  showPagesEnvModal.value = true;
}

async function handleDeletePagesEnv(row: any) {
  try {
    await workersApi.editPagesProject(accountId.value, workerName.value, {
      deployment_configs: {
        production: { env_vars: { [row.name]: null } },
        preview: { env_vars: { [row.name]: null } },
      },
    });
    message.success('环境变量已删除');
    loadPagesProject();
  } catch (e: any) { message.error(e?.message || '删除失败'); }
}

async function loadPagesDeployments() {
  pagesDeploymentsLoading.value = true;
  try {
    const { data } = await workersApi.getPagesDeployments(accountId.value, workerName.value);
    pagesDeployments.value = Array.isArray(data) ? data : [];
  } catch { pagesDeployments.value = []; }
  finally { pagesDeploymentsLoading.value = false; }
}

// Columns
const pagesDomainColumns: DataTableColumns<any> = [
  { title: '域名', key: 'name', minWidth: 120, ellipsis: { tooltip: true } },
  { title: '状态', key: 'status', width: 100, render: (row) => h(NTag, { size: 'small', type: row.status === 'active' ? 'success' : 'warning' }, { default: () => row.status || '-' }) },
  {
    title: '操作', key: 'actions', width: 120,
    render: (row) => h(NSpace, null, {
      default: () => [
        h(NButton, { size: 'tiny', type: 'info', onClick: () => window.open(`https://${row.name}`, '_blank') }, { default: () => '打开' }),
        ...(isDemoAccount(accountId.value) ? [] : [
          h(NButton, { size: 'tiny', type: 'error', onClick: () => handleRemovePagesDomain(row) }, { default: () => '删除' }),
        ]),
      ]
    })
  },
];

const pagesEnvColumns: DataTableColumns<any> = [
  { title: '名称', key: 'name', width: 120 },
  { title: '类型', key: 'type', width: 100, render: (row) => h(NTag, { size: 'small', type: row.type === 'secret_text' ? 'warning' : 'default' }, { default: () => row.type === 'secret_text' ? '加密' : '明文' }) },
  { title: '值', key: 'value', minWidth: 120, ellipsis: true },
  { title: '操作', key: 'actions', width: 140, render: (row) => h(NSpace, { size: 4 }, {
    default: () => [
      h(NButton, { size: 'tiny', onClick: () => handleEditPagesEnv(row) }, { default: () => '编辑' }),
      ...(isDemoAccount(accountId.value) ? [] : [
        h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeletePagesEnv(row) }, { default: () => '删除' }),
      ]),
    ],
  }) },
];

const bindingsColumns: DataTableColumns<any> = [
  { title: '类型', key: 'type', width: 100, render: (row) => h(NTag, { size: 'small', type: row.typeKey === 'kv_namespaces' ? 'info' : row.typeKey === 'd1_databases' ? 'warning' : 'success' }, { default: () => row.type }) },
  { title: '变量名', key: 'name', width: 120 },
  { title: '资源', key: 'value', minWidth: 150, ellipsis: true, render: (row) => {
    const resolved = resolveResourceName(row.value);
    return resolved.name
      ? h(NSpace, { size: 'small', align: 'center' }, { default: () => [h('span', null, resolved.name), h(NTag, { size: 'tiny', type: 'default', style: 'opacity: 0.6' }, { default: () => resolved.id })] })
      : h('span', null, resolved.id);
  }},
  { title: '操作', key: 'actions', width: 80, render: (row) => isDemoAccount(accountId.value)
    ? null
    : h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeleteBinding(row) }, { default: () => '删除' }) },
];

const pagesDeploymentColumns: DataTableColumns<any> = [
  { title: 'ID', key: 'id', width: 100, ellipsis: true },
  { title: '环境', key: 'environment', width: 100, render: (row) => h(NTag, { size: 'small', type: row.environment === 'production' ? 'success' : 'info' }, { default: () => row.environment || '-' }) },
  { title: '状态', key: 'status', width: 100, render: (row) => h(NTag, { size: 'small', type: row.latest_stage?.status === 'success' ? 'success' : row.latest_stage?.status === 'failure' ? 'error' : 'default' }, { default: () => row.latest_stage?.status || '-' }) },
  { title: '阶段', key: 'stage', width: 100, render: (row) => row.latest_stage?.name || '-' },
  { title: 'URL', key: 'url', minWidth: 250, render: (row) => row.url ? h('a', { href: row.url, target: '_blank', style: 'word-break: break-all; font-size: 12px;' }, row.url) : '-' },
  { title: '创建时间', key: 'created_on', width: 170, render: (row) => row.created_on ? formatCN(row.created_on) : '-' },
];

// 打开抽屉时加载数据
watch(
  () => [props.show, props.worker?.name, props.worker?.cfAccountId] as const,
  () => {
    if (props.show && props.worker) {
      loadPagesProject();
      loadPagesDomains();
      loadPagesDeployments();
      checkR2Availability();
      loadBindings();
    }
  },
  { immediate: true },
);
</script>
