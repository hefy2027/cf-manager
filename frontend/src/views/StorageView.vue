<template>
  <div class="page-view">
    <n-h2>{{ t('storage.title') }}</n-h2>
    <n-space align="center" style="margin-bottom: 16px">
     <span>{{ t('storage.accountLabel') }}</span>
      <n-select v-model:value="selectedAccount" :options="accountOptions" :render-label="renderAccountLabel" filterable :placeholder="t('storage.searchAccount')" style="width: 200px; max-width: 60vw" size="small" @update:value="onAccountChange" />
   </n-space>

    <n-tabs v-model:value="activeTab" type="line">
      <!-- ============ KV Tab ============ -->
      <n-tab-pane name="kv" :tab="t('storage.kv')">
        <n-grid :cols="24" :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
          <n-gi span="24 m:6">
            <n-card :title="t('storage.namespace')" size="small">
              <template #header-extra>
                <n-button size="tiny" type="primary" @click="handleCreateKvNs">{{ t('storage.create') }}</n-button>
              </template>
              <n-spin :show="kvNsLoading">
                <n-list hoverable clickable>
                  <n-list-item v-for="ns in kvNamespaces" :key="ns.id"
                    :style="{ background: selectedKvNs?.id === ns.id ? 'rgba(24,160,88,0.1)' : '' }">
                    <div style="display: flex; justify-content: space-between; align-items: center">
                      <span style="cursor: pointer; flex: 1" @click="selectKvNamespace(ns)">{{ ns.title || ns.id }}</span>
                      <n-button v-if="!isDemoSelected" size="tiny" type="error" quaternary @click.stop="handleDeleteKvNs(ns)">×</n-button>
                    </div>
                  </n-list-item>
                </n-list>
                <n-empty v-if="!kvNamespaces.length && !kvNsLoading" :description="t('storage.noNamespace')" />
              </n-spin>
            </n-card>
          </n-gi>
          <n-gi span="24 m:18">
            <n-card :title="selectedKvNs ? `Keys - ${selectedKvNs.title || selectedKvNs.id}` : 'Keys'" size="small">
              <template #header-extra>
                <n-space>
                  <n-input v-model:value="kvPrefix" :placeholder="t('storage.prefixFilter')" size="small" style="width: 200px" @keyup.enter="() => loadKvKeys()" clearable />
                  <n-button size="small" type="primary" @click="showKvEditor = true" :disabled="!selectedKvNs">{{ t('storage.create') }}</n-button>
                </n-space>
              </template>
              <n-data-table :columns="kvColumns" :data="kvKeys" :loading="kvKeysLoading" size="small" :bordered="false" :scroll-x="500" />
              <n-space v-if="kvCursor" justify="center" style="margin-top: 12px">
                <n-button size="small" @click="loadKvKeys(kvCursor)">{{ t('storage.loadMore') }}</n-button>
              </n-space>
            </n-card>
          </n-gi>
        </n-grid>
      </n-tab-pane>

      <!-- ============ D1 Tab ============ -->
      <n-tab-pane name="d1" :tab="t('storage.d1')">
        <n-grid :cols="24" :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
          <n-gi span="24 m:6">
            <n-card :title="t('storage.database')" size="small">
              <template #header-extra>
                <n-button size="tiny" type="primary" @click="handleCreateD1Db">{{ t('storage.create') }}</n-button>
              </template>
              <n-spin :show="d1DbLoading">
                <n-list hoverable clickable>
                  <n-list-item v-for="db in d1Databases" :key="db.uuid || db.id"
                    :style="{ background: selectedD1Db?.uuid === db.uuid ? 'rgba(24,160,88,0.1)' : '' }">
                    <div style="display: flex; justify-content: space-between; align-items: center">
                      <span style="cursor: pointer; flex: 1" @click="selectD1Database(db)">{{ db.name }}</span>
                      <n-button v-if="!isDemoSelected" size="tiny" type="error" quaternary @click.stop="handleDeleteD1Db(db)">×</n-button>
                    </div>
                  </n-list-item>
                </n-list>
                <n-empty v-if="!d1Databases.length && !d1DbLoading" :description="t('storage.noDatabase')" />
              </n-spin>
            </n-card>
            <n-card v-if="selectedD1Db" :title="t('storage.tables')" size="small" style="margin-top: 12px">
              <template #header-extra>
                <n-button size="tiny" type="primary" @click="showD1CreateTable = true">{{ t('storage.createTable') }}</n-button>
              </template>
              <n-list hoverable clickable>
                <n-list-item v-for="table in d1Tables" :key="table.name">
                  <div style="display: flex; justify-content: space-between; align-items: center; width: 100%">
                    <span style="cursor: pointer; flex: 1" @click="d1Sql = `SELECT * FROM ${table.name} LIMIT 100`; executeD1()">{{ table.name }}</span>
                    <n-button size="tiny" quaternary @click.stop="openD1TableSchema(table.name)" :title="t('storage.viewSchema')">⚙</n-button>
                  </div>
                </n-list-item>
              </n-list>
              <n-empty v-if="!d1Tables.length" :description="t('storage.noTables')" />
            </n-card>
          </n-gi>
          <n-gi span="24 m:18">
            <n-card :title="t('storage.sqlQuery')" size="small">
              <n-input v-model:value="d1Sql" type="textarea" :rows="4" :placeholder="t('storage.sqlPlaceholder')" style="margin-bottom: 12px; font-family: monospace;" />
              <n-space>
                <n-button type="primary" size="small" @click="executeD1" :loading="d1Loading" :disabled="!selectedD1Db || !d1Sql">{{ t('storage.execute') }}</n-button>
                <n-checkbox v-model:checked="d1AllowWrite" size="small" :disabled="isDemoSelected">{{ t('storage.allowWrite') }}</n-checkbox>
              </n-space>
              <div v-if="d1Result" style="margin-top: 16px">
                <n-text depth="3" style="font-size: 12px">{{ t('storage.rowsRead', { count: d1Result.meta?.rows_read || 0 }) }} {{ t('storage.rowsWritten', { count: d1Result.meta?.rows_written || 0 }) }} {{ t('storage.duration', { ms: d1Result.meta?.duration || 0 }) }}</n-text>
                <n-data-table v-if="d1ResultColumns.length" :columns="d1ResultColumns" :data="d1Result.results || []" size="small" :bordered="false" style="margin-top: 8px" :max-height="400" virtual-scroll :scroll-x="600" />
              </div>
            </n-card>
          </n-gi>
        </n-grid>
      </n-tab-pane>

      <!-- ============ R2 Tab ============ -->
      <n-tab-pane v-if="r2Available" name="r2" :tab="t('storage.r2')">
        <n-grid :cols="24" :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
          <n-gi span="24 m:6">
            <n-card :title="t('storage.bucket')" size="small">
              <template #header-extra>
                <n-button size="tiny" type="primary" @click="handleCreateR2Bucket">{{ t('storage.create') }}</n-button>
              </template>
              <n-spin :show="r2BucketLoading">
                <n-list hoverable clickable>
                  <n-list-item v-for="b in r2Buckets" :key="b.name"
                    :style="{ background: selectedR2Bucket?.name === b.name ? 'rgba(24,160,88,0.1)' : '' }">
                    <div style="display: flex; justify-content: space-between; align-items: center">
                      <span style="cursor: pointer; flex: 1" @click="selectR2Bucket(b)">{{ b.name }}</span>
                      <n-button v-if="!isDemoSelected" size="tiny" type="error" quaternary @click.stop="handleDeleteR2Bucket(b)">×</n-button>
                    </div>
                  </n-list-item>
                </n-list>
                <n-empty v-if="!r2Buckets.length && !r2BucketLoading" :description="t('storage.noBucket')" />
              </n-spin>
            </n-card>
          </n-gi>
          <n-gi span="24 m:18">
            <n-card :title="selectedR2Bucket ? `${t('storage.files')} - ${selectedR2Bucket.name}` : t('storage.files')" size="small">
              <template #header-extra>
                <n-button size="small" type="primary" @click="showR2Upload = true" :disabled="!selectedR2Bucket">{{ t('storage.upload') }}</n-button>
              </template>
              <n-breadcrumb v-if="r2Prefix" style="margin-bottom: 12px">
                <n-breadcrumb-item @click="r2Prefix = ''; loadR2Objects()">{{ t('storage.rootDir') }}</n-breadcrumb-item>
                <n-breadcrumb-item v-for="(part, i) in r2PrefixParts" :key="i"
                  @click="r2Prefix = r2PrefixParts.slice(0, i + 1).join('/') + '/'; loadR2Objects()">
                  {{ part }}
                </n-breadcrumb-item>
              </n-breadcrumb>
              <n-data-table :columns="r2Columns" :data="r2DisplayItems" :loading="r2Loading" size="small" :bordered="false" :scroll-x="600" />
            </n-card>
          </n-gi>
        </n-grid>
      </n-tab-pane>
    </n-tabs>

    <!-- KV Editor Modal -->
    <n-modal v-model:show="showKvEditor" preset="dialog" :title="kvEditKey ? t('storage.kvEditorEditTitle') : t('storage.kvEditorTitle')" style="width: 600px; max-width: 95vw">
      <n-form label-placement="left" label-width="80">
        <n-form-item label="Key">
          <n-input v-model:value="kvEditForm.key" :disabled="!!kvEditKey" :placeholder="t('storage.keyPlaceholder')" />
        </n-form-item>
        <n-form-item label="Value">
          <n-input v-model:value="kvEditForm.value" type="textarea" :rows="6" :placeholder="t('storage.valuePlaceholder')" style="font-family: monospace" />
        </n-form-item>
        <n-form-item :label="t('storage.ttlSeconds')">
          <n-input-number v-model:value="kvEditForm.ttl" :min="60" :placeholder="t('storage.ttlPlaceholder')" clearable />
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showKvEditor = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="kvSaving" @click="handleSaveKv">{{ t('common.save') }}</n-button>
      </template>
    </n-modal>

    <!-- R2 Upload Modal -->
    <n-modal v-model:show="showR2Upload" preset="dialog" :title="t('storage.uploadFileTitle')" style="width: 500px; max-width: 95vw">
      <n-form label-placement="left" label-width="80">
        <n-form-item :label="t('storage.pathPrefix')">
          <n-input v-model:value="r2UploadPrefix" :placeholder="r2Prefix || '/'" />
        </n-form-item>
        <n-form-item :label="t('storage.files')">
          <n-upload :max="1" @change="({ file }: any) => r2UploadFile = file.file || null">
            <n-button size="small">{{ t('storage.selectFile') }}</n-button>
          </n-upload>
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showR2Upload = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="r2Uploading" @click="handleR2Upload">{{ t('storage.upload') }}</n-button>
      </template>
    </n-modal>

    <!-- Create Resource Modal -->
    <n-modal v-model:show="showCreateModal" preset="dialog" :title="createModalTitle" style="width: 450px; max-width: 95vw">
      <n-form label-placement="left" label-width="80">
        <n-form-item :label="createModalLabel">
          <n-input v-model:value="createModalName" :placeholder="createModalPlaceholder" @keyup.enter="handleCreateConfirm" />
        </n-form-item>
      </n-form>
      <template #action>
        <n-button @click="showCreateModal = false">{{ t('common.cancel') }}</n-button>
        <n-button type="primary" :loading="createModalLoading" @click="handleCreateConfirm">{{ t('common.create') }}</n-button>
      </template>
    </n-modal>

    <!-- D1 Table Schema Modal -->
    <n-modal v-model:show="showD1Schema" preset="card" :title="t('storage.tableStructure', { name: d1SchemaTable })" style="width: 700px; max-width: 95vw">
      <n-data-table :columns="d1SchemaColumns" :data="d1SchemaData" :loading="d1SchemaLoading" size="small" :bordered="false" :scroll-x="500" />
      <n-space style="margin-top: 16px">
        <n-button size="small" type="primary" @click="showD1AddColumn = true">{{ t('storage.addColumn') }}</n-button>
        <n-button size="small" type="warning" @click="showD1RenameColumn = true" :disabled="!d1SchemaData.length">{{ t('storage.renameColumn') }}</n-button>
        <n-button size="small" type="error" @click="showD1DropColumn = true" :disabled="isDemoSelected || !d1SchemaData.length">{{ t('storage.dropColumn') }}</n-button>
        <n-button size="small" type="error" @click="handleD1DropTable" :disabled="isDemoSelected">{{ t('storage.dropTable') }}</n-button>
      </n-space>

      <!-- Add Column inline -->
      <n-card v-if="showD1AddColumn" :title="t('storage.addColumn')" size="small" style="margin-top: 12px">
        <n-space>
          <n-input v-model:value="d1AddColName" size="small" :placeholder="t('storage.columnNamePlaceholder')" style="width: 120px" />
          <n-select v-model:value="d1AddColType" size="small" :options="d1TypeOptions" style="width: 120px" />
          <n-checkbox v-model:checked="d1AddColNotNull" size="small">NOT NULL</n-checkbox>
          <n-input v-model:value="d1AddColDefault" size="small" :placeholder="t('storage.defaultValuePlaceholder')" style="width: 100px" />
          <n-button size="small" type="primary" @click="handleD1AddColumn" :disabled="!d1AddColName">{{ t('common.confirm') }}</n-button>
          <n-button size="small" @click="showD1AddColumn = false">{{ t('common.cancel') }}</n-button>
        </n-space>
      </n-card>

      <!-- Rename Column inline -->
      <n-card v-if="showD1RenameColumn" :title="t('storage.renameColumn')" size="small" style="margin-top: 12px">
        <n-space>
          <n-select v-model:value="d1RenameOld" size="small" :options="d1SchemaData.map((c: any) => ({ label: c.name, value: c.name }))" :placeholder="t('storage.oldColumnName')" style="width: 140px" />
          <n-input v-model:value="d1RenameNew" size="small" :placeholder="t('storage.newColumnName')" style="width: 140px" />
          <n-button size="small" type="primary" @click="handleD1RenameColumn" :disabled="!d1RenameOld || !d1RenameNew">{{ t('common.confirm') }}</n-button>
          <n-button size="small" @click="showD1RenameColumn = false">{{ t('common.cancel') }}</n-button>
        </n-space>
      </n-card>

      <!-- Drop Column inline -->
      <n-card v-if="showD1DropColumn" :title="t('storage.dropColumn')" size="small" style="margin-top: 12px">
        <n-space>
          <n-select v-model:value="d1DropColName" size="small" :options="d1SchemaData.map((c: any) => ({ label: c.name, value: c.name }))" :placeholder="t('storage.selectDropColumn')" style="width: 180px" />
          <n-button size="small" type="error" @click="handleD1DropColumn" :disabled="!d1DropColName">{{ t('storage.confirmDelete') }}</n-button>
          <n-button size="small" @click="showD1DropColumn = false">{{ t('common.cancel') }}</n-button>
        </n-space>
      </n-card>
    </n-modal>

    <!-- D1 Create Table Modal -->
    <n-modal v-model:show="showD1CreateTable" preset="card" :title="t('storage.createTableTitle')" style="width: 700px; max-width: 95vw">
      <n-form label-placement="left" label-width="80">
        <n-form-item :label="t('storage.tableName')">
          <n-input v-model:value="d1NewTableName" :placeholder="t('storage.tableNamePlaceholder')" />
        </n-form-item>
      </n-form>
      <n-data-table :columns="d1ColDefColumns" :data="d1NewTableCols" size="small" :bordered="false" style="margin-top: 8px" :scroll-x="500" />
      <n-space style="margin-top: 12px">
        <n-button size="small" @click="d1NewTableCols.push({ name: '', type: 'TEXT', primaryKey: false, notNull: false, defaultVal: '' })">{{ t('storage.addColumn') }}</n-button>
      </n-space>
      <n-card :title="t('storage.previewSql')" size="small" style="margin-top: 16px">
        <n-code :code="d1CreateTableSql" language="sql" />
      </n-card>
      <template #footer>
        <n-space justify="end">
          <n-button @click="showD1CreateTable = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="d1Creating" @click="handleD1CreateTable" :disabled="!d1NewTableName || !d1NewTableCols.some((c: any) => c.name)">{{ t('storage.executeCreateTable') }}</n-button>
        </n-space>
      </template>
    </n-modal>

    <!-- R2 Image Preview Modal -->
    <n-modal v-model:show="showR2Preview" preset="card" :title="r2PreviewName" style="width: 80vw; max-width: 900px">
      <div style="text-align: center">
        <n-spin v-if="r2PreviewLoading" />
        <img v-else-if="r2PreviewUrl" :src="r2PreviewUrl" :alt="r2PreviewName" style="max-width: 100%; max-height: 70vh; object-fit: contain; border-radius: 4px" />
      </div>
      <template #footer>
        <n-space justify="end">
          <n-button size="small" @click="handleDownloadR2({ name: r2PreviewName, key: r2PreviewKey })">{{ t('storage.downloadOriginal') }}</n-button>
          <n-button size="small" @click="showR2Preview = false">{{ t('common.close') }}</n-button>
        </n-space>
      </template>
    </n-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, h, onMounted, onBeforeUnmount, watch } from 'vue';
