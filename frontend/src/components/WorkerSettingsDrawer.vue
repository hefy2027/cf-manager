<template>
  <n-drawer v-model:show="visible" :width="drawerWidth(860)" placement="right">
    <n-drawer-content :title="t('workerSettings.drawerTitle', { name: workerName })" closable>
      <n-tabs type="line" animated>
        <!-- Secrets -->
        <n-tab-pane name="secrets" :tab="t('workerSettings.tabs.secrets')">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">{{ t('workerSettings.envAndSecrets') }}</n-text>
              <n-space>
                <n-button size="small" @click="openEnvSync">{{ t('workerSettings.syncToOther') }}</n-button>
                <n-button size="small" type="primary" @click="openVarModal()">{{ t('workerSettings.addVar') }}</n-button>
              </n-space>
            </n-space>
            <n-spin :show="secretsLoading">
              <n-data-table :columns="secretColumns" :data="secrets" :bordered="false" size="small" :scroll-x="500" />
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Cron Triggers -->
        <n-tab-pane name="schedules" :tab="t('workerSettings.tabs.schedules')">
          <n-space vertical>
            <n-text depth="3">{{ t('workerSettings.schedulesHint') }}</n-text>
            <n-spin :show="schedulesLoading">
              <!-- 已配置的触发器 -->
              <n-data-table v-if="schedules.length" :columns="scheduleColumns" :data="schedules" :bordered="false" size="small" style="margin-bottom: 12px" :scroll-x="500" />

              <!-- Cron 构建器 -->
              <n-card size="small" :title="t('workerSettings.buildCron')" style="margin-top: 8px">
                <n-space vertical :size="12">
                  <!-- 常用预设 -->
                  <n-space :wrap="true" :size="4">
                    <n-button v-for="p in cronPresets" :key="p.value" :size="'tiny'" :type="cronPreset === p.value ? 'primary' : 'default'" secondary @click="applyPreset(p.value)">{{ p.label }}</n-button>
                    <n-button size="tiny" @click="showCronFields = !showCronFields">{{ showCronFields ? t('workerSettings.collapse') : t('workerSettings.custom') }}</n-button>
                  </n-space>
                  <!-- 5 字段选择器 -->
                  <n-grid v-if="showCronFields" :cols="isMobileCron ? 2 : 5" :x-gap="6" :y-gap="6">
                    <n-gi>
                      <n-form-item :label="t('workerSettings.minute')" label-placement="top" size="small">
                        <n-input v-model:value="cronMin" size="small" placeholder="*" @update:value="onCronFieldChange" />
                      </n-form-item>
                    </n-gi>
                    <n-gi>
                      <n-form-item :label="t('workerSettings.hour')" label-placement="top" size="small">
                        <n-input v-model:value="cronHour" size="small" placeholder="*" @update:value="onCronFieldChange" />
                      </n-form-item>
                    </n-gi>
                    <n-gi>
                      <n-form-item :label="t('workerSettings.day')" label-placement="top" size="small">
                        <n-input v-model:value="cronDay" size="small" placeholder="*" @update:value="onCronFieldChange" />
                      </n-form-item>
                    </n-gi>
                    <n-gi>
                      <n-form-item :label="t('workerSettings.month')" label-placement="top" size="small">
                        <n-input v-model:value="cronMon" size="small" placeholder="*" @update:value="onCronFieldChange" />
                      </n-form-item>
                    </n-gi>
                    <n-gi>
                      <n-form-item :label="t('workerSettings.week')" label-placement="top" size="small">
                        <n-input v-model:value="cronDow" size="small" placeholder="*" @update:value="onCronFieldChange" />
                      </n-form-item>
                    </n-gi>
                  </n-grid>
                  <!-- 实时预览 -->
                  <n-space align="center">
                    <n-tag type="info" size="large">{{ builtCron }}</n-tag>
                    <n-text v-if="cronDesc" depth="3" style="font-size: 12px">{{ cronDesc }}</n-text>
                    <n-button size="small" type="primary" @click="addCronToList" :disabled="!isBuiltCronValid || cronExpressions.includes(builtCron)">{{ t('workerSettings.addToList') }}</n-button>
                  </n-space>
                  <n-text v-if="!isBuiltCronValid" type="error" style="font-size: 12px">{{ t('workerSettings.cronInvalid') }}</n-text>
                </n-space>
              </n-card>

              <!-- 待保存列表 -->
              <n-space v-if="cronExpressions.length" style="margin-top: 16px">
                <n-tag v-for="(c, i) in cronExpressions" :key="i" closable @close="cronExpressions.splice(i, 1)" :type="c === builtCron ? 'info' : 'default'">{{ c }} <n-text depth="3" style="font-size: 10px">{{ describeCron(c) }}</n-text></n-tag>
              </n-space>
              <n-empty v-else style="margin-top: 12px" :description="t('workerSettings.noCron')" size="small" />

              <n-button size="small" type="primary" style="margin-top: 12px" :loading="schedulesSaving" @click="saveSchedules" :disabled="!cronExpressions.length && !schedules.length">{{ t('workerSettings.saveSchedules') }}</n-button>
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Domains -->
        <n-tab-pane name="domains" :tab="t('workerSettings.tabs.domains')">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">{{ t('workerSettings.domainsHint') }}</n-text>
              <n-button size="small" type="primary" @click="openDomainModal">{{ t('workerSettings.addDomain') }}</n-button>
            </n-space>
            <n-spin :show="domainsLoading">
              <n-data-table :columns="domainColumns" :data="domains" :bordered="false" size="small" :scroll-x="500" />
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Subdomain -->
        <n-tab-pane name="subdomain" :tab="t('workerSettings.tabs.subdomain')">
          <n-space vertical>
            <n-text depth="3">{{ t('workerSettings.subdomainHint') }}</n-text>
            <n-spin :show="subdomainLoading">
              <n-card size="small" v-if="subdomainInfo">
                <n-space vertical>
                  <n-space align="center">
                    <n-text>{{ t('workerSettings.enableStatus') }}</n-text>
                    <n-tag :type="subdomainInfo.enabled ? 'success' : 'default'">{{ subdomainInfo.enabled ? t('workerSettings.enabled') : t('workerSettings.notEnabled') }}</n-tag>
                    <n-switch :value="subdomainInfo.enabled" @update:value="toggleSubdomain" :loading="subdomainSaving" />
                  </n-space>
                  <n-space v-if="subdomainInfo.previews_enabled !== undefined" align="center">
                    <n-text>{{ t('workerSettings.previewDeploy') }}</n-text>
                    <n-tag :type="subdomainInfo.previews_enabled ? 'success' : 'default'">{{ subdomainInfo.previews_enabled ? t('workerSettings.enabled') : t('workerSettings.notEnabled') }}</n-tag>
                  </n-space>
                  <n-space v-if="subdomainInfo.url" align="center">
                    <n-text>{{ t('workerSettings.accessUrl') }}</n-text>
                    <n-a :href="subdomainInfo.url" target="_blank" type="primary">{{ subdomainInfo.url }}</n-a>
                  </n-space>
                  <n-text v-if="subdomainInfo && !subdomainInfo.url && subdomainInfo.accountSubdomain === ''" depth="3" style="font-size: 12px;">{{ t('workerSettings.subdomainNotConfigured') }}</n-text>
                </n-space>
              </n-card>
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Settings -->
        <n-tab-pane name="settings" :tab="t('workerSettings.tabs.settings')">
          <n-space vertical>
            <n-text depth="3">{{ t('workerSettings.scriptSettingsHint') }}</n-text>
            <n-spin :show="scriptSettingsLoading">
              <n-card size="small" v-if="scriptSettings">
                <n-form label-placement="left" label-width="120">
                  <n-form-item :label="t('workerSettings.observability')">
                    <n-switch :value="scriptSettings.observability?.enabled" @update:value="(v: boolean) => updateScriptSetting('observability', { enabled: v })" />
                  </n-form-item>
                  <n-form-item label="Logpush">
                    <n-switch :value="scriptSettings.logpush" @update:value="(v: boolean) => updateScriptSetting('logpush', v)" />
                  </n-form-item>
                  <n-form-item v-if="scriptSettings.tags" :label="t('workerSettings.tags')">
                    <n-dynamic-tags v-model:value="scriptSettings.tags" />
                  </n-form-item>
                </n-form>
              </n-card>
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Routes -->
        <n-tab-pane name="routes" :tab="t('workerSettings.tabs.routes')">
          <n-space vertical>
            <n-space>
              <n-select
                v-model:value="routeZoneId"
                :options="zoneIdOptions"
                filterable
                :placeholder="t('workerSettings.selectZone')"
                :loading="zonesLoading"
                size="small"
                style="width: 280px"
              />
              <n-button size="small" type="primary" @click="loadRoutes">{{ t('workerSettings.loadRoutes') }}</n-button>
              <n-button size="small" @click="openRouteModal">{{ t('workerSettings.addRoute') }}</n-button>
            </n-space>
            <n-spin :show="routesLoading">
              <n-data-table :columns="routeColumns" :data="routes" :bordered="false" size="small" :scroll-x="500" />
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Source Code -->
        <n-tab-pane name="source" :tab="t('workerSettings.tabs.source')">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">{{ t('workerSettings.sourceHint') }}</n-text>
              <n-space>
                <n-button size="small" :disabled="!scriptContent" @click="copyScript">{{ t('workerSettings.copy') }}</n-button>
                <n-button size="small" @click="loadScriptContent">{{ t('common.refresh') }}</n-button>
              </n-space>
            </n-space>
            <n-spin :show="contentLoading">
              <n-code v-if="scriptContent" :code="scriptContent" language="javascript" :hljs="hljs" :word-wrap="true" :show-line-numbers="true" style="max-height: 500px; overflow: auto" />
              <n-empty v-else-if="!contentLoading" :description="t('workerSettings.sourceEmpty')" />
            </n-spin>
          </n-space>
        </n-tab-pane>

        <!-- Deployments -->
        <n-tab-pane name="deployments" :tab="t('workerSettings.tabs.deployments')">
          <n-space vertical>
            <n-space justify="space-between">
              <n-text depth="3">{{ t('workerSettings.deploymentsHint') }}</n-text>
              <n-button size="small" @click="loadDeployments">{{ t('common.refresh') }}</n-button>
            </n-space>
            <n-spin :show="deploymentsLoading">
              <n-data-table :columns="deploymentColumns" :data="deployments" :bordered="false" size="small" :scroll-x="600" :pagination="{ pageSize: 10 }" />
            </n-spin>
          </n-space>
        </n-tab-pane>
      </n-tabs>
    </n-drawer-content>
  </n-drawer>

  <!-- 变量 Modal（明文 + 机密统一，对齐 Pages 抽屉 UI） -->
  <n-modal v-model:show="showSecretModal" preset="dialog" :title="secretEditing ? t('workerSettings.editVar') : t('workerSettings.addVar')" style="width: 450px; max-width: 95vw">
    <n-form :model="secretForm" label-placement="left" label-width="80">
      <n-form-item :label="t('workerSettings.secretName')">
        <n-input v-model:value="secretForm.name" :placeholder="t('workerSettings.secretNamePlaceholder')" :disabled="secretEditing" />
      </n-form-item>
      <n-form-item :label="t('workerSettings.typeLabel')">
        <n-select v-model:value="secretForm.type" :options="typeOptions" :disabled="secretEditing" />
      </n-form-item>
      <n-form-item :label="t('workerSettings.varValueLabel')">
        <n-input v-model:value="secretForm.value" :type="secretForm.type === 'secret_text' ? 'password' : 'text'" show-password-on="click" :placeholder="t('workerSettings.varValuePlaceholder')" />
      </n-form-item>
    </n-form>
    <template #action>
      <n-button @click="showSecretModal = false">{{ t('common.cancel') }}</n-button>
      <n-button type="primary" :loading="secretSaving" @click="handleSaveVar">{{ t('common.save') }}</n-button>
    </template>
  </n-modal>

  <!-- Domain Modal -->
  <n-modal v-model:show="showDomainModal" preset="dialog" :title="t('workerSettings.domainModalTitle')" style="width: 520px; max-width: 95vw">
    <n-form :model="domainForm" label-placement="left" label-width="80">
      <n-form-item :label="t('workerSettings.domain')">
        <n-select
          v-model:value="domainForm.zoneName"
          :options="zoneOptions"
          filterable
          tag
          :placeholder="t('workerSettings.domainPlaceholder')"
          :loading="zonesLoading"
        />
      </n-form-item>
      <n-form-item v-if="isZoneSelected" :label="t('workerSettings.domainSubdomain')">
        <n-input-group>
          <n-input v-model:value="domainForm.subdomain" :placeholder="t('workerSettings.domainSubdomainPlaceholder')" />
          <n-input :value="`.${domainForm.zoneName}`" disabled style="width: 40%" />
        </n-input-group>
      </n-form-item>
      <n-form-item v-if="composedHostname" :label="t('workerSettings.preview')">
        <n-tag type="info" size="large">{{ composedHostname }}</n-tag>
      </n-form-item>
      <n-form-item :label="t('workerSettings.environment')">
        <n-select v-model:value="domainForm.environment" :options="[{label:'production',value:'production'},{label:'staging',value:'staging'}]" clearable />
      </n-form-item>
    </n-form>
    <template #action>
      <n-button @click="showDomainModal = false">{{ t('common.cancel') }}</n-button>
      <n-button type="primary" :loading="domainSaving" @click="handleAddDomain">{{ t('common.save') }}</n-button>
    </template>
  </n-modal>

  <!-- Route Modal -->
  <n-modal v-model:show="showRouteModal" preset="dialog" :title="t('workerSettings.routeModalTitle')" style="width: 500px; max-width: 95vw">
    <n-form :model="routeForm" label-placement="left" label-width="80">
      <n-form-item label="Zone">
        <n-select
          v-model:value="routeForm.zone_id"
          :options="zoneIdOptions"
          filterable
          :placeholder="t('workerSettings.selectZone')"
          :loading="zonesLoading"
          @update:value="onRouteZoneChange"
        />
      </n-form-item>
      <n-form-item :label="t('workerSettings.pattern')">
        <n-input v-model:value="routeForm.pattern" placeholder="example.com/*" />
      </n-form-item>
    </n-form>
    <template #action>
      <n-button @click="showRouteModal = false">{{ t('common.cancel') }}</n-button>
      <n-button type="primary" :loading="routeSaving" @click="handleAddRoute">{{ t('common.save') }}</n-button>
    </template>
  </n-modal>

  <!-- 环境同步 Modal -->
  <n-modal v-model:show="showEnvSyncModal" preset="dialog" :title="t('workerSettings.envSyncTitle')" style="width: 600px; max-width: 95vw">
    <n-form label-placement="left" label-width="100">
      <n-form-item :label="t('workerSettings.sourceLabel')">
        <n-text>{{ workerName }} ({{ accountId }})</n-text>
      </n-form-item>
      <n-form-item :label="t('workerSettings.targetWorkers')">
        <n-checkbox-group v-model:value="syncTargets">
          <n-space vertical>
            <n-checkbox v-for="w in workerStore.workers.filter((w: any) => w.type === 'worker' && !(w.cfAccountId === accountId && w.name === workerName))" :key="`${w.cfAccountId}-${w.name}`" :value="`${w.cfAccountId}:${w.name}`">
              {{ w.accountName }} / {{ w.name }}
            </n-checkbox>
          </n-space>
        </n-checkbox-group>
      </n-form-item>
      <n-form-item :label="t('workerSettings.secretValue')">
        <n-text depth="3" style="font-size: 12px">{{ t('workerSettings.secretValueHint') }}</n-text>
      </n-form-item>
      <div v-for="s in secrets" :key="s.name" style="margin-bottom: 8px">
        <n-input-group>
          <n-input :value="s.name" disabled style="width: 200px" />
          <n-input v-model:value="syncSecretValues[s.name]" type="password" show-password-on="click" :placeholder="t('workerSettings.inputValuePlaceholder')" />
        </n-input-group>
      </div>
    </n-form>
    <div v-if="syncResults.length" style="margin-top: 12px">
      <n-tag v-for="r in syncResults" :key="`${r.accountId}-${r.workerName}`" :type="r.success ? 'success' : 'error'" size="small" style="margin: 2px">
        {{ r.workerName }}: {{ r.success ? `${r.synced} ${t('workerSettings.synced')}` : r.error }}
      </n-tag>
    </div>
    <template #action>
      <n-button @click="showEnvSyncModal = false">{{ t('common.close') }}</n-button>
      <n-button type="primary" :loading="syncing" @click="handleEnvSync" :disabled="!syncTargets.length">{{ t('workerSettings.sync') }}</n-button>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, computed, watch, h } from 'vue';
