# 学习调研总览（2026-11-17）

为 dsh-plugin-boss（DSH 桌面插件，对接 BOSS 直聘）做的第一轮源码学习。全部材料在 `reference/`，笔记在 `docs/study/`。

## 材料清单（reference/）

| 仓库 | 是什么 | 关键收获 |
|---|---|---|
| `deepseek-harness/` | DSH 官方本体（DeepSeek AI，"一切皆插件"，Cordis 驱动） | 插件体系全套：defineTool、bundle/profile、slots UI、webServer、approval、jobs、官方 apps/desktop 与 ui-sidebar-browser |
| `dsh-desktop/` | Anywhere Labs 第三方桌面壳（pinned upstream submodule） | lease 门控 webview 细节、桌面/Web 探测、无 cookie API |
| `boss-cli/` | jackwener 的 BOSS 逆向 CLI（Python） | geek+recruiter 全接口表、QR 登录、防封、码表 |
| `boss-agent-cli/` | can4hou6joeng4 的 BOSS agent CLI（Python） | 2026-10 更新的接口差异（POST 搜索/traceid/HTTP2）、风控即停、批投递安全范式、MCP 工具粒度 |
| `dsh-iab/` | 第三方 DSH 插件：内置浏览器（Chromium+CDP+侧栏镜像） | 双半边插件教科书模板（已逐行笔记） |
| `dsh-web-pick/` | 第三方 DSH 插件：桌面内置浏览器选取层 | **webview executeJavaScript 实证** + 桌面/webview、Web/iframe 降级实证 |
| `dsh-proactive/`、`dsh-yunpa/` | 带 Web 管理面板插件 / Windows 凭据库+登录态保管插件 | 备查（UI 面板范式、DPAPI 凭据保管） |
| `awesome-dsh-plugin/` | 插件精选清单 | 生态地图、市场索引、桌面客户端有三家 |

## 笔记索引（docs/study/）

- `dsh-plugin-system.md` — DSH 插件体系（defineTool/结构/slots/webServer/approval/desktop/分发）
- `dsh-desktop-capabilities.md` — 桌面壳 webview/cookie/探测能力（含 executeJavaScript 矛盾点的 reconcile）
- `boss-api.md` — boss-cli 接口清单
- `boss-api-agent-cli.md` — boss-agent-cli 接口与风控（两参考冲突处已标注）
- `ecosystem-notes.md` — 生态速记（dsh-iab 双半边模式、webview=Electron 实证）

## 架构结论（对项目核心问题的回答）

1. **插件形态**：单包双半体（dsh-iab 模式）——Host 半体（Node，`defineTool` 注册 boss_* 工具 + webServer 路由）+ Client 半体（`window.__ModuleLoader__.load`，slot 注册右侧栏面板 + 工具卡片）。bundle = `dsh.bundle.patch` + `engines.dsh`。
2. **webview（仅桌面）**：官方通道 `DesktopBrowserBridge.acquire(workspace)` → lease+partition → 自建 `<webview src="about:blank#lease">` → `loadURL('https://www.zhipin.com/...')`。用户在内人工登录/过验证。
3. **Web 降级**：探测 `window.dshDesktop?.browser`（官方 Next/Beta 及同构壳）或 `dshDesktop?.protocolVersion === 1`；不存在（Web 版、Stable 壳）→ 降级为"手动导入 Cookie"（Copy as cURL / 粘贴）+ 纯工具模式，参照 boss-agent-cli 的 curl-file 路径。BOSS 有 X-Frame-Options，iframe 路线基本不可行（待实测确认）。
4. **Cookie 采集**：`webview.executeJavaScript('document.cookie')` 收割非 HttpOnly（`__zp_stoken__` 按两个参考的实现均非 HttpOnly，可拿）；HttpOnly（wt2 等疑为）不可拿 → 备选：guest 内同源 fetch 代发高风险写请求（boss-agent-cli 已验证模式，页面 JS 自维护 stoken）+ Node 侧读类接口重放。**wt2 是否 HttpOnly 需真机实测**（决定纯 Node HTTP 的可行性边界）。
5. **业务 HTTP**：Node 侧 undici/fetch（HTTP/2），接口表以 boss-agent-cli（较新）为准、boss-cli 补充；两参考冲突处（搜索 GET/POST、greet GET/POST、detail securityId/encryptJobId）做成可配置 + 真机实测定稿。
6. **投递安全**：`tools/pre-execute` 返回 `ask` 走官方 approval UI（人工确认）；SQLite 去重账本（account+job_id+security_id）；dry-run 默认；批上限；风控码（31/32/35/36/37）即停 + 本地熔断锁；throttle ≥30-60s 高斯 + 突发惩罚 + 每分钟预算。
7. **长任务**：`ctx.jobs.start()` 后台 job 跑批量投递，工具返回 canonical 句柄。

## 开放问题 / 待办

- [ ] 真机实测：搜索/greet/detail 的 method 与参数现状；wt2 HttpOnly 与否；BOSS iframe 嵌入（X-Frame-Options）
- [ ] Node 升级到 ≥24.9（官方 CLI 硬要求；本机 22.23.3）
- [ ] 确认用户手上的 "DSH Desktop Electron 壳" 具体是哪家（官方 apps/desktop / dataelement / hairyf / anywhere-labs）——影响 `browser` 桥探测写法（官方 Stable preload 无 browser 成员）
- [ ] 用户所说 "deepseek-hermes 官方客户端" 已确认为 deepseek-ai/deepseek-harness（Hermes 是另一 agent，生态兼容）

## 网络与环境备忘（本机）

- github.com:443 直连阻断；`gh-proxy.com` 镜像可用（clone 时 `--config http.proxy=""` 绕开全局代理 17890——该代理当前不通）
- api.github.com 直连 200（搜索 API 可用）
- npm registry 正常
- **用户已在用官方 DSH Desktop**（`~/.dsh` 有 desktop profile、electron-user-data、recovery，11 月活跃）——M3 webview 可在真实桌面端验证
- Node 24.9.0 已手动装入 `H:\Program Files\nvm\v24.9.0`（nvm install 假成功，zip 手动解压）；`nvm use` 需管理员，未全局切换
- 官方 CLI 已装在 24 空间：`dsh 0.2.2-rc.1`；项目内 `./dev.sh` 用 PATH 前置方式调用（不动全局 node 22）
- `dsh web` 的 `--patch` 是启动器层 flag：`dsh --profile web --no-open --patch <yml>`（放 app 名后会被 web app 拒绝）