import { NButton, NSpace, NInput, NSelect, NCheckbox, NTag, useMessage, useDialog } from 'naive-ui';
import type { DataTableColumns } from 'naive-ui';
import { useI18n } from 'vue-i18n';
import { storageApi } from '../api/storage';
import { accountsApi } from '../api/accounts';
import { formatCN } from '../utils/dateFormat';
import { loadDemoAccounts, isDemoAccount } from '../utils/demoAccounts';

const { t } = useI18n();
const message = useMessage();
const dialog = useDialog();

function confirmAction(title: string, content: string): Promise<boolean> {
  return new Promise((resolve) => {
    dialog.warning({
      title,
      content,
      positiveText: t('storage.confirmDelete'),
      negativeText: t('common.cancel'),
      onPositiveClick: () => resolve(true),
      onNegativeClick: () => resolve(false),
      onClose: () => resolve(false),
    });
  });
}

const selectedAccount = ref<number | null>(null);
const activeTab = ref('kv');
const r2Available = ref(true);
const allAccounts = ref<any[]>([]);
const accountOptions = computed(() =>
  allAccounts.value
    .filter((a: any) => a.is_active && (a.enabled_features || 'ai,workers,browser_render,dns,storage').includes('storage'))
    .map((a: any) => ({ label: a.name, value: a.id }))
);

