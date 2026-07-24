<template>
  <div class="page-view">
    <n-tabs type="line" animated>
      <!-- ============ 隧道管理 ============ -->
      <n-tab-pane name="tunnels" tab="隧道管理">
        <n-space vertical>
          <n-space align="center">
            <n-select
              v-model:value="selectedAccountId"
              :options="accountOptions"
              placeholder="选择账户"
              style="width: 260px"
              @update:value="onAccountChange"
            />
            <n-button type="primary" size="small" :disabled="!selectedAccountId" @click="showCreateModal = true">创建隧道</n-button>
            <n-button size="small" :disabled="!selectedAccountId" @click="openWizard">一键回源向导</n-button>
            <n-button size="small" @click="loadAccounts" :loading="loadingAccounts">刷新</n-button>
          </n-space>

          <n-data-table
            :columns="tunnelColumns"
            :data="tunnels"
            :loading="loadingTunnels"
            size="small"
            :bordered="false"
            :scroll-x="600"
          />
        </n-space>
      </n-tab-pane>

      <!-- ============ 规则引擎 ============ -->
      <n-tab-pane name="rules-engine" tab="规则引擎">
        <n-space vertical>
          <n-space align="center">
            <n-select
              v-model:value="selectedDomain"
              :options="domainOptions"
              placeholder="选择域名"
              filterable
              style="width: 220px"
              @update:value="onDomainChange"
            />
            <n-select
              v-model:value="selectedRulePhase"
              :options="rulePhaseOptions"
              placeholder="规则类型"
              style="width: 180px"
              @update:value="loadRules"
            />
            <n-button type="primary" size="small" :disabled="!selectedDomain || !selectedRulePhase" @click="openAddRule">新增规则</n-button>
            <n-button size="small" @click="loadDomains">刷新域名</n-button>
          </n-space>

          <n-alert v-if="isAccountLevelPhase" type="info" :bordered="false" style="margin-top: 4px">
            此规则类型为<strong>账户级</strong>，作用于整个 Cloudflare 账户而非单个域名。选择域名仅用于定位账户。
          </n-alert>
          <n-data-table
            :columns="ruleColumns"
            :data="rules"
            :loading="loadingRules"
            size="small"
            :bordered="false"
            :scroll-x="600"
          />
        </n-space>
      </n-tab-pane>
    </n-tabs>

    <!-- ============ 创建隧道 Modal ============ -->
    <n-modal v-model:show="showCreateModal" preset="dialog" title="创建隧道" style="width: 420px; max-width: 95vw">
      <n-form label-placement="left" label-width="80">
        <n-form-item label="名称">
          <n-input v-model:value="newTunnelName" placeholder="输入隧道名称" />
        </n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showCreateModal = false">取消</n-button>
          <n-button type="primary" :loading="creating" @click="submitCreateTunnel">创建</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- ============ 一键回源向导 Modal ============ -->
    <n-modal v-model:show="showWizardModal" preset="dialog" title="一键回源向导" style="width: 520px; max-width: 95vw">
      <n-form label-placement="left" label-width="100">
        <n-form-item label="模式">
          <n-radio-group v-model:value="wizard.mode">
            <n-radio value="create">新建隧道</n-radio>
            <n-radio value="reuse">复用已有隧道</n-radio>
          </n-radio-group>
        </n-form-item>
        <n-form-item v-if="wizard.mode === 'create'" label="隧道名称">
          <n-input v-model:value="wizard.tunnelName" placeholder="留空则自动生成" />
        </n-form-item>
        <n-form-item v-if="wizard.mode === 'reuse'" label="选择隧道">
          <n-select
            v-model:value="wizard.tunnelId"
            :options="tunnelSelectOptions"
            placeholder="选择已有隧道"
            filterable
          />
        </n-form-item>
        <n-form-item label="子域名">
          <n-input v-model:value="wizard.subdomain" placeholder="留空=根域" />
        </n-form-item>
        <n-form-item label="域名">
          <n-select v-model:value="wizard.domain" :options="zoneOptions" placeholder="选择域名" filterable />
        </n-form-item>
        <n-form-item label="协议">
          <n-radio-group v-model:value="wizard.protocol">
            <n-radio value="http">HTTP</n-radio>
            <n-radio value="https">HTTPS</n-radio>
            <n-radio value="tcp">TCP</n-radio>
          </n-radio-group>
        </n-form-item>
        <n-form-item label="端口">
          <n-input-number v-model:value="wizard.port" :min="1" :max="65535" style="width: 100%" />
        </n-form-item>
        <n-form-item label="路径">
          <n-input v-model:value="wizard.path" placeholder="正则匹配，留空=全部。如 ^/api" />
        </n-form-item>
      </n-form>
      <n-alert v-if="wizard.mode === 'reuse'" type="info" :bordered="false" style="margin-top: 8px">
        复用模式不会返回隧道令牌，请使用既有隧道的令牌运行 cloudflared。
      </n-alert>
      <template #action>
        <n-space>
          <n-button @click="showWizardModal = false">取消</n-button>
          <n-button type="primary" :loading="wizardLoading" @click="submitWizard">执行</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- ============ 令牌 Modal ============ -->
    <n-modal v-model:show="showTokenModal" preset="dialog" title="隧道连接令牌" style="width: 600px; max-width: 95vw">
      <n-space vertical>
        <n-input :value="tokenValue" readonly type="textarea" :rows="3" />
        <n-space>
          <n-button size="small" @click="copyToken">复制令牌</n-button>
        </n-space>
        <n-alert type="info" :bordered="false">
          在服务器上运行：<br />
          <code>cloudflared tunnel run --token {{ tokenValue ? '***' : '***' }}</code>
        </n-alert>
      </n-space>
      <template #action>
        <n-button @click="showTokenModal = false">关闭</n-button>
      </template>
    </n-modal>

    <!-- ============ 连接信息 Modal ============ -->
    <n-modal v-model:show="showConnectionsModal" preset="dialog" title="隧道连接状态" style="width: 600px; max-width: 95vw">
      <n-data-table :columns="connectionColumns" :data="connections" size="small" :bordered="false" />
      <template #action>
        <n-button @click="showConnectionsModal = false">关闭</n-button>
      </template>
    </n-modal>

    <!-- ============ Ingress 配置 Modal ============ -->
    <n-modal v-model:show="showConfigModal" preset="dialog" :title="`Ingress 配置 - ${configTunnelName}`" style="width: 900px; max-width: 95vw">
      <n-spin :show="loadingConfig">
        <n-space vertical>
          <n-alert type="info" :bordered="false" style="margin-bottom: 8px">
            Ingress 规则定义域名→本地服务的映射。最后一条为 catch-all（无 hostname），通常为 http_status:404。
          </n-alert>
          <div v-for="(entry, idx) in ingressEntries" :key="idx" style="display: flex; gap: 6px; align-items: center; width: 100%; flex-wrap: wrap">
            <n-input
              v-model:value="entry.subdomain"
              placeholder="子域名"
              style="flex: 0.5; min-width: 80px"
              :disabled="idx === ingressEntries.length - 1 && !entry.domain"
            />
            <n-select
              v-model:value="entry.domain"
              :options="zoneOptions"
              placeholder="域名"
              filterable
              style="flex: 0.7; min-width: 100px"
              :disabled="idx === ingressEntries.length - 1 && !entry.domain"
            />
            <n-input
              v-model:value="entry.path"
              placeholder="路径"
              style="flex: 0.5; min-width: 80px"
            />
            <n-select
              v-model:value="entry.protocol"
              :options="[
                { label: 'HTTP', value: 'http' },
                { label: 'HTTPS', value: 'https' },
                { label: 'TCP', value: 'tcp' },
                { label: '自定义', value: 'custom' },
              ]"
              style="flex: 0.4; min-width: 80px"
            />
            <n-input-number
              v-if="entry.protocol !== 'custom'"
              v-model:value="entry.port"
              :min="1"
              :max="65535"
              placeholder="端口"
              style="flex: 0.4; min-width: 70px"
            />
            <n-input
              v-else
              v-model:value="entry.customService"
              placeholder="如 http_status:404"
              style="flex: 0.6; min-width: 100px"
            />
            <n-button
              v-if="idx < ingressEntries.length - 1"
              size="small"
              quaternary
              type="error"
              @click="removeIngressEntry(idx)"
            >删除</n-button>
          </div>
          <n-space>
            <n-button size="small" @click="addIngressEntry">+ 添加规则</n-button>
          </n-space>
        </n-space>
      </n-spin>
      <template #action>
        <n-space>
          <n-button @click="showConfigModal = false">取消</n-button>
          <n-button type="primary" :loading="savingConfig" @click="saveConfig">保存配置</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- ============ 规则 Modal ============ -->
    <n-modal v-model:show="showRuleModal" preset="dialog" :title="editingRuleId ? '编辑规则' : '新增规则'" style="width: 520px; max-width: 95vw">
      <n-form label-placement="left" label-width="100">
        <n-form-item label="匹配类型">
          <n-select
            v-model:value="ruleForm.matchType"
            :options="[
              { label: '按主机名 — 当访问某个域名时触发', value: 'hostname' },
              { label: '按路径前缀 — 当访问某个路径时触发', value: 'pathPrefix' },
              { label: '按路径正则 — 用正则匹配路径', value: 'pathRegex' },
              { label: '主机名 + 路径前缀 — 同时匹配', value: 'hostAndPath' },
              { label: '自定义表达式 — 手写 Cloudflare 表达式', value: 'custom' },
            ]"
          />
        </n-form-item>
        <n-form-item v-if="ruleForm.matchType === 'hostname' || ruleForm.matchType === 'hostAndPath'" label="子域名">
          <n-input v-model:value="ruleForm.subdomain" placeholder="留空=根域" />
        </n-form-item>
        <n-form-item v-if="ruleForm.matchType === 'pathPrefix' || ruleForm.matchType === 'hostAndPath'" label="路径前缀">
          <n-input v-model:value="ruleForm.pathValue" placeholder="如 /api （匹配 /api、/api/xxx 等）" />
        </n-form-item>
        <n-form-item v-if="ruleForm.matchType === 'pathRegex'" label="路径正则">
          <n-input v-model:value="ruleForm.pathValue" placeholder="如 \.(jpg|png)$" />
        </n-form-item>
        <n-form-item v-if="ruleForm.matchType === 'custom'" label="表达式">
          <n-input v-model:value="ruleForm.expression" placeholder='如 (http.host eq "app.example.com")' />
        </n-form-item>
        <n-form-item v-if="selectedRulePhase === 'http_request_origin'" label="源站端口">
          <n-input-number v-model:value="ruleForm.port" :min="1" :max="65535" style="width: 100%" />
        </n-form-item>
        <n-form-item v-if="selectedRulePhase === 'http_request_redirect'" label="重定向URL">
          <n-input v-model:value="ruleForm.redirectUrl" placeholder="如 https://new-site.com${http.request.uri.path}" />
        </n-form-item>
        <n-form-item v-if="selectedRulePhase === 'http_request_redirect'" label="状态码">
          <n-select v-model:value="ruleForm.redirectStatus" :options="[{ label: '301 永久重定向', value: 301 }, { label: '302 临时重定向', value: 302 }, { label: '307 临时重定向(保留方法)', value: 307 }, { label: '308 永久重定向(保留方法)', value: 308 }]" />
        </n-form-item>
        <!-- URL 重写 -->
        <template v-if="selectedRulePhase === 'http_request_transform'">
          <n-form-item label="重写类型">
            <n-select v-model:value="ruleForm.rewriteType" :options="[{ label: '路径重写', value: 'path' }, { label: '查询参数重写', value: 'query' }]" />
          </n-form-item>
          <n-form-item :label="ruleForm.rewriteType === 'path' ? '新路径' : '新查询参数'">
            <n-input v-model:value="ruleForm.rewriteValue" :placeholder="ruleForm.rewriteType === 'path' ? '如 /new-path 或 ${http.request.uri.path}/v2' : '如 key=value'" />
          </n-form-item>
        </template>
        <!-- 请求头/响应头转换 -->
        <template v-if="selectedRulePhase === 'http_request_late_transform' || selectedRulePhase === 'http_response_headers_transform'">
          <n-form-item label="操作类型">
            <n-select v-model:value="ruleForm.headerOp" :options="[{ label: '设置 Header（覆盖）', value: 'set' }, { label: '添加 Header（追加）', value: 'add' }, { label: '删除 Header', value: 'remove' }]" />
          </n-form-item>
          <n-form-item label="Header 名">
            <n-input v-model:value="ruleForm.headerName" placeholder="如 X-Custom-Header" />
          </n-form-item>
          <n-form-item v-if="ruleForm.headerOp !== 'remove'" label="Header 值">
            <n-input v-model:value="ruleForm.headerValue" placeholder="如 my-value 或 ${http.request.uri.path}" />
          </n-form-item>
        </template>
        <!-- 缓存设置 -->
        <template v-if="selectedRulePhase === 'http_request_cache_settings'">
          <n-form-item label="启用缓存">
            <n-switch v-model:value="ruleForm.cacheEnabled" />
          </n-form-item>
          <n-form-item label="TTL 模式">
            <n-select v-model:value="ruleForm.cacheTtlMode" :options="[{ label: '遵循源站 TTL', value: 'respect_origin' }, { label: '自定义 TTL', value: 'custom' }]" />
          </n-form-item>
          <n-form-item v-if="ruleForm.cacheTtlMode === 'custom'" label="Edge TTL (秒)">
            <n-input-number v-model:value="ruleForm.cacheTtlValue" :min="0" style="width: 100%" />
          </n-form-item>
        </template>
        <!-- 速率限制 -->
        <template v-if="selectedRulePhase === 'http_ratelimit'">
          <n-form-item label="触发动作">
            <n-select v-model:value="ruleForm.ratelimitAction" :options="[{ label: '阻断 (Block)', value: 'block' }, { label: '验证码挑战', value: 'challenge' }, { label: 'JS 挑战', value: 'js_challenge' }]" />
          </n-form-item>
          <n-form-item label="限流维度">
            <n-select v-model:value="ruleForm.ratelimitChars" multiple :options="[{ label: 'IP 地址', value: 'ip' }, { label: '请求路径', value: 'uri.path' }, { label: '请求主机名', value: 'http.host' }]" />
          </n-form-item>
          <n-form-item label="时间窗口 (秒)">
            <n-input-number v-model:value="ruleForm.ratelimitPeriod" :min="1" :max="86400" style="width: 100%" />
          </n-form-item>
          <n-form-item label="请求数/窗口">
            <n-input-number v-model:value="ruleForm.ratelimitCount" :min="1" style="width: 100%" />
          </n-form-item>
          <n-form-item label="处罚时间 (秒)">
            <n-input-number v-model:value="ruleForm.ratelimitMitigation" :min="0" style="width: 100%" />
          </n-form-item>
        </template>
        <!-- 高级模式：原始 JSON -->
        <n-form-item v-if="needsAdvancedJson" label="高级模式">
          <n-switch v-model:value="ruleForm.showAdvancedJson" />
          <n-text depth="3" style="font-size: 12px; margin-left: 8px">开启后可直接输入原始 JSON</n-text>
        </n-form-item>
        <n-form-item v-if="ruleForm.showAdvancedJson && needsAdvancedJson" label="动作JSON">
          <n-input v-model:value="ruleForm.actionJson" :placeholder="actionJsonPlaceholder" type="textarea" :rows="3" />
        </n-form-item>
        <n-form-item label="描述">
          <n-input v-model:value="ruleForm.description" placeholder="可选，方便识别规则用途" />
        </n-form-item>
        <n-form-item v-if="ruleExpressionPreview" label="生成表达式">
          <n-input :value="ruleExpressionPreview" readonly type="textarea" :rows="2" />
        </n-form-item>
      </n-form>
      <template #action>
        <n-space>
          <n-button @click="showRuleModal = false">取消</n-button>
          <n-button type="primary" :loading="ruleSubmitting" @click="submitRule">{{ editingRuleId ? '保存' : '创建' }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- ============ 向导结果 Modal ============ -->
    <n-modal v-model:show="showWizardResult" preset="dialog" title="回源向导执行成功" style="width: 480px; max-width: 95vw">
      <n-descriptions label-placement="left" :column="1" bordered size="small">
        <n-descriptions-item label="隧道 ID">{{ wizardResult?.tunnelId }}</n-descriptions-item>
        <n-descriptions-item label="Hostname">{{ wizardResult?.hostname }}</n-descriptions-item>
        <n-descriptions-item label="CNAME 目标">{{ wizardResult?.cnameTarget }}</n-descriptions-item>
        <n-descriptions-item label="模式">{{ wizardResult?.mode === 'reuse' ? '复用隧道' : '新建隧道' }}</n-descriptions-item>
      </n-descriptions>
      <n-alert v-if="wizardResult?.mode === 'reuse'" type="info" :bordered="false" style="margin-top: 8px">
        复用模式：请使用既有隧道的令牌运行 cloudflared。
      </n-alert>
      <n-alert v-else type="success" :bordered="false" style="margin-top: 8px">
        新建隧道已创建，请点击隧道列表中的"令牌"按钮获取连接令牌。
      </n-alert>
      <template #action>
        <n-button @click="showWizardResult = false">关闭</n-button>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, h, onMounted } from 'vue';