import { useI18n } from 'vue-i18n';
import { NTag, NSpace, NButton, NA, useMessage } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/github-dark.css';
import { workersApi } from '../api/workers';
import { useWorkerStore } from '../stores/workerStore';
import { formatCN } from '../utils/dateFormat';
import { isDemoAccount } from '../utils/demoAccounts';
import { isValidCronExpression, normalizeCronExpression } from '../utils/cronValidation';

const { t } = useI18n();

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

// Secrets (环境变量：明文 + 机密统一管理)
const secrets = ref<any[]>([]);
const secretsLoading = ref(false);
const showSecretModal = ref(false);
const secretSaving = ref(false);
const secretEditing = ref(false);
const secretForm = ref({ name: '', value: '', type: 'plain_text' });

// Schedules
const schedules = ref<any[]>([]);
const schedulesLoading = ref(false);
const schedulesSaving = ref(false);
const cronExpressions = ref<string[]>([]);

// Cron builder
const cronPresets = computed(() => [
  { label: t('workerSettings.cronPresets.everyMinute'), value: '* * * * *' },
  { label: t('workerSettings.cronPresets.every5Min'), value: '*/5 * * * *' },
  { label: t('workerSettings.cronPresets.every15Min'), value: '*/15 * * * *' },
  { label: t('workerSettings.cronPresets.every30Min'), value: '*/30 * * * *' },
  { label: t('workerSettings.cronPresets.everyHour'), value: '0 * * * *' },
  { label: t('workerSettings.cronPresets.every2Hour'), value: '0 */2 * * *' },
  { label: t('workerSettings.cronPresets.daily0'), value: '0 0 * * *' },
  { label: t('workerSettings.cronPresets.weekly0'), value: '0 0 * * SUN' },
  { label: t('workerSettings.cronPresets.monthly1'), value: '0 0 1 * *' },
]);
const cronPreset = ref('');
const showCronFields = ref(false);
const cronMin = ref('*');
const cronHour = ref('*');
const cronDay = ref('*');
const cronMon = ref('*');
const cronDow = ref('*');
const isMobileCron = ref(window.innerWidth <= 768);
const builtCron = computed(() => normalizeCronExpression(`${cronMin.value} ${cronHour.value} ${cronDay.value} ${cronMon.value} ${cronDow.value}`));
const isBuiltCronValid = computed(() => isValidCronExpression(builtCron.value));

