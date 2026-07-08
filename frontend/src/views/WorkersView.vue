<template>
  <div class="page-view">
    <n-space justify="space-between" align="center" :wrap="true">
      <n-h2 style="margin: 0">Workers & Pages 管理</n-h2>
      <n-space>
        <n-button size="small" @click="openBatchDeploy" :disabled="!workerStore.workers.length">批量部署</n-button>
        <n-button size="small" type="primary" @click="openDeploy()" :disabled="!accountStore.accounts.length">部署</n-button>
      </n-space>
    </n-space>

    <!-- Workers Usage per Account (compact) -->
      <div class="card-grid-scroll" style="width: 100%">
      <n-grid v-if="usageData.length" :x-gap="8" :y-gap="8" cols="1 s:2 m:4 l:6 xl:8" responsive="screen" style="width: 100%; margin-bottom: 12px;">
        <n-gi v-for="u in usageData" :key="u.accountId">
        <n-popover trigger="click" placement="bottom" style="display: block; width: 100%;">
          <template #trigger>
            <div class="worker-compact-card">
              <span class="worker-compact-card__name" :title="u.accountName">{{ u.accountName }}</span>
              <n-progress
                type="line"
                :percentage="calcUsagePercentage(u)"
                :height="6"
                :show-indicator="false"
                :status="calcUsagePercentage(u) > 90 ? 'error' : calcUsagePercentage(u) > 70 ? 'warning' : 'success'"
                :style="{ flex: '1 1 0', minWidth: '24px', overflow: 'hidden' }"
              />
              <span class="worker-compact-card__metric">{{ formatNumber(u.requests) }}</span>
            </div>
          </template>
          <div style="min-width: 220px; padding: 4px 0;">
            <div style="font-weight: bold; margin-bottom: 10px;">{{ u.accountName }}</div>
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 13px;">
              <span>请求数</span><span>{{ formatNumber(u.requests) }} / 100,000</span>
            </div>
            <n-progress type="line" :percentage="calcUsagePercentage(u)" :height="12" :show-indicator="false"
              :status="calcUsagePercentage(u) > 90 ? 'error' : calcUsagePercentage(u) > 70 ? 'warning' : 'success'" style="margin-bottom: 10px;" />
            <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px;">
              <span>错误</span><span>{{ formatNumber(u.errors) }}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px;">
              <span>CPU 耗时</span><span>{{ formatCpuTime(u.cpuTimeMs) }}</span>
            </div>
            <div style="display: flex; justify-content: space-between; font-size: 13px;">
              <span>子请求</span><span>{{ formatNumber(u.subrequests) }}</span>
            </div>
          </div>
        </n-popover>
      </n-gi>
    </n-grid>
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
          <n-select v-model:value="deployForm.accountId" :options="accountOptions" />
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

    <!-- 设置 Drawer -->
    <n-drawer v-model:show="showSettingsDrawer" :width="drawerWidth(860)" placement="right">
      <n-drawer-content :title="`设置 - ${settingsWorkerName} (${settingsType})`" closable>
        <n-tabs type="line" animated>
          <!-- Worker-only tabs -->
          <template v-if="settingsType === 'worker'">
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
                <n-dynamic-tags v-model:value="cronExpressions" />
                <n-button size="small" type="primary" style="margin-top: 12px" :loading="schedulesSaving" @click="saveSchedules">保存</n-button>
                <n-data-table v-if="schedules.length" :columns="scheduleColumns" :data="schedules" :bordered="false" size="small" style="margin-top: 12px" :scroll-x="500" />
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
                <n-button size="small" @click="loadScriptContent">刷新</n-button>
              </n-space>
              <n-spin :show="contentLoading">
                <n-code v-if="scriptContent" :code="scriptContent" language="javascript" :word-wrap="true" style="max-height: 500px; overflow: auto" />
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
          </template>

          <!-- Pages tabs -->
          <template v-if="settingsType === 'pages'">
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
          </template>
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

    <!-- 环境同步 Modal -->
    <n-modal v-model:show="showEnvSyncModal" preset="dialog" title="同步 Secrets 到其他 Worker" style="width: 600px; max-width: 95vw">
      <n-form label-placement="left" label-width="100">
        <n-form-item label="来源">
          <n-text>{{ settingsWorkerName }} ({{ settingsAccountId }})</n-text>
        </n-form-item>
        <n-form-item label="目标 Workers">
          <n-checkbox-group v-model:value="syncTargets">
            <n-space vertical>
              <n-checkbox v-for="w in workerStore.workers.filter((w: any) => w.type === 'worker' && !(w.cfAccountId === settingsAccountId && w.name === settingsWorkerName))" :key="`${w.cfAccountId}-${w.name}`" :value="`${w.cfAccountId}:${w.name}`">
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
  </div>
