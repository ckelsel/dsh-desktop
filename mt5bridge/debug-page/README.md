# debug-page

纯静态 MT5Bridge 调试页：单文件 `index.html`，零依赖，连**网关 SDK 面**
`ws://127.0.0.1:18860`（网关须先启动，见 `../gateway/`）。

## 打开

```text
node serve.mjs          # → http://127.0.0.1:18999
```

浏览器打开 `http://127.0.0.1:18999`，页面加载后自动连接。

**不要直接双击 index.html**：Chrome 对 `file://` 页面的 WebSocket 会静默挂起
（无 onerror，2026-11-14 实测），页面 4s 后会提示改用 serve.mjs。

功能：方法浏览器（system.capabilities 加载）/ 任意 RPC 调用器（多终端时
params 里可加 `"terminal_id": "…"` 指定路由）/ 事件流（seq 断档高亮 +
system.resync 按钮；事件带 terminal_id）/ 账户与持仓（含平仓）/ 订阅管理 /
demo 下单 / 行情快照。token 在顶栏输入，自动拼 `/?token=`。

## 测试脚本（Node ≥ 18，`npm i ws` 一次；网关须在跑）

| 脚本 | 覆盖 | 行情依赖 |
|---|---|---|
| `smoke-test.mjs` | hello（终端清单）/ account.get / market.quote / capabilities | 否 |
| `trade-test.mjs` | execute → in deal → status 回填 → close → out deal | **需开市** |
| `market-test.mjs` | subscribe → tick 流 → market.book → unsubscribe | **需开市** |
| `resync-test.mjs` | seq 单调 / resync 重建快照 / SDK 重连 seq 延续 | **需开市**（含开平仓） |
| `sub-lifecycle-test.mjs` | subscribe→挂图EA→registered→refs=1→unsubscribe→拆图→表空 | 否 |
| `gateway-restart-test.mjs` | 网关杀→重启：SDK 断线重连→终端恢复（hello 快照或 event.terminal，二者竞态）→RPC 探活 | 否（杀/重启网关由外部编排） |
| `scan-symbols.mjs` | symbol.list 全量→并发 quote 找活跃品种（换服务器后找周末行情用） | — |
| `tester-test.mjs` | 策略测试器回放：双终端路由/账户隔离/tick 推流/开平仓（见下方编排） | 否（回放=行情源） |
| `trade-suite-tester.mjs` | 交易域 13 方法全套（分 `PHASE=A/B` 两段各配一次回测）：市价链/挂单链含穿越成交/并发/历史/错误路径 | 否（回放撮合） |
| `verify-page.mjs` | CDP 端到端：headless Chrome 打开页面，断言自动连接 + 方法加载 | 否 |

### 策略测试器回放（休市日行情/交易链路测试）

`BridgeTesterEA`（合体 Service+Market，OnTick=历史回放推流，OnTimer=RPC 单步切片）
跑在测试器 agent 里，DLL 拨号网关成为第二个终端（terminal_id 含 `\Tester\`，
与真实终端并存——顺带实测多终端路由）。编排三坑：

1. **DLL 权限**：agent 不继承终端全局设置，改 `config/common.ini` 的
   `AllowDllImport=1`（默认 0 会报 `DLL loading is not allowed`）后重启终端。
2. **/config 路径**：Git Bash 的 MSYS 转换会把 `/config:"H:/..."` 截成 `H:\`，
   必须用 PowerShell `Start-Process ... -ArgumentList '/config:"..."'` 启动。
3. **时序**：回测窗口约 2 分钟（EURUSD 两周 real ticks），测试脚本要**先在场**
   监听，再重启终端触发回测；agent 的 `connected` 广播与 hello 快照两路都认
   （同 gateway-restart-test 的竞态契约）。

回放测试的固有边界（实测）：

- **快照残留**：hello.terminals 里可能有上一轮回测的已死 agent（网关表未清），
  认到终端先以 tick 探活（10s 无 tick 即丢弃等新 agent 的 connected 事件）。
- **回测时钟速度不可控**（数据段密度决定）：快时全部 RPC 毫秒级回包，慢时
  4-8s/步——全局超时给足（230s），交易类操作尽早。
- **事件两级衰减**：deal 事件走 conflation 队列，同拍批量成交合并为单事件；
  回放尾部交易后若无 OnTimer 拍点，事件随 EA 卸载丢失（真实终端 Service
  常驻无此问题）。对账以 `history.deals` 权威账本为准。

```powershell
# 1) 改 AllowDllImport=1（首次）+ 写 bridge-tester.ini（[Tester] 段，ShutdownTerminal=0）
# 2) 起 tester-test.mjs / trade-suite-tester.mjs（在场监听）
# 3) 重启终端带配置，回测自动跑：
Stop-Process -Name terminal64 -Force; Start-Sleep 3
Start-Process "H:\Program Files\MetaTrader 5\terminal64.exe" -ArgumentList '/config:"<bridge-tester.ini 绝对路径>"'
```

`verify-page.mjs` 用法（需先起 serve.mjs）：

```powershell
Start-Process "H:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList `
  '--headless=new','--disable-gpu','--remote-debugging-port=19222',
  "--user-data-dir=$env:TEMP\chrome-cdp-verify",'about:blank'
node verify-page.mjs
```
