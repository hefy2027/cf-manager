import apiClient from './client';

export interface AccountListParams {
  page?: number;
  pageSize?: number;
  filter?: 'all' | 'active' | 'unverified';
  search?: string;
}

export const accountsApi = {
  getAll: (params: AccountListParams = {}) =>
    apiClient.get('/accounts', { params }),
  create: (data: any) => apiClient.post('/accounts', data),
  delete: (id: number) => apiClient.delete(`/accounts/${id}`),
  test: (id: number) => apiClient.post(`/accounts/${id}/test`),
  testBatch: (data: { ids?: number[]; onlyUnverified?: boolean }) =>
    apiClient.post('/accounts/test-batch', data, { timeout: 600000 }),
  updateFeatures: (id: number, enabled_features: string) =>
    apiClient.patch(`/accounts/${id}/features`, { enabled_features }),
  clearExhausted: (id: number) =>
    apiClient.post(`/accounts/${id}/clear-exhausted`),
  getCredentials: (id: number) =>
    apiClient.get(`/accounts/${id}/credentials`),
  importCsv: (file: File, skipVerify = false) => {
    const formData = new FormData();
    formData.append('file', file);
    if (skipVerify) formData.append('skipVerify', '1');
    return apiClient.post('/accounts/import-csv', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 600000, // 10 分钟，并发批处理下足够覆盖数百账户
    });
  },
};