</template>

<script setup lang="ts">
import { ref, h, computed, onMounted } from 'vue';
import { NButton, NSpace, NTag, useMessage, NSwitch, NRadio, NRadioGroup } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { useWorkerStore } from '../stores/workerStore';
import { useAccountStore } from '../stores/accountStore';
import { workersApi } from '../api/workers';
import { formatCN } from '../utils/dateFormat';
import { loadDemoAccounts, isDemoAccount } from '../utils/demoAccounts';

const workerStore = useWorkerStore();
const accountStore = useAccountStore();
const message = useMessage();

function drawerWidth(desktopWidth: number): number {
  return window.innerWidth <= 768 ? Math.min(window.innerWidth, desktopWidth) : desktopWidth;
}

// ============ Workers Usage ============
const usageData = ref<Array<{ accountId: number; accountName: string; requests: number; errors: number; subrequests: number; cpuTimeMs: number }>>([]);
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

async function loadUsage() {
  try {
    const { data } = await workersApi.getUsage();
    usageData.value = Array.isArray(data) ? data : [];
  } catch { usageData.value = []; }
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

// Settings state
const showSettingsDrawer = ref(false);
const settingsWorkerName = ref('');
const settingsAccountId = ref(0);
const settingsType = ref<'worker' | 'pages'>('worker');

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
const r2Available = ref(true);  // 恢复默认值
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
      workersApi.getKvNamespaces(settingsAccountId.value).catch(() => null),
      workersApi.getD1Databases(settingsAccountId.value).catch(() => null),
    ];
    // Only fetch R2 if available
    if (r2Available.value) {
      promises.push(workersApi.getR2Buckets(settingsAccountId.value, { _silent: true } as any).catch((err: any) => {
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
      workersApi.getPagesProject(settingsAccountId.value, settingsWorkerName.value),
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
    if (type === 'kv_namespaces') resp = await workersApi.getKvNamespaces(settingsAccountId.value);
    else if (type === 'd1_databases') resp = await workersApi.getD1Databases(settingsAccountId.value);
    else if (type === 'r2_buckets') {
      resp = await workersApi.getR2Buckets(settingsAccountId.value, { _silent: true } as any);
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
    const { data } = await workersApi.getPagesProject(settingsAccountId.value, settingsWorkerName.value);
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
    await workersApi.updatePagesBindings(settingsAccountId.value, settingsWorkerName.value, {
      production: { ...production, [type]: updated },
      preview: { ...preview, [type]: updated },
    });
    message.success('绑定已添加');
    showBindingModal.value = false;
    loadBindings();
  } finally { bindingSaving.value = false; }
}

async function handleDeleteBinding(row: any) {
  const { data } = await workersApi.getPagesProject(settingsAccountId.value, settingsWorkerName.value);
  const configs = data?.deployment_configs || {};
  const production = configs.production || {};
  const existing = { ...(production[row.typeKey] || {}) };
  delete existing[row.name];
  const preview = configs.preview || {};
  const val = Object.keys(existing).length > 0 ? existing : null;
  await workersApi.updatePagesBindings(settingsAccountId.value, settingsWorkerName.value, {
    production: { ...production, [row.typeKey]: val },
    preview: { ...preview, [row.typeKey]: val },
  });
  message.success('绑定已删除');
  loadBindings();
}
const pagesDeployments = ref<any[]>([]);
const pagesDeploymentsLoading = ref(false);

const accountOptions = computed(() =>
  accountStore.accounts
    .filter((a: any) => a.is_active && (a.enabled_features || 'ai,workers,browser_render,dns,storage').includes('workers'))
    .map((a: any) => ({ label: a.name, value: a.id }))
);

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

// ============ Settings ============
async function openSettings(row: any) {
  settingsWorkerName.value = row.name;
  settingsAccountId.value = row.cfAccountId;
  settingsType.value = row.type;
  showSettingsDrawer.value = true;
  if (row.type === 'worker') {
    loadSecrets();
    loadSchedules();
    loadDomains();
    loadSubdomain();
    loadScriptSettings();
    loadDeployments();
  } else {
    loadPagesProject();
    loadPagesDomains();
    loadPagesDeployments();
    checkR2Availability();
    loadBindings();
  }
}

async function checkR2Availability() {
  try {
    const { data } = await workersApi.getR2Buckets(settingsAccountId.value, { _silent: true });
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

async function loadSecrets() {
  secretsLoading.value = true;
  try {
    const { data } = await workersApi.getSecrets(settingsAccountId.value, settingsWorkerName.value);
    secrets.value = Array.isArray(data) ? data : [];
  } catch { secrets.value = []; }
  finally { secretsLoading.value = false; }
}

async function handleAddSecret() {
  if (!secretForm.value.name) { message.warning('请填写名称'); return; }
  secretSaving.value = true;
  try {
    await workersApi.updateSecret(settingsAccountId.value, settingsWorkerName.value, secretForm.value.name, secretForm.value.type, secretForm.value.text, secretForm.value.key_base64);
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
  await workersApi.deleteSecret(settingsAccountId.value, settingsWorkerName.value, row.name);
  message.success('Secret 已删除');
  loadSecrets();
}

async function loadSchedules() {
  schedulesLoading.value = true;
  try {
    const { data } = await workersApi.getSchedules(settingsAccountId.value, settingsWorkerName.value);
    const result = data as any;
    schedules.value = result?.schedules || [];
    cronExpressions.value = schedules.value.map((s: any) => s.cron);
  } catch { schedules.value = []; cronExpressions.value = []; }
  finally { schedulesLoading.value = false; }
}

async function saveSchedules() {
  schedulesSaving.value = true;
  try {
    await workersApi.updateSchedules(settingsAccountId.value, settingsWorkerName.value, cronExpressions.value);
    message.success('定时触发器已保存');
    loadSchedules();
  } finally { schedulesSaving.value = false; }
}

async function loadDomains() {
  domainsLoading.value = true;
  try {
    const { data } = await workersApi.getDomains(settingsAccountId.value, settingsWorkerName.value);
    domains.value = Array.isArray(data) ? data : [];
  } catch { domains.value = []; }
  finally { domainsLoading.value = false; }
}

async function handleAddDomain() {
  if (!domainForm.value.hostname) { message.warning('请填写域名'); return; }
  domainSaving.value = true;
  try {
    await workersApi.createDomain(settingsAccountId.value, settingsWorkerName.value, domainForm.value.hostname, domainForm.value.environment || undefined);
    message.success('域名已添加');
    showDomainModal.value = false;
    domainForm.value = { hostname: '', environment: '' };
    loadDomains();
  } finally { domainSaving.value = false; }
}

async function handleDeleteDomain(row: any) {
  await workersApi.deleteDomain(settingsAccountId.value, settingsWorkerName.value, row.id);
  message.success('域名已删除');
  loadDomains();
}

async function loadSubdomain() {
  subdomainLoading.value = true;
  try {
    const { data } = await workersApi.getSubdomain(settingsAccountId.value, settingsWorkerName.value);
    subdomainInfo.value = data;
  } catch { subdomainInfo.value = null; }
  finally { subdomainLoading.value = false; }
}

async function toggleSubdomain(val: boolean) {
  subdomainSaving.value = true;
  try {
    await workersApi.setSubdomain(settingsAccountId.value, settingsWorkerName.value, val);
    message.success(val ? '子域名已启用' : '子域名已禁用');
    loadSubdomain();
  } finally { subdomainSaving.value = false; }
}

async function loadScriptSettings() {
  scriptSettingsLoading.value = true;
  try {
    const { data } = await workersApi.getSettings(settingsAccountId.value, settingsWorkerName.value);
    scriptSettings.value = data;
  } catch { scriptSettings.value = null; }
  finally { scriptSettingsLoading.value = false; }
}

async function updateScriptSetting(key: string, value: any) {
  const update: any = {};
  if (key === 'observability') update.observability = value;
  else update[key] = value;
  await workersApi.updateSettings(settingsAccountId.value, settingsWorkerName.value, update);
  message.success('设置已更新');
  loadScriptSettings();
}

async function loadRoutes() {
  if (!routeZoneId.value) { message.warning('请输入 Zone ID'); return; }
  routesLoading.value = true;
  try {
    const { data } = await workersApi.getRoutes(settingsAccountId.value, settingsWorkerName.value, routeZoneId.value);
    routes.value = Array.isArray(data) ? data : [];
  } catch { routes.value = []; }
  finally { routesLoading.value = false; }
}

async function handleAddRoute() {
  if (!routeForm.value.zone_id || !routeForm.value.pattern) { message.warning('请填写完整'); return; }
  routeSaving.value = true;
  try {
    await workersApi.createRoute(settingsAccountId.value, settingsWorkerName.value, routeForm.value.zone_id, routeForm.value.pattern);
    message.success('路由已添加');
    showRouteModal.value = false;
    routeZoneId.value = routeForm.value.zone_id;
    routeForm.value = { zone_id: '', pattern: '' };
    loadRoutes();
  } finally { routeSaving.value = false; }
}

async function handleDeleteRoute(row: any) {
  if (!routeZoneId.value) return;
  await workersApi.deleteRoute(settingsAccountId.value, settingsWorkerName.value, row.id, routeZoneId.value);
  message.success('路由已删除');
  loadRoutes();
}

async function loadScriptContent() {
  contentLoading.value = true;
  try {
    const { data } = await workersApi.getContent(settingsAccountId.value, settingsWorkerName.value);
    scriptContent.value = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  } catch (e: any) { scriptContent.value = '加载失败: ' + (e?.errorMessage || e?.message || '未知错误'); }
  finally { contentLoading.value = false; }
}

async function loadDeployments() {
  deploymentsLoading.value = true;
  try {
    const { data } = await workersApi.getDeployments(settingsAccountId.value, settingsWorkerName.value);
    const result = data as any;
    deployments.value = result?.items || result?.deployments || (Array.isArray(data) ? data : []);
  } catch { deployments.value = []; }
  finally { deploymentsLoading.value = false; }
}

// ============ Pages Settings ============
async function loadPagesProject() {
  pagesProjectLoading.value = true;
  try {
    const { data } = await workersApi.getPagesProject(settingsAccountId.value, settingsWorkerName.value);
    pagesProject.value = data;
    // Extract env vars
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
    const { data } = await workersApi.getPagesDomains(settingsAccountId.value, settingsWorkerName.value);
    pagesDomains.value = Array.isArray(data) ? data : [];
  } catch { pagesDomains.value = []; }
  finally { pagesDomainsLoading.value = false; }
}

async function openPagesDomainModal() {
  pagesDomainHostname.value = '';
  showPagesDomainModal.value = true;
  managedDomainsLoading.value = true;
  try {
    const { data } = await workersApi.getZones(settingsAccountId.value);
    managedDomains.value = Array.isArray(data) ? data : [];
  } catch { managedDomains.value = []; }
  finally { managedDomainsLoading.value = false; }
}

async function handleAddPagesDomain() {
  if (!pagesDomainHostname.value) { message.warning('请填写域名'); return; }
  pagesDomainSaving.value = true;
  try {
    await workersApi.addPagesDomain(settingsAccountId.value, settingsWorkerName.value, pagesDomainHostname.value);
    message.success('域名已添加');
    showPagesDomainModal.value = false;
    pagesDomainHostname.value = '';
    loadPagesDomains();
  } finally { pagesDomainSaving.value = false; }
}

async function handleRemovePagesDomain(row: any) {
  await workersApi.removePagesDomain(settingsAccountId.value, settingsWorkerName.value, row.name || row.hostname);
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
    await workersApi.editPagesProject(settingsAccountId.value, settingsWorkerName.value, {
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
    await workersApi.editPagesProject(settingsAccountId.value, settingsWorkerName.value, {
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
    const { data } = await workersApi.getPagesDeployments(settingsAccountId.value, settingsWorkerName.value);
    pagesDeployments.value = Array.isArray(data) ? data : [];
  } catch { pagesDeployments.value = []; }
  finally { pagesDeploymentsLoading.value = false; }
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
          h(NButton, { size: 'small', type: 'error', onClick: () => handleDelete(row) }, { default: () => '删除' }),
        ]),
      ],
    }),
  });
  return cols;
});

// Secret columns
const secretColumns: DataTableColumns<any> = [
  { title: '名称', key: 'name', minWidth: 100 },
  { title: '类型', key: 'type', width: 120, render: (row) => h(NTag, { size: 'small' }, { default: () => row.type || 'unknown' }) },
  { title: '操作', key: 'actions', width: 140, render: (row) => h(NSpace, { size: 4 }, {
    default: () => [
      h(NButton, { size: 'tiny', onClick: () => handleEditSecret(row) }, { default: () => '编辑' }),
      ...(isDemoAccount(settingsAccountId.value) ? [] : [
        h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeleteSecret(row) }, { default: () => '删除' }),
      ]),
    ],
  }) },
];