function describeCron(cron: string): string {
  if (!cron) return '';
  // 预设匹配
  const preset = cronPresets.value.find(p => p.value === cron);
  if (preset) return preset.label;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return '';
  const fieldLabels = [t('workerSettings.minute'), t('workerSettings.hour'), t('workerSettings.day'), t('workerSettings.month'), t('workerSettings.week')];
  const desc = fieldLabels.map((label, i) => parts[i] === '*' ? '' : `${label}${parts[i]}`);
  return desc.filter(Boolean).join(' ') || `${t('workerSettings.minute')}/${t('workerSettings.hour')}/${t('workerSettings.day')}/${t('workerSettings.month')}/${t('workerSettings.week')}`;
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
  if (!isValidCronExpression(expr)) {
    message.warning(t('workerSettings.cronInvalid'));
    return;
  }
  if (!cronExpressions.value.includes(expr)) {
    cronExpressions.value.push(expr);
  }
}

// Domains
const domains = ref<any[]>([]);
const domainsLoading = ref(false);
const showDomainModal = ref(false);
const domainSaving = ref(false);
const domainForm = ref({ zoneName: '', subdomain: '', environment: '' });
const isZoneSelected = computed(() =>
  !!domainForm.value.zoneName && zones.value.some((z: any) => z.name === domainForm.value.zoneName)
);
const composedHostname = computed(() => {
  const zone = domainForm.value.zoneName;
  if (!zone) return '';
  const sub = domainForm.value.subdomain?.trim();
  return sub ? `${sub}.${zone}` : zone;
});

