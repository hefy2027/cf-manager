# CF Manager — 产品需求文档 (PRD)

> **版本**: 2.0.2 | **日期**: 2026-08-13 | **状态**: ready-for-agent

---

## Problem Statement

管理多个 Cloudflare 账户的用户面临以下痛点：

1. **多账户管理碎片化**：拥有多个 Cloudflare 账户的用户需要在 CF Dashboard 间反复切换登录，无法统一查看各账户的 Workers、Pages、DNS、存储等资源状态，运维效率极低。

2. **AI 推理资源利用率不均**：每个 CF 账户有独立的 Workers AI 神经元日配额，单个账户容易触顶，而其他账户配额闲置。用户需要手动切换账户来分散请求，无法自动负载均衡。

3. **Workers/Pages 部署操作繁琐**：跨多账户部署同一个 Worker 或 Pages 项目时，需要逐个登录账户、上传代码、配置环境变量和绑定，没有批量部署能力。

4. **DNS 管理分散**：多个账户下的域名分散在不同 Dashboard 中，无法统一查看和编辑 DNS 记录，缺乏批量 Zone 管理能力。

5. **外部工具对接困难**：用户希望使用 Cursor、ChatGPT-Next-Web、Open WebUI 等工具调用 Cloudflare Workers AI，但这些工具只兼容 OpenAI API 格式，与 CF 原生 API 不兼容，缺少一个转换层。

6. **安全与合规风险**：API Token 明文存储、部署链路存在 SSRF 风险、演示账户缺乏保护机制，自建部署方案缺乏安全加固。

7. **部署灵活性不足**：用户既需要 Docker 自建部署（数据完全自主可控），也需要 Cloudflare Pages 无服务器部署（零运维），但两套部署方案的业务逻辑往往不一致，维护成本高。

---

## Solution

CF Manager 是一个 **Cloudflare 多账户统一管理平台**，提供以下核心能力：

- **统一管理界面**：通过单一 Web 界面管理多个 CF 账户的 Workers / Pages / DNS / KV / D1 / R2 / AI 推理 / 浏览器渲染，无需在 Dashboard 间切换。
- **AI 推理代理**：暴露 OpenAI 兼容 API（`/v1/chat/completions`、`/v1/images/generations`、`/v1/audio/speech`、`/v1/translations`），自动在多账户间负载均衡，配额耗尽自动切换，支持流式和非流式响应。
- **批量部署能力**：Workers/Pages 支持跨多账户批量部署，商店模板一键部署到多个账户，部署前自动预检（配置差异、Secrets 覆盖）。
- **DNS 统一管理**：多账户 Zone 汇总查看、DNS 记录 CRUD、Zone 批量创建/删除、Zone 级设置管理（SSL/TLS、缓存、安全等级等）。
- **安全加固**：API Token AES 加密存储、SSRF 防护、部署 URL 白名单、演示账户保护、根路径 nginx 伪装。
- **双后端架构**：同一套业务逻辑分别用 Express（Docker 自建）和 Hono（Cloudflare Pages）实现，共享同一套前端，用户可根据需求选择部署方式。
- **国际化**：支持中文（zh-CN）与英文（en）双语界面，自动检测浏览器语言。

---

## User Stories

### 账户管理

1. 作为运维管理员，我想要添加 Cloudflare 账户（API Token 认证），以便在统一界面中管理该账户的资源。
2. 作为运维管理员，我想要添加 Cloudflare 账户（Global API Key 认证），以便兼容仅有 API Key 的旧账户。
3. 作为运维管理员，我想要编辑已有账户的凭证和名称，以便在不需要删除重建的情况下更新账户信息或切换认证方式。
4. 作为运维管理员，我想要删除不再使用的账户，以便保持账户列表整洁。
5. 作为运维管理员，我想要批量导入账户（CSV），以便快速添加大量账户而不用逐个手动输入。
6. 作为运维管理员，我想要导出账户列表（CSV），以便备份或迁移到其他实例。
7. 作为运维管理员，我想要测试单个账户的连接状态，以便确认凭证是否有效。
8. 作为运维管理员，我想要批量测试所有账户的连接状态，以便快速发现失效账户。
9. 作为运维管理员，我想要为每个账户设置功能开关（AI / Workers / Browser Render / DNS / Storage），以便控制该账户参与哪些功能。
10. 作为运维管理员，我想要查看账户的 API Token 脱敏信息，以便确认账户身份而不会泄露完整凭证。
11. 作为运维管理员，我想要为每个账户配置独立的代理 URL，以便通过不同出口 IP 访问 Cloudflare API。
12. 作为运维管理员，我想要为账户设置密码字段，以便存储和查看账户的登录密码信息。
13. 作为运维管理员，我想要看到账户是否支持 R2 存储（能力标识），以便在存储管理时快速判断可用性。
14. 作为运维管理员，我想要批量勾选账户后执行批量操作（删除/设置功能/设置代理），以便提高多账户管理效率。
15. 作为运维管理员，我想要看到账户的 Cloudflare Account ID，以便在需要手动操作 CF API 时快速获取。

