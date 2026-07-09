<template>
  <div class="page-view">
    <n-h2>模板商店</n-h2>

    <!-- Source Status Bar -->
    <n-space v-if="sources.length > 0" align="center" style="margin-bottom: 12px">
      <n-tag v-for="s in sources" :key="s.id" :type="s.last_status === 'ok' ? 'success' : s.last_status === 'error' ? 'error' : 'default'" size="small" round>
        {{ s.name }}
        <template #icon><n-icon :component="s.last_status === 'ok' ? CheckmarkCircle : s.last_status === 'error' ? CloseCircle : TimeOutline" /></template>
        {{ s.last_status === 'ok' ? '已更新' : s.last_status === 'error' ? '失败' : '加载中' }}
      </n-tag>
      <n-button size="small" @click="loadTemplates(true)" :loading="refreshing">刷新目录</n-button>
    </n-space>

    <!-- Toolbar -->
    <n-space align="center" style="margin-bottom: 16px">
      <n-input v-model:value="searchText" placeholder="搜索模板..." clearable size="small" style="width: 200px" />
      <n-select v-model:value="typeFilter" :options="typeOptions" size="small" style="width: 120px" />
      <n-select v-model:value="tagFilter" :options="tagOptions" size="small" style="width: 150px" clearable placeholder="标签筛选" />
    </n-space>

    <!-- Template Cards -->
    <n-spin :show="loading">
      <n-grid v-if="filteredTemplates.length > 0" :cols="isMobile ? 1 : 3" :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
        <n-gi v-for="item in filteredTemplates" :key="item.template.id" span="1 m:1 l:1">
          <n-card hoverable size="small" @click="showDetail(item)">
            <template #header>
              <n-space align="center">
                <n-avatar v-if="item.template.icon" :src="item.template.icon" size="small" round />
                <span>{{ item.template.name }}</span>
                <n-tag size="tiny" round>{{ item.template.version }}</n-tag>
              </n-space>
            </template>
            <template #header-extra>
              <n-tag :type="item.template.type === 'worker' ? 'info' : 'warning'" size="tiny">{{ item.template.type }}</n-tag>
            </template>
            <p style="margin: 0 0 8px; color: var(--text-color-3); font-size: 13px">{{ item.template.description || '暂无描述' }}</p>
            <n-space size="small">
              <n-tag v-for="tag in (item.template.tags || []).slice(0, 3)" :key="tag" size="tiny">{{ tag }}</n-tag>
            </n-space>
            <template #footer>
              <n-space justify="space-between" align="center">
                <span style="font-size: 12px; color: var(--text-color-3)">by {{ item.template.author?.name || 'unknown' }}</span>
                <n-space>
                  <n-button size="tiny" @click.stop="showDetail(item)">详情</n-button>
                  <n-button size="tiny" type="primary" @click.stop="openDeploy(item)">部署</n-button>
                </n-space>
              </n-space>
            </template>
          </n-card>
        </n-gi>
      </n-grid>
      <n-empty v-else-if="!loading" description="暂无模板，请检查 catalog 源" style="padding: 40px" />
    </n-spin>

    <!-- Detail Drawer -->
    <n-drawer v-model:show="detailVisible" :width="isMobile ? '100%' : 500" placement="right">
      <n-drawer-content :title="detailItem?.template.name || '详情'" closable>
        <template v-if="detailItem">
          <n-space vertical>
            <n-descriptions label-placement="left" :column="1" size="small" bordered>
              <n-descriptions-item label="版本">{{ detailItem.template.version }}</n-descriptions-item>
              <n-descriptions-item label="类型">{{ detailItem.template.type }}</n-descriptions-item>
              <n-descriptions-item label="作者">{{ detailItem.template.author?.name || '-' }}</n-descriptions-item>
              <n-descriptions-item label="来源">{{ detailItem.sourceName }}</n-descriptions-item>
              <n-descriptions-item v-if="detailItem.sourceCount > 1" label="多源">来自 {{ detailItem.sourceCount }} 个源</n-descriptions-item>
            </n-descriptions>

            <div v-if="readmeContent" class="readme-content" v-html="renderedReadme"></div>

            <div v-if="detailItem.template.bindings?.length">
              <n-h4>绑定</n-h4>
              <n-list size="small" bordered>
                <n-list-item v-for="b in detailItem.template.bindings" :key="b.name">
                  <n-tag size="tiny" :type="bindingTagType(b.type)">{{ b.type }}</n-tag>
                  <span style="margin-left: 8px">{{ b.name }}</span>
                  <span v-if="b.title" style="color: var(--text-color-3); margin-left: 8px">→ {{ b.title }}</span>
                </n-list-item>
              </n-list>
            </div>

            <div v-if="detailItem.template.env && Object.keys(detailItem.template.env).length">
              <n-h4>环境变量</n-h4>
              <n-list size="small" bordered>
                <n-list-item v-for="(v, k) in detailItem.template.env" :key="k">
                  <span style="font-family: monospace">{{ k }}</span> = <span style="color: var(--text-color-3)">{{ v }}</span>
                </n-list-item>
              </n-list>
            </div>

            <n-button type="primary" block @click="openDeploy(detailItem)">部署此模板</n-button>
          </n-space>
        </template>
      </n-drawer-content>
    </n-drawer>

    <!-- Deploy Dialog -->
    <StoreDeployDialog
      v-model:show="deployVisible"
      :template="deployItem?.template"
      @deployed="onDeployed"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { CheckmarkCircle, CloseCircle, TimeOutline } from '@vicons/ionicons5';
