# 账户认证方式说明

CF Manager 支持两种方式添加 Cloudflare 账户，您可以根据需求选择其中一种。

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
   - `Account.Browser Rendering:Edit` — 浏览器渲染（截图、PDF、Markdown 等）

   **Zone 级别权限：**
   - `Zone.Zone:Read` — 区域列表读取
   - `Zone.DNS:Edit` — DNS 记录管理（含 Pages 自动 CNAME）
   - `Zone.Workers Routes:Edit` — Workers 路由管理
7. 设置 Token 名称，确认资源范围：
   - **Account Resources**：选择 `All accounts` 或指定账户（推荐选 `All accounts`，方便多账户管理）
   - **Zone Resources**：选择 `All zones` 或指定区域（推荐选 `All zones`，Workers 路由和 DNS 管理需要）
8. 点击 **Continue to summary** → **Create Token**
9. 复制生成的 Token（仅显示一次，请妥善保存）

---

## 方式二：Global API Key + Email

Global API Key 是账户级别的全局密钥，拥有与账户所有者相同的完整权限。适用于需要全部权限或旧版 API 兼容的场景。

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

> **注意**：Global API Key 拥有账户的完整权限，请妥善保管，避免泄露。

---

## 两种方式对比

| 特性 | API Token | Global API Key + Email |
|---|---|---|
| **权限控制** | 细粒度，可按需分配 | 全局完整权限 |
| **安全性** | 更高（最小权限原则） | 较低（等同于账户密码） |
| **所需信息** | 仅需 Token | Key + 邮箱 |
| **推荐场景** | 生产环境、多账户管理 | 快速测试、需要全部权限 |
| **Cloudflare 推荐** | 是 | 否（仅兼容旧版） |

---

## 添加账户后的自动行为

账户添加成功后，系统会自动执行以下操作：

1. **验证凭证有效性** — 调用 Cloudflare API 确认 Token / Key 可用
2. **自动获取 Account ID** — 从 Cloudflare API 拉取账户 ID 并存储，无需手动填写
3. **标记活跃状态** — 验证通过后将账户标记为「活跃」

您也可以随时在账户列表中点击「测试」按钮，手动验证账户连接状态。