function renderAccountLabel(option: { label: string; value: number }) {
  const account = allAccounts.value.find((a: any) => a.id === option.value);
  if (!account) return option.label;
  const af = (account.available_features || '').split(',').filter(Boolean);
  if (af.includes('r2')) {
    return h('span', { style: 'display: inline-flex; align-items: center; gap: 4px' }, [
      option.label,
      h(NTag, { size: 'tiny', type: 'success', bordered: false }, { default: () => 'R2' }),
    ]);
  }
  return option.label;
}

// 当前选中的账户是否为演示（Demo）保护账户：演示账户禁用所有删除/写操作按钮
const isDemoSelected = computed(() => isDemoAccount(selectedAccount.value));

async function checkR2Available() {
  if (!selectedAccount.value) { r2Available.value = true; return; }
  const account = allAccounts.value.find((a: any) => a.id === selectedAccount.value);
  if (!account) return;

  // 用数组精确匹配，避免 includes('r2') 误匹配 '-r2' 子串
  const features = (account.available_features || '').split(',').filter(Boolean);
  if (features.includes('r2')) { r2Available.value = true; return; }
  if (features.includes('-r2')) {
    r2Available.value = false;
    if (activeTab.value === 'r2') activeTab.value = 'kv';
    return;
  }
  // 空值 = 未探测：显式复位为 true。
  // 若不复位，切换到「未探测」账号时 r2Available 会沿用上一个账号的值，
  // 导致上一个账号是 '-r2'（禁用 R2）时，R2 tab 在新账号下仍然被隐藏。
  r2Available.value = true;
}