import { NButton, NSpace, NTag, NPopconfirm } from 'naive-ui';
import { tunnelsApi } from '../api/tunnels';
import { dnsApi } from '../api/dns';
import { message } from '../utils/discreteApi';

// ============ 隧道管理 ============
const selectedAccountId = ref<number | null>(null);
const accounts = ref<Array<{ id: number; name: string; account_id: string }>>([]);
const tunnels = ref<any[]>([]);
const loadingAccounts = ref(false);
const loadingTunnels = ref(false);

const accountOptions = computed(() =>
  accounts.value.map((a) => ({ label: `${a.name} (${a.account_id})`, value: a.id }))
);

async function loadAccounts() {
  loadingAccounts.value = true;
  try {
    const { data } = await tunnelsApi.getAccounts();
    accounts.value = data;
    if (accounts.value.length > 0 && !selectedAccountId.value) {
      selectedAccountId.value = accounts.value[0].id;
      await loadTunnels();
    }
  } catch {
    accounts.value = [];
  } finally {
    loadingAccounts.value = false;
  }
}

async function loadTunnels() {
  if (!selectedAccountId.value) { tunnels.value = []; return; }
  loadingTunnels.value = true;
  try {
    const { data } = await tunnelsApi.listTunnels(selectedAccountId.value);
    tunnels.value = data;
  } catch {
    tunnels.value = [];
  } finally {
    loadingTunnels.value = false;
  }
}

