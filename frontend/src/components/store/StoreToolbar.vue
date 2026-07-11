<template>
  <n-space align="center" class="toolbar" wrap>
    <n-input
      :value="searchText"
      @update:value="(v: string) => emit('update:searchText', v)"
      placeholder="搜索模板..."
      clearable
      size="small"
      style="width: 220px"
    />
    <n-select
      :value="sortBy"
      @update:value="(v: string) => emit('update:sortBy', v as 'name' | 'version')"
      :options="sortOptions"
      size="small"
      style="width: 150px"
    />
    <n-button
      size="small"
      :type="favOnly ? 'primary' : 'default'"
      :secondary="favOnly"
      @click="emit('update:favOnly', !favOnly)"
    >
      <template #icon>
        <n-icon :component="favOnly ? Star : StarOutline" />
      </template>
      {{ favOnly ? '仅看收藏' : '收藏' }}
    </n-button>
    <n-button
      v-if="hasActiveFilter"
      size="small"
      quaternary
      @click="emit('clear')"
    >
      清除筛选
    </n-button>
  </n-space>
</template>

<script setup lang="ts">
import { Star, StarOutline } from '@vicons/ionicons5';

const props = defineProps<{
  searchText: string;
  sortBy: 'name' | 'version';
  favOnly: boolean;
  hasActiveFilter: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:searchText', value: string): void;
  (e: 'update:sortBy', value: 'name' | 'version'): void;
  (e: 'update:favOnly', value: boolean): void;
  (e: 'clear'): void;
}>();

const sortOptions = [
  { label: '名称 (A-Z)', value: 'name' },
  { label: '版本 (新→旧)', value: 'version' },
];
</script>

<style scoped>
.toolbar {
  margin-bottom: 16px;
}
</style>