// Schedule columns
const scheduleColumns: DataTableColumns<any> = [
  { title: 'Cron 表达式', key: 'cron', minWidth: 120 },
  { title: '修改时间', key: 'modified_on', width: 170, render: (row) => row.modified_on ? formatCN(row.modified_on) : '-' },
];

// Domain columns
const domainColumns: DataTableColumns<any> = [
  { title: '域名', key: 'hostname', minWidth: 120, ellipsis: { tooltip: true } },
  { title: '环境', key: 'environment', width: 100, render: (row) => h(NTag, { size: 'small', type: row.environment === 'production' ? 'success' : 'warning' }, { default: () => row.environment || '-' }) },
  { title: '操作', key: 'actions', width: 80, render: (row) => isDemoAccount(settingsAccountId.value)
    ? null
    : h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeleteDomain(row) }, { default: () => '删除' }) },
];

// Route columns
const routeColumns: DataTableColumns<any> = [
  { title: 'Pattern', key: 'pattern', minWidth: 120, ellipsis: true },
  { title: 'Script', key: 'script', width: 150 },
  { title: 'ID', key: 'id', width: 120, ellipsis: true },
  { title: '操作', key: 'actions', width: 80, render: (row) => isDemoAccount(settingsAccountId.value)
    ? null
    : h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeleteRoute(row) }, { default: () => '删除' }) },
];