async function onAccountChange() {
  await loadTunnels();
}

// 创建隧道
const showCreateModal = ref(false);
const newTunnelName = ref('');
const creating = ref(false);

async function submitCreateTunnel() {
  if (!newTunnelName.value || !selectedAccountId.value) return;
  creating.value = true;
  try {
    await tunnelsApi.createTunnel(selectedAccountId.value, newTunnelName.value);
    message.success('隧道创建成功');
    showCreateModal.value = false;
    newTunnelName.value = '';
    await loadTunnels();
  } catch {
    // error handled by interceptor
  } finally {
    creating.value = false;
  }
}

// 令牌
const showTokenModal = ref(false);
const tokenValue = ref('');

async function showToken(tunnelId: string) {
  if (!selectedAccountId.value) return;
  try {
    const { data } = await tunnelsApi.getToken(selectedAccountId.value, tunnelId);
    tokenValue.value = data.token;
    showTokenModal.value = true;
  } catch {
    // error handled by interceptor
  }
}

function copyToken() {
  navigator.clipboard.writeText(tokenValue.value).then(() => message.success('已复制到剪贴板'));
}

// 连接信息
const showConnectionsModal = ref(false);
const connections = ref<any[]>([]);

const connectionColumns = [
  { title: 'ID', key: 'id', ellipsis: { tooltip: true } },
  { title: 'Colo', key: 'colo_name' },
  { title: '版本', key: 'version' },
  { title: 'IP', key: 'ip' },
];

