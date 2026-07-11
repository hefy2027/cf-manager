<template>
  <n-drawer v-model:show="visible" :width="drawerWidth(860)" placement="right">
    <n-drawer-content :title="`设置 - ${workerName} (worker)`" closable>
      <n-tabs type="line" animated>
        <!-- Secrets -->
        <n-tab-pane name="secrets" tab="Secrets">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">环境变量和加密密钥</n-text>
              <n-space>
                <n-button size="small" @click="openEnvSync">同步到其他 Worker</n-button>
                <n-button size="small" type="primary" @click="secretEditing = false; secretForm = { name: '', type: 'secret_text', text: '', key_base64: '' }; showSecretModal = true">添加 Secret</n-button>
              </n-space>
            </n-space>
            <n-spin :show="secretsLoading">
              <n-data-table :columns="secretColumns" :data="secrets" :bordered="false" size="small" :scroll-x="500" />
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Cron Triggers -->
        <n-tab-pane name="schedules" tab="定时触发器">
          <n-space vertical>
            <n-text depth="3">配置 Cron 表达式，让 Worker 定时执行</n-text>
            <n-spin :show="schedulesLoading">
              <!-- 已配置的触发器 -->
              <n-data-table v-if="schedules.length" :columns="scheduleColumns" :data="schedules" :bordered="false" size="small" style="margin-bottom: 12px" :scroll-x="500" />

              <!-- Cron 构建器 -->
              <n-card size="small" title="构建 Cron 表达式" style="margin-top: 8px">
                <n-space vertical :size="12">
                  <!-- 常用预设 -->
                  <n-space :wrap="true" :size="4">
                    <n-button v-for="p in cronPresets" :key="p.value" :size="'tiny'" :type="cronPreset === p.value ? 'primary' : 'default'" secondary @click="applyPreset(p.value)">{{ p.label }}</n-button>
                    <n-button size="tiny" @click="showCronFields = !showCronFields">{{ showCronFields ? '收起' : '自定义' }}</n-button>
                  </n-space>
                  <!-- 5 字段选择器 -->
                  <n-grid v-if="showCronFields" :cols="isMobileCron ? 2 : 5" :x-gap="6" :y-gap="6">
                    <n-gi>
                      <n-form-item label="分钟" label-placement="top" size="small">
                        <n-input v-model:value="cronMin" size="small" placeholder="*" @update:value="onCronFieldChange" />
                      </n-form-item>
                    </n-gi>
                    <n-gi>
                      <n-form-item label="小时" label-placement="top" size="small">
                        <n-input v-model:value="cronHour" size="small" placeholder="*" @update:value="onCronFieldChange" />
                      </n-form-item>
                    </n-gi>
                    <n-gi>
                      <n-form-item label="日" label-placement="top" size="small">
                        <n-input v-model:value="cronDay" size="small" placeholder="*" @update:value="onCronFieldChange" />
                      </n-form-item>
                    </n-gi>
                    <n-gi>
                      <n-form-item label="月" label-placement="top" size="small">
                        <n-input v-model:value="cronMon" size="small" placeholder="*" @update:value="onCronFieldChange" />
                      </n-form-item>
                    </n-gi>
                    <n-gi>
                      <n-form-item label="周" label-placement="top" size="small">
                        <n-input v-model:value="cronDow" size="small" placeholder="*" @update:value="onCronFieldChange" />
                      </n-form-item>
                    </n-gi>
                  </n-grid>
                  <!-- 实时预览 -->
                  <n-space align="center">
                    <n-tag type="info" size="large">{{ builtCron }}</n-tag>
                    <n-text v-if="cronDesc" depth="3" style="font-size: 12px">{{ cronDesc }}</n-text>
                    <n-button size="small" type="primary" @click="addCronToList" :disabled="cronExpressions.includes(builtCron)">添加到列表</n-button>
                  </n-space>
                </n-space>
              </n-card>

              <!-- 待保存列表 -->
              <n-space v-if="cronExpressions.length" style="margin-top: 16px">
                <n-tag v-for="(c, i) in cronExpressions" :key="i" closable @close="cronExpressions.splice(i, 1)" :type="c === builtCron ? 'info' : 'default'">{{ c }} <n-text depth="3" style="font-size: 10px">{{ describeCron(c) }}</n-text></n-tag>
              </n-space>
              <n-empty v-else style="margin-top: 12px" description="尚未添加 Cron 表达式，可输入 / 选择后添加" size="small" />

              <n-button size="small" type="primary" style="margin-top: 12px" :loading="schedulesSaving" @click="saveSchedules" :disabled="!cronExpressions.length && !schedules.length">保存触发器</n-button>
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Domains -->
        <n-tab-pane name="domains" tab="自定义域名">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">绑定自定义域名到 Worker</n-text>
              <n-button size="small" type="primary" @click="showDomainModal = true">添加域名</n-button>
            </n-space>
            <n-spin :show="domainsLoading">
              <n-data-table :columns="domainColumns" :data="domains" :bordered="false" size="small" :scroll-x="500" />
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Subdomain -->
        <n-tab-pane name="subdomain" tab="子域名">
          <n-space vertical>
            <n-text depth="3">workers.dev 子域名状态</n-text>
            <n-spin :show="subdomainLoading">
              <n-card size="small" v-if="subdomainInfo">
                <n-space vertical>
                  <n-space align="center">
                    <n-text>启用状态：</n-text>
                    <n-tag :type="subdomainInfo.enabled ? 'success' : 'default'">{{ subdomainInfo.enabled ? '已启用' : '未启用' }}</n-tag>
                    <n-switch :value="subdomainInfo.enabled" @update:value="toggleSubdomain" :loading="subdomainSaving" />
                  </n-space>
                  <n-space v-if="subdomainInfo.previews_enabled !== undefined" align="center">
                    <n-text>预览部署：</n-text>
                    <n-tag :type="subdomainInfo.previews_enabled ? 'success' : 'default'">{{ subdomainInfo.previews_enabled ? '已启用' : '未启用' }}</n-tag>
                  </n-space>
                </n-space>
              </n-card>
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Settings -->
        <n-tab-pane name="settings" tab="脚本设置">
          <n-space vertical>
            <n-text depth="3">可观测性、日志等设置</n-text>
            <n-spin :show="scriptSettingsLoading">
              <n-card size="small" v-if="scriptSettings">
                <n-form label-placement="left" label-width="120">
                  <n-form-item label="可观测性">
                    <n-switch :value="scriptSettings.observability?.enabled" @update:value="(v: boolean) => updateScriptSetting('observability', { enabled: v })" />
                  </n-form-item>
                  <n-form-item label="Logpush">
                    <n-switch :value="scriptSettings.logpush" @update:value="(v: boolean) => updateScriptSetting('logpush', v)" />
                  </n-form-item>
                  <n-form-item v-if="scriptSettings.tags" label="标签">
                    <n-dynamic-tags v-model:value="scriptSettings.tags" />
                  </n-form-item>
                </n-form>
              </n-card>
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Routes -->
        <n-tab-pane name="routes" tab="路由">
          <n-space vertical>
            <n-space>
              <n-input v-model:value="routeZoneId" placeholder="Zone ID" size="small" style="width: 260px" />
              <n-button size="small" type="primary" @click="loadRoutes">加载路由</n-button>
              <n-button size="small" @click="showRouteModal = true">添加路由</n-button>
            </n-space>
            <n-spin :show="routesLoading">
              <n-data-table :columns="routeColumns" :data="routes" :bordered="false" size="small" :scroll-x="500" />
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Source Code -->
        <n-tab-pane name="source" tab="源代码">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">查看 Worker 脚本内容</n-text>
              <n-space>
                <n-button size="small" :disabled="!scriptContent" @click="copyScript">复制</n-button>
                <n-button size="small" @click="loadScriptContent">刷新</n-button>
              </n-space>
            </n-space>
            <n-spin :show="contentLoading">
              <n-code v-if="scriptContent" :code="scriptContent" language="javascript" :hljs="hljs" :word-wrap="true" :show-line-numbers="true" style="max-height: 500px; overflow: auto" />
              <n-empty v-else-if="!contentLoading" description="点击刷新加载源代码" />
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Deployments -->
        <n-tab-pane name="deployments" tab="部署历史">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">查看部署记录</n-text>
              <n-button size="small" @click="loadDeployments">刷新</n-button>
            </n-space>
            <n-spin :show="deploymentsLoading">
              <n-data-table :columns="deploymentColumns" :data="deployments" :bordered="false" size="small" :scroll-x="600" :pagination="{ pageSize: 10 }" />
            </n-spin>
          </n-space>
        </n-tab-pane>
      </n-tabs>
    </n-drawer-content>
  </n-drawer>

  <!-- Secret Modal -->
  <n-modal v-model:show="showSecretModal" preset="dialog" :title="secretEditing ? '编辑 Secret' : '添加 Secret'" style="width: 450px; max-width: 95vw">
    <n-form :model="secretForm" label-placement="left" label-width="80">
      <n-form-item label="名称">
        <n-input v-model:value="secretForm.name" placeholder="环境变量名" :disabled="secretEditing" />
      </n-form-item>
      <n-form-item label="类型">
        <n-select v-model:value="secretForm.type" :options="[{label:'Text',value:'secret_text'},{label:'Key',value:'secret_key'}]" />
      </n-form-item>
      <n-form-item v-if="secretForm.type === 'secret_text'" label="值">
        <n-input v-model:value="secretForm.text" type="password" show-password-on="click" placeholder="Secret 值" />
      </n-form-item>
      <n-form-item v-else label="Base64 Key">
        <n-input v-model:value="secretForm.key_base64" type="password" show-password-on="click" placeholder="Base64 编码的密钥" />
      </n-form-item>
    </n-form>
    <template #action>
      <n-button @click="showSecretModal = false">取消</n-button>
      <n-button type="primary" :loading="secretSaving" @click="handleAddSecret">保存</n-button>
    </template>
  </n-modal>

  <!-- Domain Modal -->
  <n-modal v-model:show="showDomainModal" preset="dialog" title="添加自定义域名" style="width: 450px; max-width: 95vw">
    <n-form :model="domainForm" label-placement="left" label-width="80">
      <n-form-item label="域名">
        <n-input v-model:value="domainForm.hostname" placeholder="example.com" />
      </n-form-item>
      <n-form-item label="环境">
        <n-select v-model:value="domainForm.environment" :options="[{label:'production',value:'production'},{label:'staging',value:'staging'}]" clearable />
      </n-form-item>
    </n-form>
    <template #action>
      <n-button @click="showDomainModal = false">取消</n-button>
      <n-button type="primary" :loading="domainSaving" @click="handleAddDomain">保存</n-button>
    </template>
  </n-modal>

  <!-- Route Modal -->
  <n-modal v-model:show="showRouteModal" preset="dialog" title="添加路由" style="width: 450px; max-width: 95vw">
    <n-form :model="routeForm" label-placement="left" label-width="80">
      <n-form-item label="Zone ID">
        <n-input v-model:value="routeForm.zone_id" placeholder="Zone ID" />
      </n-form-item>
      <n-form-item label="Pattern">
        <n-input v-model:value="routeForm.pattern" placeholder="example.com/*" />
      </n-form-item>
    </n-form>
    <template #action>
      <n-button @click="showRouteModal = false">取消</n-button>
      <n-button type="primary" :loading="routeSaving" @click="handleAddRoute">保存</n-button>
    </template>
  </n-modal>

  <!-- 环境同步 Modal -->
  <n-modal v-model:show="showEnvSyncModal" preset="dialog" title="同步 Secrets 到其他 Worker" style="width: 600px; max-width: 95vw">
    <n-form label-placement="left" label-width="100">
      <n-form-item label="来源">
        <n-text>{{ workerName }} ({{ accountId }})</n-text>
      </n-form-item>
      <n-form-item label="目标 Workers">
        <n-checkbox-group v-model:value="syncTargets">
          <n-space vertical>
            <n-checkbox v-for="w in workerStore.workers.filter((w: any) => w.type === 'worker' && !(w.cfAccountId === accountId && w.name === workerName))" :key="`${w.cfAccountId}-${w.name}`" :value="`${w.cfAccountId}:${w.name}`">
              {{ w.accountName }} / {{ w.name }}
            </n-checkbox>
          </n-space>
        </n-checkbox-group>
      </n-form-item>
      <n-form-item label="Secret 值">
        <n-text depth="3" style="font-size: 12px">Cloudflare API 不支持读取 Secret 明文值，请手动填写需要同步的值：</n-text>
      </n-form-item>
      <div v-for="s in secrets" :key="s.name" style="margin-bottom: 8px">
        <n-input-group>
          <n-input :value="s.name" disabled style="width: 200px" />
          <n-input v-model:value="syncSecretValues[s.name]" type="password" show-password-on="click" placeholder="输入值" />
        </n-input-group>
      </div>
    </n-form>
    <div v-if="syncResults.length" style="margin-top: 12px">
      <n-tag v-for="r in syncResults" :key="`${r.accountId}-${r.workerName}`" :type="r.success ? 'success' : 'error'" size="small" style="margin: 2px">
        {{ r.workerName }}: {{ r.success ? `${r.synced} 项已同步` : r.error }}
      </n-tag>
    </div>
    <template #action>
      <n-button @click="showEnvSyncModal = false">关闭</n-button>
      <n-button type="primary" :loading="syncing" @click="handleEnvSync" :disabled="!syncTargets.length">同步</n-button>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, computed, watch, h } from 'vue';