### 仪表盘

16. 作为运维管理员，我想要在首页看到所有账户的今日配额使用量概览，以便快速了解资源消耗情况。
17. 作为运维管理员，我想要看到配额使用的可视化进度条，以便直观判断哪些账户即将触顶。
18. 作为运维管理员，我想要看到 Workers 和 Pages 的总量统计，以便了解部署规模。
19. 作为运维管理员，我想要看到浏览器渲染的总量统计，以便了解渲染服务使用情况。
20. 作为运维管理员，我想要看到最近操作的审计日志，以便追溯关键操作记录。
21. 作为运维管理员，我想要统计数据以紧凑格式（K/M）显示，以便在小屏幕上也能快速浏览。

### AI 推理

22. 作为开发者，我想要通过 OpenAI 兼容 API 调用 Cloudflare Workers AI 的聊天模型，以便在 Cursor / ChatGPT-Next-Web 等工具中无缝使用。
23. 作为开发者，我想要使用流式（SSE）模式获取 AI 响应，以便获得打字机效果的实时输出体验。
24. 作为开发者，我想要系统自动在多个账户间负载均衡 AI 请求，以便最大化利用所有账户的神经元配额。
25. 作为开发者，我想要当一个账户配额耗尽时系统自动切换到下一个可用账户，以便请求不会因为单账户触顶而失败。
26. 作为开发者，我想要通过 `X-Account-ID` 头部指定使用特定账户，以便在需要时手动控制请求路由。
27. 作为开发者，我想要获取所有可用的 AI 模型列表（OpenAI `/v1/models` 格式），以便选择合适的模型。
28. 作为开发者，我想要使用支持 Prompt Caching 的模型时自动复用同一账户以提升缓存命中率，以便降低神经元消耗。
29. 作为开发者，我想要看到每次请求的神经元消耗量，以便了解资源使用情况。
30. 作为开发者，我想要流式响应自动注入 `stream_options.include_usage`，以便流式模式下也能获取 usage 信息。
31. 作为运维管理员，我想要在前端 AI 工作台页面直接进行对话测试，以便验证 AI 代理服务是否正常。
32. 作为运维管理员，我想要在 AI 统计页面查看各账户的用量汇总，以便了解 AI 资源分配情况。

### AI 图片生成

33. 作为开发者，我想要通过 OpenAI 兼容 API 调用 Cloudflare Workers AI 的文生图模型，以便程序化生成图片。
34. 作为开发者，我想要通过 API 调用图生图模型（传入参考图 base64），以便在已有图片基础上进行修改。
35. 作为开发者，我想要设置图片生成的高级参数（宽高/步数/引导强度/反向提示词），以便控制生成效果。
36. 作为运维管理员，我想要在前端 AI 绘图页面进行文生图/图生图操作，以便通过可视化界面生成图片。
37. 作为运维管理员，我想要上传参考图进行图生图，以便基于已有图片进行 AI 编辑。
38. 作为运维管理员，我想要预览、下载和复用生成的图片，以便管理生成结果。
39. 作为运维管理员，我想要查看生成历史画廊，以便回顾之前生成的图片。
40. 作为运维管理员，我想要点击"复用"时自动切换到图生图模式并使用生成的图片作为参考图，以便快速迭代图片效果。
41. 作为运维管理员，我想要看到每张图片的神经元消耗（⚡ neurons 徽章），以便了解图片生成的资源成本。

### AI 语音合成

42. 作为开发者，我想要通过 OpenAI 兼容 API 调用 Cloudflare Workers AI 的 TTS 模型，以便程序化生成语音。
43. 作为开发者，我想要使用 OpenAI 标准语音名称（alloy/echo/fable 等），以便兼容已有 OpenAI TTS 调用代码。
44. 作为开发者，我想要也支持 CF 原生说话人名称（luna/mars/athena 等），以便使用更丰富的语音选项。
45. 作为运维管理员，我想要在前端 AI 语音页面选择模型和说话人，以便通过可视化界面生成语音。
46. 作为运维管理员，我想要播放、下载和复用生成的音频，以便管理语音合成结果。
47. 作为运维管理员，我想要看到每次语音合成的神经元消耗，以便了解资源使用情况。

