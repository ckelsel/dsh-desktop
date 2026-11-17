# MT5 Bridge 消息流

## 1. Envelope（全链路唯一报文格式）

JSON-RPC 2.0 + 两处扩展（多终端时 `params.terminal_id` 供 SDK 指定路由目标，可省略；`seq` 仅事件）：

```jsonc
// 请求（SDK → DLL → MQL5）
{ "jsonrpc": "2.0", "id": "c1-42", "method": "market.quote",
  "params": { "symbol": "EURUSD" } }

// 响应（MQL5 → DLL → SDK）
{ "jsonrpc": "2.0", "id": "c1-42", "result": { "symbol": "EURUSD", "bid": 1.10517 } }

// 错误（code=JSON-RPC int；data.name=桥稳定字符串码）
{ "jsonrpc": "2.0", "id": "c1-42",
  "error": { "code": -32002, "message": "market component not found",
             "data": { "name": "MARKET_NOT_FOUND" } } }

// 事件（无 id；seq 由 DLL 按网关会话注入，单调递增；网关透传给 SDK 并附 terminal_id）
{ "jsonrpc": "2.0", "method": "event.market.tick", "seq": 104857,
  "params": { "symbol": "EURUSD", "bid": 1.10517, "ask": 1.10519, "terminal_id": "..." } }
```

连接建立后：

- DLL→网关（终端面 18850，**裸 TCP + NDJSON**，首行 hello 带 token）：
  `{ "role": "SERVICE", "terminal_id": "...", "version": "0.4.0", "token": "..." }`
  + 组件清单重放 + `event.resync_required`（重连时）
- 网关→SDK（SDK 面 18860，WS）：

```json
{ "jsonrpc": "2.0", "method": "bridge.hello",
  "params": { "role": "GATEWAY", "version": "0.3.0",
              "terminals": [{ "terminal_id": "...", "role": "SERVICE", "components": [...] }] } }
```

**SDK 重连恢复语义**（网关重启后实测，2026-11-14）：DLL 重连广播与
SDK 重连的先后在网关事件循环里是竞态——DLL hello 先到则 `event.terminal(connected)`
先于 SDK 入 `sdkConns`（广播丢失）；SDK 先连则 hello 快照时终端尚未注册
（快照为空）。因此 SDK 恢复判定必须认两路信号：**重连后 `bridge.hello`
的 `terminals` 非空，或收到 `event.terminal(connected)`**，任一到达即触发
重同步（拉订阅/持仓/账户）+ RPC 探活。hello 是快照基线，事件是增量。

## 2. 流程一：同步请求（market.quote）

```text
SDK ──WS 18860──▶ 网关（terminal_id 缺省选 SERVICE 终端；gid 关联还原 id）
                ──TCP/NDJSON 18850──▶ 终端 DLL 读线程
                    · 校验 envelope（id/method 必备，params 不解析）
                    · rid=1001 → pending[1001]=(conn,gid,now+30s)
                    · 改写 id=1001 → SERVICE 入站队列
                 Service 循环 ≤2ms 后 Bridge_Poll 取出
                 Dispatcher → MarketHandler.GetQuote → SymbolInfoTick
                 RpcWriter 编码 → Bridge_Reply
                 读线程侧路由：pending[1001] 还原 id=gid → conn 出站队列
                 写线程 ──WS──▶ 网关还原 SDK id ──WS──▶ SDK
延迟预算（本机）：WS 收发 ~0.2ms ×4 + 唤醒 1~5ms + Handler ~1ms ≈ 5~10ms
```

## 3. 流程二：行情事件（event.market.tick）

```text
MT5 价格跳动 → MarketEA.OnTick（推送触发，与轮询无关）
             → TickPublisher 编码 → Bridge_Emit(CONFLATED, key="EURUSD")
             → Runtime 出站队列：同 symbol 旧 tick 被覆盖
             → 会话写线程（网关会话 seq）──TCP──▶ 网关注入 terminal_id
             → 扇出全部 SDK 连接 ──WS 18860──▶ 订阅客户端
延迟预算：桥接层 < 2ms
seq 断档（如 100→103，按 terminal_id 分组）→ SDK 调 system.resync 重建快照
```

