<template>
  <n-config-provider :theme="theme">
    <n-dialog-provider>
      <n-message-provider>
        <n-notification-provider>
          <n-loading-bar-provider>
            <!-- 初始加载 -->
            <div v-if="authChecking" style="display: flex; justify-content: center; align-items: center; height: 100vh">
              <n-spin size="large" />
            </div>

            <!-- 登录界面 -->
            <div v-else-if="showLogin" style="display: flex; justify-content: center; align-items: center; height: 100vh; padding: 16px">
              <n-card title="CF Manager" style="width: 400px; max-width: 100%">
                <n-form @submit.prevent="handleLogin">
                  <n-form-item label="API Secret">
                    <n-input v-model:value="loginSecret" type="password" placeholder="输入 API Secret" show-password-on="click" @keyup.enter="handleLogin" />
                  </n-form-item>
                  <n-button type="primary" block :loading="loginLoading" @click="handleLogin">登录</n-button>
                </n-form>
              </n-card>
            </div>

            <!-- Desktop Layout -->
            <n-layout v-else-if="!isMobile" has-sider style="height: 100vh">
              <n-layout-sider bordered :width="220" :collapsed-width="64" collapse-mode="width" :collapsed="collapsed">
                <div style="padding: 16px; text-align: center; font-weight: bold; font-size: 18px">
                  {{ collapsed ? 'CF' : 'CF Manager' }}
                </div>
                <n-menu v-model:value="activeMenuKey" :options="menuOptions" :collapsed="collapsed" @update:value="handleMenuClick" />
              </n-layout-sider>
              <n-layout>
                <n-layout-header bordered style="height: 48px; display: flex; align-items: center; justify-content: space-between; padding: 0 16px">
                  <n-button quaternary circle @click="collapsed = !collapsed">
                    <template #icon><n-icon :component="MenuOutline" /></template>
                  </n-button>
                  <n-space>
                    <n-button quaternary circle @click="toggleTheme">
                      <template #icon><n-icon :component="isDark ? SunnyOutline : MoonOutline" /></template>
                    </n-button>
                    <n-button v-if="isAuthenticated" quaternary size="small" @click="handleLogout">退出</n-button>
                  </n-space>
                </n-layout-header>
                <n-layout-content content-style="padding: 24px; height: 100%; box-sizing: border-box;" style="height: calc(100vh - 48px - 32px); overflow-y: auto">
                  <router-view />
                </n-layout-content>
                <n-layout-footer bordered style="height: 32px; display: flex; align-items: center; justify-content: flex-end; padding: 0 16px; font-size: 12px; color: #999">
                  <span v-if="appVersion">CF Manager v{{ appVersion }}<template v-if="appCommit"> · {{ appCommit }}</template></span>
                </n-layout-footer>
              </n-layout>
            </n-layout>

            <!-- Mobile Layout -->
            <div v-else class="mobile-layout">
              <div class="mobile-content">
                <router-view />
                <div class="app-footer" v-if="appVersion">CF Manager v{{ appVersion }}<template v-if="appCommit"> · {{ appCommit }}</template></div>
              </div>

              <!-- FAB Overlay -->
              <transition name="fab-overlay">
                <div v-if="fabOpen" class="fab-overlay" @click="fabOpen = false" />
              </transition>

              <!-- FAB Panel -->
              <transition name="fab-panel">
                <div v-if="fabOpen" class="fab-panel" :class="{ 'fab-panel--dark': isDark }">
                  <div class="fab-panel-header">
                    <span class="fab-panel-title">CF Manager</span>
                    <div class="fab-panel-actions">
                      <n-button circle size="small" quaternary @click="toggleTheme">
                        <template #icon><n-icon :component="isDark ? SunnyOutline : MoonOutline" :size="16" /></template>
                      </n-button>
                      <n-button circle size="small" quaternary type="error" @click="handleLogout">
                        <template #icon><n-icon :component="LogOutOutline" :size="16" /></template>
                      </n-button>
                    </div>
                  </div>
                  <div class="fab-panel-body">
                    <div class="fab-grid">
                      <div
                        v-for="item in navItems"
                        :key="item.key"
                        class="fab-item"
                        :class="{ 'fab-item--active': activeMenuKey === item.key }"
                        @click="handleMenuClick(item.key); fabOpen = false"
                      >
                        <n-icon :component="item.iconComponent" :size="22" />
                        <span class="fab-item-label">{{ item.label }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </transition>

              <!-- FAB Button -->
              <div
                class="fab-btn"
                :class="{ 'fab-btn--open': fabOpen, 'fab-btn--dragging': fabDragging, 'fab-btn--dark': isDark }"
                :style="fabStyle"
                @click.prevent="onFabClick"
                @touchstart.passive="onFabTouchStart"
                @touchmove.prevent="onFabTouchMove"
                @touchend.passive="onFabTouchEnd"
              >
                <n-icon :component="fabOpen ? CloseOutline : GridOutline" :size="24" />
              </div>
            </div>
          </n-loading-bar-provider>
        </n-notification-provider>
      </n-message-provider>
    </n-dialog-provider>
  </n-config-provider>
</template>

<script setup lang="ts">
import { ref, reactive, computed, h, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { darkTheme } from 'naive-ui';
import type { Component } from 'vue';
import { NIcon } from 'naive-ui';
import {
  SpeedometerOutline, PeopleOutline, GlobeOutline, ConstructOutline,
  SparklesOutline, ImageOutline, SettingsOutline,
  MenuOutline, SunnyOutline, MoonOutline, ServerOutline,
  CloseOutline, GridOutline, LogOutOutline, StorefrontOutline,
} from '@vicons/ionicons5';
import apiClient from './api/client';
import { message as globalMessage } from './utils/discreteApi';

const router = useRouter();
const route = useRoute();
const collapsed = ref(false);
const isDark = ref(false);
const activeMenuKey = ref(route.name as string);
const theme = computed(() => isDark.value ? darkTheme : null);

const isAuthenticated = ref(!!localStorage.getItem('api_token'));
const showLogin = ref(false);
const authChecking = ref(true);
const loginSecret = ref('');
const loginLoading = ref(false);
const appVersion = ref('');
const appCommit = ref('');

function applyVersion(data: any) {
  appVersion.value = data?.version || '';
  appCommit.value = data?.git_commit || '';
}

const isMobile = ref(window.innerWidth <= 768);
const fabOpen = ref(false);
const fabDragging = ref(false);
const fabPos = reactive({ x: -1, y: -1 });
let dragStartX = 0, dragStartY = 0, dragStartPosX = 0, dragStartPosY = 0;
let dragMoved = false;

const fabStyle = computed(() => {
  if (fabPos.x < 0) return {};
  return { right: 'auto', bottom: 'auto', left: fabPos.x + 'px', top: fabPos.y + 'px' };
});

const navItems = [
  { label: '仪表盘', key: 'dashboard', iconComponent: SpeedometerOutline },
  { label: '账号', key: 'accounts', iconComponent: PeopleOutline },
  { label: 'DNS', key: 'dns', iconComponent: GlobeOutline },
  { label: 'Workers', key: 'workers', iconComponent: ConstructOutline },
  { label: '存储', key: 'storage', iconComponent: ServerOutline },
  { label: 'AI', key: 'ai', iconComponent: SparklesOutline },
  { label: '渲染', key: 'browser-render', iconComponent: ImageOutline },
  { label: '商店', key: 'store', iconComponent: StorefrontOutline },
  { label: '设置', key: 'settings', iconComponent: SettingsOutline },
];

function initFabPos() {
  if (fabPos.x < 0) {
    fabPos.x = window.innerWidth - 72;
    fabPos.y = window.innerHeight - 72;
  }
}

function clampFab() {
  fabPos.x = Math.max(8, Math.min(window.innerWidth - 64, fabPos.x));
  fabPos.y = Math.max(8, Math.min(window.innerHeight - 64, fabPos.y));
}

function snapToEdge() {
  const center = fabPos.x + 28;
  fabPos.x = center < window.innerWidth / 2 ? 12 : window.innerWidth - 68;
}

function onFabClick() {
  if (dragMoved) return;
  fabOpen.value = !fabOpen.value;
}

function onFabTouchStart(e: TouchEvent) {
  const t = e.touches[0];
  dragStartX = t.clientX; dragStartY = t.clientY;
  dragStartPosX = fabPos.x; dragStartPosY = fabPos.y;
  dragMoved = false;
  fabDragging.value = true;
}

function onFabTouchMove(e: TouchEvent) {
  if (!fabDragging.value) return;
  const t = e.touches[0];
  const dx = t.clientX - dragStartX, dy = t.clientY - dragStartY;
  if (Math.abs(dx) > 5 || Math.abs(dy) > 5) dragMoved = true;
  fabPos.x = dragStartPosX + dx;
  fabPos.y = dragStartPosY + dy;
  clampFab();
}

function onFabTouchEnd() {
  fabDragging.value = false;
  clampFab();
  snapToEdge();
}

function onResize() {
  isMobile.value = window.innerWidth <= 768;
  if (isMobile.value && fabPos.x >= 0) clampFab();
}

onMounted(async () => {
  initFabPos();
  window.addEventListener('resize', onResize);
  window.addEventListener('auth-expired', () => {
    isAuthenticated.value = false;
    showLogin.value = true;
  });
  try {
    const resp: any = await apiClient.get('/settings', { _silent: true });
    applyVersion(resp.data);
    showLogin.value = false;
  } catch (err: any) {
    if (err?.response?.status === 401 || err?.response?.status === 403) {
      showLogin.value = true;
    }
  } finally {
    authChecking.value = false;
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
});

async function handleLogin() {
  if (!loginSecret.value) return;
  loginLoading.value = true;
  try {
    localStorage.setItem('api_token', loginSecret.value);
    const resp: any = await apiClient.get('/settings', { _silent: true });
    applyVersion(resp.data);
    isAuthenticated.value = true;
    showLogin.value = false;
  } catch {
    localStorage.removeItem('api_token');
    isAuthenticated.value = false;
    globalMessage.error('API Secret 不正确');
  } finally {
    loginLoading.value = false;
  }
}

function handleLogout() {
  localStorage.removeItem('api_token');
  isAuthenticated.value = false;
  showLogin.value = true;
  loginSecret.value = '';
}

watch(() => route.name, (newName) => {
  if (newName) activeMenuKey.value = newName as string;
});

function renderIcon(icon: Component) {
  return () => h(NIcon, null, { default: () => h(icon) });
}

const menuOptions = [
  { label: '仪表盘', key: 'dashboard', icon: renderIcon(SpeedometerOutline) },
  { label: '账号管理', key: 'accounts', icon: renderIcon(PeopleOutline) },
  { label: 'DNS 管理', key: 'dns', icon: renderIcon(GlobeOutline) },
  { label: 'Workers', key: 'workers', icon: renderIcon(ConstructOutline) },
  { label: '存储管理', key: 'storage', icon: renderIcon(ServerOutline) },
  { label: 'AI 推理', key: 'ai', icon: renderIcon(SparklesOutline) },
  { label: '浏览器渲染', key: 'browser-render', icon: renderIcon(ImageOutline) },
  { label: '模板商店', key: 'store', icon: renderIcon(StorefrontOutline) },
  { label: '设置', key: 'settings', icon: renderIcon(SettingsOutline) },
];

function handleMenuClick(key: string) {
  router.push({ name: key }).catch(() => {});
}

function toggleTheme() {
  isDark.value = !isDark.value;
}
</script>

<style scoped>
/* Mobile Layout */
.mobile-layout {
  height: 100vh;
  overflow-y: auto;
  scrollbar-width: none;
  -ms-overflow-style: none;
  display: flex;
  flex-direction: column;
}
.mobile-layout::-webkit-scrollbar {
  display: none;
}

.mobile-content {
  flex: 1;
  padding: 10px;
  display: flex;
  flex-direction: column;
}

.app-footer {
  margin-top: auto;
  padding: 12px 4px 4px;
  text-align: center;
  font-size: 12px;
  color: #999;
}

.page-view {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
}

/* FAB Button */
.fab-btn {
  position: fixed;
  bottom: 20px;
  right: 16px;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: #18a058;
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 1100;
  box-shadow: 0 4px 16px rgba(24, 160, 88, 0.4);
  transition: transform 0.2s ease, background 0.2s, box-shadow 0.2s;
  user-select: none;
  -webkit-tap-highlight-color: transparent;
}

.fab-btn:active { transform: scale(0.92); }
.fab-btn--dragging { transition: none !important; transform: scale(1.08); opacity: 0.85; }

.fab-btn--open {
  background: #fff;
  color: #333;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
}

.fab-btn--open.fab-btn--dark {
  background: #2c2c32;
  color: #e0e0e0;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}

/* FAB Overlay */
.fab-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 1090;
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

/* FAB Panel */
.fab-panel {
  position: fixed;
  bottom: 88px;
  right: 16px;
  width: calc(100vw - 32px);
  max-width: 360px;
  max-height: 70vh;
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(230, 230, 230, 0.8);
  border-radius: 20px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.12);
  z-index: 1095;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.fab-panel--dark {
  background: rgba(36, 36, 40, 0.95);
  border-color: rgba(255, 255, 255, 0.08);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.4);
}

.fab-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid rgba(230, 230, 230, 0.6);
  flex-shrink: 0;
}

.fab-panel--dark .fab-panel-header {
  border-bottom-color: rgba(255, 255, 255, 0.08);
}

.fab-panel-title {
  font-size: 0.95rem;
  font-weight: 600;
}

.fab-panel-actions {
  display: flex;
  gap: 4px;
}

.fab-panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
}

/* FAB Grid */
.fab-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
}