### AI 翻译

48. 作为开发者，我想要通过 API 调用 Cloudflare Workers AI 的翻译模型，以便程序化进行文本翻译。
49. 作为开发者，我想要指定源语言和目标语言，以便控制翻译方向。
50. 作为运维管理员，我想要在前端 AI 翻译页面进行翻译操作，以便通过可视化界面翻译文本。
51. 作为运维管理员，我想要复制翻译结果，以便快速使用翻译内容。
52. 作为运维管理员，我想要看到翻译的神经元消耗，以便了解资源使用情况。

### Workers / Pages 管理

53. 作为运维管理员，我想要查看所有账户下的 Workers 脚本列表，以便统一了解部署情况。
54. 作为运维管理员，我想要查看所有账户下的 Pages 项目列表，以便统一了解部署情况。
55. 作为运维管理员，我想要手动部署 Worker（上传 ZIP/JS 文件），以便将代码部署到指定账户。
56. 作为运维管理员，我想要手动部署 Pages 项目（上传 ZIP），以便将静态网站部署到指定账户。
57. 作为运维管理员，我想要在部署时配置环境变量（明文/机密），以便 Worker 运行时读取所需配置。
58. 作为运维管理员，我想要在部署时配置资源绑定（KV/D1/R2/AI/Durable Objects/Service/Queue），以便 Worker 访问 Cloudflare 资源。
59. 作为运维管理员，我想要批量部署同一个 Worker 到多个账户，以便快速扩展部署范围。
60. 作为运维管理员，我想要批量部署 Pages 到多个账户，以便快速扩展静态站点部署范围。
61. 作为运维管理员，我想要在批量部署时失败账户可以单独重试，以便不需要全部重新部署。
62. 作为运维管理员，我想要在重部署时只更新配置而不重传代码（当仅有 secrets 变更时），以便减少部署时间和带宽。
63. 作为运维管理员，我想要在重部署时复用现有代码重传（当 vars/bindings 变更时），以便不需要重新上传文件。
64. 作为运维管理员，我想要打开部署对话框时预填当前配置，以便快速修改而非从头配置。
65. 作为运维管理员，我想要删除 Worker 或 Pages 部署，以便清理不再需要的资源。
66. 作为运维管理员，我想要查看 Worker 的绑定、环境变量、路由和自定义域名配置，以便了解 Worker 的运行环境。
67. 作为运维管理员，我想要编辑 Worker 的绑定和环境变量（通过设置抽屉），以便在线修改配置而不需要重新部署。
68. 作为运维管理员，我想要通过 Zone 下拉选择 + 子域名前缀设置自定义域名，以便避免手动输入完整域名的错误。
69. 作为运维管理员，我想要看到部署后的访问地址（如 `https://script.account-subdomain.workers.dev`），以便快速确认部署可访问。
70. 作为运维管理员，我想要看到底部统计栏显示总数/Worker 数/Pages 数/当前账户名，以便快速了解资源概况。

### 应用商店 (Catalog Store)

71. 作为运维管理员，我想要从 Catalog 源浏览可部署的 Worker/Pages 模板，以便快速找到合适的模板部署。
72. 作为运维管理员，我想要添加自定义 Catalog 源，以便使用私有或第三方模板仓库。
73. 作为运维管理员，我想要编辑已有的 Catalog 源 URL，以便更新源地址。
74. 作为运维管理员，我想要删除不再需要的 Catalog 源，以便保持源列表整洁。
75. 作为运维管理员，我想要在添加 Catalog 源前测试 URL 可用性，以便避免添加无效源。
76. 作为运维管理员，我想要看到 Catalog 源的同步状态和最后同步时间，以便了解源数据是否最新。
77. 作为运维管理员，我想要一键将模板部署到多个账户，以便快速扩展部署。
78. 作为运维管理员，我想要在部署模板前进行预检（Worker 存在性、配置差异、Secrets 覆盖），以便避免部署冲突或覆盖重要配置。
79. 作为运维管理员，我想要在部署对话框中区分密钥和配置项（密码框 vs 普通文本框），以便正确填写不同类型的参数。
80. 作为运维管理员，我想要看到模板的说明文档（Markdown 渲染），以便了解模板的功能和配置要求。
81. 作为运维管理员，我想要看到模板的仓库入口链接，以便查看源代码。
82. 作为运维管理员，我想要官方默认源支持多地址 fallback，以便在主地址不可达时自动切换镜像。