// Zones（用于域名选择和路由选择）
const zones = ref<any[]>([]);
const zonesLoading = ref(false);
const zoneOptions = computed(() =>
  zones.value.map((z: any) => ({ label: `${z.name} (${z.status})`, value: z.name }))
);
const zoneIdOptions = computed(() =>
  zones.value.map((z: any) => ({ label: `${z.name} (${z.status})`, value: z.id }))
);

async function loadZones() {
  if (zones.value.length) return; // 已加载过则跳过
  zonesLoading.value = true;
  try {
    const { data } = await workersApi.getZones(accountId.value);
    zones.value = Array.isArray(data) ? data : [];
  } catch { zones.value = []; }
  finally { zonesLoading.value = false; }
}

async function openDomainModal() {
  domainForm.value = { zoneName: '', subdomain: '', environment: '' };
  showDomainModal.value = true;
  loadZones();
}

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
    // 合并显示所有环境变量：明文（getWorkerConfig）+ 机密（config vars + secrets API 补充）
    const [cfg, sec] = await Promise.all([
      workersApi.getWorkerConfig(accountId.value, workerName.value),
      workersApi.getSecrets(accountId.value, workerName.value),
    ]);
    const cfgVars = (cfg?.data?.vars || []) as any[];
    const secList = (Array.isArray(sec?.data) ? sec.data : []) as any[];
    const merged: any[] = [
      ...cfgVars.map((v: any) => ({ name: v.name, type: v.secret ? 'secret_text' : 'plain_text', value: v.value ?? '' })),
      ...secList.filter((s: any) => !cfgVars.some((v: any) => v.name === s.name)).map((s: any) => ({ name: s.name, type: 'secret_text', value: '' })),
    ];
    secrets.value = merged;
  } catch { secrets.value = []; }
  finally { secretsLoading.value = false; }
}

