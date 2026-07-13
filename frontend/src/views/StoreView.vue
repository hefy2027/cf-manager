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

    <!-- Category Nav -->
    <StoreCategoryNav
      :types="typeCounts"
      :selected-type="selectedType"
      :tags="allTags"
      :selected-tags="selectedTags"
      @update:selected-type="(v) => (selectedType = v)"
      @toggle-tag="toggleTag"
    />

    <!-- Toolbar -->
    <StoreToolbar
      :search-text="searchText"
      :sort-by="sortBy"
      :fav-only="favOnly"
      :has-active-filter="hasActiveFilter"
      @update:search-text="(v) => (searchText = v)"
      @update:sort-by="(v) => (sortBy = v)"
      @update:fav-only="(v) => (favOnly = v)"
      @clear="clearFilters"
    />

    <!-- Template Cards -->
    <n-spin :show="loading">
      <n-grid v-if="filteredTemplates.length > 0" :cols="isMobile ? 1 : 3" :x-gap="12" :y-gap="12" responsive="screen" item-responsive>
        <n-gi v-for="item in filteredTemplates" :key="item.template.id" span="1 m:1 l:1">
          <StoreCard
            :item="item"
            @detail="showDetail"
            @deploy="openDeploy"
            @toggle-fav="toggleFav"
          />
        </n-gi>
      </n-grid>
      <n-empty v-else-if="!loading" description="暂无模板，请检查 catalog 源或调整筛选" style="padding: 40px" />
    </n-spin>

    <!-- Detail Drawer -->
    <n-drawer v-model:show="detailVisible" :width="isMobile ? '100%' : 720" placement="right">
      <n-drawer-content :title="detailItem?.template.name || '详情'" closable>
        <template v-if="detailItem">
          <n-space vertical>
            <n-descriptions label-placement="left" :column="1" size="small" bordered>
              <n-descriptions-item label="版本">{{ detailItem.template.version }}</n-descriptions-item>
              <n-descriptions-item label="类型">{{ detailItem.template.type }}</n-descriptions-item>
              <n-descriptions-item label="作者">
                <a v-if="detailItem.template.author?.url" :href="detailItem.template.author.url" target="_blank" rel="noopener noreferrer">{{ detailItem.template.author.name }}</a>
                <span v-else>{{ detailItem.template.author?.name || '-' }}</span>
              </n-descriptions-item>
              <n-descriptions-item label="来源">{{ detailItem.sourceName }}</n-descriptions-item>
              <n-descriptions-item v-if="detailItem.sourceCount > 1" label="多源">来自 {{ detailItem.sourceCount }} 个源</n-descriptions-item>
              <n-descriptions-item v-if="detailItem.template.homepage" label="主页">
                <a :href="detailItem.template.homepage" target="_blank" rel="noopener noreferrer">{{ detailItem.template.homepage }}</a>
              </n-descriptions-item>
            </n-descriptions>

            <n-space style="margin-bottom: 8px">
              <n-button
                v-if="sourceRepoUrl"
                size="small"
                tag="a"
                :href="sourceRepoUrl"
                target="_blank"
                rel="noopener noreferrer"
              >
                <template #icon><n-icon :component="LogoGithub" /></template>
                前往源仓库
              </n-button>
              <n-button
                v-if="readmeGithubUrl"
                size="small"
                secondary
                tag="a"
                :href="readmeGithubUrl"
                target="_blank"
                rel="noopener noreferrer"
              >
                在 GitHub 查看完整 README
              </n-button>
            </n-space>

            <n-spin v-if="readmeLoading" size="small" style="padding: 8px 0">正在加载 README…</n-spin>
            <MarkdownRenderer v-else :content="readmeContent || detailItem.template.description || '暂无说明'" :base-url="readmeBaseUrl" :repo-url="repoRootUrl" />

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
import { CheckmarkCircle, CloseCircle, TimeOutline, LogoGithub } from '@vicons/ionicons5';
import { storeApi } from '../api/store';
import StoreDeployDialog from '../components/StoreDeployDialog.vue';
import StoreCard from '../components/store/StoreCard.vue';
import StoreCategoryNav from '../components/store/StoreCategoryNav.vue';
import StoreToolbar from '../components/store/StoreToolbar.vue';
import MarkdownRenderer from '../components/store/MarkdownRenderer.vue';
import { isFav, toggleFav } from '../utils/favorites';
import { message } from '../utils/discreteApi';
import type { CatalogBindingType, TemplateItem } from '../types/store';

const loading = ref(false);
const refreshing = ref(false);
const templates = ref<TemplateItem[]>([]);
const sources = ref<any[]>([]);

const searchText = ref('');
const selectedType = ref<string | null>(null);
const selectedTags = ref<string[]>([]);
const sortBy = ref<'name' | 'version'>('name');
const favOnly = ref(false);

const detailVisible = ref(false);
const detailItem = ref<TemplateItem | null>(null);
const readmeContent = ref('');
const readmeBaseUrl = ref('');
const readmeLoading = ref(false);
const deployVisible = ref(false);
const deployItem = ref<TemplateItem | null>(null);

const isMobile = ref(window.innerWidth <= 768);

const typeCounts = computed(() => {
  const map: Record<string, number> = { worker: 0, pages: 0, hybrid: 0 };
  templates.value.forEach((it) => {
    const t = it.template.type;
    if (map[t] !== undefined) map[t]++;
  });
  return (['worker', 'pages', 'hybrid'] as const).map((v) => ({
    value: v,
    label: v === 'worker' ? 'Worker' : v === 'pages' ? 'Pages' : 'Hybrid',
    count: map[v],
  }));
});

