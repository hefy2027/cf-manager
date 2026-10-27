# 第三方 fork 功能调研：58cdn/cf-manager

> 整理社区 fork `58cdn/cf-manager` 相对上游 `hefy2027/cf-manager` 的全部改动，并给出移植评估。
>
> 调研日期：2026-10-27。对比基线：上游 `master` @ `2d09c51`（PR #63）；该 fork 分叉点即 `2d09c51`（已完整同步上游，落后 0 个提交）。

---

## 一、概述

| 项 | 值 |
|---|---|
| 调研对象 | `58cdn/cf-manager`（`main` 分支） |
| 领先上游 | **6 个提交**，其中 4 个是同步上游的 merge，实质只有 **2 个** |
| 代码规模 | 22 个文件，+616 −175 |
| 内容 | 青岚（Verdant）主题 + 外观持久化；`demo_mode` 默认值改 false |
| 结论 | 主题系统**已被上游后续的「多主题色 + 磨砂玻璃」体系覆盖**，整段移植无意义；唯一值得借鉴的是 **首屏防闪烁的 `theme-init.js`** |

### 提交索引

| SHA | 日期 | 主题 | 性质 |
|---|---|---|---|
| `9164efc` / `a53d9d6` | 09-20 / 10-14 | 合并上游 develop | 同步 |
| `d1aa73f` | 09-17 | **新增青岚主题与持久化外观切换** | 实质改动 1 |
| `fb98ee7` | 09-17 | `demo_mode` 默认改 false | 实质改动 2 |
| `09e6729` / `6b1d817` | 10-23 | 合并上游 2.4.2 并保留定制 | 同步 |

---

## 二、青岚主题实现（`d1aa73f`，+439 −64）

### 文件结构

| 文件 | 行数 | 作用 |
|---|---|---|
| `frontend/public/theme-init.js` | 16 | **首屏前置脚本**：`<head>` 同步执行，读 localStorage 决定 `data-ui-theme` / `app-dark`，避免白闪 |
| `frontend/src/composables/useUiTheme.ts` | 73 | 主题状态（`default` / `verdant`）、`themeOverrides` 色板、`uiConfig`（供 `n-config-provider` 与 discrete API 共用） |
| `frontend/src/styles/verdant.css` | 122 | 仅在 `html[data-ui-theme='verdant']` 下重定义 `--app-*` / `--ui-*` CSS 变量，含 `.app-dark` 变体 |
| `frontend/src/components/ThemeSelector.vue` | 38 | 原生 `<select>` 切换主题；localStorage 不可用时显示「仅本次会话」 |
| `frontend/index.html` | +1 | `<script src="/theme-init.js"></script>` |
| `frontend/src/main.ts` | +1 | `import './styles/verdant.css'` |
| `frontend/src/App.vue` | ±119 | 移除本地 `isDark` 状态，改为消费 `useUiTheme()` |
| `frontend/src/utils/discreteApi.ts` | ±17 | 删除 `setDiscreteTheme`，discrete API 直接用共享的 `uiConfig` |
| `frontend/src/api/client.ts` | ±5 | `localStorage` 读写包 `try/catch`（隐私模式不再抛错） |
| `i18n` / `docs` / `CHANGELOG` | — | 中英文各 8 条文案、`docs/admin-ui-plan.md`（68 行规划）、版本条目 |

### 关键设计（值得借鉴的两点）

1. **首屏防闪烁**：`theme-init.js` 在应用与样式加载前同步执行，直接写 `documentElement`：
   ```js
   var root = document.documentElement;
   if (localStorage.getItem('cf-manager.ui-theme') === 'verdant') style = 'verdant';
   var saved = localStorage.getItem('darkMode');
   if (saved === 'true' || saved === 'false') dark = saved === 'true';
   root.dataset.uiTheme = style;
   root.classList.toggle('app-dark', dark);
   ```
   `localStorage` 抛异常时打 `data-preference-storage="unavailable"` 标记，供 UI 提示「偏好无法保存」。

2. **主题覆盖单点化**：`uiConfig` 同时提供给 `n-config-provider` 和 `createDiscreteApi`，避免此前「页面是主题色、message/dialog 还是默认色」的不一致。

### 与上游现状对照（重要）

上游在 2026-09 之后已实现更完整的主题体系（`frontend/src/utils/theme.ts`，约 520 行）：