import { NTag, NSpace, NButton, useMessage } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';
import { workersApi } from '../api/workers';
import { useWorkerStore } from '../stores/workerStore';
import { formatCN } from '../utils/dateFormat';
import { isDemoAccount } from '../utils/demoAccounts';

interface WorkerProp {
  name: string;
  cfAccountId: number;
  type: 'worker' | 'pages';
}

const props = defineProps<{ show: boolean; worker: WorkerProp | null }>();
const emit = defineEmits<{ 'update:show': [boolean] }>();

const workerStore = useWorkerStore();
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

// Secrets
const secrets = ref<any[]>([]);
const secretsLoading = ref(false);
const showSecretModal = ref(false);
const secretSaving = ref(false);
const secretEditing = ref(false);
const secretForm = ref({ name: '', type: 'secret_text', text: '', key_base64: '' });

// Schedules
const schedules = ref<any[]>([]);
const schedulesLoading = ref(false);
const schedulesSaving = ref(false);
const cronExpressions = ref<string[]>([]);

// Cron builder
const cronPresets = [
  { label: '每分钟', value: '* * * * *' },
  { label: '每5分钟', value: '*/5 * * * *' },
  { label: '每15分钟', value: '*/15 * * * *' },
  { label: '每30分钟', value: '*/30 * * * *' },
  { label: '每小时', value: '0 * * * *' },
  { label: '每2小时', value: '0 */2 * * *' },
  { label: '每天0点', value: '0 0 * * *' },
  { label: '每周日0点', value: '0 0 * * 0' },
  { label: '每月1号0点', value: '0 0 1 * *' },
];
const cronPreset = ref('');
const showCronFields = ref(false);
const cronMin = ref('*');
const cronHour = ref('*');
const cronDay = ref('*');
const cronMon = ref('*');
const cronDow = ref('*');
const isMobileCron = ref(window.innerWidth <= 768);
const builtCron = computed(() => `${cronMin.value} ${cronHour.value} ${cronDay.value} ${cronMon.value} ${cronDow.value}`);