/**
 * 清空所有「账号级」缓存：列表、选中项、游标/前缀、查询结果。
 *
 * 页面按 `!xxx.value.length` 做惰性加载（见下方 watch(activeTab)），
 * 若切换账号时保留上一个账号的列表，切回该 tab 会因列表非空而跳过重新加载，
 * 于是既显示旧账号的记录，又会把旧账号的资源 ID 配新账号的凭据发请求
 * （旧资源在新账号下不存在）→ 报错或返回空数据。
 */
function resetStorageCaches() {
  // KV
  kvNamespaces.value = [];
  selectedKvNs.value = null;
  kvKeys.value = [];
  kvCursor.value = '';
  // D1
  d1Databases.value = [];
  selectedD1Db.value = null;
  d1Tables.value = [];
  d1Result.value = null;
  d1SchemaTable.value = '';
  d1SchemaData.value = [];
  // R2
  r2Buckets.value = [];
  selectedR2Bucket.value = null;
  r2Objects.value = [];
  r2Prefixes.value = [];
  r2Prefix.value = '';
}

async function onAccountChange() {
  // 先清缓存再判断 R2 可用性：checkR2Available 可能把 activeTab 从 r2 切到 kv，
  // 因此必须在它之后再按最终 tab 触发加载。
  resetStorageCaches();
  await checkR2Available();
  if (activeTab.value === 'kv') loadKvNamespaces();
  else if (activeTab.value === 'd1') loadD1Databases();
  else if (activeTab.value === 'r2') loadR2Buckets();
}

// ============ KV ============
const kvNamespaces = ref<any[]>([]);
const kvNsLoading = ref(false);
const selectedKvNs = ref<any>(null);
const kvKeys = ref<any[]>([]);
const kvKeysLoading = ref(false);
const kvPrefix = ref('');
const kvCursor = ref('');
const showKvEditor = ref(false);
const kvEditKey = ref('');
const kvEditForm = ref({ key: '', value: '', ttl: null as number | null });
const kvSaving = ref(false);

// ============ 通用创建 Modal ============
const showCreateModal = ref(false);
const createModalTitle = ref('');
const createModalLabel = computed(() => t('storage.nameLabel'));
const createModalPlaceholder = ref('');
const createModalName = ref('');
const createModalLoading = ref(false);
let createModalCallback: ((name: string) => Promise<void>) | null = null;

function openCreateModal(title: string, placeholder: string, callback: (name: string) => Promise<void>) {
  createModalTitle.value = title;
  createModalPlaceholder.value = placeholder;
  createModalName.value = '';
  createModalCallback = callback;
  showCreateModal.value = true;
}

async function handleCreateConfirm() {
  if (!createModalName.value.trim() || !createModalCallback) return;
  createModalLoading.value = true;
  try {
    await createModalCallback(createModalName.value.trim());
    showCreateModal.value = false;
  } finally { createModalLoading.value = false; }
}

async function handleDeleteKvNs(ns: any) {
  if (!selectedAccount.value) return;
  if (!await confirmAction(t('storage.msg.deleteTitle'), t('storage.msg.deleteNamespaceConfirm', { name: ns.title || ns.id }))) return;
  await storageApi.deleteKvNamespace(selectedAccount.value, ns.id);
  message.success(t('storage.msg.namespaceDeleted'));
  if (selectedKvNs.value?.id === ns.id) {
    selectedKvNs.value = null;
    kvKeys.value = [];
  }
  loadKvNamespaces();
}

