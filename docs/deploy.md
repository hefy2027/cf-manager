# CF Manager 部署指南

CF Manager 支持两种部署方式：**Docker 部署**（自建服务器）和 **Cloudflare Worker 部署**（Serverless）。两种方式功能完全一致，前端界面相同，API 接口兼容。

---

## 方式一：Docker 部署

适合有自建服务器（VPS）的用户，提供完整的 Node.js 后端 + Nginx 前端。

### 前置要求

- Docker 和 Docker Compose
- 一台可以访问 Cloudflare API 的服务器（或配置代理）

### 部署步骤

```bash
# 1. 克隆项目
git clone <your-repo-url>
cd cf-manager

# 2. 创建配置文件
cp .env.example .env

# 3. 编辑 .env 配置
```

### 环境变量

编辑 `.env` 文件：

| 变量 | 必填 | 说明 |
|------|------|------|
| `ENCRYPTION_KEY` | 是 | 加密存储 API Token 的密钥（任意随机字符串，至少 16 位） |
| `API_SECRET` | 否 | 管理界面访问密码，留空则无需登录 |
| `PROXY_URL` | 否 | HTTP/SOCKS5 代理地址，如 `socks5://127.0.0.1:1080` |
| `APP_PORT` | 否 | 对外暴露端口，默认 `3000` |
| `BASE_URL` | 否 | 前端访问路径，如 `/admin/`，默认 `/`。设置后需重新构建镜像 |

### 启动服务

```bash
# 一键部署（构建 + 启动）
chmod +x deploy.sh
./deploy.sh

# 或手动启动
docker compose up -d --build

# 查看日志
docker compose logs -f
```

访问 `http://<your-server-ip>:3000`（如配置了 `BASE_URL=/admin/`，则访问 `http://<your-server-ip>:3000/admin/`）。

### 更新

```bash
git pull
./deploy.sh
```

### 数据持久化

- 数据库文件存储在 `backend/data/cf-manager.db`
- 日志文件存储在 `backend/data/logs/`
- Docker Compose 已配置 volume 映射，数据不会随容器销毁丢失

### 本地开发

```bash
# 后端（http://localhost:3001）
cd backend
npm install
ENCRYPTION_KEY="dev-key" npm run dev

# 前端（http://localhost:5173，自动代理 /api 到后端）
cd frontend
npm install
npm run dev
```

### Docker 架构

```
                     ┌─────────────┐
  用户 ──── :3000 ──▶│   Nginx     │
                     │  (前端静态)  │
                     │  /api → :3001│
                     └──────┬──────┘
                            │
                     ┌──────▼──────┐
                     │  Node.js    │
                     │  Express 5  │
                     │  SQLite DB  │
                     └──────┬──────┘
                            │ (通过代理)
                     ┌──────▼──────┐
                     │ Cloudflare  │
                     │    API      │
                     └─────────────┘
```

---

## 方式二：Cloudflare Worker 部署

适合无自建服务器的用户，完全运行在 Cloudflare 边缘网络上，免费计划即可使用。

### 优势

- **无需服务器**：运行在 Cloudflare 全球边缘节点
- **无需代理**：Worker 在 CF 内网直接调用 API，不存在 `socket hang up` 问题
- **零成本起步**：Workers Free 计划足够个人使用
- **全球加速**：就近节点响应，延迟极低

### 前置要求

- 一个 Cloudflare 账号
- Node.js 18+（用于构建）

有两种部署方式可选：

| | 方式 A：Dashboard 上传 | 方式 B：Wrangler CLI |
|---|---|---|
| 需要安装工具 | 不需要 | 需要 Wrangler CLI |
| D1 数据库创建 | Dashboard 网页操作 | 命令行操作 |
| 部署方式 | 网页上传 ZIP | 命令行一键部署 |
| 适合场景 | 不想装 CLI 的用户 | 熟悉命令行 / CI 自动化 |

---

### 方式 A：Dashboard 网页上传

全程在浏览器中操作，不需要安装 Wrangler CLI。

#### 1. 创建 D1 数据库

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 左侧菜单 → **Workers & Pages** → **D1 SQL Database**
3. 点击 **Create** → 名称填 `cf-manager` → 创建
4. 进入数据库详情页 → **Console** 标签
5. 将 `worker/src/db/schema.sql` 文件内容粘贴到控制台中执行

#### 2. 一键构建部署包

```bash
cd worker
npm install
npm run build
```

这一条命令会自动完成：
1. 安装前端依赖并构建（base=/admin/）
2. 复制前端资源到 `public/`
3. 将 Worker 后端 TypeScript 打包为 `public/_worker.js`
4. 自动压缩为 `worker/cf-manager.zip`

#### 3. 创建 Pages 项目并上传

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Upload assets**
2. 项目名称填 `cf-manager`
3. 上传 `worker/cf-manager.zip`
4. 等待部署完成

#### 4. 配置 Bindings 和环境变量

部署完成后，进入项目设置：

1. **Settings** → **Bindings** → **Add** → **D1 Database**
   - Variable name: `DB`
   - D1 database: 选择 `cf-manager`
2. **Settings** → **Environment variables** → **Add**
   - `ENCRYPTION_KEY`：你的加密密钥（加密类型选 **Encrypt**）
   - `API_SECRET`：你的访问密码（可选，加密类型选 **Encrypt**）
