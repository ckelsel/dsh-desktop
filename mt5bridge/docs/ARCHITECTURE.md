# MT5 Bridge 架构

## 1. 运行形态（P9：DLL=client，网关汇聚）

```text
 MT5 终端 A 进程                     MT5 终端 B 进程
┌──────────────────────────┐      ┌──────────────────────────┐
│ BridgeService + EA×N     │      │ （多账户=多终端实例）      │
│   #import ABI            │      │                          │
│ DLL Runtime（client）    │      │ DLL Runtime（client）    │
└───────────┬──────────────┘      └───────────┬──────────────┘
            │ 裸 TCP + NDJSON（hello 带 token）    │
            ▼                                 ▼
┌──────────────────────────────────────────────────────────┐
│ 网关 gateway/（Node）                                     │
│  终端面 :18850 ← DLL 连入（hello 建终端会话，组件清单）     │
│  SDK 面  :18860 ← SDK/调试页连入（hello=终端清单）          │
│  终端级路由 + 事件扇出（注入 terminal_id）                  │
└───────────┬──────────────────────────────────────────────┘
            │ WS
   SDK / dsh-desktop(Electron main) / debug-page
```

- 终端面传输 = **裸 TCP + NDJSON**（帧 = 一行 JSON + `\n`）：该段消费者只有
  自家 DLL，无浏览器，WS 的握手/掩码/分片纯属负担。token 随 hello 首行上报，
  不匹配网关回 `AUTH_FAILED` 后断开。SDK 面保持 WS（调试页/多语言生态）。
- DLL 在终端进程内主动拨号网关（断线指数退避重连，网关可后启动）；
  MQL 侧 ABI / 组件模型 / 队列分级 / rid 关联与传输无关，全部沿用。
- 重连成功：hello + 组件清单重放 + 广播 `event.resync_required`（SDK 重建快照）。
- 心跳应用层 `system.ping`/`system.pong`（15s）；30s 无任何入站判定半开，断开重连。
- 终端级路由在网关：`params.terminal_id` 优先；`market.book` → 有匹配
  symbol MARKET 组件的终端；其余 → 有 SERVICE 组件的终端。
  终端内 SERVICE/MARKET 组件路由在 DLL（`MARKET_METHODS`），不变。
- EA 上下线经 event.component 广播；终端上下线经 event.terminal 广播。

## 2. 代码目录