### DNS 管理

83. 作为运维管理员，我想要查看所有账户下的 DNS Zone 汇总列表，以便统一了解域名管理情况。
84. 作为运维管理员，我想要按账户过滤 Zone 列表，以便聚焦特定账户的域名。
85. 作为运维管理员，我想要搜索域名，以便快速定位特定 Zone。
86. 作为运维管理员，我想要看到 Zone 状态指示器（彩色圆点），以便直观判断 Zone 是否激活。
87. 作为运维管理员，我想要按账户分组折叠显示 Zone 列表，以便组织大量域名。
88. 作为运维管理员，我想要批量创建 Zone（textarea 每行一个域名），以便快速添加多个域名。
89. 作为运维管理员，我想要在创建 Zone 时选择 Full 或 Partial 类型，以便根据 DNS 托管需求选择合适模式。
90. 作为运维管理员，我想要在创建 Zone 后看到 Cloudflare 分配的 NS 信息并一键复制，以便快速到注册商修改 NS。
91. 作为运维管理员，我想要批量删除 Zone（多选 + 二次确认），以便清理不再需要的域名。
92. 作为运维管理员，我想要查看和编辑 DNS 记录（A/AAAA/CNAME/MX/TXT/NS 等），以便管理域名解析。
93. 作为运维管理员，我想要添加 DNS 记录时设置 MX 优先级，以便正确配置邮件交换记录。
94. 作为运维管理员，我想要删除 DNS 记录时有二次确认，以便防止误操作。
95. 作为运维管理员，我想要 DNS 记录分页显示，以便在记录量大时流畅浏览。
96. 作为运维管理员，我想要查看和修改 Zone 级 SSL/TLS 设置（模式、Always HTTPS、自动 HTTPS 重写），以便管理域名安全配置。
97. 作为运维管理员，我想要清除 Zone 全部缓存或按 URL 清除缓存，以便刷新缓存内容。
98. 作为运维管理员，我想要查看和修改缓存级别、浏览器缓存 TTL、开发模式，以便控制缓存行为。
99. 作为运维管理员，我想要查看和修改 Zone 的安全等级、Auto Minify、Brotli 压缩、0-RTT 等设置，以便优化 Zone 配置。
100. 作为运维管理员，我想要在 CF Manager 中暂停/激活 Zone（二次确认警告），以便控制域名服务状态。

### 隧道与规则引擎

101. 作为运维管理员，我想要查看账户下的 Cloudflare Tunnel 列表和连接状态，以便了解隧道运行情况。
102. 作为运维管理员，我想要创建新的 Cloudflare Tunnel，以便建立到 CF 边缘的安全连接。
103. 作为运维管理员，我想要删除不再需要的 Tunnel，以便清理资源。
104. 作为运维管理员，我想要查看 Tunnel 的连接令牌，以便在服务器上启动隧道。
105. 作为运维管理员，我想要查看和编辑 Tunnel 的 Ingress 配置（子域名/协议/端口/路径），以便控制流量路由。
106. 作为运维管理员，我想要通过 CNAME 扫描自动发现隧道绑定的域名，以便快速了解隧道关联资源。
107. 作为运维管理员，我想要使用通用规则引擎管理 8 种 Phase 的规则（回源/URL 重写/请求头/响应头/缓存/防火墙/速率限制/重定向），以便统一管理 Zone 和 Account 级规则。
108. 作为运维管理员，我想要使用结构化表单配置规则（无需手写 JSON），以便降低配置门槛。
109. 作为运维管理员，我想要使用表达式生成器生成 Cloudflare 表达式（按主机名/路径/正则等），以便无需学习表达式语法。
110. 作为运维管理员，我想要切换到高级模式直接输入原始 JSON，以便灵活配置复杂规则。
111. 作为运维管理员，我想要使用一键回源向导（新建/复用隧道 + 自动创建 DNS CNAME + ingress 配置），以便快速搭建回源链路。
112. 作为运维管理员，我想要一键回源向导在部分失败时回滚（逆序删除已创建资源），以便避免残留无效资源。
113. 作为运维管理员，我想要 CNAME 冲突检测，以便在 hostname 已有记录时收到提示。

### 存储管理