## 4. 流程三：交易闭环（trade.execute，实测验证的形态）

```text
SDK: trade.execute {action, symbol, volume, ..., idempotency_key}
  → Service: OrderCheck 预检（可选前置 trade.preview 已做）
  → OrderSendAsync —— 发出即返回（不等服务器！）
  → 响应 { "status": "accepted", "request_id": <uint> }   ← deferred 语义
  → Service TradeWatcher 每 ~20ms 轮询对比：
       新订单   → event.order.changed   {order, state, ...}
       新持仓   → event.position.changed
       新成交   → event.deal.added      {deal, profit, ...}
       账户变动 → event.account.changed {balance, equity, ...}
  → SDK 据 request_id/订单号 关联 Promise 终态或走 onTrade 回调

规则：
  · 超时 ≠ 取消：SDK 只能 trade.status 对账，绝不自动重发
  · idempotency_key 防超时重试重复下单（映射 order.comment，注意长度受限）
  · 同步 OrderSend 全链路禁用（实测阻塞 61s）
```

## 5. 流程四：订阅生命周期

```text
SDK: market.subscribe {symbol, period?, events:["tick","bar","book"]}
  → Service SubscribeHandler
       引用计数 +1（同 symbol+period 复用已有图表）
       无图表 → ChartOpen(隐藏) + ChartApplyTemplate(BridgeMarket.tpl)
       → MarketEA OnInit → Bridge_Register(MARKET, instance_key=symbol)
       → Runtime M 广播 event.component {type:"registered", symbol}
  → 响应 { "subscription_id": "EURUSD:M1", "status": "ready" }

SDK: market.unsubscribe {symbol, period?}
  → 引用计数 -1 → 归零 → ChartClose
  → event.component {type:"unregistered"}

崩溃自愈（Watchdog，~2s 周期）：
  subscriptions 记录 vs 实际注册组件对账 → 缺失则重开图表重挂
```

## 6. 请求方法 → 延迟分级

| 级别 | 方法 | 预期（本机桥接层） |
|---|---|---|
| fast | account/terminal/symbol/quote/position.list/order.list | 3~8ms |
| trade | trade.preview / trade.execute | 3~10ms（不含服务器往返） |
| slow | market.bars(大区间) / market.ticks / history.* | 数百 ms~数秒，SDK 异步处理 + 分页 |
| sub | market.subscribe / unsubscribe | 50~500ms（开图表挂 EA） |

## 7. 错误模型（三层）

```text
1. JSON-RPC 标准层：-32700 parse / -32600 invalid / -32601 method
2. 桥层 -32000..-32099（errors.yaml 全表）：
   -32000 QUEUE_FULL          入站队列满（立即拒，不排队）
   -32001 SERVICE_NOT_READY   Service 未注册/已下线
   -32002 MARKET_NOT_FOUND    无该 symbol 的 MarketEA
   -32003 REQUEST_TIMEOUT     pending 超时（状态未知，勿重发交易）
   -32004 INTERNAL            桥内部错误
   -32005 COMPONENT_OFFLINE   组件心跳超时（V2）
3. MT5 业务层：result.error.data 携带 retcode/retcode_description/order
```

## 8. 已知限制（诚实清单）

```text
① MQL5 单线程执行：Service 一次一条请求。slow 方法（history 大查询）
   会让后续请求排队数百 ms。演进：拆第二个 QueryService 实例，协议不变。
② 交易事件为轮询对比（~20ms 粒度），非 OnTradeTransaction 推送。
   UI 展示足够；若需毫秒级推送，预留极薄 TradeEventEA 补充（协议位置已留）。
③ demo 服务器往返可达 15~60s，属网络问题；桥本身不等服务器（async）。
④ CopyTicksRange 强阻塞：market.ticks 服务端强制 ≤2 小时窗口分页。
```
