# DSH（deepseek-harness）插件开发体系

> 源：`reference/deepseek-harness`（官方，Cordis 4.1.0 vendored，无 @cordis/router）。

## 0. 实测踩坑记录（npm 发行版 0.2.2-rc.1）

- `--patch` 是启动器层 flag，必须放最前：`dsh --patch x.yml --profile web --no-open`（放 app 名后 → `unknown option '--patch'`）。
- apply() 收到的 config 值可能是 schemastery volatile 的 `.get()` live wrapper（也可能是裸值/缺失）——统一走 readConfig 辅助（dsh-iab 模式）。
- `output.schema` 显式对象根必须声明 `additionalProperties: true|false`，否则 dsh-tools 的 JSON Schema 编译抛 JsonSchemaError。
- 插件以绝对路径 `--patch` 加载时，Node 模块解析从插件文件目录向上找 node_modules —— 插件自己的 dependencies 要在项目目录里 `npm install`；与宿主共享实例的 dsh 包声明在 peerDependencies+devDependencies。

## 1. defineTool

- 导出：`@deepseek-ai/dsh-tools`（`packages/core/tools/package.json:2`，`src/index.ts:409` re-export schema.ts）。
- 签名（`packages/core/tools/src/schema.ts:555-557`）：
  ```ts
  defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(
    options: DefineToolOptions<S, O>
  ): ToolDefinition
  ```
- `DefineToolOptions`（schema.ts:484-546）：`name`、`description`、`parameters: S`（属性开放对象根 DSL，`InferArgs<S>` 推导类型）、`output: { schema: O; render(args,value): ContentBlock[]; presentationMeta?(args,value) }`、`timeoutMs?`、`isConcurrencySafe?`、`execute(args, exec: ToolRunContext)`、`presentCall?/presentResult?`（UI 卡片）。
- 注册：`ctx.tools.register(def, options?)`（`packages/core/tools/src/index.ts:128-153`，返回 disposer）。schema 自动进 system prompt（index.ts:111-118）。
- 范例：`packages/web/tool-web/src/index.ts:23-103`（含 presentCall/presentationMeta）、`packages/todo/tool-todo/src/index.ts:22-209`、教程 `docs/user/develop/basic/tool.md`、权威参考 `docs/cookbook/adding-a-tool.md`。

## 2. 插件最小结构与分发

- 插件 = ESM 模块导出 `apply`（+`name`/`inject`/`Config`；object/class 形式亦可）。
- 本地开发：overlay `- insert: [{id, name: '/abs/path.ts'}]` + `pnpm dsh web --patch ./cordis.yml`。
- bundle：package.json `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`（可数组按序）+ `engines.dsh`；`dsh plugin --profile <name> add <npm|git|tarball|path>`；层序 = bundle 层 → profile patch → home patch → --patch（`docs/user/develop/basic/publish.md`）。
- manifest 类型：`packages/util/package-manifest/README.md:30-58`（patch/listedByDefault/platforms/locale meta/icon）。
- git 安装坑：无 build 环节跑 prepare，pnpm≥10 需 allowBuilds 授权；免授权 = npm 发布预构建 lib/ 或 tarball。
- 第三方命名无强制前缀。市场 index 由 `apps/plugin-market-generator` 生成。

## 3. 客户端 UI 插件（slots）

- `ctx.slots.register({name, children?, store?, inject?}, Component)`；向他人 slot 注册用 `ctx.slots.inject(name, () => ctx.slots.register(...))`（`docs/subsystems/slots.md`）。kinds：single/list/keyed/chain/hoc。唯一内置声明 `'root'`。
- slot 命名 `<domain>.<entry>.<hole>`；工具卡片 = keyed slot `tool.call.toolview`（按 wire 工具名）。
- 范例：`packages/client/ui-skill/src/client/index.ts:89-92`（toolview）；`packages/client/ui-sidebar-browser/src/client/index.ts:43-105`（复杂面板）；插件管理页 slots `plugins.bundle.config`/`plugins.row.config`/`plugins.detail.section`。
- 客户端包：`src/client/` 半体 + `./client` 导出 + `dsh.client` manifest（platform:'web'）；内置包另需进 tsconfig.client.json 聚合 + web-app cordis.patch.yml + package.json 依赖。组件只见 props 不见 ctx；跨包 UI 只走 slot。
- Host 的 presentCall/presentResult 不进 Web Client——Client 插件自己注册 `tool.call.toolview`。
- 动态客户端模块：`window.__ModuleLoader__.load({id, factory(require)})`，`require('react')` 用外壳 React（dsh-iab client.js 实证）。

