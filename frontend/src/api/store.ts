import apiClient from './client';

export const storeApi = {
  // Sources
  getSources: () => apiClient.get('/store/sources'),
  addSource: (url: string, name: string) => apiClient.post('/store/sources', { url, name }),
  testSource: (url: string) => apiClient.post('/store/sources/test', { url }),
  updateSource: (id: number, data: any) => apiClient.put(`/store/sources/${id}`, data),
  deleteSource: (id: number) => apiClient.delete(`/store/sources/${id}`),

  // Templates
  getTemplates: () => apiClient.get('/store/templates'),
  refresh: () => apiClient.post('/store/refresh'),
  init: () => apiClient.get('/store/init', { _silent: true }),

  // Preflight (两阶段部署: 预检)
  preflight: (data: {
    accountId: number;
    templateId: string;
    name: string;
    bindingSelections?: Record<string, any>;
    secretValues?: Record<string, string>;
    deployType?: 'worker' | 'pages' | 'both';
  }) => apiClient.post('/store/preflight', data, { timeout: 30000 }),

  // Deploy (两阶段部署: 确认执行)
  deploy: (data: {
    accountId: number;
    templateId: string;
    name: string;
    bindingSelections?: Record<string, any>;
    secretValues?: Record<string, string>;
    deployType?: 'worker' | 'pages' | 'both';
    traces?: boolean;   // Workers 跟踪（默认开启）
    logs?: boolean;     // Workers 日志（默认开启）
  }) => apiClient.post('/store/deploy', data, { timeout: 120000 }),
};