const FIELD_LABELS: Record<string, string> = { min: '分钟', hour: '小时', day: '日', mon: '月', dow: '周' };
const FIELD_MAP: [string, number][] = [['min', 0], ['hour', 1], ['day', 2], ['mon', 3], ['dow', 4]];

function describeCron(cron: string): string {
  if (!cron) return '';
  // 预设匹配
  const preset = cronPresets.find(p => p.value === cron);
  if (preset) return preset.label;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return '';
  const desc = FIELD_MAP.map(([k, i]) => parts[i] === '*' ? '' : `每${FIELD_LABELS[k]}${parts[i]}`);
  return desc.filter(Boolean).join(' ') || '每分/时/日/月/周';
}

const cronDesc = computed(() => describeCron(builtCron.value));

function applyPreset(value: string) {
  cronPreset.value = value;
  const parts = value.split(' ');
  cronMin.value = parts[0];
  cronHour.value = parts[1];
  cronDay.value = parts[2];
  cronMon.value = parts[3];
  cronDow.value = parts[4];
  showCronFields.value = true;
}

function onCronFieldChange() {
  cronPreset.value = '';
}

function addCronToList() {
  const expr = builtCron.value;
  if (!cronExpressions.value.includes(expr)) {
    cronExpressions.value.push(expr);
  }
}