import { storeApi } from '../api/store';
import StoreDeployDialog from '../components/StoreDeployDialog.vue';
import { message } from '../utils/discreteApi';

interface TemplateItem {
  template: any;
  sourceId: number;
  sourceName: string;
  sourceCount: number;
}

const loading = ref(false);
const refreshing = ref(false);
const templates = ref<TemplateItem[]>([]);
const sources = ref<any[]>([]);
const searchText = ref('');
const typeFilter = ref<string | null>(null);
const tagFilter = ref<string | null>(null);

const detailVisible = ref(false);
const detailItem = ref<TemplateItem | null>(null);
const readmeContent = ref('');
const deployVisible = ref(false);
const deployItem = ref<TemplateItem | null>(null);

const isMobile = ref(window.innerWidth <= 768);

const typeOptions = [
  { label: '全部', value: null },
  { label: 'Worker', value: 'worker' },
  { label: 'Pages', value: 'pages' },
];

const tagOptions = computed(() => {
  const tags = new Set<string>();
  templates.value.forEach(t => (t.template.tags || []).forEach((tag: string) => tags.add(tag)));
  return Array.from(tags).map(t => ({ label: t, value: t }));
});

const filteredTemplates = computed(() => {
  let result = templates.value;
  if (searchText.value) {
    const q = searchText.value.toLowerCase();
    result = result.filter(t => {
      const tmpl = t.template;
      return tmpl.name?.toLowerCase().includes(q) ||
        tmpl.description?.toLowerCase().includes(q) ||
        (tmpl.tags || []).some((tag: string) => tag.toLowerCase().includes(q));
    });
  }
  if (typeFilter.value) {
    result = result.filter(t => t.template.type === typeFilter.value);
  }
  if (tagFilter.value) {
    result = result.filter(t => (t.template.tags || []).includes(tagFilter.value));
  }
  return result;
});

const renderedReadme = computed(() => {
  return readmeContent.value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
});

function bindingTagType(type: string) {
  const map: Record<string, string> = { kv: 'success', d1: 'info', r2: 'warning', ai: 'default', var: 'error' };
  return map[type] || 'default';
}

async function loadTemplates(force = false) {
  loading.value = !force;
  refreshing.value = force;
  try {
    if (force) await storeApi.refresh();
    const { data } = await storeApi.getTemplates();
    templates.value = (data as any).templates || [];
    sources.value = (data as any).sources || [];
  } catch (e: any) {
    console.error('Load templates failed:', e);
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

async function showDetail(item: TemplateItem) {
  detailItem.value = item;
  detailVisible.value = true;
  readmeContent.value = '';
  if (item.template.readmeUrl) {
    try {
      const resp = await fetch(item.template.readmeUrl);
      readmeContent.value = await resp.text();
    } catch {}
  }
}

function openDeploy(item: TemplateItem) {
  deployItem.value = item;
  deployVisible.value = true;
}

function onDeployed(result: any) {
  const data = result.data || result; // handle AxiosResponse or plain object
  if (data.error) {
    message.error(`部署失败: ${data.error}`);
    if (data.rolledBack) message.warning('已自动回滚');
    return; // 报错时保留弹窗，方便查看原因并重新部署
  }
  if (data.url) {
    message.success(`部署成功！访问: ${data.url}`);
  } else {
    message.success('部署成功！请在 CF Dashboard 查看');
  }
  deployVisible.value = false;
}

onMounted(async () => {
  await storeApi.init();
  await loadTemplates();
});
</script>

<style scoped>
.readme-content {
  max-height: 300px;
  overflow-y: auto;
  padding: 12px;
  background: var(--card-color);
  border: 1px solid var(--divider-color);
  border-radius: 4px;
  font-size: 13px;
  line-height: 1.6;
}
</style>