// 统一 type 选择：明文 / 机密
const typeOptions = computed(() => [
  { label: t('workers.envVars.plainLabel'), value: 'plain_text' },
  { label: t('workerSettings.secretTextLabel'), value: 'secret_text' },
]);

function openVarModal(row?: any) {
  secretEditing.value = !!row;
  secretForm.value = row
    ? { name: row.name, value: '', type: row.type || 'plain_text' }
    : { name: '', value: '', type: 'plain_text' };
  showSecretModal.value = true;
}

// 保存变量：明文走 batchDeploy 重部署（同时保留机密 keep=true），机密走 updateSecret
async function handleSaveVar() {
  const form = secretForm.value;
  if (!form.name) { message.warning(t('workerSettings.msg.nameRequired')); return; }
  secretSaving.value = true;
  try {
    if (form.type === 'plain_text') {
      // 明文：收集当前所有 vars（机密 keep=true），替换/添加该 name 的明文，batchDeploy 重部署
      const cfg = await workersApi.getWorkerConfig(accountId.value, workerName.value);
      const currentVars = (cfg?.data?.vars || []) as any[];
      const nextVars = currentVars
        .filter((v: any) => v.name !== form.name)
        .map((v: any) => ({ name: v.name, value: '', secret: !!v.secret, keep: !!v.secret }));
      nextVars.push({ name: form.name, value: form.value, secret: false, keep: false });
      await workersApi.batchDeploy(
        [{ accountId: accountId.value, workerName: workerName.value }],
        { isRedeploy: true, vars: nextVars },
      );
    } else {
      // 机密：PUT /secrets/:name
      await workersApi.updateSecret(accountId.value, workerName.value, form.name, 'secret_text', form.value, '');
    }
    message.success(t('workerSettings.msg.varSaved'));
    showSecretModal.value = false;
    loadSecrets();
  } catch (e: any) {
    message.error(e?.errorMessage || e?.message || t('workerSettings.msg.saveFailed'));
  } finally { secretSaving.value = false; }
}