114. 作为运维管理员，我想要查看账户下的 R2 Bucket 列表，以便了解对象存储使用情况。
115. 作为运维管理员，我想要创建 R2 Bucket，以便开始使用对象存储。
116. 作为运维管理员，我想要删除 R2 Bucket，以便清理不再需要的存储。
117. 作为运维管理员，我想要浏览 R2 Bucket 中的文件，以便查看存储内容。
118. 作为运维管理员，我想要上传文件到 R2 Bucket，以便存储新文件。
119. 作为运维管理员，我想要下载 R2 Bucket 中的文件，以便获取存储内容。
120. 作为运维管理员，我想要删除 R2 Bucket 中的文件，以便清理不需要的文件。
121. 作为运维管理员，我想要查看和管理 KV Namespace 列表，以便了解键值存储使用情况。
122. 作为运维管理员，我想要创建 KV Namespace，以便开始使用键值存储。
123. 作为运维管理员，我想要删除 KV Namespace，以便清理不再需要的键值存储。
124. 作为运维管理员，我想要查看和编辑 KV Namespace 中的键值对，以便管理存储数据。
125. 作为运维管理员，我想要对不支持 R2 的账户看到优雅降级提示，以便了解功能限制。

### 浏览器渲染

126. 作为开发者，我想要通过 API 调用 Cloudflare Browser Rendering 截取网页截图，以便程序化获取页面视觉。
127. 作为开发者，我想要通过 API 获取网页内容（HTML），以便抓取页面数据。
128. 作为开发者，我想要通过 API 获取网页内容的 Markdown 格式，以便进行文本分析。
129. 作为开发者，我想要通过 API 获取网页的 PDF，以便保存页面快照。
130. 作为开发者，我想要通过 API 获取网页中的所有链接，以便分析页面外链。
131. 作为开发者，我想要选择浏览器引擎（Chromium / Kitesurf），以便根据需求选择渲染引擎。
132. 作为开发者，我想要指定账户进行浏览器渲染，以便控制使用哪个账户的配额。
133. 作为运维管理员，我想要查看浏览器渲染的可用账户数和令牌桶间隔，以便了解服务容量。
134. 作为运维管理员，我想要浏览器渲染请求有限速控制，以免触发 Cloudflare API 速率限制。

### 系统设置与安全

135. 作为系统管理员，我想要设置 API_SECRET 进行接口认证，以便保护管理 API 不被未授权访问。
136. 作为系统管理员，我想要设置 ENCRYPTION_KEY 对 API Token 进行 AES 加密存储，以便即使数据库泄露凭证也不被暴露。
137. 作为系统管理员，我想要配置全局代理 URL，以便所有 CF API 调用通过指定代理出口。
138. 作为系统管理员，我想要配置 Resin 代理池实现每账户 sticky IP 绑定，以免 Cloudflare 因 IP 频繁变动触发风控。
139. 作为系统管理员，我想要代理优先级链为"账户专属 > Resin > 全局 > 无代理"，以便灵活控制不同账户的代理策略。
140. 作为系统管理员，我想要设置演示账户保护（DEMO_ACCOUNT_IDS），以便演示环境中的关键账户不被删除或修改。
141. 作为系统管理员，我想要根路径伪装为 nginx 默认页，以便隐藏管理界面的存在。
142. 作为系统管理员，我想要管理界面在 `/admin/` 路径下访问（Worker 版），以便增加隐蔽性。
143. 作为系统管理员，我想要配置部署 URL 白名单（WORKER_DEPLOY_URL_ALLOWLIST），以便限制可部署的脚本来源。
144. 作为系统管理员，我想要在 Settings 页面管理 Catalog 源（CRUD），以便集中管理模板来源。
145. 作为系统管理员，我想要在 Settings 页面管理定时任务（创建/编辑/删除/查看执行历史），以便自动化周期性操作。
146. 作为系统管理员，我想要查看审计日志并按操作类型和日期范围筛选，以便事后追溯和排查。
147. 作为系统管理员，我想要在 Settings 页面看到版本号和 git commit SHA，以便识别当前运行版本。
148. 作为系统管理员，我想要切换界面语言（中文/英文），以便不同语言偏好的用户都能使用。
149. 作为系统管理员，我想要切换暗色/亮色主题，以便在不同光线环境下舒适使用。

### 部署与运维

