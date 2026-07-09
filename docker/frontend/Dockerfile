# ---- Build Stage ----
FROM node:24-alpine AS builder
WORKDIR /app

ARG BASE_URL=/
ENV VITE_BASE_URL=${BASE_URL}

COPY frontend/package*.json ./
# 使用 npm install 而非 npm ci：lock 在 macOS 生成、Docker 为 Linux，
# 平台专属可选原生依赖（如 @emnapi/core）版本不一致会导致 npm ci 严格校验失败。
RUN --mount=type=cache,target=/root/.npm npm install
COPY frontend/tsconfig*.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/public ./public
COPY frontend/src ./src
RUN npm run build

# ---- Production Stage ----
FROM nginx:alpine

ARG BASE_URL=/
ENV BASE_URL=${BASE_URL}

RUN rm -f /etc/nginx/conf.d/default.conf

COPY --from=builder /app/dist /usr/share/nginx/html
COPY docker/frontend/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker/frontend/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:80/ || exit 1

ENTRYPOINT ["/entrypoint.sh"]