function handleCreateKvNs() {
  if (!selectedAccount.value) return;
  openCreateModal(t('storage.kvEditorTitle'), '', async (name) => {
    await storageApi.createKvNamespace(selectedAccount.value!, name);
    message.success(t('storage.msg.namespaceCreated'));
    loadKvNamespaces();
  });
}

async function loadKvNamespaces() {
  if (!selectedAccount.value) return;
  kvNsLoading.value = true;
  try {
    const { data } = await storageApi.getKvNamespaces(selectedAccount.value);
    kvNamespaces.value = Array.isArray(data) ? data : [];
  } catch { kvNamespaces.value = []; }
  finally { kvNsLoading.value = false; }
}

function selectKvNamespace(ns: any) {
  selectedKvNs.value = ns;
  kvKeys.value = [];
  kvCursor.value = '';
  loadKvKeys();
}

async function loadKvKeys(cursor?: string) {
  if (!selectedAccount.value || !selectedKvNs.value) return;
  kvKeysLoading.value = true;
  try {
    const { data } = await storageApi.getKvKeys(selectedAccount.value, selectedKvNs.value.id, {
      prefix: kvPrefix.value || undefined,
      cursor: cursor || undefined,
      limit: 100,
    });
    if (cursor) {
      kvKeys.value.push(...(data.keys || []));
    } else {
      kvKeys.value = data.keys || [];
    }
    kvCursor.value = data.cursor || '';
  } catch { kvKeys.value = []; }
  finally { kvKeysLoading.value = false; }
}

async function viewKvValue(row: any) {
  if (!selectedAccount.value || !selectedKvNs.value) return;
  try {
    const { data } = await storageApi.getKvValue(selectedAccount.value, selectedKvNs.value.id, row.name);
    kvEditKey.value = row.name;
    kvEditForm.value = { key: row.name, value: data.value || '', ttl: null };
    showKvEditor.value = true;
  } catch {
    kvEditForm.value = { key: row.name, value: '', ttl: null };
  }
}

async function handleSaveKv() {
  if (!selectedAccount.value || !selectedKvNs.value || !kvEditForm.value.key) return;
  kvSaving.value = true;
  try {
    await storageApi.putKvValue(selectedAccount.value, selectedKvNs.value.id, kvEditForm.value.key, kvEditForm.value.value, {
      expiration_ttl: kvEditForm.value.ttl || undefined,
    });
    message.success(t('storage.msg.kvSaved'));
    showKvEditor.value = false;
    kvEditKey.value = '';
    loadKvKeys();
  } finally { kvSaving.value = false; }
}

async function handleDeleteKv(row: any) {
  if (!selectedAccount.value || !selectedKvNs.value) return;
  await storageApi.deleteKvKey(selectedAccount.value, selectedKvNs.value.id, row.name);
  message.success(t('storage.msg.deleted'));
  loadKvKeys();
}

const kvColumns = computed<DataTableColumns<any>>(() => [
  { title: 'Key', key: 'name', width: 180, minWidth: 100, ellipsis: { tooltip: true } },
  { title: t('storage.ttl'), key: 'expiration', width: 180, render: (row) => row.expiration ? formatCN(row.expiration * 1000) : t('storage.never') },
  {
    title: t('common.actions'), key: 'actions', width: 140,
    render: (row) => h(NSpace, null, { default: () => [
      h(NButton, { size: 'small', onClick: () => viewKvValue(row) }, { default: () => t('storage.view') }),
      ...(isDemoSelected.value ? [] : [
        h(NButton, { size: 'small', type: 'error', onClick: () => handleDeleteKv(row) }, { default: () => t('common.delete') }),
      ]),
    ]}),
  },
]);

// ============ D1 ============
const d1Databases = ref<any[]>([]);
const d1DbLoading = ref(false);
const selectedD1Db = ref<any>(null);
const d1Tables = ref<any[]>([]);
const d1Sql = ref('');
const d1AllowWrite = ref(false);
const d1Loading = ref(false);
const d1Result = ref<any>(null);

const d1ResultColumns = computed<DataTableColumns<any>>(() => {
  if (!d1Result.value?.results?.length) return [];
  return Object.keys(d1Result.value.results[0]).map(key => ({
    title: key, key, ellipsis: { tooltip: true }, width: 150,
  }));
});

async function handleDeleteD1Db(db: any) {
  if (!selectedAccount.value) return;
  if (!await confirmAction(t('storage.msg.deleteDatabaseTitle'), t('storage.msg.deleteDatabaseConfirm', { name: db.name }))) return;
  await storageApi.deleteD1Database(selectedAccount.value, db.uuid || db.id);
  message.success(t('storage.msg.databaseDeleted'));
  if (selectedD1Db.value?.uuid === db.uuid) {
    selectedD1Db.value = null;
    d1Tables.value = [];
    d1Result.value = null;
  }
  loadD1Databases();
}

function handleCreateD1Db() {
  if (!selectedAccount.value) return;
  openCreateModal(t('storage.d1'), '', async (name) => {
    await storageApi.createD1Database(selectedAccount.value!, name);
    message.success(t('storage.msg.databaseCreated'));
    loadD1Databases();
  });
}

async function loadD1Databases() {
  if (!selectedAccount.value) return;
  d1DbLoading.value = true;
  try {
    const { data } = await storageApi.getD1Databases(selectedAccount.value);
    d1Databases.value = Array.isArray(data) ? data : [];
  } catch { d1Databases.value = []; }
  finally { d1DbLoading.value = false; }
}

async function selectD1Database(db: any) {
  selectedD1Db.value = db;
  try {
    const { data } = await storageApi.getD1Tables(selectedAccount.value!, db.uuid || db.id);
    d1Tables.value = Array.isArray(data) ? data : [];
  } catch { d1Tables.value = []; }
}