async function showConnections(tunnelId: string) {
  if (!selectedAccountId.value) return;
  try {
    const { data } = await tunnelsApi.getConnections(selectedAccountId.value, tunnelId);
    connections.value = data;
    showConnectionsModal.value = true;
  } catch {
    // error handled by interceptor
  }
}

// 删除隧道
async function deleteTunnel(tunnelId: string) {
  if (!selectedAccountId.value) return;
  try {
    await tunnelsApi.deleteTunnel(selectedAccountId.value, tunnelId);
    message.success('隧道已删除');
    await loadTunnels();
  } catch {
    // error handled by interceptor
  }
}

// Ingress 配置管理
const showConfigModal = ref(false);
const configTunnelId = ref('');
const configTunnelName = ref('');
const loadingConfig = ref(false);
const savingConfig = ref(false);
const ingressEntries = ref<Array<{ domain: string; subdomain: string; path: string; protocol: string; port: number; customService: string }>>([]);
const boundHostnames = ref<string[]>([]);
const tunnelZones = ref<Array<{ id: string; name: string }>>([]);
const zoneOptions = computed(() => tunnelZones.value.map((z) => ({ label: z.name, value: z.name })));

async function openConfig(tunnelId: string, name: string) {
  if (!selectedAccountId.value) return;
  configTunnelId.value = tunnelId;
  configTunnelName.value = name;
  showConfigModal.value = true;
  loadingConfig.value = true;
  try {
    const [configRes, zonesRes] = await Promise.all([
      tunnelsApi.getConfig(selectedAccountId.value, tunnelId),
      tunnelsApi.getZones(selectedAccountId.value),
    ]);
    tunnelZones.value = zonesRes.data || [];
    const ingress = configRes.data || [];
    ingressEntries.value = ingress.map((e: any) => {
      const hostname = e.hostname || '';
      const service = e.service || '';
      // 尝试从 service 解析出 protocol + port
      const m = service.match(/^(https?|tcp):\/\/localhost:(\d+)$/);
      const proto = m ? m[1] : 'custom';
      const port = m ? parseInt(m[2], 10) : 0;
      const customService = m ? '' : service;
      const path = e.path || '';
      // 从 hostname 中拆分出 domain (zone apex) 和 subdomain
      if (!hostname) return { domain: '', subdomain: '', path, protocol: proto, port, customService };
      const zone = tunnelZones.value.find((z) => hostname === z.name || hostname.endsWith('.' + z.name));
      if (zone) {
        const subdomain = hostname === zone.name ? '' : hostname.slice(0, -(zone.name.length + 1));
        return { domain: zone.name, subdomain, path, protocol: proto, port, customService };
      }
      // 未找到匹配的 zone，将整个 hostname 放入 subdomain
      return { domain: '', subdomain: hostname, path, protocol: proto, port, customService };
    });
    if (ingressEntries.value.length === 0) {
      ingressEntries.value = [{ domain: '', subdomain: '', path: '', protocol: 'custom', port: 0, customService: 'http_status:404' }];
    }
  } catch {
    ingressEntries.value = [{ domain: '', subdomain: '', path: '', protocol: 'custom', port: 0, customService: 'http_status:404' }];
    tunnelZones.value = [];
  } finally {
    loadingConfig.value = false;
  }
}