```text
MT5Bridge/
├── contracts/                      ← 协议唯一源头（先冻结）
│   ├── registry.yaml               ← method → target → handler → MT5 API
│   ├── envelope.md                 ← JSON-RPC + seq 扩展
│   └── errors.yaml                 ← 三层错误码
├── mql5/
│   ├── Services/BridgeService.mq5  ← 入口：OnStart 常驻循环
│   ├── Experts/BridgeMarketEA.mq5  ← 入口：事件推送
│   ├── Templates/BridgeMarket.tpl  ← Service 挂 EA 用模板
│   └── Include/Bridge/
│       ├── Abi/BridgeApi.mqh       ← 只含 #import
│       ├── Rpc/                    ← ★ JSON 编解码唯一层，别处禁止拼 JSON
│       │   ├── Json.mqh            ← 通用 JSON 解析器（移植自旧版）
│       │   ├── RpcReader.mqh       ← 请求 envelope → 参数读取
│       │   ├── RpcWriter.mqh       ← MQL5 结果 → 响应 envelope
│       │   ├── RpcEventWriter.mqh  ← MQL5 数据 → 事件（含 seq 透传）
│       │   └── RpcErrors.mqh       ← 错误 envelope
│       ├── Core/
│       │   ├── Dispatcher.mqh      ← method 字符串 → Handler 分发
│       │   ├── ServiceLoop.mqh     ← 收发主循环 + 生命周期
│       │   └── Watchdog.mqh        ← MarketEA 掉线检测重挂
│       ├── Handlers/               ← 只碰 MQL5 类型与 MT5 API
│       │   ├── SystemHandler.mqh   AccountHandler.mqh
│       │   ├── SymbolHandler.mqh   MarketHandler.mqh
│       │   ├── TradeHandler.mqh    PositionHandler.mqh
│       │   ├── OrderHandler.mqh    HistoryHandler.mqh
│       │   └── SubscribeHandler.mqh
│       ├── Events/
│       │   ├── AccountWatcher.mqh  ← 轮询对比账户字段 → 事件
│       │   └── TradeWatcher.mqh    ← 轮询对比持仓/订单/成交 → 事件
│       ├── Market/                 ← MarketEA 专用
│       │   ├── TickPublisher.mqh   BarPublisher.mqh
│       │   └── BookPublisher.mqh
│       └── Chart/ChartManager.mqh  ← 订阅→图表→模板→EA 生命周期
├── native/mt5bridge/               ← Rust DLL（TCP client，NDJSON）
│   ├── include/mt5bridge_abi.h
│   └── src/
│       ├── ffi.rs                  ← C ABI（Register/Poll/Reply/Emit）
│       ├── ndjson.rs               ← 终端面传输：一行 JSON + '\n'（读/写）
│       ├── envelope.rs             ← JSON-RPC envelope（只碰 id/method）
│       ├── router.rs               ← rid 登记 / 还原 / 分发出站
│       ├── queue.rs                ← 组件入站队列 + 连接出站队列（含 conflation）
│       ├── session.rs              ← 连接会话 + pending 表 + 超时
│       └── runtime.rs              ← 全局 Runtime、拨号重连、线程编排
├── gateway/                        ← Node 网关（终端面 + SDK 面）
│   ├── gateway.mjs / test.mjs
│   └── gateway.ini.example
├── debug-page/                     ← 纯静态 HTML，连网关 SDK 面
└── docs/
```

## 3. 线程模型（全双工无阻塞的核心）

```text
每个终端进程的 DLL Runtime 内（P9：单条网关会话）：

  [连接线程] connect（断线指数退避重连；无握手，连上即会话）
       │ 成功后成为会话读循环
       ▼
  [会话读循环]──请求──▶ 组件入站队列(有界)
                                │ Bridge_Poll() 非阻塞取（O(1)）
                    MT5 Service 线程（唯一串行点）
                    ┌─────────────────────────────┐
                    │ ① 处理请求（全为立即返回调用）│
                    │ ② Watcher 轮询对比(~20ms 周期)│
                    └──────────┬──────────────────┘
                               │ Bridge_Reply / Bridge_Emit
                               │ （memcpy 入出站队列即返回）
                    ┌──────────▼──────────────────┐
                    │ 会话出站队列(有界,分级)       │
                    └──────────┬──────────────────┘
  [会话写线程]◀── NDJSON 行写出（rid 还原 / 事件注入 seq / system.ping）
  [定时器线程]  超时扫描 / WS ping(15s) / 失活清理
```

### 无阻塞四保证

```text
① ABI 层：Bridge_Poll/Reply/Emit 全部 O(1)
   Poll 空队列立即返回；Reply/Emit 只入内存队列，绝不碰 socket
② Service 层：循环内只做立即返回的 MT5 调用
   OrderSendAsync 发出即回（实测）；同步 OrderSend 禁用（实测阻塞 61s）
③ 网络层：每连接读/写线程独立，WS 全双工
   MT5 处理请求的同时事件持续外发，互不等待
④ 背压层：慢客户端只影响自己
   tick 类 CONFLATED（同 symbol 只留最新，覆盖旧值）
   交易/账户类 RELIABLE（有界；溢出=断开该慢客户端并广播 resync_required）
   入站满 → 立即回 QUEUE_FULL，不排队不等待
```

### 队列总表

| 队列 | 有界 | 策略 | 满时行为 |
|---|---|---|---|
| SERVICE 入站 | 1024 | FIFO | 立即回 `QUEUE_FULL` |
| MARKET 入站（每 EA） | 256 | FIFO | 同上 |
| 连接出站 RELIABLE | 512 | FIFO | 断开该连接 + `event.resync_required` |
| 连接出站 CONFLATED | — | 同 key 覆盖 | 无感覆盖（tick 天然可丢旧） |
| pending 表 | — | rid→(conn,id,deadline) | 超时回 `REQUEST_TIMEOUT`；迟到回包丢弃 |

