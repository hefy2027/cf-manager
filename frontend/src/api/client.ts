import axios, { type AxiosError } from 'axios';
import { message as globalMessage } from '../utils/discreteApi';
import i18n from '../i18n';

declare module 'axios' {
  interface AxiosRequestConfig {
    _silent?: boolean;
  }
}

export interface ApiError extends AxiosError {
  errorMessage: string;
}

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 60000,
});

apiClient.interceptors.request.use((config) => {
  const token = localStorage.getItem('api_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => {
    const body = response.data;
    if (body && typeof body === 'object' && body.success !== undefined) {
      response.data = body.data;
    }
    return response;
  },
  (error: ApiError) => {
    const body = error?.response?.data as any;
    const errObj = body?.error;
    if (errObj) {
      error.errorMessage = typeof errObj === 'string'
        ? errObj
        : (errObj.message || JSON.stringify(errObj));
    } else {
      error.errorMessage = body?.message || error?.message || i18n.global.t('common.networkError');
    }

    // 只有「管理端鉴权失败」才登出：
    //  - 401：API_SECRET 缺失或错误（backend / worker 的 authMiddleware）
    //  - 403 + FORBIDDEN：旧版本后端对错误 API_SECRET 的返回，保留兼容
    // 其它 403 属于业务性拒绝（DEMO_PROTECTED / R2_NOT_ENABLED / DEFAULT_SOURCE_LOCKED 等）；
    // Cloudflare 上游的 401 / 403（账号 Token 缺权限）已由后端映射为 502 + CF_* 错误码，
    // 因此不会再因为某个账号授权异常就把整个会话踢掉（issue #68）。
    const authFailureCodes = new Set(['UNAUTHORIZED', 'INVALID_API_KEY', 'TOKEN_EXPIRED', 'FORBIDDEN']);
    const status = error?.response?.status;
    const code = errObj && typeof errObj === 'object' ? errObj.code : undefined;
    const isAuthFailure = status === 401 || (status === 403 && typeof code === 'string' && authFailureCodes.has(code));

    if (isAuthFailure) {
      localStorage.removeItem('api_token');
      window.dispatchEvent(new Event('auth-expired'));
    }

    if (!error.config?._silent) {
      globalMessage.error(error.errorMessage, { duration: 5000 });
    }

    return Promise.reject(error);
  }
);

export default apiClient;
