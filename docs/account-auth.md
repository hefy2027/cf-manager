# 账户认证方式说明

CF Manager 支持两种方式添加 Cloudflare 账户，您可以根据需求选择其中一种。

> ⚠️ 仅添加您本人或已明确授权管理的 Cloudflare 账户，不使用任何未授权账户。凭证均加密存储（AES），但 Global API Key 等高风险凭证仍请谨慎保管。

---

## 方式一：API Token（推荐）

API Token 是 Cloudflare 推荐的认证方式，支持细粒度的权限控制，安全性更高。

### 所需信息

| 字段 | 说明 |
|---|---|
| **名称** | 自定义的账户名称，方便区分 |
| **认证类型** | 选择 `API Token` |
| **API Token** | Cloudflare API Token 字符串 |

### 获取 API Token 步骤

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 点击右上角头像，进入 **My Profile**（我的个人资料）
3. 左侧菜单选择 **API Tokens**
4. 点击 **Create Token**（创建令牌）
5. 可以选择：
   - **Use template**：使用预设模板（如 `Edit Cloudflare Workers`、`Edit DNS` 等），按需选择
   - **Create Custom Token**：自定义权限，按需勾选所需资源权限
6. 推荐权限（覆盖本工具所有功能）：

   **User 级别权限：**
   - `User.User Details:Read` — 验证 Token 有效性（测试连接需要）

   **Account 级别权限：**
   - `Account.Account Analytics:Read` — 仪表盘统计（Workers/Pages 用量）
   - `Account.Workers Scripts:Edit` — Workers 脚本、Secrets、Cron Triggers、Custom Domains、Settings 管理
   - `Account.Workers Tail:Read` — Worker 日志查看
   - `Account.Workers KV Storage:Edit` — KV 命名空间和键值对管理
   - `Account.D1:Edit` — D1 数据库管理（含 SQL 查询执行）
   - `Account.Workers R2 Storage:Edit` — R2 存储桶和对象管理
   - `Account.Cloudflare Pages:Edit` — Pages 项目和部署管理
   - `Account.Workers AI:Edit` — AI 模型列表和推理
   - `Account.Browser Rendering:Edit` — 浏览器渲染（截图、PDF、Markdown 等）。**注意**：Cloudflare 较新账户已在权限列表中移除该独立权限（产品已更名为 Browser Run），部分账户可能看不到此项。若列表中无此权限，浏览器渲染功能需改用「Global API Key + Email」（方式二）或确认账户已开通 Browser Rendering/Browser Run 计划。
   - `Account.Cloudflare Tunnel:Edit` — 隧道（cloudflared）管理：创建/删除隧道、读取连接状态、获取隧道 Token、查看与更新 ingress 配置（含隧道绑定域名探测，依赖下方 Zone 级 DNS 权限）
   - `Account.Rulesets:Edit` — 账户级规则集管理（如账户级单重定向 `http_request_redirect` 规则）
  - `Account.Billing:Read` — **可选**：测试连接时自动识别账号的 Workers 计划类型（免费/付费/企业），决定付费模型（`require_workers_paid`）能否路由到该账号。**没有该权限也能正常使用**：计划类型会保持「免费」默认值，可在「账号管理 → 编辑」里手工选择。

   **Zone 级别权限：**
   - `Zone.Zone:Read` — 区域列表读取
   - `Zone.Zone:Edit` — 区域创建 / 删除 / 暂停与激活
   - `Zone.Zone Settings:Edit` — 区域设置（SSL、缓存、安全等级等）管理
   - `Zone.Cache Purge` — 清除区域缓存（**注意**：Cloudflare 已取消 Read/Edit 区分，权限列表中仅剩统一的 `Cache Purge`，不再有 `:Edit` 后缀）
   - `Zone.DNS:Edit` — DNS 记录管理（含 Pages 自动 CNAME、隧道绑定域名探测）
   - `Zone.Workers Routes:Edit` — Workers 路由管理
   - `Zone.Origin Rules:Edit` — 回源规则（"规则引擎"）
   - `Zone.Single Redirect:Edit` / `Zone.Dynamic URL Redirects:Edit` — 区域级重定向规则（"规则引擎"）。**注意**：原 `Zone.Redirect Rules:Edit` 已被拆分重命名为 Single Redirect 与 Dynamic URL Redirects，请按需求勾选对应项（列表中的 `Redirect Rules` 名称已不再存在）
   - `Zone.Transform Rules:Edit` — URL 重写 / 请求头 / 响应头转换规则（"规则引擎"）
   - `Zone.Cache Rules:Edit` — 缓存设置规则（"规则引擎"）
   - `Zone.WAF:Edit` — 防火墙自定义规则（"规则引擎"）
   - `Zone.Rate Limiting Rules:Edit`（或 `Zone.WAF:Edit` 下的速率限制规则）— 速率限制规则（"规则引擎"）。**注意**：原 `Zone.Rate Limiting:Edit` 已从权限列表中移除，速率限制能力已并入 WAF / 规则集体系，请使用 `Rate Limiting Rules` 或 `Custom Rules` 相关权限