async function executeD1() {
  if (!selectedAccount.value || !selectedD1Db.value || !d1Sql.value) return;
  d1Loading.value = true;
  try {
    const { data } = await storageApi.executeD1Query(selectedAccount.value, selectedD1Db.value.uuid || selectedD1Db.value.id, d1Sql.value, d1AllowWrite.value);
    d1Result.value = data;
  } catch { d1Result.value = null; }
  finally { d1Loading.value = false; }
}

// ============ D1 Table Schema ============
const showD1Schema = ref(false);
const d1SchemaTable = ref('');
const d1SchemaData = ref<any[]>([]);
const d1SchemaLoading = ref(false);

const showD1AddColumn = ref(false);
const d1AddColName = ref('');
const d1AddColType = ref('TEXT');
const d1AddColNotNull = ref(false);
const d1AddColDefault = ref('');

const showD1RenameColumn = ref(false);
const d1RenameOld = ref('');
const d1RenameNew = ref('');

const showD1DropColumn = ref(false);
const d1DropColName = ref('');

const d1SchemaColumns = computed<DataTableColumns<any>>(() => [
  { title: '#', key: 'cid', width: 40 },
  { title: t('storage.columnName'), key: 'name', width: 140 },
  { title: t('storage.columnType'), key: 'type', width: 100 },
  { title: 'NOT NULL', key: 'notnull', width: 80, render: (row) => row.notnull ? t('common.yes') : t('common.no') },
  { title: t('storage.defaultValue'), key: 'dflt_value', width: 100, render: (row) => row.dflt_value ?? '-' },
  { title: t('storage.primaryKey'), key: 'pk', width: 60, render: (row) => row.pk ? t('common.yes') : '' },
]);

async function openD1TableSchema(tableName: string) {
  if (!selectedAccount.value || !selectedD1Db.value) return;
  d1SchemaTable.value = tableName;
  d1SchemaLoading.value = true;
  showD1Schema.value = true;
  showD1AddColumn.value = false;
  showD1RenameColumn.value = false;
  showD1DropColumn.value = false;
  try {
    const { data } = await storageApi.getD1TableSchema(selectedAccount.value, selectedD1Db.value.uuid || selectedD1Db.value.id, tableName);
    d1SchemaData.value = Array.isArray(data) ? data : [];
  } catch { d1SchemaData.value = []; }
  finally { d1SchemaLoading.value = false; }
}

async function runD1Alter(sql: string) {
  if (!selectedAccount.value || !selectedD1Db.value) return;
  await storageApi.executeD1Query(selectedAccount.value, selectedD1Db.value.uuid || selectedD1Db.value.id, sql, true);
  openD1TableSchema(d1SchemaTable.value);
}

async function handleD1AddColumn() {
  let sql = `ALTER TABLE ${d1SchemaTable.value} ADD COLUMN ${d1AddColName.value} ${d1AddColType.value}`;
  if (d1AddColNotNull.value && d1AddColDefault.value) sql += ` NOT NULL DEFAULT ${d1AddColDefault.value}`;
  else if (d1AddColDefault.value) sql += ` DEFAULT ${d1AddColDefault.value}`;
  await runD1Alter(sql);
  message.success(t('storage.msg.columnAdded', { name: d1AddColName.value }));
  d1AddColName.value = '';
  showD1AddColumn.value = false;
}

async function handleD1RenameColumn() {
  await runD1Alter(`ALTER TABLE ${d1SchemaTable.value} RENAME COLUMN ${d1RenameOld.value} TO ${d1RenameNew.value}`);
  message.success(t('storage.msg.columnRenamed'));
  d1RenameOld.value = '';
  d1RenameNew.value = '';
  showD1RenameColumn.value = false;
}

async function handleD1DropColumn() {
  await runD1Alter(`ALTER TABLE ${d1SchemaTable.value} DROP COLUMN ${d1DropColName.value}`);
  message.success(t('storage.msg.columnDeleted', { name: d1DropColName.value }));
  d1DropColName.value = '';
  showD1DropColumn.value = false;
}

async function handleD1DropTable() {
  if (!await confirmAction(t('storage.msg.deleteTableTitle'), t('storage.msg.deleteTableConfirm', { name: d1SchemaTable.value }))) return;
  await runD1Alter(`DROP TABLE ${d1SchemaTable.value}`);
  message.success(t('storage.msg.tableDeleted', { name: d1SchemaTable.value }));
  showD1Schema.value = false;
  selectD1Database(selectedD1Db.value);
}

// ============ D1 Create Table ============
interface D1ColDef { name: string; type: string; primaryKey: boolean; notNull: boolean; defaultVal: string }

const showD1CreateTable = ref(false);
const d1NewTableName = ref('');
const d1NewTableCols = ref<D1ColDef[]>([
  { name: 'id', type: 'INTEGER', primaryKey: true, notNull: true, defaultVal: '' },
  { name: '', type: 'TEXT', primaryKey: false, notNull: false, defaultVal: '' },
]);
const d1Creating = ref(false);

const d1TypeOptions = ['INTEGER', 'TEXT', 'REAL', 'BLOB', 'BOOLEAN', 'DATETIME'].map(v => ({ label: v, value: v }));

const d1CreateTableSql = computed(() => {
  if (!d1NewTableName.value) return t('storage.enterTableName');
  const cols = d1NewTableCols.value.filter(c => c.name.trim());
  if (!cols.length) return t('storage.addAtLeastOneCol');
  const lines = cols.map(c => {
    let def = `  ${c.name} ${c.type}`;
    if (c.primaryKey) def += ' PRIMARY KEY AUTOINCREMENT';
    if (c.notNull && !c.primaryKey) def += ' NOT NULL';
    if (c.defaultVal) def += ` DEFAULT ${c.defaultVal}`;
    return def;
  });
  return `CREATE TABLE ${d1NewTableName.value} (\n${lines.join(',\n')}\n);`;
});