.fab-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 6px;
  border-radius: 14px;
  cursor: pointer;
  transition: background 0.15s;
  -webkit-tap-highlight-color: transparent;
}

.fab-item:active {
  transform: scale(0.95);
}

.fab-item:hover {
  background: rgba(24, 160, 88, 0.06);
}

.fab-item--active {
  background: rgba(24, 160, 88, 0.12);
  color: #18a058;
}

.fab-panel--dark .fab-item:hover {
  background: rgba(24, 160, 88, 0.12);
}

.fab-panel--dark .fab-item--active {
  background: rgba(24, 160, 88, 0.2);
}

.fab-item-label {
  font-size: 0.7rem;
  font-weight: 500;
  white-space: nowrap;
}

/* Transitions */
.fab-overlay-enter-active,
.fab-overlay-leave-active {
  transition: opacity 0.2s ease;
}
.fab-overlay-enter-from,
.fab-overlay-leave-to {
  opacity: 0;
}

.fab-panel-enter-active {
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
}
.fab-panel-leave-active {
  transition: transform 0.2s ease, opacity 0.15s ease;
}
.fab-panel-enter-from {
  transform: translateY(20px) scale(0.95);
  opacity: 0;
}
.fab-panel-leave-to {
  transform: translateY(10px) scale(0.97);
  opacity: 0;
}
</style>
