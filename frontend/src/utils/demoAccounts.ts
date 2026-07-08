import { ref } from 'vue';
import { accountsApi } from '../api/accounts';

// 全量账户缓存（含 is_demo 标记），用于前端判断某账户是否为演示保护账户。
// 模块级单例：多个视图共享一次加载结果，避免重复请求。
const accountsCache = ref<Array<{ id: number; is_demo?: boolean }>>([]);
let loaded = false;

export async function loadDemoAccounts(): Promise<void> {
  if (loaded) return;
  try {
    const { data } = await accountsApi.getAll();
    accountsCache.value = data.accounts || [];
  } catch {
    accountsCache.value = [];
  }
  loaded = true;
}

// 判断指定数据库账户 id 是否为演示（Demo）保护账户。
// 读取 accountsCache.value，天然具备 Vue 响应式依赖追踪。
export function isDemoAccount(id?: number | null): boolean {
  if (id == null) return false;
  return accountsCache.value.some((a) => a.id === id && a.is_demo);
}
