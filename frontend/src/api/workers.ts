import apiClient from './client';

export const workersApi = {
  // List all (可按 accountId 按需加载，不带参数返回全部)
  getAll: (accountId?: number) => apiClient.get('/workers', {
    params: accountId != null ? { accountId } : undefined,
  }),
  // 账户用量 + 已部署数量摘要
  getSummary: () => apiClient.get('/workers/summary'),

  // Deploy / Delete
  deploy: (accountId: number, name: string, file: File) => {
    const formData = new FormData();
    formData.append('script', file);
    formData.append('name', name);
    return apiClient.post(`/workers/${accountId}/workers`, formData);
  },
  deployFromUrl: (accountId: number, name: string, url: string) => {
    return apiClient.post(`/workers/${accountId}/workers`, { name, url });
  },
  deployPages: (accountId: number, name: string, files: File[], skipCreateProject?: boolean) => {
    const formData = new FormData();
    formData.append('name', name);
    if (skipCreateProject) formData.append('skipCreateProject', 'true');
    files.forEach(f => formData.append('files', f, f.name));
    return apiClient.post(`/workers/${accountId}/pages/deploy`, formData, { timeout: 120000 });
  },
  delete: (accountId: number, name: string) => apiClient.delete(`/workers/${accountId}/workers/${name}`),
  deletePages: (accountId: number, name: string) => apiClient.delete(`/workers/${accountId}/pages/${name}`),
  getLogs: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/logs`, { _silent: true }),

  // Secrets
  getSecrets: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/secrets`),
  updateSecret: (accountId: number, workerName: string, secretName: string, type: string, text?: string, keyBase64?: string) =>
    apiClient.put(`/workers/${accountId}/workers/${workerName}/secrets`, { name: secretName, type, text, key_base64: keyBase64 }),
  deleteSecret: (accountId: number, name: string, secretName: string) =>
    apiClient.delete(`/workers/${accountId}/workers/${name}/secrets/${secretName}`),

  // Schedules (Cron Triggers)
  getSchedules: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/schedules`),
  updateSchedules: (accountId: number, name: string, crons: string[]) =>
    apiClient.put(`/workers/${accountId}/workers/${name}/schedules`, { crons }),

  // Custom Domains
  getDomains: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/domains`),
  createDomain: (accountId: number, name: string, hostname: string, environment?: string) =>
    apiClient.post(`/workers/${accountId}/workers/${name}/domains`, { hostname, environment }),
  deleteDomain: (accountId: number, name: string, domainId: string) =>
    apiClient.delete(`/workers/${accountId}/workers/${name}/domains/${domainId}`),

  // Subdomain (workers.dev)
  getSubdomain: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/subdomain`),
  setSubdomain: (accountId: number, name: string, enabled: boolean) =>
    apiClient.put(`/workers/${accountId}/workers/${name}/subdomain`, { enabled }),

  // Script Settings
  getSettings: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/settings`),
  updateSettings: (accountId: number, name: string, settings: any) =>
    apiClient.patch(`/workers/${accountId}/workers/${name}/settings`, settings),

  // Routes
  getRoutes: (accountId: number, name: string, zoneId: string) =>
    apiClient.get(`/workers/${accountId}/workers/${name}/routes?zone_id=${zoneId}`),
  createRoute: (accountId: number, name: string, zoneId: string, pattern: string, script?: string) =>
    apiClient.post(`/workers/${accountId}/workers/${name}/routes`, { zone_id: zoneId, pattern, script }),
  deleteRoute: (accountId: number, name: string, routeId: string, zoneId: string) =>
    apiClient.delete(`/workers/${accountId}/workers/${name}/routes/${routeId}?zone_id=${zoneId}`),

  // Script Content
  getContent: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/content`, { _silent: true }),

  // Deployments
  getDeployments: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/workers/${name}/deployments`),

  // Pages Settings
  getPagesProject: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/pages/${name}/project`),
  editPagesProject: (accountId: number, name: string, params: any) => apiClient.patch(`/workers/${accountId}/pages/${name}/project`, params),
  getPagesDomains: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/pages/${name}/domains`),
  addPagesDomain: (accountId: number, name: string, hostname: string) => apiClient.post(`/workers/${accountId}/pages/${name}/domains`, { hostname }),
  removePagesDomain: (accountId: number, name: string, hostname: string) => apiClient.delete(`/workers/${accountId}/pages/${name}/domains/${hostname}`),
  getPagesDeployments: (accountId: number, name: string) => apiClient.get(`/workers/${accountId}/pages/${name}/deployments`),

  // Resources (for Pages bindings)
  getKvNamespaces: (accountId: number) => apiClient.get(`/workers/${accountId}/resources/kv`),
  getD1Databases: (accountId: number) => apiClient.get(`/workers/${accountId}/resources/d1`),
  getR2Buckets: (accountId: number, config?: any) => apiClient.get(`/workers/${accountId}/resources/r2`, config),
  getZones: (accountId: number) => apiClient.get(`/workers/${accountId}/resources/zones`, { timeout: 60000 }),
  updatePagesBindings: (accountId: number, name: string, deploymentConfigs: any) =>
    apiClient.put(`/workers/${accountId}/pages/${name}/bindings`, { deployment_configs: deploymentConfigs }),

  // Usage
  getUsage: () => apiClient.get('/workers/usage'),

  // Batch Deploy
  batchDeploy: (targets: Array<{ accountId: number; workerName: string }>, script?: File, url?: string) => {
    const formData = new FormData();
    formData.append('targets', JSON.stringify(targets));
    if (script) formData.append('script', script);
    if (url) formData.append('url', url);
    return apiClient.post('/workers/batch-deploy', formData, { timeout: 120000 });
  },
  batchDeployPages: (targets: Array<{ accountId: number; workerName: string }>, zipFile: File) => {
    const formData = new FormData();
    formData.append('targets', JSON.stringify(targets));
    formData.append('zipFile', zipFile);
    return apiClient.post('/workers/batch-deploy-pages', formData, { timeout: 300000 });
  },

  // Environment Sync
  envSyncPreview: (source: { accountId: number; workerName: string }, targets: Array<{ accountId: number; workerName: string }>, syncTypes?: string[]) =>
    apiClient.post('/workers/env-sync/preview', { source, targets, syncTypes }),
  envSyncExecute: (source: { accountId: number; workerName: string }, targets: Array<{ accountId: number; workerName: string }>, secretValues: Record<string, string>, syncTypes?: string[]) =>
    apiClient.post('/workers/env-sync/execute', { source, targets, secretValues, syncTypes }),
};