## 4. Router / HTTP

- **无 ctx.router**（全仓零命中；vendored cordis 无 @cordis/router）。用户所说 "Cordis Router" 在 DSH 中对应自研 `ctx.webServer`。
- `packages/host/webserver/src/index.ts`：`register(route)` :520（kind exact|prefix，handler|resource，auth required|anonymous|deny）、`registerUpgrade` :535、`registerFallback` :552；事件 `webserver/request`、`webserver/index-inject` 等。
- 实例：`packages/api/gateway/src/index.ts:277`、`packages/client/modules/src/index.ts:234,705`、`packages/host/open-in-app/src/index.ts:170-226`。
- 浏览器侧无 URL 路由器；"页面"= slot 组合/视图状态；插件页面落地：slot 贡献或 webServer 路由 + iframe/webview。

## 5. Desktop（官方 apps/desktop）

- Desktop = 同一 Web 应用的 Electron 壳（`apps/desktop/README.md:40`）；Host 由 `@deepseek-ai/dsh-desktop-host` 子进程跑；profile `$DSH_HOME/profiles/desktop`。
- **官方内置侧栏浏览器 `packages/client/ui-sidebar-browser`**：Web=iframe（browser/IframeImpl.ts），Desktop=Electron `<webview>`（electron/ElectronWebViewImpl.ts）。
- 检测：`globalThis.dshDesktop?.protocolVersion === 1`（preload `apps/desktop/src/preload-app.ts:113,128`；客户端分支 ui-sidebar-browser/src/client/index.ts:69-101）。
- webview 通道（官方桌面）：`apps/desktop/src/browser-guests.ts`（lease 租约/隔离，attach 校验 webPreferences 覆写）；preload 窄桥 `DesktopBrowserBridge{acquire,release,onOpenRequested}`（`apps/desktop/src/preload-browser.ts:20-21`；类型 `ui-sidebar-browser/src/types.ts:20-27`）。
- 官方 ElectronWebViewImpl 实证 webview 元素 API：`element.loadURL(url)`、`element.getURL()`（src/client/electron/ElectronWebViewImpl.ts:196,211）→ 同接口 executeJavaScript 可用（dsh-web-pick 实证）。
- Host 侧桌面探测：`ctx.get('desktopProfiles') === undefined` → 普通 DSH 回退。

## 6. 权限/确认（投递门禁用）

- `tools/pre-execute` waterfall → `PreToolDecision = allow | deny{reason} | cancel | ask{reason}`（`packages/core/tools/src/events.ts:18`）；范例 `docs/cookbook/extension-cookbook.md:15-31`。
- ask → `ctx.get('approval')` fail-closed（`packages/core/tools/src/pipeline.ts:442-466`）；`ApprovalService.request(): Promise<'allowed-once'|'rejected'|'cancelled'|'unavailable'>`（`packages/interaction/user-approval/src/index.ts:243`）；UI = `packages/client/ui-approval`；预设 `packages/interaction/permission-presets`。
- 单调拒绝：`ctx.tools.guard()`（tools/src/index.ts:384-401）。观测/包装：`tools/execute`、`tools/post-execute`、`tools/result`。

## 7. 后台任务

- `ctx.jobs.start({ kind, label, owner: exec.agent, run })` → 后台 job（canonical 句柄 `{kind:'background', jobId}`）；cancel/done/output 约定见 `packages/jobs/jobs/README.zh.md` 与 dsh-tool-bash。批投递长任务用。

## 8. 落地建议（来自报告，待方案阶段确认）

1. Node 半体：`ctx.tools.register(defineTool(...))` 注册 boss_* 工具；投递等敏感动作挂 `tools/pre-execute` 返回 `ask` 走 approval 人工确认；硬红线 `ctx.tools.guard()`。
2. UI 半体：client slot 注入（参考 ui-sidebar-browser tab + plugins.row.config）+ `tool.call.toolview` 卡片。
3. Desktop webview/Web iframe：照抄 ui-sidebar-browser 的 `dshDesktop?.protocolVersion === 1` 双实现。
4. 分发：`dsh.bundle.patch` + `engines.dsh`，npm 预构建发布。