// 删除变量：明文走 batchDeploy 移除（机密 keep），机密走 deleteSecret
async function handleDeleteVar(row: any) {
  secretSaving.value = true;
  try {
    if (row.type === 'plain_text') {
      const cfg = await workersApi.getWorkerConfig(accountId.value, workerName.value);
      const currentVars = (cfg?.data?.vars || []) as any[];
      const nextVars = currentVars
        .filter((v: any) => v.name !== row.name)
        .map((v: any) => ({ name: v.name, value: '', secret: !!v.secret, keep: !!v.secret }));
      await workersApi.batchDeploy(
        [{ accountId: accountId.value, workerName: workerName.value }],
        { isRedeploy: true, vars: nextVars },
      );
    } else {
      await workersApi.deleteSecret(accountId.value, workerName.value, row.name);
    }
    message.success(t('workerSettings.msg.varDeleted'));
    loadSecrets();
  } catch (e: any) {
    message.error(e?.errorMessage || e?.message || t('workerSettings.msg.deleteFailed'));
  } finally { secretSaving.value = false; }
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
  const normalized = cronExpressions.value.map(normalizeCronExpression);
  if (!normalized.every(isValidCronExpression)) {
    message.warning(t('workerSettings.cronInvalid'));
    return;
  }
  cronExpressions.value = [...new Set(normalized)];
  schedulesSaving.value = true;
  try {
    await workersApi.updateSchedules(accountId.value, workerName.value, cronExpressions.value);
    message.success(t('workerSettings.msg.schedulesSaved'));
    loadSchedules();
  } catch (e: any) {
    message.error(e?.errorMessage || e?.message || t('workerSettings.msg.saveFailed'));
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
  if (!composedHostname.value) { message.warning(t('workerSettings.msg.domainRequired')); return; }
  domainSaving.value = true;
  try {
    await workersApi.createDomain(accountId.value, workerName.value, composedHostname.value, domainForm.value.environment || undefined);
    message.success(t('workerSettings.msg.domainAdded'));
    showDomainModal.value = false;
    domainForm.value = { zoneName: '', subdomain: '', environment: '' };
    loadDomains();
  } finally { domainSaving.value = false; }
}

async function handleDeleteDomain(row: any) {
  await workersApi.deleteDomain(accountId.value, workerName.value, row.id);
  message.success(t('workerSettings.msg.domainDeleted'));
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
    message.success(val ? t('workerSettings.msg.subdomainEnabled') : t('workerSettings.msg.subdomainDisabled'));
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
  message.success(t('workerSettings.msg.settingsUpdated'));
  loadScriptSettings();
}

async function loadRoutes() {
  if (!routeZoneId.value) { message.warning(t('workerSettings.msg.zoneRequired')); return; }
  routesLoading.value = true;
  try {
    const { data } = await workersApi.getRoutes(accountId.value, workerName.value, routeZoneId.value);
    routes.value = Array.isArray(data) ? data : [];
  } catch { routes.value = []; }
  finally { routesLoading.value = false; }
}

async function openRouteModal() {
  routeForm.value = { zone_id: routeZoneId.value || '', pattern: '' };
  showRouteModal.value = true;
  loadZones();
}

function onRouteZoneChange(zoneId: string) {
  // 根据选中的 Zone 自动建议 pattern
  const zone = zones.value.find((z: any) => z.id === zoneId);
  if (zone && !routeForm.value.pattern) {
    routeForm.value.pattern = `${zone.name}/*`;
  }
}

async function handleAddRoute() {
  if (!routeForm.value.zone_id || !routeForm.value.pattern) { message.warning(t('workerSettings.msg.infoRequired')); return; }
  routeSaving.value = true;
  try {
    await workersApi.createRoute(accountId.value, workerName.value, routeForm.value.zone_id, routeForm.value.pattern);
    message.success(t('workerSettings.msg.routeAdded'));
    showRouteModal.value = false;
    routeZoneId.value = routeForm.value.zone_id;
    routeForm.value = { zone_id: '', pattern: '' };
    loadRoutes();
  } finally { routeSaving.value = false; }
}

async function handleDeleteRoute(row: any) {
  if (!routeZoneId.value) return;
  await workersApi.deleteRoute(accountId.value, workerName.value, row.id, routeZoneId.value);
  message.success(t('workerSettings.msg.routeDeleted'));
  loadRoutes();
}

async function loadScriptContent() {
  contentLoading.value = true;
  try {
    const { data } = await workersApi.getContent(accountId.value, workerName.value);
    scriptContent.value = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  } catch (e: any) { scriptContent.value = t('workerSettings.msg.loadFailed', { error: e?.errorMessage || e?.message || '' }); }
  finally { contentLoading.value = false; }
}

async function copyScript() {
  if (!scriptContent.value) return;
  try {
    await navigator.clipboard.writeText(scriptContent.value);
    message.success(t('workerSettings.msg.copied'));
  } catch {
    message.error(t('workerSettings.msg.copyFailed'));
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
  const targets = syncTargets.value.map(item => {
    const [a, n] = item.split(':');
    return { accountId: Number(a), workerName: n };
  });
  const nonEmptyValues: Record<string, string> = {};
  for (const [k, v] of Object.entries(syncSecretValues.value)) {
    if (v) nonEmptyValues[k] = v;
  }
  if (Object.keys(nonEmptyValues).length === 0) {
    message.warning(t('workerSettings.msg.atLeastOneSecret'));
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
    message.success(t('workerSettings.msg.syncComplete', { success: successCount, total: targets.length }));
  } finally { syncing.value = false; }
}

// Columns
const secretColumns = computed<DataTableColumns<any>>(() => [
  { title: t('workerSettings.secretName'), key: 'name', minWidth: 100 },
  { title: t('workerSettings.secretType'), key: 'type', width: 100, render: (row) => h(NTag, { size: 'small', type: row.type === 'secret_text' ? 'warning' : 'info', bordered: false }, { default: () => row.type === 'secret_text' ? t('workers.envVars.secretLabel') : t('workers.envVars.plainLabel') }) },
  { title: t('workerSettings.varValueLabel'), key: 'value', minWidth: 160, render: (row) => row.type === 'secret_text' ? h('span', { style: 'color:#999' }, '******') : (row.value || h('span', { style: 'color:#999' }, '—')) },
  { title: t('common.actions'), key: 'actions', width: 150, render: (row) => h(NSpace, { size: 4 }, {
    default: () => [
      h(NButton, { size: 'tiny', onClick: () => openVarModal(row) }, { default: () => t('common.edit') }),
      ...(isDemoAccount(accountId.value) ? [] : [
        h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeleteVar(row) }, { default: () => t('common.delete') }),
      ]),
    ],
  }) },
]);