function addIngressEntry() {
  // 在 catch-all 之前插入新规则
  const catchAll = ingressEntries.value[ingressEntries.value.length - 1];
  if (catchAll && !catchAll.domain) {
    ingressEntries.value.splice(ingressEntries.value.length - 1, 0, { domain: '', subdomain: '', path: '', protocol: 'http', port: 8080, customService: '' });
  } else {
    ingressEntries.value.push({ domain: '', subdomain: '', path: '', protocol: 'http', port: 8080, customService: '' });
  }
}

function removeIngressEntry(idx: number) {
  ingressEntries.value.splice(idx, 1);
}

async function saveConfig() {
  if (!selectedAccountId.value) return;
  savingConfig.value = true;
  try {
    // 确保最后一条是 catch-all
    const last = ingressEntries.value[ingressEntries.value.length - 1];
    if (last && last.domain) {
      ingressEntries.value.push({ domain: '', subdomain: '', path: '', protocol: 'custom', port: 0, customService: 'http_status:404' });
    }
    const ingress = ingressEntries.value.map((e) => {
      const entry: any = {};
      // 组合 domain + subdomain 为 hostname
      if (e.domain) {
        entry.hostname = e.subdomain ? `${e.subdomain}.${e.domain}` : e.domain;
      }
      if (e.path) entry.path = e.path;
      // 组合 service
      entry.service = e.protocol === 'custom' ? e.customService : `${e.protocol}://localhost:${e.port}`;
      return entry;
    });
    await tunnelsApi.updateConfig(selectedAccountId.value, configTunnelId.value, ingress);
    message.success('Ingress 配置已保存');
    showConfigModal.value = false;
  } catch {
    // error handled by interceptor
  } finally {
    savingConfig.value = false;
  }
}

// 隧道表格列
const tunnelColumns = computed(() => [
  { title: '名称', key: 'name', ellipsis: { tooltip: true } },
  { title: 'ID', key: 'id', ellipsis: { tooltip: true } },
  { title: '状态', key: 'status', render: (row: any) => h(NTag, { type: row.status === 'healthy' ? 'success' : 'default', size: 'small' }, { default: () => row.status || '-' }) },
  { title: '连接数', key: 'connections', render: (row: any) => row.connections?.length || 0 },
  {
    title: '操作',
    key: 'actions',
    render: (row: any) => h(NSpace, { size: 'small' }, {
      default: () => [
        h(NButton, { size: 'small', quaternary: true, type: 'primary', onClick: () => showToken(row.id) }, { default: () => '令牌' }),
        h(NButton, { size: 'small', quaternary: true, type: 'info', onClick: () => openConfig(row.id, row.name) }, { default: () => '配置' }),
        h(NButton, { size: 'small', quaternary: true, onClick: () => showConnections(row.id) }, { default: () => '连接' }),
        h(NPopconfirm, { onPositiveClick: () => deleteTunnel(row.id) }, {
          trigger: () => h(NButton, { size: 'small', quaternary: true, type: 'error' }, { default: () => '删除' }),
          default: () => `确认删除隧道 ${row.name}?`,
        }),
      ],
    }),
  },
]);

// ============ 一键回源向导 ============
const showWizardModal = ref(false);
const wizardLoading = ref(false);
const wizard = reactive({
  mode: 'create' as 'create' | 'reuse',
  tunnelId: '',
  tunnelName: '',
  domain: '',
  subdomain: '',
  protocol: 'http',
  port: 8080,
  path: '',
});

const showWizardResult = ref(false);
const wizardResult = ref<{ tunnelId: string; hostname: string; cnameTarget: string; mode: string } | null>(null);

const tunnelSelectOptions = computed(() =>
  tunnels.value.map((t) => ({ label: `${t.name} (${t.id})`, value: t.id }))
);

function openWizard() {
  wizard.mode = 'create';
  wizard.tunnelId = '';
  wizard.tunnelName = '';
  wizard.domain = '';
  wizard.subdomain = '';
  wizard.protocol = 'http';
  wizard.port = 8080;
  wizard.path = '';
  showWizardModal.value = true;
  // 加载 zones 供域名选择
  if (selectedAccountId.value) {
    tunnelsApi.getZones(selectedAccountId.value).then(({ data }) => {
      tunnelZones.value = data || [];
    }).catch(() => { tunnelZones.value = []; });
  }
}

async function submitWizard() {
  if (!selectedAccountId.value || !wizard.domain || !wizard.port) return;
  wizardLoading.value = true;
  try {
    const hostname = wizard.subdomain ? `${wizard.subdomain}.${wizard.domain}` : wizard.domain;
    const payload: any = {
      mode: wizard.mode,
      hostname,
      port: wizard.port,
      protocol: wizard.protocol,
    };
    if (wizard.path) payload.path = wizard.path;
    if (wizard.mode === 'reuse') {
      payload.tunnelId = wizard.tunnelId;
    } else if (wizard.tunnelName) {
      payload.tunnelName = wizard.tunnelName;
    }
    const { data } = await tunnelsApi.runWizard(selectedAccountId.value, payload);
    wizardResult.value = data;
    showWizardModal.value = false;
    showWizardResult.value = true;
    await loadTunnels();
    message.success('回源向导执行成功');
  } catch {
    // error handled by interceptor
  } finally {
    wizardLoading.value = false;
  }
}

