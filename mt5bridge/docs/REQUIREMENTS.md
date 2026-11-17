# MT5 Bridge 需求定稿

> 定稿日期：2026-11-13。所有能力边界均经实机 spike 验证（MetaQuotes-Demo，build 6318）。

## 1. 目标

```text
把 MT5 Terminal 的全部对外能力，通过 MT5 内部 Service/EA + Rust DLL，
以 WebSocket + JSON-RPC 直接暴露给浏览器端 SDK。
```

**非目标（明确不做）：**

- 不做券商私有 API / MT5 协议替代品
- 不做 HFT 级交易（架构下限：请求唤醒 1~5ms、事件桥接 < 2ms）
- 不引入中间服务器（无 Gateway / Proxy / Bridge Server）
- 不引入二进制业务协议（JSON-RPC 从浏览器直达 EA）

## 2. 组件（仅两个 MQL5 程序 + 一个 DLL）

### 2.1 BridgeService（1 个实例）

```text
职责：
  · 全部 RPC 请求执行：查询 / OrderCheck / OrderSendAsync
  · 轮询对比产生事件：账户变化、持仓变化、订单变化、新成交
  · 订阅生命周期管理：market.subscribe → 开图表挂 MarketEA；
                      market.unsubscribe → 引用清零关图表
线程模型：
  独立线程（Service 天然如此），OnStart 内 Sleep(1) 常驻循环
  → 请求唤醒延迟 1~5ms（实测 Sleep 精度良好）
```

### 2.2 BridgeMarketEA（每 symbol 一实例，仅订阅时存在）

```text
职责：
  · OnTick()      → event.market.tick（推送触发，零轮询）
  · K线变化       → event.market.bar / event.market.bar_closed
  · MarketBookAdd + OnBookEvent → event.market.book
    （盘口订阅是 EA 专属能力，Service 实测不可用）
线程模型：
  挂在 Service 自动开的隐藏图表上，EventSetMillisecondTimer(1000) 仅心跳
```

### 2.3 mt5bridge.dll（Rust）

```text
职责：
  · 网关 gateway/（Node）：终端面 裸TCP:18850（DLL 拨号，NDJSON）+ SDK 面 WS:18860
  · SDK 连网关 SDK 面（ws://127.0.0.1:18860），多终端用 params.terminal_id 路由
  · JSON-RPC envelope 解析（只碰 jsonrpc/id/method，绝不解析业务 params）
  · 请求路由（rid 登记还原；method 集合路由：market.book → EA 组件，其余 → Service 组件）
  · 组件队列、分级出站队列、背压、超时
不做的：
  · 不调用任何 MT5 API（AccountInfo/OrderSend/OnTick 全部在 MQL5 侧）
  · 不实现业务方法
加载边界（实测，2026-11-13 修正）：
  一个 terminal64 进程内 DLL 只加载一份（单一模块 = 单一静态存储 = 单一 Runtime）。
  Service 与 MarketEA 的组件注册进同一 Runtime。
  陷阱：#import 按程序目录优先解析 —— Experts\ 下若残留旧 mt5bridge.dll 会先被
  EA 加载（曾导致 EA 行为与 Service 不一致）。DLL 只允许存在于 MQL5\Libraries\。
```

## 3. 已删除的概念（相对旧版 MT5LocalBridge）

```text
✂️ BridgeControlEA        —— Service 全部接管（本轮实测验证）
✂️ PROXY_HOST 占位图表     —— 仅为承载 ControlEA 而存在
✂️ Node Bridge Server     —— DLL 直接当 WS 服务端
✂️ HTTP + SSE             —— 被 WSS 替代
✂️ BridgeWire 二进制协议   —— JSON-RPC 直达 MQL5
✂️ 同步 OrderSend          —— 实测阻塞 Service 线程 61 秒，全面禁用
```

## 4. 实测硬约束（写入协议与代码）

