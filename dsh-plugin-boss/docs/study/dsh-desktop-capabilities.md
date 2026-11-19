# dsh-desktop（Anywhere Labs 第三方桌面壳）能力探查

> 源：`reference/dsh-desktop`。三产品包：dsh-plugin-desktop（stable v2.0.18）、dsh-plugin-desktop-beta（v2.0.23-beta.1）、dsh-desktop-next（v2.0.23-next）。upstream 分别 0.2.1-rc.3 / 0.2.2-rc.3。
> ⚠️ 注意：这是 Anywhere Labs 的第三方壳，**不是官方 deepseek-harness/apps/desktop**。官方桌面能力另见 deepseek-harness 主仓库（已 clone）。

## 1. 架构

- Yarn workspace + pinned submodule `deepseek-harness/`（本 clone 中未初始化，为空）。
- Stable：Electron main `lib/main.js`←`src/main.ts`；`electron-shell-generation.ts:220` 拥有 BrowserWindow/Tray；三种模式 compatibility/extended/advanced（`src/runtime.ts:19`）；本身是 Cordis Host 插件 `desktop-shell`（`src/index.ts:80-84`，inject=['webServer','appExit','settings','connection']）；compatibility 主窗口经 WebContentsView 加载未修改 upstream Web 客户端（127.0.0.1:port，分区 persist:dsh-desktop-renderer）。
- Next/Beta：主窗口加载自定义协议 `dsh-app://app/`（静态资源=打包的官方 Web 前端 dist，其余路径 Host cookie+native token 转发 loopback Host）；Host 是 Electron Node 子进程（runProfile 启动官方 Web profile）；Next 能力 = Host 插件 `desktop-next-capabilities`（provide desktopPermissions/desktopProfiles/desktopPnpm/desktopActions）。
- Preload（Next/Beta）：`window.desktopNext`（state/command/permissions）、`window.dshDesktop`（**browser/keyboard/fileActions/fileDrag**）、`window.dshDesktopSetup/Boot`、`window.dshPlatform`、`window.__DSH_DIRECTORY_PICKER__`、`window.__DSH_HOST_PATHS__`。Stable preload 只暴露 `dshDesktop={protocolVersion:1}`。

## 2. webview 通道（lease 门控，Beta/Next）

- 主窗口 `webviewTag: primary`（`dsh-desktop-next/src/main.ts:412-414`）。
- `DesktopBrowserGuests.acquire(owner, workspace)`（`browser-guests.ts:16-173`）→ `{lease, partition}`；partition 每 workspace 内存级 `dsh-sidebar-browser-<uuid>`。
- 渲染端：`window.dshDesktop.browser.acquire(workspace)`（preload-browser.ts:20-21）；IPC `dsh-next:browser-acquire/release`。
- attach 校验：只接受 `src="about:blank#<lease>"` 且 partition 匹配；guest webPreferences 被整体覆写（sandbox、contextIsolation、无 node、webviewTag:false）；**guest 不带任何 preload**（verify-sidebar-browser.mjs:61-62 断言 guest 内 window.desktopNext/dshDesktop/require/process === undefined）。
- 官方拼装范式（照抄）：`<webview partition=<p> allowpopups src="about:blank#"+lease>` → appendTo DOM → `webview.loadURL(target)`。
- 导航白名单：仅 http/https、无 userinfo、**Host origin 全禁**；权限全拒、下载阻止；guest 的 window.open 被拒并经 `dsh-next:browser-open-requested` 回传宿主渲染层。
- 上游消费者：官方插件 `@deepseek-ai/dsh-client-ui-sidebar-browser`（侧栏浏览器）。preload-app.ts:43-45 注释：没有 `browser` 成员时官方插件**静默回退沙箱 iframe**。
- **Stable 无 webview**：webviewTag 默认 false + 拒绝 will-attach-webview（local-window-policy.ts:25-39）；stable preload 无 `browser`。
- 壳层面没有"读 guest session/cookies"的 IPC（主进程只用过 renderer.session.cookies.get 做 Host 会话重放、platform cookie 注入，均私有）。

## 3. executeJavaScript 矛盾点（重要，待官方源验证）

- 本报告称"webview 元素 API 也没有 executeJavaScript/cookies"。
- **但 dsh-web-pick（已 clone）的 client.js:5-7 明确用 `webview.executeJavaScript()` 注入官方侧栏浏览器的 webview 并读回 outbox**——宿主渲染层对 `<webview>` 元素的 DOM 级方法调用不受 guest webPreferences 限制。
- reconcile：壳不提供 ≠ DOM API 不存在。结论：**宿主渲染层（client 插件）可对自建 webview 调 executeJavaScript 在 guest 页面执行 JS**；guest 内部看不到任何 preload API（隔离的是 guest 内环境，不是宿主侧元素方法）。
- 推论：`executeJavaScript('document.cookie')` 可拿非 HttpOnly cookie（`__zp_stoken__` 大概率可拿，boss-agent-cli 的 _extract_stoken 正是 document.cookie.match）；**HttpOnly cookie（wt2 等）拿不到**——纯 Node HTTP 重放需要全量 cookie 时是硬缺口；兜底=guest 页面内同源 fetch 代发（credentials:'include' 自动带 HttpOnly，boss-agent-cli 已验证该模式）。

## 4. Desktop vs Web 检测

- 渲染层：`window.dshDesktop` 存在性（官方客户端插件识别 Desktop 的载体）；Next 细粒度探测 `window.dshDesktop.browser`；`window.desktopNext?.state`；CSS/DOM 标记 `data-platform`、`data-dsh-desktop-mode`、`data-dsh-desktop-frame`。Stable URL 标记 `dsh-desktop-mode/...`（parseDesktopClientEnvironment，普通 Web 返回 undefined）。
- Host 侧：`ctx.get('desktopProfiles') === undefined` → 普通 DSH 回退；存在则嵌套 `ctx.inject(['desktopPnpm'],...)`（**文档化判别法**，dsh-plugin-desktop/docs/plugin-services.md:260-310）。
- Web 载体门：`x-dsh-desktop-renderer` 头 + 拒普通浏览器带 `dsh-desktop-*` URL 标记（无法伪装）。
- 桌面私有 Host 能力（desktopRuntime/desktopPnpmBootstrap）非稳定契约，插件只应依赖 `window.dshDesktop.browser` / `desktopProfiles` 等文档化接缝。

## 5. 许可

MIT（Anywhere Labs / upstream DeepSeek）。依赖白名单强制宽松许可。第三方插件基于未修改壳调试 OK；勿改 submodule。注意此壳非官方。

## 6. 对 dsh-plugin-boss 的结论

1. 探测链：`window.dshDesktop?.browser` 存在（Next/Beta）→ acquire lease + 自建 webview 开 zhipin.com；否则（Web **以及 Stable 桌面**）→ iframe/降级模式。降级必须覆盖 Stable。
2. HttpOnly cookie 缺口的两条出路：(a) 业务请求经 guest 内 fetch 代发（Node 编排、webview 传输）；(b) 官方侧栏浏览器插件若暴露更强的会话接缝（查 upstream `@deepseek-ai/dsh-client-ui-sidebar-browser` 源码，deepseek-harness 主仓库已 clone）。
3. 官方 apps/desktop（deepseek-harness 仓库内）的 webview/IPC 面未在本报告范围——需另行确认，用户所说 "DSH Desktop Electron 壳" 更可能指官方。
