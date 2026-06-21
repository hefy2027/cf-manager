import { createRouter, createWebHistory } from 'vue-router';

const routes = [
  { path: '/', name: 'dashboard', component: () => import('../views/DashboardView.vue') },
  { path: '/accounts', name: 'accounts', component: () => import('../views/AccountsView.vue') },
  { path: '/dns', name: 'dns', component: () => import('../views/DnsView.vue') },
  { path: '/workers', name: 'workers', component: () => import('../views/WorkersView.vue') },
  { path: '/ai', name: 'ai', component: () => import('../views/AiView.vue') },
  { path: '/storage', name: 'storage', component: () => import('../views/StorageView.vue') },
  { path: '/browser-render', name: 'browser-render', component: () => import('../views/BrowserRenderView.vue') },
  { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
];

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
});

export default router;