// ============ 回源规则 ============
const selectedDomain = ref<string | null>(null);
const selectedRulePhase = ref<string>('http_request_origin');
const rulePhaseOptions = [
  { label: '回源 (Origin)', value: 'http_request_origin' },
  { label: '重定向 (Redirect) [账户级]', value: 'http_request_redirect' },
  { label: 'URL重写 (Transform)', value: 'http_request_transform' },
  { label: '请求头转换', value: 'http_request_late_transform' },
  { label: '响应头转换', value: 'http_response_headers_transform' },
  { label: '缓存设置', value: 'http_request_cache_settings' },
  { label: '防火墙 (Firewall)', value: 'http_request_firewall_custom' },
  { label: '速率限制 (Rate Limit)', value: 'http_ratelimit' },
];
const domains = ref<any[]>([]);
const rules = ref<any[]>([]);
const loadingRules = ref(false);

const domainOptions = computed(() =>
  domains.value.map((d) => ({ label: typeof d === 'string' ? d : d.name, value: typeof d === 'string' ? d : d.name }))
);

// 账户级 Phase 检测
const ACCOUNT_LEVEL_PHASES = new Set(['http_request_redirect', 'http_request_dynamic_redirect']);
const isAccountLevelPhase = computed(() => ACCOUNT_LEVEL_PHASES.has(selectedRulePhase.value));

async function loadDomains() {
  try {
    const { data } = await dnsApi.getDomains();
    domains.value = data;
  } catch {
    domains.value = [];
  }
}

async function onDomainChange() {
  await loadRules();
}

async function loadRules() {
  if (!selectedDomain.value || !selectedRulePhase.value) { rules.value = []; return; }
  loadingRules.value = true;
  try {
    const { data } = await tunnelsApi.listRules(selectedDomain.value, selectedRulePhase.value);
    rules.value = data;
  } catch {
    rules.value = [];
  } finally {
    loadingRules.value = false;
  }
}

// 规则表单
const showRuleModal = ref(false);
const editingRuleId = ref<string | null>(null);
const ruleSubmitting = ref(false);
const ruleForm = reactive({
  matchType: 'hostname' as 'hostname' | 'pathPrefix' | 'pathRegex' | 'hostAndPath' | 'custom',
  subdomain: '',
  pathValue: '',
  expression: '',
  port: 80,
  description: '',
  redirectUrl: '',
  redirectStatus: 301,
  actionJson: '',
  showAdvancedJson: false,
  // URL 重写
  rewriteType: 'path' as 'path' | 'query',
  rewriteValue: '',
  // Header 转换
  headerOp: 'set' as 'set' | 'add' | 'remove',
  headerName: '',
  headerValue: '',
  // 缓存设置
  cacheEnabled: true,
  cacheTtlMode: 'respect_origin' as 'respect_origin' | 'custom',
  cacheTtlValue: 3600,
  // 速率限制
  ratelimitAction: 'block' as 'block' | 'challenge' | 'js_challenge',
  ratelimitChars: ['ip'] as string[],
  ratelimitPeriod: 60,
  ratelimitCount: 100,
  ratelimitMitigation: 60,
});

// 需要结构化表单的 Phase
const needsAdvancedJson = computed(() => [
  'http_request_transform',
  'http_request_late_transform',
  'http_response_headers_transform',
  'http_request_cache_settings',
  'http_ratelimit',
].includes(selectedRulePhase.value));

// 根据 phase 提供 action JSON 的占位提示
const actionJsonPlaceholder = computed(() => {
  switch (selectedRulePhase.value) {
    case 'http_request_transform':
      return '{"action":"rewrite","action_parameters":{"uri":{"path":{"expression":"${http.request.uri.path}"}}}}';
    case 'http_request_late_transform':
      return '{"action":"rewrite","action_parameters":{"headers":{"request":{"set":{"X-Custom-Header":"value"}}}}}';
    case 'http_response_headers_transform':
      return '{"action":"rewrite","action_parameters":{"headers":{"response":{"set":{"X-Frame-Options":"DENY"}}}}}';
    case 'http_request_cache_settings':
      return '{"action":"set_cache_settings","action_parameters":{"cache":true,"edge_ttl":{"mode":"respect_origin_ttl"}}}';
    case 'http_ratelimit':
      return '{"action":"block","action_parameters":{"characteristics":["ip"],"period":60,"requests_per_period":100}}';
    default:
      return '{"action":"rewrite","action_parameters":{...}}';
  }
});

const actionJsonHint = computed(() => {
  switch (selectedRulePhase.value) {
    case 'http_request_transform':
      return 'URL 重写：修改请求路径。action 通常为 rewrite。';
    case 'http_request_late_transform':
      return '请求头转换：添加/修改/删除请求头。action 通常为 rewrite。';
    case 'http_response_headers_transform':
      return '响应头转换：添加/修改/删除响应头。action 通常为 rewrite。';
    case 'http_request_cache_settings':
      return '缓存设置：控制 CDN 缓存行为。action 通常为 set_cache_settings。';
    case 'http_ratelimit':
      return '速率限制：按 IP/路径等维度限流。action 通常为 block 或 challenge。';
    default:
      return '';
  }
});

// 根据 subdomain + selectedDomain 计算 hostname
const ruleHostname = computed(() => {
  if (!selectedDomain.value) return '';
  return ruleForm.subdomain ? `${ruleForm.subdomain}.${selectedDomain.value}` : selectedDomain.value;
});

const ruleExpressionPreview = computed(() => {
  switch (ruleForm.matchType) {
    case 'hostname':
      if (!ruleHostname.value) return '';
      return `(http.host eq "${ruleHostname.value}")`;
    case 'pathPrefix':
      if (!ruleForm.pathValue) return '';
      return `(http.request.uri.path matches "^${ruleForm.pathValue}.*")`;
    case 'pathRegex':
      if (!ruleForm.pathValue) return '';
      return `(http.request.uri.path matches "${ruleForm.pathValue}")`;
    case 'hostAndPath':
      if (!ruleHostname.value || !ruleForm.pathValue) return '';
      return `(http.host eq "${ruleHostname.value}" and http.request.uri.path matches "^${ruleForm.pathValue}.*")`;
    case 'custom':
      return ruleForm.expression;
    default:
      return '';
  }
});