// Domains
const domains = ref<any[]>([]);
const domainsLoading = ref(false);
const showDomainModal = ref(false);
const domainSaving = ref(false);
const domainForm = ref({ hostname: '', environment: '' });

// Subdomain
const subdomainInfo = ref<any>(null);
const subdomainLoading = ref(false);
const subdomainSaving = ref(false);

// Script Settings
const scriptSettings = ref<any>(null);
const scriptSettingsLoading = ref(false);

// Routes
const routes = ref<any[]>([]);
const routesLoading = ref(false);
const routeZoneId = ref('');
const showRouteModal = ref(false);
const routeSaving = ref(false);
const routeForm = ref({ zone_id: '', pattern: '' });

// Script Content
const scriptContent = ref('');
const contentLoading = ref(false);

// Deployments
const deployments = ref<any[]>([]);
const deploymentsLoading = ref(false);

// Environment Sync
const showEnvSyncModal = ref(false);
const syncTargets = ref<string[]>([]);
const syncSecretValues = ref<Record<string, string>>({});
const syncing = ref(false);
const syncResults = ref<any[]>([]);

async function loadSecrets() {
  secretsLoading.value = true;
  try {
    const { data } = await workersApi.getSecrets(accountId.value, workerName.value);
    secrets.value = Array.isArray(data) ? data : [];
  } catch { secrets.value = []; }
  finally { secretsLoading.value = false; }
}

