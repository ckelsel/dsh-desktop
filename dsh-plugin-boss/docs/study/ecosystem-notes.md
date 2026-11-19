# 生态调研速记（源：awesome-dsh-plugin 清单）

## 关键先例：DSH 内置浏览器（桌面版）

- **alamsir/dsh-iab** — "DSH 内置浏览器：独立 Chromium + 持久化 profile，SSO 登录一次跨重启有效，经 CDP 驱动，7 个 Agent 工具（status/open/eval/read/feishu/screenshot/tabs），页面实时镜像到右侧栏面板，工具调用时面板自动打开。需本机 Chrome/Edge/Chromium（不自动下载），`DSH_IAB_CHROME` 指定可执行文件。"
  → 与我们 BOSS 登录态需求几乎同构（登录一次、cookie 持久、CDP）。
- **Chenghui-Liang/dsh-web-pick** — "在 DSH 桌面版内置浏览器里加元素选取层……**仅桌面版可用：Web 版浏览器是 iframe，选取层不会出现**"
  → 直接印证：桌面版内置浏览器是原生级（webview/BrowserView），Web 版是 iframe（降级）。与我们"只在 Desktop 用 webview，Web 版自动降级"的判断一致。
- **alvinlui-hk/dsh-browser-bridge** — "完整控制与截图需 DSH 桌面端；在普通浏览器（Web）中仅能读取或操控同源页面"
  → 再次印证桌面/Web 能力分层。
- **binskyz/dsh-yunpa**（仅 Windows）— 本地加密凭据库（DPAPI + AES-256-GCM）+ 无头 Chrome 登录态保管：登录一次会话存本机，抓登录墙内页面；页面镜像到可拖动右缘抽屉，验证码在抽屉里人工过。
  → **与 dsh-plugin-boss 的登录态保管 + 人工过验证需求高度同构**，Windows 实现可参考。
- **Baisbt/dsh-plugin-webrelay** — 同源反向代理把外部 AI 站点嵌进 DSH 右侧面板（DOM 适配器写在配置里）。
  → iframe/代理方案参考。

## 带 UI 的完整插件范式

- **john-walks-slow/dsh-proactive** — host 级定时唤醒 + **Web 管理面板（设置页节 + 会话页签，SSE 实时刷新）**。"每日投递预算约束"等概念也与本项目相关。
- **FelixJiashengFu/dsh-muse-code** — 右侧边栏面板 + 5 个聊天工具共享会话，仅 Windows。
- **dsh-market** — 插件市场本身是插件（`dsh plugin --profile web add dshmarket`）。

## 其他要点

- 插件收录标准：声明 `dsh.bundle` manifest + `dsh plugin add` 可装。
- 市场索引：`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`（format 1）。
- 桌面客户端有三个：dataelement/dsh-desktop、hairyf/deepseek-harness-desktop、anywhere-labs/deepseek-harness-desktop——均内嵌 dsh-market。
- Node.js 要求：npm 版 @deepseek-ai/dsh 0.2.2-rc.1 要求 node>=24.9.0（本机 22.23.3 **需升级**）。dsh-sidepanel-web 等提到 "Node.js 22.19+"，说明部分插件兼容 22.19+。
- 生态警告（收录方立场）：安装插件=本机第三方代码，工具审批管不到插件自身代码——权限设计要自觉。

## dsh-iab 双半边实现模式（已 clone，教科书模板）

- `cordis.patch.yml`：`- insert: [{ id: dsh-iab, name: dsh-iab }]` 单行插入 Host 组合（注释强调：宿主面插件进 Host 组合，绝不进 agent preset）。
- `engines.dsh: ">=0.2.0-0 <0.3.0-0 || >=0.2.1-rc.1 <0.3.0-0"`、`engines.node: >=22.5`（插件本体兼容 Node 22；24.9 只是 npm CLI dsh 的要求）。
- peerDeps：`@deepseek-ai/cordis ^4.0.4`、`@deepseek-ai/dsh-tools >=0.1.7-rc.2`、`@deepseek-ai/schemastery`（optional）。
- **Host 半边**（src/）：`inject: ['tools']` 只硬依赖 tools；`webServer`/`connection` 走**动态注入**（硬声明会在无 webServer 的 profile 里永久 pending = 启动失败）；Schemastery 经 `createRequire` 可选加载；`.volatile()` 字段投射进设置页；自持 Chromium（persistent profile + CDP + ScreencastHub 镜像）；`defineTool` 注册 agent 工具。
- **Client 半边**（client/client.js）：`window.__ModuleLoader__.load({ id, factory(require) })`；`require('react')` 用外壳提供的 React；注册右侧栏 tab（`sidebar.right.pane.tab`，与官方内置 Browser tab 同位）；SSE screencast 画进 `<img>`，输入事件回传 Host；中英文案内联 dict。
- exports：`.`/`./client`/`./cordis.patch.yml`/`./package.json`；files: src、client、cordis.patch.yml。

## 官方桌面内置浏览器 = Electron `<webview>`（dsh-web-pick 证据）

- client 半边（GUI 页内）直接 `document.querySelectorAll('webview')`（含 shadowRoot 嵌套）找到内置浏览器面板的 `<webview>` 元素，然后 `webview.executeJavaScript()` 注入 overlay、读回 outbox。"no proxy, no CDP, no project change"。
- **Host 半边（Node 子进程）碰不到 Electron webview guest**——注入只能由 Client 半边做。
- "The built-in browser is a session-scoped panel"。
- Web 版 DSH 的"浏览器"是 iframe（同源限制），选取层不出现 → 降级判断可基于此。
- 对我们的意义：BOSS 登录页可寄生官方内置浏览器的 webview（用户人工登录+过验证）；cookie 收割路径待定（client 半边 executeJavaScript 读 cookie / 桌面壳 IPC 读 webview session / 或 webview 内代发同源请求验证登录态）——等 dsh-desktop 报告确认桌面壳暴露的 IPC 面。

## 待办

- [ ] 等 DSH 插件体系报告：确认官方"内置浏览器"API 面（dsh-browser-use 包）、cookie 读取能力
- [ ] clone 样例：alamsir/dsh-iab、Chenghui-Liang/dsh-web-pick、john-walks-slow/dsh-proactive、binskyz/dsh-yunpa
- [ ] Node 升级到 24.9+（官方 CLI 硬要求）
