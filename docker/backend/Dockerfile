# ---- Build Stage ----
FROM node:24-alpine AS builder

RUN --mount=type=cache,target=/var/cache/apk apk add --no-cache python3 make g++

WORKDIR /app
COPY backend/package*.json ./
# 使用 npm install 而非 npm ci：lock 在 macOS 生成、Docker 为 Linux，
# better-sqlite3 等平台专属可选原生依赖（如 @emnapi/core）版本不一致会导致 npm ci 严格校验失败。
RUN --mount=type=cache,target=/root/.npm npm install
COPY backend/tsconfig.json ./
COPY scripts/gen-version.js ./scripts/gen-version.js
COPY CHANGELOG.md ./CHANGELOG.md
COPY backend/src ./src
# 版本信息：从 CHANGELOG.md 提取版本号，git commit 通过 build-arg 注入（缺省为空）
ARG GIT_COMMIT=""
ENV BACKEND_SRC=/app/src
ENV GIT_COMMIT=${GIT_COMMIT}
RUN node scripts/gen-version.js backend
# model-pricing.json 在 .gitignore 中，需从 shared/ 手动拷贝
COPY shared/model-pricing.json ./src/data/model-pricing.json
RUN npx tsc
# Prune dev deps in builder so production just copies clean node_modules
RUN npm prune --omit=dev

# ---- Production Stage ----
FROM node:24-alpine

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data

ENV PORT=3001
ENV DB_PATH=/app/data/cf-manager.db

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "dist/index.js"]