async function handleAddSecret() {
  if (!secretForm.value.name) { message.warning('请填写名称'); return; }
  secretSaving.value = true;
  try {
    await workersApi.updateSecret(accountId.value, workerName.value, secretForm.value.name, secretForm.value.type, secretForm.value.text, secretForm.value.key_base64);
    message.success('Secret 已保存');
    showSecretModal.value = false;
    secretForm.value = { name: '', type: 'secret_text', text: '', key_base64: '' };
    loadSecrets();
  } finally { secretSaving.value = false; }
}

function handleEditSecret(row: any) {
  secretEditing.value = true;
  secretForm.value = { name: row.name, type: row.type || 'secret_text', text: '', key_base64: '' };
  showSecretModal.value = true;
}

async function handleDeleteSecret(row: any) {
  await workersApi.deleteSecret(accountId.value, workerName.value, row.name);
  message.success('Secret 已删除');
  loadSecrets();
}

async function loadSchedules() {
  schedulesLoading.value = true;
  try {
    const { data } = await workersApi.getSchedules(accountId.value, workerName.value);
    const result = data as any;
    schedules.value = result?.schedules || [];
    cronExpressions.value = schedules.value.map((s: any) => s.cron);
  } catch { schedules.value = []; cronExpressions.value = []; }
  finally { schedulesLoading.value = false; }
}

async function saveSchedules() {
  schedulesSaving.value = true;
  try {
    await workersApi.updateSchedules(accountId.value, workerName.value, cronExpressions.value);
    message.success('定时触发器已保存');
    loadSchedules();
  } finally { schedulesSaving.value = false; }
}

async function loadDomains() {
  domainsLoading.value = true;
  try {
    const { data } = await workersApi.getDomains(accountId.value, workerName.value);
    domains.value = Array.isArray(data) ? data : [];
  } catch { domains.value = []; }
  finally { domainsLoading.value = false; }
}