150. 作为运维工程师，我想要通过 Docker Compose 一键部署 CF Manager（单容器 all-in-one），以便快速启动服务。
151. 作为运维工程师，我想要通过 `docker pull` 获取预构建镜像（多架构 amd64 + arm64），以便无需 clone 仓库即可部署。
152. 作为运维工程师，我想要通过 Cloudflare Pages + D1 无服务器部署，以便零运维运行 CF Manager。
153. 作为运维工程师，我想要通过 GitHub Actions 自动化部署到 Cloudflare，以便 CI/CD 流程化。
154. 作为运维工程师，我想要 D1 数据库迁移自动化（schema.sql 建表 + migrations.sql 列级迁移），以便升级时数据库自动更新。
155. 作为运维工程师，我想要 Docker 版通过 `initDb()` 在启动时自动迁移 SQLite，以便升级时不需要手动执行迁移脚本。
156. 作为运维工程师，我想要完全覆盖部署模式（full_wipe），以便实现纯净重新部署。
157. 作为运维工程师，我想要部署工作流支持演示模式开关，以便在演示和生产环境间切换保护策略。

---

## Implementation Decisions

### 架构决策

1. **双后端对称架构**：同一套业务逻辑分别用 Express 5（Docker 自建，CommonJS，better-sqlite3）和 Hono 4（Cloudflare Pages，ESM，D1）实现。`backend/src/` 和 `worker/src/` 的路由、服务、中间件保持功能对称。新增功能需同时修改两端。

2. **单一前端共享**：Vue 3 + Naive UI + Pinia + Vite 前端同时为两个后端服务。Docker 版前端路径固定为 `/`（all-in-one），Worker 版固定为 `/admin/`。

3. **共享文件唯一真实来源**：`shared/` 目录是 AI 模型定价、Catalog JSON Schema、Catalog 校验器源码的唯一真实来源。`scripts/sync-shared.js` 在 dev/build 前自动同步到 backend 和 worker。不直接编辑自动生成文件。

4. **版本号管理**：版本号从 `CHANGELOG.md` 首个 `## [x.y.z]` 提取，由 `scripts/gen-version.js` 生成 `version.ts`。不手动编辑版本文件。

### API 设计决策

5. **双格式响应**：
   - 内部 API（`/api/*`）：经过 `responseWrapper` 中间件，自动包装为 `{ success: true, data }` 或 `{ success: false, error }`。
   - 外部 API（`/v1/*` 和 `/api/v1/*`）：OpenAI 兼容格式，不经过 responseWrapper。
   - 前端 Axios 拦截器自动解包 `success`/`data`。

6. **OpenAI 兼容 API 端点**：
   - `GET /v1/models` — 模型列表
   - `POST /v1/chat/completions` — 聊天补全（流式/非流式）
   - `POST /v1/images/generations` — 图片生成（文生图/图生图）
   - `POST /v1/audio/speech` — 语音合成
   - `POST /v1/translations` — 文本翻译
   - `POST /v1/browser/render` — 浏览器渲染
   - `GET /v1/browser/status` — 渲染状态

7. **AI 账户轮换策略**：
   - 普通模型：least-used 策略，选择今日神经元消耗最少的账户。
   - Prompt Caching 模型（GLM-5.2 / Kimi K2.5 / K2.6 / K2.7-code）：软粘性路由，优先复用最近使用的账户以提升缓存命中率；仅当粘性账户用量超出最优账户 10,000 神经元时才切换。
   - 配额耗尽（4006 错误）的账户自动标记为 exhausted，不再重复发起请求。

8. **神经元计费**：
   - 基于 `shared/model-pricing.json` 的定价数据估算神经元消耗。
   - 缓存模型根据 CF 返回的 `prompt_tokens_details.cached_tokens` 区分缓存命中与未命中，缓存命中部分按 ~1/5 价格计费。
   - 图片生成按 `perImage` 字段计费，TTS 按 `perKChar` 字段计费，翻译按 input/output 字段计费。

9. **TTS 模型 Schema 驱动**：不同 TTS 模型入参完全不同（aura-2-en 用 `text+speaker+encoding`、melotts 用 `prompt+lang` 无 speaker）。通过 `GET /accounts/{account_id}/ai/models/schema?model={model}` 动态获取每个模型的 input schema（缓存于服务层），用 `buildTtsCfBody` 只发送 schema 存在的字段。`/v1/models?task=text-to-speech` 附带 `speakers`/`default_speaker`/`advanced_params`。

### 部署决策

10. **Worker 部署使用 Versions API**：对标 wrangler，首次部署自动回退到传统 PUT。部署 API 注入 `User-Agent: wrangler/4.112.0`。

11. **Pages 部署**：JWT 自动刷新、Hash 校验、分批上传及部署状态轮询。支持创建空项目和上传 ZIP 部署。