const allTags = computed(() => {
  const tags = new Set<string>();
  templates.value.forEach((t) => (t.template.tags || []).forEach((tag: string) => tags.add(tag)));
  return Array.from(tags).sort();
});

const hasActiveFilter = computed(
  () => !!searchText.value || !!selectedType.value || selectedTags.value.length > 0 || favOnly.value,
);

// 源仓库地址：优先用 homepage，其次从 readmeBaseUrl（raw.githubusercontent）推断
const sourceRepoUrl = computed(() => {
  const homepage = detailItem.value?.template.homepage;
  if (homepage) return homepage;
  const m = readmeBaseUrl.value.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\//);
  return m ? `https://github.com/${m[1]}/${m[2]}` : '';
});

// 在 GitHub 上查看完整 README（图片等资产由 GitHub 正确渲染，绕开 raw 拉取限制）
const readmeGithubUrl = computed(() => {
  const m = readmeBaseUrl.value.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\//);
  return m ? `https://github.com/${m[1]}/${m[2]}/blob/${m[3]}/README.md` : sourceRepoUrl.value;
});

// 仓库根目录（用于把相对仓库根目录的图片/链接也解析为绝对地址）
const repoRootUrl = computed(() => {
  const m = readmeBaseUrl.value.match(/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\//);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/` : '';
});

const filteredTemplates = computed(() => {
  let list = templates.value;
  const q = searchText.value.trim().toLowerCase();
  if (q) {
    list = list.filter((t) => {
      const tm = t.template;
      return (
        tm.name?.toLowerCase().includes(q) ||
        tm.description?.toLowerCase().includes(q) ||
        (tm.tags || []).some((tag: string) => tag.toLowerCase().includes(q))
      );
    });
  }
  if (selectedType.value) {
    list = list.filter((t) => t.template.type === selectedType.value);
  }
  if (selectedTags.value.length) {
    list = list.filter((t) => (t.template.tags || []).some((tag) => selectedTags.value.includes(tag)));
  }
  if (favOnly.value) {
    list = list.filter((t) => isFav(t));
  }
  return [...list].sort((a, b) => {
    const fa = isFav(a) ? 1 : 0;
    const fb = isFav(b) ? 1 : 0;
    if (fa !== fb) return fb - fa; // 收藏置顶
    if (sortBy.value === 'name') return a.template.name.localeCompare(b.template.name);
    return compareSemver(b.template.version, a.template.version);
  });
});

function compareSemver(a: string, b: string): number {
  const pa = (a || '0.0.0').split('.').map(Number);
  const pb = (b || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function bindingTagType(type: CatalogBindingType) {
  const map: Record<string, any> = { kv: 'success', d1: 'info', r2: 'warning', ai: 'default', var: 'error' };
  return map[type] || 'default';
}

function toggleTag(tag: string) {
  const idx = selectedTags.value.indexOf(tag);
  if (idx >= 0) selectedTags.value.splice(idx, 1);
  else selectedTags.value.push(tag);
}

function clearFilters() {
  searchText.value = '';
  selectedType.value = null;
  selectedTags.value = [];
  favOnly.value = false;
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

// 从 GitHub 仓库地址推断 README 原始地址（支持 main/master 分支回退）
function githubReadmeCandidates(url?: string): string[] {
  if (!url) return [];
  const m = url.match(/github\.com\/([^/\s]+)\/([^/\s]+)/i);
  if (!m) return [];
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, '');
  const base = `https://raw.githubusercontent.com/${owner}/${repo}`;
  return [`${base}/main/README.md`, `${base}/master/README.md`];
}

async function showDetail(item: TemplateItem) {
  detailItem.value = item;
  detailVisible.value = true;
  readmeContent.value = '';
  readmeBaseUrl.value = '';
  readmeLoading.value = true;
  try {
    // 优先使用 catalog 配置的 readmeUrl；未配置时从 homepage / source.url 推断
    const urls: string[] = [];
    if (item.template.readmeUrl) {
      urls.push(item.template.readmeUrl);
    } else {
      const repoCandidates = githubReadmeCandidates(
        item.template.homepage || item.template.source?.url,
      );
      urls.push(...repoCandidates);
      // 如果上面没匹配到，再用 author.url 补试
      if (repoCandidates.length === 0 && item.template.author?.url) {
        urls.push(...githubReadmeCandidates(item.template.author?.url));
      }
    }
    for (const url of urls) {
      try {
        const resp = await fetch(url);
        if (resp.ok) {
          const text = await resp.text();
          if (text && !text.startsWith('404: Not Found')) {
            readmeContent.value = text;
            // 记录 README 所在目录，用于把相对图片/链接转成绝对地址
            readmeBaseUrl.value = url.replace(/[^/]*$/, '');
            break;
          }
        }
      } catch {
        // 尝试下一个候选地址
      }
    }
  } finally {
    readmeLoading.value = false;
  }
}

function openDeploy(item: TemplateItem) {
  deployItem.value = item;
  deployVisible.value = true;
}

function onDeployed(result: any) {
  const data = result.data || result;
  if (data.error) {
    message.error(`部署失败: ${data.error}`);
    if (data.rolledBack) message.warning('已自动回滚');
    return;
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
  // 已配置目录源但模板为空时，自动刷新拉取数据
  if (sources.value.length > 0 && templates.value.length === 0) {
    await loadTemplates(true);
  }
});
</script>

<style scoped>
.page-view {
  max-width: 1100px;
  margin: 0 auto;
}
</style>