function removeD1Col(idx: number) {
  d1NewTableCols.value.splice(idx, 1);
}

const d1ColDefColumns = computed<DataTableColumns<D1ColDef>>(() => [
  {
    title: t('storage.columnName'), key: 'name', width: 140,
    render: (row, idx) => h(NInput, {
      size: 'small', value: row.name, placeholder: t('storage.columnNamePlaceholder'),
      onUpdateValue: (v: string) => { d1NewTableCols.value[idx].name = v; },
    }),
  },
  {
    title: t('storage.columnType'), key: 'type', width: 130,
    render: (row, idx) => h(NSelect, {
      size: 'small', value: row.type, options: d1TypeOptions,
      onUpdateValue: (v: string) => { d1NewTableCols.value[idx].type = v; },
    }),
  },
  {
    title: t('storage.primaryKey'), key: 'primaryKey', width: 60,
    render: (row, idx) => h(NCheckbox, {
      checked: row.primaryKey,
      onUpdateChecked: (v: boolean) => { d1NewTableCols.value[idx].primaryKey = v; },
    }),
  },
  {
    title: 'NOT NULL', key: 'notNull', width: 80,
    render: (row, idx) => h(NCheckbox, {
      checked: row.notNull,
      onUpdateChecked: (v: boolean) => { d1NewTableCols.value[idx].notNull = v; },
    }),
  },
  {
    title: t('storage.defaultValue'), key: 'defaultVal', width: 120,
    render: (row, idx) => h(NInput, {
      size: 'small', value: row.defaultVal, placeholder: t('storage.optional'),
      onUpdateValue: (v: string) => { d1NewTableCols.value[idx].defaultVal = v; },
    }),
  },
  {
    title: '', key: 'actions', width: 50,
    render: (_row, idx) => h(NButton, {
      size: 'tiny', type: 'error', quaternary: true,
      onClick: () => removeD1Col(idx),
    }, { default: () => '×' }),
  },
]);

async function handleD1CreateTable() {
  if (!selectedAccount.value || !selectedD1Db.value) return;
  d1Creating.value = true;
  try {
    await storageApi.executeD1Query(
      selectedAccount.value,
      selectedD1Db.value.uuid || selectedD1Db.value.id,
      d1CreateTableSql.value,
      true,
    );
    message.success(t('storage.msg.tableCreated', { name: d1NewTableName.value }));
    showD1CreateTable.value = false;
    d1NewTableName.value = '';
    d1NewTableCols.value = [
      { name: 'id', type: 'INTEGER', primaryKey: true, notNull: true, defaultVal: '' },
      { name: '', type: 'TEXT', primaryKey: false, notNull: false, defaultVal: '' },
    ];
    selectD1Database(selectedD1Db.value);
  } finally { d1Creating.value = false; }
}

// ============ R2 ============
const r2Buckets = ref<any[]>([]);
const r2BucketLoading = ref(false);
const selectedR2Bucket = ref<any>(null);
const r2Objects = ref<any[]>([]);
const r2Prefixes = ref<string[]>([]);
const r2Loading = ref(false);
const r2Prefix = ref('');
const showR2Upload = ref(false);
const r2UploadPrefix = ref('');
const r2UploadFile = ref<File | null>(null);
const r2Uploading = ref(false);

const r2PrefixParts = computed(() => r2Prefix.value.split('/').filter(Boolean));

const r2DisplayItems = computed(() => {
  const folders = r2Prefixes.value.map(p => ({
    name: p.replace(r2Prefix.value, '').replace(/\/$/, ''),
    key: p, isFolder: true, size: 0, lastModified: '', contentType: '',
  }));
  const files = r2Objects.value.map(o => ({
    name: o.key?.replace(r2Prefix.value, '') || o.key,
    key: o.key, isFolder: false, size: o.size || 0,
    lastModified: o.last_modified || '',
    contentType: o.http_metadata?.contentType || '',
  }));
  return [...folders, ...files];
});

async function handleDeleteR2Bucket(b: any) {
  if (!selectedAccount.value) return;
  if (!await confirmAction(t('storage.msg.deleteBucketTitle'), t('storage.msg.deleteBucketConfirm', { name: b.name }))) return;
  await storageApi.deleteR2Bucket(selectedAccount.value, b.name);
  message.success(t('storage.msg.bucketDeleted'));
  if (selectedR2Bucket.value?.name === b.name) {
    selectedR2Bucket.value = null;
    r2Objects.value = [];
    r2Prefixes.value = [];
  }
  loadR2Buckets();
}

function handleCreateR2Bucket() {
  if (!selectedAccount.value) return;
  openCreateModal(t('storage.r2'), '', async (name) => {
    await storageApi.createR2Bucket(selectedAccount.value!, name);
    message.success(t('storage.msg.bucketCreated'));
    loadR2Buckets();
  });
}

async function loadR2Buckets() {
  if (!selectedAccount.value) return;
  r2BucketLoading.value = true;
  try {
    const { data } = await storageApi.getR2Buckets(selectedAccount.value);
    r2Buckets.value = Array.isArray(data) ? data : [];
  } catch { r2Buckets.value = []; }
  finally { r2BucketLoading.value = false; }
}

function selectR2Bucket(b: any) {
  selectedR2Bucket.value = b;
  r2Prefix.value = '';
  loadR2Objects();
}

async function loadR2Objects() {
  if (!selectedAccount.value || !selectedR2Bucket.value) return;
  r2Loading.value = true;
  try {
    const { data } = await storageApi.getR2Objects(selectedAccount.value, selectedR2Bucket.value.name, {
      prefix: r2Prefix.value || undefined,
      delimiter: '/',
    });
    r2Objects.value = data.objects || [];
    r2Prefixes.value = data.delimited_prefixes || [];
  } catch { r2Objects.value = []; r2Prefixes.value = []; }
  finally { r2Loading.value = false; }
}