| # | 实测结论 | 协议/代码体现 |
|---|---|---|
| C1 | Service 可调 OrderCheck/OrderSendAsync，真实成交验证 | `trade.execute` 只走 async，立即返回 `accepted + request_id` |
| C2 | 同步 OrderSend 阻塞 61s（demo 服务器往返慢时） | 禁用；交易事件靠轮询对比闭环 |
| C3 | Service 无任何事件回调（无 OnTradeTransaction/OnTimer） | 交易/账户事件 = Service 轮询对比（10~50ms 粒度） |
| C4 | MarketBookAdd 在 Service 中返回失败；EA 中可用 | 盘口流 target=MARKET，由 MarketEA 承担 |
| C5 | MarketBookGet 在 Service 可读（前提该品种已有订阅） | 盘口快照查询可走 MARKET 通道 |
| C6 | CopyTicksRange 同步阻塞可达分钟级 | `market.ticks` 标记 slow，强制小窗口分页 |
| C7 | Service 可用 SymbolsTotal(12158)/SymbolInfo*/CopyRates/History* | 查询类全走 Service |
| C8 | Service 常驻 while+Sleep(1) 循环不影响终端其他程序 | 官方文档明确 |
| C9 | ~~MT5 为 Service / EA 分别加载 DLL 上下文~~（2026-11-13 修正：早期观测受 Experts\ 残留旧 DLL 干扰） | 实际单模块单 Runtime；`#import` 按程序目录优先解析，DLL 只放 MQL5\Libraries\；单端口设计 |

## 5. 能力矩阵（最终定案）

| 能力 | 执行者 | 通道 | 语义 |
|---|---|---|---|
| terminal/account/symbol 查询 | Service | 18850 | sync |
| market.quote / market.bars | Service | 18850 | sync |
| market.ticks | Service | 18850 | sync，slow，小窗口分页 |
| position/order/history 查询 | Service | 18850 | sync（history 标 slow） |
| trade.preview (OrderCheck) | Service | 18850 | sync |
| trade.execute (OrderSendAsync) | Service | 18850 | deferred：accepted → 事件闭环 |
| trade.status | Service | 18850 | sync |
| market.subscribe / unsubscribe | Service | 18850 | subscription |
| market.book 快照 | MarketEA | 18850（symbol 路由） | sync（EA 1s 轮询入站，~1s 延迟） |
| event.market.tick / bar / bar_closed | MarketEA | 18850 | 推送，CONFLATED(tick) |
| event.market.book | MarketEA | 18850 | 推送，RELIABLE |
| event.account/position/order/deal | Service | 18850 | 轮询对比，RELIABLE |
| event.component（EA 上下线） | DLL | 18850 | 推送 |

## 6. 客户端体验目标

```js
const mt5 = new Mt5Bridge('ws://127.0.0.1:18860');   // 网关 SDK 面：RPC + 全部事件
await mt5.connect();

// 同步语义
const quote = await mt5.call('market.quote', { symbol: 'EURUSD' });

// 订阅语义（Service 自动开图表挂 EA，对用户透明）
mt5.subscribe('EURUSD', { events: ['tick'] });
mt5.on('event.market.tick', t => render(t));

// 交易两段式
const pre = await mt5.call('trade.preview', {...});
const { request_id } = await mt5.call('trade.execute', { ..., idempotency_key });
```

SDK 不暴露：chart.open / chart.close / 挂载 EA / component_id（内部路由细节）。

## 7. 验收标准（第一阶段）

1. 仅启动 BridgeService，SDK 通过 18850 完成全部查询 + 一笔 demo 开平仓闭环
2. subscribe EURUSD 后同一连接收到 tick 流，unsubscribe 后图表关闭、事件停推
3. 慢客户端（不读 socket）不阻塞 MT5：tick 丢弃旧保新，交易事件不丢
4. 断开重连后 seq 断档触发 resync，状态一致