7. 设置 Token 名称，确认资源范围：
   - **Account Resources**：选择 `All accounts` 或指定账户（推荐选 `All accounts`，方便多账户管理）
   - **Zone Resources**：选择 `All zones` 或指定区域（推荐选 `All zones`，Workers 路由和 DNS 管理需要）
8. 点击 **Continue to summary** → **Create Token**
9. 复制生成的 Token（仅显示一次，请妥善保存）

---

## 方式二：Global API Key + Email

Global API Key 是账户级别的全局密钥，拥有与账户所有者**相同的完整权限（覆盖全账号域名与资源）**。除非确需全部权限或旧版 API 兼容，否则**不建议用于日常运维**——泄露将导致全部资产面临风险，日常强烈建议使用细粒度 API Token。

### 所需信息

| 字段 | 说明 |
|---|---|
| **名称** | 自定义的账户名称，方便区分 |
| **认证类型** | 选择 `API Key + Email` |
| **API Key** | Cloudflare Global API Key 字符串 |
| **Email** | Cloudflare 账户登录邮箱 |

### 获取 Global API Key 步骤

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 点击右上角头像，进入 **My Profile**（我的个人资料）
3. 左侧菜单选择 **API Tokens**
4. 在页面中找到 **API Keys** 区域
5. 点击 **Global API Key** 右侧的 **View**
6. 输入账户密码进行安全验证
7. 复制显示的 Global API Key

> **⚠️ 安全警告**：Global API Key 权限等同账户所有者，泄露后攻击者可完全控制你的所有 Cloudflare 资源（域名、DNS、Workers、存储、AI 等）。请仅用于本地测试，切勿提交到代码仓库或日志，日常运维强烈建议使用最小权限 API Token。

---

## 两种方式对比

| 特性 | API Token | Global API Key + Email |
|---|---|---|
| **权限控制** | 细粒度，可按需分配 | 全局完整权限 |
| **安全性** | 更高（最小权限原则） | 较低（等同于账户密码） |
| **所需信息** | 仅需 Token | Key + 邮箱 |
| **推荐场景** | 生产环境、多账户管理（推荐） | 仅本地快速测试；日常运维不建议使用 |
| **Cloudflare 推荐** | 是 | 否（仅兼容旧版） |

---

## 添加账户后的自动行为

账户添加成功后，系统会自动执行以下操作：

1. **验证凭证有效性** — 调用 Cloudflare API 确认 Token / Key 可用
2. **自动获取 Account ID** — 从 Cloudflare API 拉取账户 ID 并存储，无需手动填写
3. **标记活跃状态** — 验证通过后将账户标记为「活跃」

您也可以随时在账户列表中点击「测试」按钮，手动验证账户连接状态。