async function handleAddDomain() {
  if (!domainForm.value.hostname) { message.warning('请填写域名'); return; }
  domainSaving.value = true;
  try {
    await workersApi.createDomain(accountId.value, workerName.value, domainForm.value.hostname, domainForm.value.environment || undefined);
    message.success('域名已添加');
    showDomainModal.value = false;
    domainForm.value = { hostname: '', environment: '' };
    loadDomains();
  } finally { domainSaving.value = false; }
}

async function handleDeleteDomain(row: any) {
  await workersApi.deleteDomain(accountId.value, workerName.value, row.id);
  message.success('域名已删除');
  loadDomains();
}

async function loadSubdomain() {
  subdomainLoading.value = true;
  try {
    const { data } = await workersApi.getSubdomain(accountId.value, workerName.value);
    subdomainInfo.value = data;
  } catch { subdomainInfo.value = null; }
  finally { subdomainLoading.value = false; }
}

async function toggleSubdomain(val: boolean) {
  subdomainSaving.value = true;
  try {
    await workersApi.setSubdomain(accountId.value, workerName.value, val);
    message.success(val ? '子域名已启用' : '子域名已禁用');
    loadSubdomain();
  } finally { subdomainSaving.value = false; }
}

async function loadScriptSettings() {
  scriptSettingsLoading.value = true;
  try {
    const { data } = await workersApi.getSettings(accountId.value, workerName.value);
    scriptSettings.value = data;
  } catch { scriptSettings.value = null; }
  finally { scriptSettingsLoading.value = false; }
}

async function updateScriptSetting(key: string, value: any) {
  const update: any = {};
  if (key === 'observability') update.observability = value;
  else update[key] = value;
  await workersApi.updateSettings(accountId.value, workerName.value, update);
  message.success('设置已更新');
  loadScriptSettings();
}

async function loadRoutes() {
  if (!routeZoneId.value) { message.warning('请输入 Zone ID'); return; }
  routesLoading.value = true;
  try {
    const { data } = await workersApi.getRoutes(accountId.value, workerName.value, routeZoneId.value);
    routes.value = Array.isArray(data) ? data : [];
  } catch { routes.value = []; }
  finally { routesLoading.value = false; }
}

async function handleAddRoute() {
  if (!routeForm.value.zone_id || !routeForm.value.pattern) { message.warning('请填写完整'); return; }
  routeSaving.value = true;
  try {
    await workersApi.createRoute(accountId.value, workerName.value, routeForm.value.zone_id, routeForm.value.pattern);
    message.success('路由已添加');
    showRouteModal.value = false;
    routeZoneId.value = routeForm.value.zone_id;
    routeForm.value = { zone_id: '', pattern: '' };
    loadRoutes();
  } finally { routeSaving.value = false; }
}

async function handleDeleteRoute(row: any) {
  if (!routeZoneId.value) return;
  await workersApi.deleteRoute(accountId.value, workerName.value, row.id, routeZoneId.value);
  message.success('路由已删除');
  loadRoutes();
}

async function loadScriptContent() {
  contentLoading.value = true;
  try {
    const { data } = await workersApi.getContent(accountId.value, workerName.value);
    scriptContent.value = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  } catch (e: any) { scriptContent.value = '加载失败: ' + (e?.errorMessage || e?.message || '未知错误'); }
  finally { contentLoading.value = false; }
}

async function copyScript() {
  if (!scriptContent.value) return;
  try {
    await navigator.clipboard.writeText(scriptContent.value);
    message.success('已复制到剪贴板');
  } catch {
    message.error('复制失败，请手动选择文本复制');
  }
}

async function loadDeployments() {
  deploymentsLoading.value = true;
  try {
    const { data } = await workersApi.getDeployments(accountId.value, workerName.value);
    const result = data as any;
    deployments.value = result?.items || result?.deployments || (Array.isArray(data) ? data : []);
  } catch { deployments.value = []; }
  finally { deploymentsLoading.value = false; }
}