3. 添加完 Bindings 后，需要**重新部署**才能生效（在 Deployments 中点击最新部署的 **Retry deployment**）

#### 5. 访问

部署成功后，访问 `https://cf-manager.<your-subdomain>.pages.dev/admin/`。

> 根路径显示伪装的 nginx 欢迎页面，管理界面固定通过 `/admin/` 路径访问。

#### 更新

1. `cd worker && npm run build` 重新构建
2. Dashboard → Pages → cf-manager → **Create deployment** → 上传新的 `worker/cf-manager.zip`

---

### 方式 B：Wrangler CLI 部署

适合熟悉命令行或需要自动化部署的用户。

#### 1. 认证 Wrangler

两种方式任选其一：

```bash
# 方式一：交互式登录（会打开浏览器）
npx wrangler login

# 方式二：使用 API Token（无需浏览器，适合服务器/CI）
# 在 Cloudflare Dashboard → My Profile → API Tokens → Create Token
# 选择 "Edit Cloudflare Workers" 模板
export CLOUDFLARE_API_TOKEN="你的API Token"
# Windows PowerShell:
$env:CLOUDFLARE_API_TOKEN="你的API Token"
```

#### 2. 创建 D1 数据库

```bash
cd worker
npx wrangler d1 create cf-manager
```

记录输出的 `database_id`，填入 `wrangler.toml`：

```toml
[[d1_databases]]
binding = "DB"
database_name = "cf-manager"
database_id = "你的数据库ID"
```

#### 3. 初始化数据库表

```bash
npx wrangler d1 execute cf-manager --file=src/db/schema.sql --remote
```

#### 4. 设置 Secrets

```bash
# 加密密钥（必填，用于加密存储 API Token）
npx wrangler pages secret put ENCRYPTION_KEY
# 输入你的加密密钥

# 访问密码（可选，留空则无需登录）
npx wrangler pages secret put API_SECRET
# 输入你的密码
```

#### 5. 一键构建并部署

```bash
cd worker
npm install
npm run deploy
```

`npm run deploy` 自动完成全部流程：
1. 安装前端依赖并构建
2. 复制前端资源
3. 打包 Worker 后端代码
4. 生成 ZIP（备份）
5. 部署到 Cloudflare Pages

部署完成后，终端会输出访问 URL（如 `https://cf-manager.your-subdomain.pages.dev/admin/`）。

> 根路径显示伪装的 nginx 欢迎页面，管理界面固定通过 `/admin/` 路径访问。

#### 更新

```bash
git pull
cd worker && npm run deploy
```

---

### 自定义域名

在 Cloudflare Dashboard → Pages → cf-manager → **Custom domains** 中添加域名。

或使用 CLI：
```bash
wrangler pages project add-domain cf-manager your-domain.com
```

### Worker 架构

```
                     ┌──────────────────┐
  用户 ──── HTTPS ──▶│  Cloudflare Edge │
                     │                  │
                     │  /        → Fake │
                     │            Nginx │
                     │  /admin/* → SPA  │
                     │  /api/*  → API   │
                     │  /v1/*   → API   │
                     │                  │
                     │  ┌────────────┐  │
                     │  │ Hono App   │  │
                     │  │ + D1 (SQL) │  │
                     │  └─────┬──────┘  │
                     │        │ (内网)   │
                     │  ┌─────▼──────┐  │
                     │  │ CF REST API│  │
                     │  └────────────┘  │
                     └──────────────────┘
```

### 限制说明

| 项目 | Free 计划 | Paid 计划 |
|------|-----------|-----------|
| 请求数 | 100,000/天 | 无限制 |
| CPU 时间 | 10ms/请求 | 最高 5 分钟 |
| D1 读取 | 500 万行/天 | 250 亿行/月 |
| D1 写入 | 10 万行/天 | 5000 万行/月 |
| D1 存储 | 5 GB | 5 GB + 按量 |
| 内存 | 128 MB | 128 MB |

对于个人使用的管理工具，Free 计划完全够用。

### 与 Docker 版本的区别

| 特性 | Docker 版本 | Worker 版本 |
|------|-------------|-------------|
| 数据库 | SQLite (本地文件) | D1 (Cloudflare 托管) |
| 代理支持 | 支持 HTTP/SOCKS5 | 不需要（CF 内网） |
| 加密算法 | Node.js crypto | Web Crypto API |
| 定时任务 | node-cron | 不支持 |
| 日志 | 文件日志 + winston | console.log + Logpush |
| 部署方式 | docker compose | wrangler deploy |
| 数据迁移 | 不兼容（加密格式不同） | 需重新添加账户 |

---

## 常见问题

### Docker 版：Cloudflare API 请求 socket hang up

多账户并发请求时代理可能无法处理所有连接。解决方案：
- 使用更稳定的代理服务
- 在设置页面切换代理开关临时关闭代理测试
- 改用 Worker 版本（无需代理）

### Worker 版：CPU 时间超限

Free 计划的 10ms CPU 限制可能导致复杂操作（如批量部署）失败。解决方案：
- 升级到 Workers Paid 计划（$5/月）
- 减少单次请求的并发账户数量