// Deployment columns
const deploymentColumns: DataTableColumns<any> = [
  { title: 'ID', key: 'id', width: 120, ellipsis: true },
  { title: '创建时间', key: 'created_on', width: 170, render: (row) => row.created_on ? formatCN(row.created_on) : '-' },
  { title: '来源', key: 'source', width: 100, render: (row) => row.source || '-' },
];

// Pages domain columns
const pagesDomainColumns: DataTableColumns<any> = [
  { title: '域名', key: 'name', minWidth: 120, ellipsis: { tooltip: true } },
  { title: '状态', key: 'status', width: 100, render: (row) => h(NTag, { size: 'small', type: row.status === 'active' ? 'success' : 'warning' }, { default: () => row.status || '-' }) },
  {
    title: '操作', key: 'actions', width: 120,
    render: (row) => h(NSpace, null, {
      default: () => [
        h(NButton, { size: 'tiny', type: 'info', onClick: () => window.open(`https://${row.name}`, '_blank') }, { default: () => '打开' }),
        ...(isDemoAccount(settingsAccountId.value) ? [] : [
          h(NButton, { size: 'tiny', type: 'error', onClick: () => handleRemovePagesDomain(row) }, { default: () => '删除' }),
        ]),
      ]
    })
  },
];

// Pages env var columns
const pagesEnvColumns: DataTableColumns<any> = [
  { title: '名称', key: 'name', width: 120 },
  { title: '类型', key: 'type', width: 100, render: (row) => h(NTag, { size: 'small', type: row.type === 'secret_text' ? 'warning' : 'default' }, { default: () => row.type === 'secret_text' ? '加密' : '明文' }) },
  { title: '值', key: 'value', minWidth: 120, ellipsis: true },
  { title: '操作', key: 'actions', width: 140, render: (row) => h(NSpace, { size: 4 }, {
    default: () => [
      h(NButton, { size: 'tiny', onClick: () => handleEditPagesEnv(row) }, { default: () => '编辑' }),
      ...(isDemoAccount(settingsAccountId.value) ? [] : [
        h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeletePagesEnv(row) }, { default: () => '删除' }),
      ]),
    ],
  }) },
];