| 能力 | 上游现状 | 58cdn fork |
|---|---|---|
| 明/暗/跟随系统 | ✅ `themeMode: auto/light/dark` | ❌ 仅明/暗 |
| 主题色 | ✅ **6 套预设**（orange/green/blue/purple/cyan/rose） | ⚠️ 等于把 `green` 固化成一套 verdant 色板 |
| 磨砂玻璃 + 浓度档位 | ✅ `frostedGlass` / `glassIntensity` | ❌ |
| 语义色派生 | ✅ `deriveSemanticColorGroups()` | ❌ 手写 `--app-*` 变量 |
| 文档级应用 | ✅ `applyThemeToDocument()` 写 `app-dark` / `app-glass` / `--theme-primary*` | ✅ 同类（`data-ui-theme` + `--app-*`） |
| **首屏防闪烁** | ❌ **无**，主题在 `App.vue` 挂载后才写 DOM | ✅ `theme-init.js` |
| discrete API 一致 | ✅ 已通过 `setDiscreteTheme(isDark, overrides)` 传参 | ✅ 改为共享 `uiConfig`（等价） |

结论：**主题本体的移植价值已经消失**（上游的 6 预设 + 磨砂玻璃是它的超集），但它暴露了上游一个真实缺陷——**首屏闪烁**。

---

## 三、`demo_mode` 默认值改 false（`fb98ee7`）

`.github/workflows/deploy-cf-secret.yml` 一行：

```diff
-  demo_mode: 'true'
+  demo_mode: 'false'
```

作者意图是自部署时不启用演示保护。上游当前默认 `true`（`.github/actions/deploy-cf/action.yml` 的 `inputs.demo_mode.default: 'true'`），真正生效的是 `DEMO_ACCOUNT_IDS`（`worker/wrangler.toml` 默认空 = 未配置即无保护账户）。

**不建议跟随**：`demo_mode=true` 是「一键部署给公众访问」场景的安全兜底（保护演示账户不被改删）。需要关闭的人本来就可以在部署时覆盖输入，改默认值只会让直接 fork 部署的人默认处于裸奔状态。

---

## 四、移植建议

| 内容 | 判断 | 动作 |
|---|---|---|
| **首屏防闪烁脚本** | ⭐ 值得移植 | 按上游 localStorage 键（`themeMode` / `darkMode` / `themeAccent`）重写 `theme-init.js`，在 `<head>` 同步执行，复刻 `app-dark` / `app-glass` / `--theme-primary*` |
| 主题覆盖单点化 | ➖ 上游已实现 | 仅确认 discrete API 与 `n-config-provider` 用的是同一个 `getThemeOverrides()` 结果 |
| verdant 色板 / `useUiTheme` / `ThemeSelector` | ❌ 已被超越 | 不做；如需新配色，往 `theme.ts` 的 `ACCENT_PRESETS` 加一条 preset 更省 |
| `localStorage` try/catch（`client.ts`） | ⭐ 可顺手带上 | 隐私模式/禁用存储下不再抛异常中断请求 |
| `demo_mode` 默认 false | ❌ 不建议 | 保持 `true` |

### 首屏脚本移植要点（伪代码）

```html
<!-- frontend/index.html，放在所有样式之前 -->
<script>
  (function () {
    var r = document.documentElement, mode, accent = 'orange';
    try {
      var m = localStorage.getItem('themeMode');
      var d = localStorage.getItem('darkMode');
      mode = m || (d === 'true' ? 'dark' : 'light');
      accent = localStorage.getItem('themeAccent') || accent;
      var glass = localStorage.getItem('frostedGlass') !== 'false';
      r.classList.toggle('app-glass', glass);
    } catch (e) { mode = 'light'; }
    var sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    r.classList.toggle('app-dark', mode === 'auto' ? sysDark : mode === 'dark');
    r.dataset.accent = accent;   // 供 CSS 在挂载前选主色
  })();
</script>
```

同时需要在 CSS 里为每个 accent 预设提供 `html[data-accent='green'] { --theme-primary: … }` 之类的静态兜底，否则脚本只解决了明暗、没解决主色闪烁。

### 复现命令

```bash
git fetch --no-tags https://github.com/58cdn/cf-manager.git \
  '+refs/heads/*:refs/remotes/fk/58cdn/*'
git show d1aa73f --stat
git show d1aa73f:frontend/public/theme-init.js
```

---

## 附：关联文档

- [FLuoXue fork 调研](fork-review-fluoxue.md)
- [xuexu fork 调研](fork-review-xuexu.md)
- [Heisenberg2024 fork 调研](fork-review-heisenberg2024.md)
