import { defineStore } from 'pinia';
import { ref } from 'vue';
import { accountsApi } from '../api/accounts';

export const useAccountStore = defineStore('accounts', () => {
  const accounts = ref<any[]>([]);
  const quota = ref<any[]>([]);
  const loading = ref(false);

  // 分页/筛选/搜索状态
  const page = ref(1);
  const pageSize = ref(10);
  const filter = ref<'all' | 'active' | 'unverified'>('all');
  const search = ref('');
  const total = ref(0);             // 当前筛选条件下总数
  const counts = ref({ all: 0, active: 0, unverified: 0 }); // 三种状态各自总数

  async function fetchAccounts() {
    loading.value = true;
    try {
      const { data } = await accountsApi.getAll({
        page: page.value,
        pageSize: pageSize.value,
        filter: filter.value,
        search: search.value,
      });
      accounts.value = data.accounts;
      quota.value = data.quota;
      // 分页响应可能不包含 total/counts（旧后端），做兼容
      total.value = (data as any).total ?? data.accounts.length;
      counts.value = (data as any).counts ?? { all: data.accounts.length, active: 0, unverified: 0 };
    } catch {
      accounts.value = [];
      quota.value = [];
      total.value = 0;
      counts.value = { all: 0, active: 0, unverified: 0 };
    } finally {
      loading.value = false;
    }
  }

  function setPage(p: number) {
    page.value = p;
    return fetchAccounts();
  }
  function setPageSize(ps: number) {
    pageSize.value = ps;
    page.value = 1;
    return fetchAccounts();
  }
  function setFilter(f: 'all' | 'active' | 'unverified') {
    filter.value = f;
    page.value = 1;
    return fetchAccounts();
  }
  function setSearch(s: string) {
    search.value = s;
    page.value = 1;
    return fetchAccounts();
  }

  async function createAccount(input: any) {
    await accountsApi.create(input);
    await fetchAccounts();
  }

  async function deleteAccount(id: number) {
    await accountsApi.delete(id);
    await fetchAccounts();
  }

  async function testAccount(id: number) {
    const { data } = await accountsApi.test(id);
    return data;
  }

  async function testBatch(opts: { ids?: number[]; onlyUnverified?: boolean }) {
    const { data } = await accountsApi.testBatch(opts);
    await fetchAccounts();
    return data as { summary: { total: number; success: number; error: number }; results: Array<{ id: number; name: string; status: 'success' | 'error'; message?: string }> };
  }

  async function updateFeatures(id: number, enabled_features: string) {
    await accountsApi.updateFeatures(id, enabled_features);
    await fetchAccounts();
  }

  async function clearExhausted(id: number) {
    await accountsApi.clearExhausted(id);
    await fetchAccounts();
  }

  async function getCredentials(id: number) {
    const { data } = await accountsApi.getCredentials(id);
  return data as {
    id: number;
    name: string;
    auth_type: 'token' | 'global_key';
    account_id: string | null;
    email: string | null;
    api_token: string | null;
    api_key: string | null;
    password: string | null;
  };
  }

  async function importCsv(file: File, skipVerify = false) {
    const { data } = await accountsApi.importCsv(file, skipVerify);
    await fetchAccounts();
    return data as { summary: { total: number; success: number; skipped: number; error: number }; results: Array<{ email: string; name: string; status: 'success' | 'skipped' | 'error'; message?: string }> };
  }

  return {
    accounts, quota, loading,
    page, pageSize, filter, search, total, counts,
    fetchAccounts, setPage, setPageSize, setFilter, setSearch,
    createAccount, deleteAccount, testAccount, testBatch, updateFeatures, clearExhausted, importCsv,
    getCredentials,
  };
});
