import { defineStore } from 'pinia';
import { ref } from 'vue';
import { dnsApi } from '../api/dns';

export const useDnsStore = defineStore('dns', () => {
  const domains = ref<any[]>([]);
  const records = ref<any[]>([]);
  const currentDomain = ref('');
  const loading = ref(false);
  const zoneSettings = ref<Record<string, any>>({});
  const settingsLoading = ref(false);
  // 加载失败时的原因（例如该账号的 API Token 缺少 DNS:Read 权限）。
  // 保留在 store 里是为了在面板内展示可读提示，而不是只靠一次性的全局 toast。
  const recordsError = ref('');
  const settingsError = ref('');

  async function fetchDomains() {
    loading.value = true;
    try {
      const { data } = await dnsApi.getDomains();
      domains.value = data;
    } catch {
      domains.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function fetchRecords(domain: string) {
    loading.value = true;
    currentDomain.value = domain;
    recordsError.value = '';
    try {
      const { data } = await dnsApi.getRecords(domain);
      records.value = data;
    } catch (err: any) {
      records.value = [];
      recordsError.value = err?.errorMessage || err?.message || '';
    } finally {
      loading.value = false;
    }
  }

  async function createDomains(data: { names: string[]; account_id: number; type: 'full' | 'partial' }) {
    const { data: result } = await dnsApi.createDomains(data);
    await fetchDomains();
    return result;
  }

  async function deleteDomains(domains: string[]) {
    const { data: result } = await dnsApi.deleteDomains(domains);
    await fetchDomains();
    return result;
  }

  async function fetchZoneSettings(domain: string) {
    settingsLoading.value = true;
    settingsError.value = '';
    try {
      const { data } = await dnsApi.getSettings(domain);
      zoneSettings.value = data;
    } catch (err: any) {
      zoneSettings.value = {};
      settingsError.value = err?.errorMessage || err?.message || '';
    } finally {
      settingsLoading.value = false;
    }
  }

  async function updateZoneSettings(domain: string, settings: Record<string, any>) {
    const { data } = await dnsApi.updateSettings(domain, settings);
    return data;
  }

  async function purgeZoneCache(domain: string, options: { purge_everything?: boolean; files?: string[] }) {
    const { data } = await dnsApi.purgeCache(domain, options);
    return data;
  }

  async function updateZoneStatus(domain: string, paused: boolean) {
    await dnsApi.updateStatus(domain, paused);
    // 更新本地域名列表中的状态
    const d = domains.value.find((x: any) => (typeof x === 'string' ? x : x.name) === domain);
    if (d && typeof d === 'object') {
      d.status = paused ? 'paused' : 'active';
    }
  }

  return {
    domains, records, currentDomain, loading,
    zoneSettings, settingsLoading,
    recordsError, settingsError,
    fetchDomains, fetchRecords,
    createDomains, deleteDomains,
    fetchZoneSettings, updateZoneSettings, purgeZoneCache, updateZoneStatus,
  };
});