// Pages bindings columns
const bindingsColumns: DataTableColumns<any> = [
  { title: '类型', key: 'type', width: 100, render: (row) => h(NTag, { size: 'small', type: row.typeKey === 'kv_namespaces' ? 'info' : row.typeKey === 'd1_databases' ? 'warning' : 'success' }, { default: () => row.type }) },
  { title: '变量名', key: 'name', width: 120 },
  { title: '资源', key: 'value', minWidth: 150, ellipsis: true, render: (row) => {
    const resolved = resolveResourceName(row.value);
    return resolved.name
      ? h(NSpace, { size: 'small', align: 'center' }, { default: () => [h('span', null, resolved.name), h(NTag, { size: 'tiny', type: 'default', style: 'opacity: 0.6' }, { default: () => resolved.id })] })
      : h('span', null, resolved.id);
  }},
  { title: '操作', key: 'actions', width: 80, render: (row) => isDemoAccount(settingsAccountId.value)
    ? null
    : h(NButton, { size: 'tiny', type: 'error', onClick: () => handleDeleteBinding(row) }, { default: () => '删除' }) },
];

// Pages deployment columns
const pagesDeploymentColumns: DataTableColumns<any> = [
  { title: 'ID', key: 'id', width: 100, ellipsis: true },
  { title: '环境', key: 'environment', width: 100, render: (row) => h(NTag, { size: 'small', type: row.environment === 'production' ? 'success' : 'info' }, { default: () => row.environment || '-' }) },
  { title: '状态', key: 'status', width: 100, render: (row) => h(NTag, { size: 'small', type: row.latest_stage?.status === 'success' ? 'success' : row.latest_stage?.status === 'failure' ? 'error' : 'default' }, { default: () => row.latest_stage?.status || '-' }) },
  { title: '阶段', key: 'stage', width: 100, render: (row) => row.latest_stage?.name || '-' },
  { title: 'URL', key: 'url', minWidth: 250, render: (row) => row.url ? h('a', { href: row.url, target: '_blank', style: 'word-break: break-all; font-size: 12px;' }, row.url) : '-' },
  { title: '创建时间', key: 'created_on', width: 170, render: (row) => row.created_on ? formatCN(row.created_on) : '-' },
];

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

// ============ Environment Sync ============
const showEnvSyncModal = ref(false);
const syncTargets = ref<string[]>([]);
const syncSecretValues = ref<Record<string, string>>({});
const syncing = ref(false);
const syncResults = ref<any[]>([]);

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
    const [accountId, workerName] = t.split(':');
    return { accountId: Number(accountId), workerName };
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
      { accountId: settingsAccountId.value, workerName: settingsWorkerName.value },
      targets,
      nonEmptyValues,
    );
    syncResults.value = Array.isArray(data) ? data : [];
    const successCount = syncResults.value.filter(r => r.success).length;
    message.success(`同步完成: ${successCount}/${targets.length} 成功`);
  } finally { syncing.value = false; }
}

onMounted(async () => {
  await loadDemoAccounts();
  workerStore.fetchWorkers();
  accountStore.fetchAccounts();
  loadUsage();
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