const scheduleColumns = computed<DataTableColumns<any>>(() => [
  { title: t('workerSettings.cronExpr'), key: 'cron', minWidth: 120, render: (row) => h('div', {}, [
    h('div', { style: { fontFamily: 'monospace' } }, row.cron),
    h('div', { style: { fontSize: '11px', color: '#999' } }, describeCron(row.cron)),
  ]) },
  { title: t('workerSettings.modifiedTime'), key: 'modified_on', width: 170, render: (row) => row.modified_on ? formatCN(row.modified_on) : '-' },
]);

const domainColumns = computed<DataTableColumns<any>>(() => [
  {
    title: t('workerSettings.domain'), key: 'hostname', minWidth: 180, ellipsis: { tooltip: true },
    render: (row) => h(NA, { href: `https://${row.hostname}`, target: '_blank', type: 'primary' }, { default: () => row.hostname }),
  },
  { title: t('workerSettings.environment'), key: 'environment', width: 100, render: (row) => h(NTag, { size: 'small', type: row.environment === 'production' ? 'success' : 'warning' }, { default: () => row.environment || '-' }) },
  { title: t('common.actions'), key: 'actions', width: 140, render: (row) => isDemoAccount(accountId.value)
    ? h(NButton, { size: 'tiny', type: 'info', onClick: () => window.open(`https://${row.hostname}`, '_blank') }, { default: () => t('workerSettings.open') })
    : h(NSpace, { size: 4 }, {
        default: () => [
          h(NButton, { size: 'tiny', type: 'info', onClick: () => window.open(`https://${row.hostname}`, '_blank') }, { default: () => t('workerSettings.open') }),
          h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeleteDomain(row) }, { default: () => t('common.delete') }),
        ],
      }),
  },
]);

const routeColumns = computed<DataTableColumns<any>>(() => [
  { title: t('workerSettings.pattern'), key: 'pattern', minWidth: 120, ellipsis: true },
  { title: 'Script', key: 'script', width: 150 },
  { title: 'ID', key: 'id', width: 120, ellipsis: true },
  { title: t('common.actions'), key: 'actions', width: 80, render: (row) => isDemoAccount(accountId.value)
    ? null
    : h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeleteRoute(row) }, { default: () => t('common.delete') }) },
]);

const deploymentColumns = computed<DataTableColumns<any>>(() => [
  { title: 'ID', key: 'id', width: 120, ellipsis: true },
  { title: t('workerSettings.createdTime'), key: 'created_on', width: 170, render: (row) => row.created_on ? formatCN(row.created_on) : '-' },
  { title: t('workerSettings.sourceLabel'), key: 'source', width: 100, render: (row) => row.source || '-' },
]);

// 打开抽屉时加载数据
watch(
  () => [props.show, props.worker?.name, props.worker?.cfAccountId] as const,
  () => {
  if (props.show && props.worker) {
    zones.value = []; // 重置 zones，新 worker 重新加载
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