// ============ Environment Sync ============
function openEnvSync() {
  syncTargets.value = [];
  syncResults.value = [];
  syncSecretValues.value = {};
  for (const s of secrets.value) {
    syncSecretValues.value[s.name] = '';
  }
  showEnvSyncModal.value = true;
}

async function handleEnvSync() {
  const targets = syncTargets.value.map(t => {
    const [a, n] = t.split(':');
    return { accountId: Number(a), workerName: n };
  });
  const nonEmptyValues: Record<string, string> = {};
  for (const [k, v] of Object.entries(syncSecretValues.value)) {
    if (v) nonEmptyValues[k] = v;
  }
  if (Object.keys(nonEmptyValues).length === 0) {
    message.warning('请至少填写一个 Secret 值');
    return;
  }
  syncing.value = true;
  try {
    const { data } = await workersApi.envSyncExecute(
      { accountId: accountId.value, workerName: workerName.value },
      targets,
      nonEmptyValues,
    );
    syncResults.value = Array.isArray(data) ? data : [];
    const successCount = syncResults.value.filter(r => r.success).length;
    message.success(`同步完成: ${successCount}/${targets.length} 成功`);
  } finally { syncing.value = false; }
}

// Columns
const secretColumns: DataTableColumns<any> = [
  { title: '名称', key: 'name', minWidth: 100 },
  { title: '类型', key: 'type', width: 120, render: (row) => h(NTag, { size: 'small' }, { default: () => row.type || 'unknown' }) },
  { title: '操作', key: 'actions', width: 140, render: (row) => h(NSpace, { size: 4 }, {
    default: () => [
      h(NButton, { size: 'tiny', onClick: () => handleEditSecret(row) }, { default: () => '编辑' }),
      ...(isDemoAccount(accountId.value) ? [] : [
        h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeleteSecret(row) }, { default: () => '删除' }),
      ]),
    ],
  }) },
];

const scheduleColumns: DataTableColumns<any> = [
  { title: 'Cron 表达式', key: 'cron', minWidth: 120, render: (row) => h('div', {}, [
    h('div', { style: { fontFamily: 'monospace' } }, row.cron),
    h('div', { style: { fontSize: '11px', color: '#999' } }, describeCron(row.cron)),
  ]) },
  { title: '修改时间', key: 'modified_on', width: 170, render: (row) => row.modified_on ? formatCN(row.modified_on) : '-' },
];

const domainColumns: DataTableColumns<any> = [
  { title: '域名', key: 'hostname', minWidth: 120, ellipsis: { tooltip: true } },
  { title: '环境', key: 'environment', width: 100, render: (row) => h(NTag, { size: 'small', type: row.environment === 'production' ? 'success' : 'warning' }, { default: () => row.environment || '-' }) },
  { title: '操作', key: 'actions', width: 80, render: (row) => isDemoAccount(accountId.value)
    ? null
    : h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeleteDomain(row) }, { default: () => '删除' }) },
];

const routeColumns: DataTableColumns<any> = [
  { title: 'Pattern', key: 'pattern', minWidth: 120, ellipsis: true },
  { title: 'Script', key: 'script', width: 150 },
  { title: 'ID', key: 'id', width: 120, ellipsis: true },
  { title: '操作', key: 'actions', width: 80, render: (row) => isDemoAccount(accountId.value)
    ? null
    : h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeleteRoute(row) }, { default: () => '删除' }) },
];

const deploymentColumns: DataTableColumns<any> = [
  { title: 'ID', key: 'id', width: 120, ellipsis: true },
  { title: '创建时间', key: 'created_on', width: 170, render: (row) => row.created_on ? formatCN(row.created_on) : '-' },
  { title: '来源', key: 'source', width: 100, render: (row) => row.source || '-' },
];

// 打开抽屉时加载数据
watch(
  () => [props.show, props.worker?.name, props.worker?.cfAccountId] as const,
  () => {
  if (props.show && props.worker) {
    loadSecrets();
    loadSchedules();
    loadDomains();
    loadSubdomain();
    loadScriptSettings();
    loadScriptContent();
    loadDeployments();
  }
  },
  { immediate: true },
);
</script>