function openAddRule() {
  editingRuleId.value = null;
  ruleForm.matchType = 'hostname';
  ruleForm.subdomain = '';
  ruleForm.pathValue = '';
  ruleForm.expression = '';
  ruleForm.port = 80;
  ruleForm.description = '';
  ruleForm.redirectUrl = '';
  ruleForm.redirectStatus = 301;
  ruleForm.actionJson = '';
  ruleForm.showAdvancedJson = false;
  ruleForm.rewriteType = 'path';
  ruleForm.rewriteValue = '';
  ruleForm.headerOp = 'set';
  ruleForm.headerName = '';
  ruleForm.headerValue = '';
  ruleForm.cacheEnabled = true;
  ruleForm.cacheTtlMode = 'respect_origin';
  ruleForm.cacheTtlValue = 3600;
  ruleForm.ratelimitAction = 'block';
  ruleForm.ratelimitChars = ['ip'];
  ruleForm.ratelimitPeriod = 60;
  ruleForm.ratelimitCount = 100;
  ruleForm.ratelimitMitigation = 60;
  showRuleModal.value = true;
}

function openEditRule(row: any) {
  editingRuleId.value = row.id;
  ruleForm.expression = row.expression || '';
  ruleForm.description = row.description || '';
  ruleForm.port = 80;
  ruleForm.redirectUrl = '';
  ruleForm.redirectStatus = 301;
  ruleForm.actionJson = '';

  // 解析 action_parameters 到表单字段
  const ap = row.action_parameters || {};
  if (ap.origin?.port) {
    ruleForm.port = ap.origin.port;
  }
  if (row.action === 'redirect' && ap.from_value) {
    ruleForm.redirectUrl = ap.from_value.target?.url || '';
    ruleForm.redirectStatus = ap.from_value.status_code || 301;
  }

  // 重置结构化表单字段
  ruleForm.showAdvancedJson = false;
  ruleForm.actionJson = '';
  ruleForm.rewriteType = 'path';
  ruleForm.rewriteValue = '';
  ruleForm.headerOp = 'set';
  ruleForm.headerName = '';
  ruleForm.headerValue = '';
  ruleForm.cacheEnabled = true;
  ruleForm.cacheTtlMode = 'respect_origin';
  ruleForm.cacheTtlValue = 3600;
  ruleForm.ratelimitAction = 'block';
  ruleForm.ratelimitChars = ['ip'];
  ruleForm.ratelimitPeriod = 60;
  ruleForm.ratelimitCount = 100;
  ruleForm.ratelimitMitigation = 60;

  // URL 重写
  if (ap.uri?.path?.expression) {
    ruleForm.rewriteType = 'path';
    ruleForm.rewriteValue = ap.uri.path.expression;
  } else if (ap.uri?.query?.expression) {
    ruleForm.rewriteType = 'query';
    ruleForm.rewriteValue = ap.uri.query.expression;
  }

  // Header 转换
  const headerScope = ap.headers?.request || ap.headers?.response;
  if (headerScope) {
    if (headerScope.set) {
      ruleForm.headerOp = 'set';
      const [k, v] = Object.entries(headerScope.set)[0];
      ruleForm.headerName = k; ruleForm.headerValue = v as string;
    } else if (headerScope.add) {
      ruleForm.headerOp = 'add';
      const [k, v] = Object.entries(headerScope.add)[0];
      ruleForm.headerName = k; ruleForm.headerValue = v as string;
    } else if (headerScope.remove) {
      ruleForm.headerOp = 'remove';
      ruleForm.headerName = (headerScope.remove[0] as string) || '';
    }
  }

  // 缓存设置
  if (typeof ap.cache === 'boolean') {
    ruleForm.cacheEnabled = ap.cache;
    if (ap.edge_ttl?.mode === 'override' && ap.edge_ttl?.value != null) {
      ruleForm.cacheTtlMode = 'custom';
      ruleForm.cacheTtlValue = ap.edge_ttl.value;
    } else {
      ruleForm.cacheTtlMode = 'respect_origin';
    }
  }

  // 速率限制
  if (ap.characteristics || ap.period || ap.requests_per_period) {
    ruleForm.ratelimitAction = row.action || 'block';
    ruleForm.ratelimitChars = ap.characteristics || ['ip'];
    ruleForm.ratelimitPeriod = ap.period || 60;
    ruleForm.ratelimitCount = ap.requests_per_period || 100;
    ruleForm.ratelimitMitigation = ap.mitigation_timeout || 60;
  }

  // 无法解析到结构化字段时，启用高级模式
  const hasStructured = ruleForm.rewriteValue || ruleForm.headerName ||
    (typeof ap.cache === 'boolean') || ap.characteristics ||
    ['route', 'redirect', 'block'].includes(row.action);
  if (!hasStructured && row.action) {
    ruleForm.showAdvancedJson = true;
    ruleForm.actionJson = JSON.stringify({ action: row.action, action_parameters: ap });
  }

  // 尝试从表达式解析出匹配类型和值
  const expr = row.expression || '';
  const hostMatch = expr.match(/http\.host eq "([^"]+)"/);
  const pathMatch = expr.match(/http\.request\.uri\.path matches "([^"]+)"/);
  if (hostMatch && pathMatch) {
    ruleForm.matchType = 'hostAndPath';
    ruleForm.pathValue = pathMatch[1].replace(/^\^/, '').replace(/\.\*$/, '');
  } else if (hostMatch) {
    ruleForm.matchType = 'hostname';
  } else if (pathMatch) {
    ruleForm.pathValue = pathMatch[1];
    if (pathMatch[1].startsWith('^')) {
      ruleForm.matchType = 'pathPrefix';
      ruleForm.pathValue = pathMatch[1].replace(/^\^/, '').replace(/\.\*$/, '');
    } else {
      ruleForm.matchType = 'pathRegex';
    }
  } else {
    ruleForm.matchType = 'custom';
  }

  // 从 hostname 中拆分出 subdomain
  if (hostMatch && selectedDomain.value) {
    const fullHost = hostMatch[1];
    if (fullHost === selectedDomain.value) {
      ruleForm.subdomain = '';
    } else if (fullHost.endsWith('.' + selectedDomain.value)) {
      ruleForm.subdomain = fullHost.slice(0, -(selectedDomain.value.length + 1));
    } else {
      ruleForm.subdomain = '';
      ruleForm.matchType = 'custom';
      ruleForm.expression = expr;
    }
  } else {
    ruleForm.subdomain = '';
  }

  showRuleModal.value = true;
}