12. **ZIP 多模块部署**：部署 ZIP 产物时自动解包为多模块上传（对标 wrangler），自动推断 main_module，非入口 JS 作为附属模块。

13. **Worker with Assets**：catalog 模板可选 `assets` 字段，静态资源三阶段上传（manifest 校验、base64 分块、PUT 注入 JWT 与 ASSETS 绑定）。

14. **部署并发控制**：批量部署使用并发池（concurrency=3），避免 CF API 速率限制。Zone 批量创建/删除同样使用并发池。

15. **两阶段部署流程**：`POST /api/store/preflight` 预检端点在用户确认部署前检查 Worker 存在性、配置差异、Secrets 覆盖。前端自动预检流程：无问题直接部署，有问题展示结果等待二次确认。

### 安全决策

16. **凭证加密**：API Token / API Key / Password 使用 AES 加密存储，密钥为 `ENCRYPTION_KEY` 环境变量。返回时脱敏为 `***encrypted***`。

17. **SSRF 防护**：部署链路全部裸 `fetch(url)` 替换为 `fetchScriptSafely()` / `assertUrlSafe()`，强制校验：
   - 协议白名单（仅 `https:`，Docker 版额外放行 `http://localhost`）
   - 主机/IP 校验（拒绝环回/私网/链路本地/唯一本地地址）
   - 重定向防护（逐跳重新校验）
   - Content-Type 校验（仅 JavaScript/文本类型）
   - 响应大小限制（最大 5 MiB）
   - 可选来源白名单（`WORKER_DEPLOY_URL_ALLOWLIST`）

18. **认证加固**：`API_SECRET` 未配置时不再静默跳过认证，而是自动生成密码学随机临时 secret 并在控制台输出安全告警。

19. **演示账户保护**：通过 `DEMO_ACCOUNT_IDS` 环境变量保护的账户不可删除/修改，覆盖账户 CRUD、规则 DELETE 等操作。

### 数据库决策

20. **Docker 版（SQLite）**：`better-sqlite3` 同步查询，WAL 模式，外键约束开启。`initDb()` 启动时自动建表和列级迁移。

21. **Worker 版（D1）**：异步查询，`schema.sql` 建表，`migrations.sql` 列级迁移。GitHub Actions 部署时自动执行。

22. **缓存策略**：
   - Backend: NodeCache（内存）缓存 Zones 列表（5 分钟 TTL）
   - Worker: KV 缓存 Zones 列表（5 分钟 TTL）和 Catalog 数据
   - 创建/删除 Zone 后自动清除缓存

23. **代理服务决策**：Backend 通过 `cloudflare` SDK（`getCfClient()`）+ `https-proxy-agent`/`socks-proxy-agent` 访问 CF API；Worker 通过 `fetch` 封装（`cfFetch()`）直连。代理优先级：账户专属（已启用）> Resin（已启用）> 全局代理（已启用）> 无代理。

### 前端决策

24. **国际化**：vue-i18n，zh-CN / en 两个语言包（1052+ 词条），自动检测浏览器语言并持久化到 localStorage。

25. **响应式布局**：桌面端使用 Naive UI 侧边栏布局（可折叠），移动端使用 FAB（浮动操作按钮）网格导航。卡片网格列数响应式适配。

26. **主题**：暗色/亮色切换，`html.app-dark` class + localStorage 持久化 + `setDiscreteTheme` 同步离散组件主题。

27. **Docker 单容器**：Express 直接通过 `express.static` + `compression` 中间件提供前端静态文件服务（gzip 压缩、30 天缓存、SPA 路由回退），不再依赖 Nginx。SSE 流式响应在 Node.js 中原生处理。

---

## Testing Decisions

> 本项目目前无现有测试。以下为建议的测试策略，供后续实施参考。

- **测试原则**：仅测试外部行为（API 响应格式、状态码、副作用），不测试实现细节（内部函数调用、变量赋值）。
- **最高测试边界（优先）**：API 集成测试 — 启动完整服务器，发真实 HTTP 请求，Mock Cloudflare API 调用，覆盖认证→路由→业务逻辑→数据库→响应格式全链路。
- **次高边界**：服务层单元测试 — 针对定价计算、加密/解密、SSRF 防护、配额追踪、限流器等纯逻辑模块。
- **前端测试**：Vue Test Utils + axios mock adapter 测试组件交互逻辑。
- **共享模块测试**：Catalog 校验器、模型定价计算等 `shared/` 下的逻辑。

---

## Out of Scope

