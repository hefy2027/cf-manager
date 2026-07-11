<template>
  <n-card hoverable size="small" class="store-card" @click="emit('detail', item)">
    <template #header>
      <n-space align="center" :size="8">
        <span class="cover-thumb">{{ isIconUrl ? '' : (item.template.icon || '📦') }}</span>
        <img v-if="isIconUrl" :src="item.template.icon" class="cover-thumb-img" alt="" />
        <span class="tpl-name">{{ item.template.name }}</span>
      </n-space>
    </template>

    <template #header-extra>
      <n-button
        text
        size="small"
        @click.stop="emit('toggle-fav', item)"
        :title="faved ? '取消收藏' : '收藏'"
      >
        <n-icon
          :component="faved ? Star : StarOutline"
          :color="faved ? '#f0a020' : 'var(--text-color-3)'"
          :size="18"
        />
      </n-button>
    </template>

    <p class="tpl-desc">{{ item.template.description || '暂无描述' }}</p>

    <n-space v-if="bindingTypes.length" class="binding-row" size="small">
      <n-tag
        v-for="b in bindingTypes"
        :key="b"
        size="tiny"
        round
        :type="bindingTagType(b)"
        :bordered="false"
      >
        {{ b.toUpperCase() }}
      </n-tag>
    </n-space>

    <n-space class="tag-row" size="small">
      <n-tag v-for="tag in displayTags" :key="tag" size="tiny">{{ tag }}</n-tag>
    </n-space>

    <template #footer>
      <n-space justify="space-between" align="center">
        <span class="meta">
          <template v-if="item.template.author?.url">
            <a :href="item.template.author.url" target="_blank" rel="noopener noreferrer" @click.stop>{{ item.template.author.name }}</a>
          </template>
          <template v-else>by {{ item.template.author?.name || 'unknown' }}</template>
          <n-tag size="tiny" round class="ver-tag">{{ item.template.version }}</n-tag>
        </span>
        <n-button size="tiny" type="primary" @click.stop="emit('deploy', item)">部署</n-button>
      </n-space>
    </template>
  </n-card>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Star, StarOutline } from '@vicons/ionicons5';
import type { CatalogBindingType, TemplateItem } from '../../types/store';
import { isFav } from '../../utils/favorites';

const props = defineProps<{ item: TemplateItem }>();
const emit = defineEmits<{
  (e: 'detail', item: TemplateItem): void;
  (e: 'deploy', item: TemplateItem): void;
  (e: 'toggle-fav', item: TemplateItem): void;
}>();

const faved = computed(() => isFav(props.item));

const isIconUrl = computed(() =>
  /^(https?:|data:)/.test(props.item.template.icon || ''),
);

const bindingTypes = computed(() => {
  const set = new Set<CatalogBindingType>();
  (props.item.template.bindings || []).forEach((b) => set.add(b.type));
  return Array.from(set);
});

const displayTags = computed(() => (props.item.template.tags || []).slice(0, 4));

function bindingTagType(type: CatalogBindingType) {
  const map: Record<string, any> = {
    kv: 'success',
    d1: 'info',
    r2: 'warning',
    ai: 'default',
    var: 'error',
  };
  return map[type] || 'default';
}
</script>

<style scoped>
.store-card {
  height: 100%;
}
.cover-thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  background: linear-gradient(135deg, var(--primary-color) 0%, #7c5cff 100%);
  color: #fff;
  font-size: 15px;
}
.cover-thumb-img {
  width: 26px;
  height: 26px;
  border-radius: 6px;
  object-fit: cover;
}
.tpl-name {
  font-weight: 600;
  font-size: 14px;
}
.tpl-desc {
  margin: 0 0 10px;
  color: var(--text-color-3);
  font-size: 13px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 36px;
}
.binding-row {
  margin-bottom: 8px;
}
.tag-row {
  margin-bottom: 4px;
  min-height: 22px;
}
.meta {
  font-size: 12px;
  color: var(--text-color-3);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.meta a {
  color: var(--primary-color);
  text-decoration: none;
}
.ver-tag {
  margin-left: 2px;
}
</style>