function navigateR2Folder(prefix: string) {
  r2Prefix.value = prefix;
  loadR2Objects();
}

async function handleDeleteR2(row: any) {
  if (!selectedAccount.value || !selectedR2Bucket.value) return;
  await storageApi.deleteR2Object(selectedAccount.value, selectedR2Bucket.value.name, row.key);
  message.success(t('storage.msg.deleted'));
  loadR2Objects();
}

async function handleR2Upload() {
  if (!selectedAccount.value || !selectedR2Bucket.value || !r2UploadFile.value) return;
  r2Uploading.value = true;
  try {
    const prefix = r2UploadPrefix.value || r2Prefix.value || '';
    const key = prefix + r2UploadFile.value.name;
    await storageApi.uploadR2Object(selectedAccount.value, selectedR2Bucket.value.name, key, r2UploadFile.value);
    message.success(t('storage.msg.uploadSuccess'));
    showR2Upload.value = false;
    r2UploadFile.value = null;
    loadR2Objects();
  } finally { r2Uploading.value = false; }
}

function formatSize(bytes: number): string {
  if (!bytes) return '-';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

const showR2Preview = ref(false);
const r2PreviewUrl = ref('');
const r2PreviewName = ref('');
const r2PreviewKey = ref('');
const r2PreviewLoading = ref(false);

function clearR2PreviewUrl() {
  if (r2PreviewUrl.value) {
    URL.revokeObjectURL(r2PreviewUrl.value);
    r2PreviewUrl.value = '';
  }
}

watch(showR2Preview, (isOpen) => {
  if (!isOpen) clearR2PreviewUrl();
});

onBeforeUnmount(() => {
  clearR2PreviewUrl();
});

function isImageType(contentType: string): boolean {
  return contentType.startsWith('image/');
}

async function handlePreviewR2(row: any) {
  if (!selectedAccount.value || !selectedR2Bucket.value) return;
  r2PreviewName.value = row.name;
  r2PreviewKey.value = row.key;
  clearR2PreviewUrl();
  r2PreviewLoading.value = true;
  showR2Preview.value = true;
  try {
    const resp = await storageApi.downloadR2Object(selectedAccount.value, selectedR2Bucket.value.name, row.key);
    const blob = new Blob([resp.data], { type: row.contentType || 'image/png' });
    r2PreviewUrl.value = URL.createObjectURL(blob);
  } catch {
    message.error(t('storage.msg.imageLoadFailed'));
  } finally {
    r2PreviewLoading.value = false;
  }
}

async function handleDownloadR2(row: any) {
  if (!selectedAccount.value || !selectedR2Bucket.value) return;
  try {
    const resp = await storageApi.downloadR2Object(selectedAccount.value, selectedR2Bucket.value.name, row.key);
    const blob = new Blob([resp.data]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = row.name;
    a.click();
    URL.revokeObjectURL(url);
  } catch {}
}

const r2Columns = computed<DataTableColumns<any>>(() => [
  {
    title: t('common.name'), key: 'name', width: 180, minWidth: 100, ellipsis: { tooltip: true },
    render: (row: any) => {
      if (row.isFolder) {
        return h('a', { style: 'cursor:pointer;color:#2080f0', onClick: () => navigateR2Folder(row.key) }, `📁 ${row.name}`);
      }
      if (isImageType(row.contentType)) {
        return h('a', { style: 'cursor:pointer;color:#2080f0', onClick: () => handlePreviewR2(row) }, row.name);
      }
      return row.name;
    },
  },
  { title: t('common.type'), key: 'contentType', width: 120, ellipsis: { tooltip: true }, render: (row: any) => row.contentType || '-' },
  { title: t('storage.columnName'), key: 'size', width: 100, render: (row: any) => row.isFolder ? '-' : formatSize(row.size) },
  { title: t('workers.table.modifiedTime'), key: 'lastModified', width: 180, render: (row: any) => row.lastModified ? formatCN(row.lastModified) : '-' },
  {
    title: t('common.actions'), key: 'actions', width: 180,
    render: (row: any) => {
      if (row.isFolder) return null;
      const btns: any[] = [];
      if (isImageType(row.contentType)) {
        btns.push(h(NButton, { size: 'small', type: 'info', onClick: () => handlePreviewR2(row) }, { default: () => t('storage.preview') }));
      }
      btns.push(h(NButton, { size: 'small', onClick: () => handleDownloadR2(row) }, { default: () => t('storage.download') }));
      if (!isDemoSelected.value) {
        btns.push(h(NButton, { size: 'small', type: 'error', onClick: () => handleDeleteR2(row) }, { default: () => t('common.delete') }));
      }
      return h(NSpace, { size: 'small' }, { default: () => btns });
    },
  },
]);

// ============ Init ============
watch(isDemoSelected, (demo) => { if (demo) d1AllowWrite.value = false; });
watch(activeTab, (tab) => {
  if (!selectedAccount.value) return;
  // 加载中（!xxxLoading）时不再重复触发：切换账号时 checkR2Available 可能改写
  // activeTab，onAccountChange 已主动加载一次，避免同一次切换发出两个相同请求。
  if (tab === 'kv' && !kvNamespaces.value.length && !kvNsLoading.value) loadKvNamespaces();
  else if (tab === 'd1' && !d1Databases.value.length && !d1DbLoading.value) loadD1Databases();
  else if (tab === 'r2' && !r2Buckets.value.length && !r2BucketLoading.value) loadR2Buckets();
});

onMounted(async () => {
  try {
    await loadDemoAccounts();
    const { data } = await accountsApi.getAll();
    allAccounts.value = data.accounts || [];
  } catch {
    allAccounts.value = [];
  }
  if (accountOptions.value.length > 0) {
    selectedAccount.value = accountOptions.value[0].value;
    await checkR2Available();
    loadKvNamespaces();
  }
});
</script>