## 4. rid 关联机制（多客户端关键）

```text
SDK 发 {id:"c1-42"}                     → DLL 分配 rid=1001，
                                          pending[1001]=(conn1,"c1-42",deadline)
改写 id 后入组件队列 {id:1001}           → MQL 原样回显 id=1001
DLL 收 Reply(id=1001)                    → 查表还原 id="c1-42"，推回 conn1
```

解决：客户端 A/B 同用 id=1 不冲突；超时/断线的 pending 清理；迟到回包按 rid 丢弃。

## 5. 组件守护（Watchdog）

- Service 每 ~2s 对账 `market.subscriptions` 与 MARKET 注册组件：
  图表被手关 / EA 掉线 → 自动重开图表重挂 EA（复用旧 ChartManager 逻辑）
- MQL 侧自愈：主循环 / OnTimer 首查 `Bridge_PeekSize == -2`（组件已被 DLL 清理）
  → `BridgeEnsureComponent` 自动重注册（P7 实测）
- DLL 侧失活清理：每组件记录 `last_poll_ms`（Poll 刷新）；timer 线程移除
  >300s 无 Poll 的组件并广播 `event.component(unregistered)`；
  组件全部失活 → 关停整个 Runtime（断开网关会话，下次 Register 重建）
- 离线组件的请求立即回错（SERVICE 缺席 `SERVICE_NOT_READY`，MARKET 无匹配
  symbol `MARKET_NOT_FOUND`）；`COMPONENT_OFFLINE`（-32005）保留未用

## 6. MQL5 内部代码纪律

```text
· Handlers/ 与 Events/ 禁止出现 JSON 字符串字面量
· JSON 只允许出现在 Rpc/ 四个文件
· Handler 输入 = MQL5 类型，输出 = MQL5 类型
· 每个 method 在 contracts/registry.yaml 有且仅有一行映射
```

## 7. 配置

`<terminal_data>\MQL5\Libraries\mt5bridge.ini`（与 DLL 同目录；样例见
`native/mt5bridge/mt5bridge.ini.example`）：

```ini
gateway_host=127.0.0.1   ; 网关地址，默认 127.0.0.1
gateway_port=18850       ; 网关终端面端口，默认 18850
;token=change-me         ; 非空则拨号 URL 带 ?token=（网关校验）
```

- 优先级：环境变量 `MT5_BRIDGE_GATEWAY_HOST` / `MT5_BRIDGE_GATEWAY_PORT`
  > ini > 默认值（环境变量仅供测试注入；token 只认 ini）
- 网关自身配置 `gateway/gateway.ini`（terminal_port / client_port / token；
  样例 gateway.ini.example；env `MT5_GATEWAY_*` 优先）
- 修改 ini 需重启终端（DLL 只在 Runtime 创建时读一次）

### 多账户部署

MT5 一个终端进程同一时刻只登录一个账户；多账户同时在线 = 多终端实例
（各自数据目录）。每份终端的 DLL 主动拨号**同一个网关**：

```text
终端 A（账户 1）→ gateway_host:gateway_port
终端 B（账户 2）→ gateway_host:gateway_port
```

- 网关按 hello 的 terminal_id 区分终端（同 id 重连自动顶替旧会话）；
  SDK 用 `params.terminal_id` 指定路由目标，不指定则缺省有 SERVICE 的终端
- 跨机部署：网关机器对外开放终端面 18850（+token），终端机只出不入
- 单终端内切换账户：组件自动重注册，连接不断（同 §5）

## 8. 依赖纪律（Rust）

```text
仅 serde_json（envelope 解析）。
终端面为零依赖手写 NDJSON（一行 JSON + '\n'，无握手），心跳走应用层
system.ping/pong；线程模型 = 连接线程（拨号/重连/读循环）+ 每会话写线程 +
定时器线程。网关（Node）终端面用内置 net，SDK 面依赖 ws。
```