function buildExpression(): string {
  return ruleExpressionPreview.value;
}
async function submitRule() {
  if (!selectedDomain.value || !selectedRulePhase.value) return;
  const phase = selectedRulePhase.value;
  // 回源规则需要端口
  if (phase === 'http_request_origin' && !ruleForm.port) return;
  const expression = buildExpression();
  if (!expression) return;
  ruleSubmitting.value = true;
  try {
    // 根据 phase 确定 action 和 action_parameters
    let action = 'route';
    let action_parameters: any = {};
    if (phase === 'http_request_origin') {
      action = 'route';
      action_parameters = { origin: { port: ruleForm.port } };
    } else if (phase === 'http_request_redirect') {
      action = 'redirect';
      action_parameters = { from_value: { target: { url: ruleForm.redirectUrl || '' }, status_code: ruleForm.redirectStatus || 301 } };
    } else if (phase === 'http_request_firewall_custom') {
      action = 'block';
      action_parameters = {};
    } else if (ruleForm.showAdvancedJson && ruleForm.actionJson) {
      // 高级模式：用户自定义 action + action_parameters
      const parsed = JSON.parse(ruleForm.actionJson);
      action = parsed.action || action;
      action_parameters = parsed.action_parameters || action_parameters;
    } else if (phase === 'http_request_transform') {
      // URL 重写
      action = 'rewrite';
      const key = ruleForm.rewriteType === 'path' ? 'path' : 'query';
      action_parameters = { uri: { [key]: { expression: ruleForm.rewriteValue } } };
    } else if (phase === 'http_request_late_transform' || phase === 'http_response_headers_transform') {
      // Header 转换
      action = 'rewrite';
      const scope = phase === 'http_request_late_transform' ? 'request' : 'response';
      const opKey = ruleForm.headerOp; // 'set' | 'add' | 'remove'
      if (opKey === 'remove') {
        action_parameters = { headers: { [scope]: { remove: [ruleForm.headerName] } } };
      } else {
        action_parameters = { headers: { [scope]: { [opKey]: { [ruleForm.headerName]: ruleForm.headerValue || '' } } } };
      }
    } else if (phase === 'http_request_cache_settings') {
      // 缓存设置
      action = 'set_cache_settings';
      action_parameters = { cache: ruleForm.cacheEnabled };
      if (ruleForm.cacheTtlMode === 'custom') {
        action_parameters.edge_ttl = { mode: 'override', value: ruleForm.cacheTtlValue };
      } else {
        action_parameters.edge_ttl = { mode: 'respect_origin_ttl' };
      }
    } else if (phase === 'http_ratelimit') {
      // 速率限制
      action = ruleForm.ratelimitAction;
      action_parameters = {
        characteristics: ruleForm.ratelimitChars,
        period: ruleForm.ratelimitPeriod,
        requests_per_period: ruleForm.ratelimitCount,
        mitigation_timeout: ruleForm.ratelimitMitigation,
      };
    }
    const payload = {
      expression,
      action,
      action_parameters,
      description: ruleForm.description || undefined,
    };
    if (editingRuleId.value) {
      await tunnelsApi.updateRule(selectedDomain.value, phase, editingRuleId.value, payload);
      message.success('规则已更新');
    } else {
      await tunnelsApi.createRule(selectedDomain.value, phase, payload);
      message.success('规则已创建');
    }
    showRuleModal.value = false;
    await loadRules();
  } catch {
    // error handled by interceptor
  } finally {
    ruleSubmitting.value = false;
  }
}

async function deleteRule(ruleId: string) {
  if (!selectedDomain.value || !selectedRulePhase.value) return;
  try {
    await tunnelsApi.deleteRule(selectedDomain.value, selectedRulePhase.value, ruleId);
    message.success('规则已删除');
    await loadRules();
  } catch {
    // error handled by interceptor
  }
}

// 规则表格列
const ruleColumns = computed(() => [
  { title: '描述', key: 'description', ellipsis: { tooltip: true }, render: (row: any) => row.description || '-' },
  { title: '表达式', key: 'expression', ellipsis: { tooltip: true } },
  { title: '动作', key: 'action', render: (row: any) => h(NTag, { size: 'small' }, { default: () => row.action || '-' }) },
  { title: '参数', key: 'params', ellipsis: { tooltip: true }, render: (row: any) => JSON.stringify(row.action_parameters || {}).slice(0, 60) },
  { title: '状态', key: 'enabled', render: (row: any) => h(NTag, { type: row.enabled ? 'success' : 'default', size: 'small' }, { default: () => row.enabled ? '启用' : '禁用' }) },
  {
    title: '操作',
    key: 'actions',
    render: (row: any) => h(NSpace, { size: 'small' }, {
      default: () => [
        h(NButton, { size: 'small', quaternary: true, type: 'primary', onClick: () => openEditRule(row) }, { default: () => '编辑' }),
        h(NPopconfirm, { onPositiveClick: () => deleteRule(row.id) }, {
          trigger: () => h(NButton, { size: 'small', quaternary: true, type: 'error' }, { default: () => '删除' }),
          default: () => `确认删除此规则?`,
        }),
      ],
    }),
  },
]);

// ============ 初始化 ============
onMounted(async () => {
  await loadAccounts();
  await loadDomains();
});
</script>

<style scoped>
.page-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
}
</style>