1. **跨账号算力分摊/商用转售**：CF Manager 的多账户调度仅为技术调度逻辑，不支持对外提供商用算力服务。公网开放多账户调度接口违反 Cloudflare 服务条款，存在账号封禁风险。
2. **账户自动注册**：曾有的 `cf-reg` 批量注册工具已出于安全原因下线，不再纳入范围。
3. **原生移动应用**：仅提供响应式 Web 界面，不开发原生 iOS/Android 应用。
4. **多租户/多用户权限**：当前为单用户（单 API_SECRET）模式，不支持多用户账户和 RBAC 权限管理。
5. **CF Workers 自定义域名 HTTPS 证书管理**：证书由 Cloudflare 自动管理，不提供手动证书上传/管理功能。
6. **Cloudflare Stream/Images 等其他产品**：仅覆盖 Workers/Pages/DNS/KV/D1/R2/AI/Browser Rendering/Tunnel/Rulesets，不覆盖 Stream、Images、WARP 等其他 CF 产品。
7. **实时监控/告警**：不提供实时性能监控、告警通知（Webhook/邮件）等运维监控能力。
8. **CI/CD Pipeline 集成**：不提供与 GitHub/GitLab CI 的原生 Pipeline 集成，部署通过手动或 GitHub Actions 工作流完成。

---

## Further Notes

### 合规声明

CF Manager 仅限学习研究及已授权自有账户运维使用。用户需确保遵守 Cloudflare 服务条款及相关法律法规。公网开放 AI 推理代理接口存在账号封禁风险，仅推荐局域网本地开发调试使用。

### 技术栈概览

| 层级 | Docker 版 (backend/) | Worker 版 (worker/) |
|---|---|---|
| 框架 | Express 5 + TypeScript | Hono 4 + TypeScript |
| 数据库 | SQLite (better-sqlite3) | Cloudflare D1 |
| CF 交互 | `cloudflare` SDK (Node.js) | 原生 `fetch` 调用 CF REST API |
| 部署 | Docker Compose (单容器) | Cloudflare Pages |
| 模块系统 | CommonJS | ESM (esbuild bundle) |
| 前端 | Vue 3 + Naive UI + Pinia + Vite + TypeScript | 同左 |

### 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `ENCRYPTION_KEY` | 是 | AES 加密密钥，用于加密存储 API Token 等凭证 |
| `API_SECRET` | 否 | 管理 API 认证密钥；未配置时自动生成临时 secret 并告警 |
| `PROXY_URL` | 否 | 全局代理 URL（支持 HTTP/HTTPS/SOCKS4/SOCKS4a/SOCKS5/SOCKS5h） |
| `DEMO_ACCOUNT_IDS` | 否 | 演示账户 ID 列表（逗号分隔），受保护不可删除/修改 |
| `DB_PATH` | 否 | SQLite 数据库路径（Docker 版，默认 `/app/data/cf-manager.db`） |
| `WORKER_DEPLOY_URL_ALLOWLIST` | 否 | 部署 URL 白名单（逗号分隔主机名），限制可部署脚本来源 |
| `CLOUDFLARE_API_KEY` | 否 | Cloudflare API Key（CI 部署用） |

### 关键依赖

- **前端**：Vue 3.5, Naive UI 2.44, Pinia 3, vue-router 5, vue-i18n 9, Axios, markdown-it, highlight.js, dompurify
- **Backend**：Express 5, better-sqlite3 12, cloudflare SDK 6, winston 3, node-cron 4, ajv 8
- **Worker**：Hono 4, ajv 8, esbuild, wrangler 4, @noble/hashes

### 版本历史摘要

- **v1.0.0** (2026-06)：初始发布，多账户管理、AI 推理代理、Workers/Pages 管理、DNS/存储管理、浏览器渲染
- **v1.3.x** (2026-07)：应用商店、Catalog 部署、账户编辑、R2 缓存、SSRF 防护、隧道管理、规则引擎
- **v1.4.x** (2026-07)：账户级代理、审计日志筛选、Resin 代理池、Docker 单容器、批量部署
- **v1.5.x** (2026-08)：演示模式开关、批量操作 UI 优化
- **v2.0.x** (2026-08)：AI 图片生成、AI 语音合成、AI 翻译、AI 功能整合、前端 i18n、Zone 管理（创建/删除/设置/缓存/状态）、DNS View UI 重构、Workers/Pages 部署增强（环境变量/绑定/配置重部署）、Kitesurf 引擎支持、SOCKS5h 代理修复
