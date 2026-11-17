# MT5Bridge 开发计划

> 新架构 V2。旧版 MT5LocalBridge 保留只读，不再维护。

## 阶段

- [x] P0 需求与能力实测（Service 交易 API / 盘口边界 / 阻塞实测，3 个 spike）
- [x] P1 文档定稿：REQUIREMENTS / ARCHITECTURE / MESSAGE_FLOW
- [x] P1 协议冻结：contracts/registry.yaml + errors.yaml + envelope.md
- [x] P2 Rust DLL（WebSocket 服务端反转）
  - [x] websocket.rs 握手/帧编解码（sha1+base64 零依赖）
  - [x] session/queue/router：rid 关联、分级出站、conflation、超时
  - [x] ffi.rs 新 ABI（instance_key / queue_class）
  - [x] cargo check / release build 通过（仅 serde_json 依赖）
- [x] P3 MQL5 Service 侧
  - [x] Rpc/ 编解码层（Json/RpcReader/RpcWriter/RpcEventWriter）
  - [x] Core/ServiceLoop + Dispatcher
  - [x] Handlers 全量（system/account/symbol/market/position/order/history/trade/subscribe）
  - [x] Events/Watchers（account/position/order/deal 轮询对比 + journal 回填）
  - [x] MetaEditor 编译 0 error（BridgeService.ex5）
- [x] P4 MQL5 MarketEA 侧
  - [x] BridgeMarketEA + Market/Tick|Bar|BookPublisher
  - [x] Templates/BridgeMarket.tpl
  - [x] 编译通过（BridgeMarketEA.ex5）
- [x] P5 实机联调（spike 验证同环境，2026-11-13 全部通过）
  - [x] 18850：查询全通 + demo 开平仓闭环（OrderSendAsync，trade-test PASS）
  - [x] subscribe → tick/bar/book 事件流 → unsubscribe 关图表（market-test PASS）
  - [x] 慢客户端背压：RELIABLE 溢出断开 / CONFLATED 覆盖（队列级测试固化；e2e 场景留 P8）
  - 注：联调中发现并修复 Windows accept 非阻塞继承 bug（WSAEWOULDBLOCK）；
    推翻 C9（DLL 单模块单 Runtime）→ 架构简化为单端口 18850
- [x] P6 debug-page（纯静态 WSS 调试页，2026-11-14）
  - [x] index.html 单文件三栏：方法浏览器 / 事件流（seq 断档高亮 + resync）/ 状态面板（账户·持仓平仓·订阅·demo 下单）
  - [x] serve.mjs 零依赖静态服务（Chrome 对 file:// 页面的 WS 静默挂起，须走 http）
  - [x] CDP 端到端验证 PASS（verify-page.mjs：自动连接 + 26 方法加载 + 账户 RPC 渲染）
- [x] P7 Watchdog 自愈 + system.resync 断档恢复实测（2026-11-13）
  - [x] resync-test PASS：seq 单调 / 断档 → resync_required → resync 全字段重推 / 重连重置
  - [x] MQL 侧 BridgeEnsureComponent（PeekSize==-2 自动重注册）；DLL 侧孤儿图表清理
- [x] P8 V2 项（2026-11-14；TradeEventEA 未做，见下）
  - [x] mt5bridge.ini（bind/port/token；env > ini > 默认）+ ini.example
  - [x] token 认证（WS 握手 `?token=`，不匹配 401）
  - [x] 组件失活自愈：DLL 300s 无 Poll 清理 + 广播 unregistered，全失活关停 Runtime
  - [ ] TradeEventEA（毫秒级交易推送，可选——TradeWatcher 200ms 轮询已覆盖，暂不做）

## P9 方向反转：DLL = client 拨号网关（2026-11-14 决策）

背景：消费方 dsh-desktop（Electron）按"多终端拨号汇聚到中心"部署；
老 DshBridge 因 "MQL5 sockets cannot listen" 被迫 EA 拨号，本桥 DLL 是
Rust 原生代码无此限制，但按部署形态仍反转为 client。

**不变**：contracts 协议层（JSON-RPC + seq + 事件 envelope + 错误码）、
MQL 全部代码与 ABI（Register/Poll/Reply/Emit）、组件模型、rid 关联、
conflation/RELIABLE 队列、失活清理。

- [x] P9a DLL client 网络层（native/mt5bridge，2026-11-14）
  - [x] 握手发起方：生成 Key、校验 Accept、`?token=` 上报（sha1/base64 复用）
  - [x] 帧掩码编码（client→server 帧必须掩码；解码已有）
  - [x] accept 线程 → 连接线程（connect + 指数退避重连 1s→15s；网关可后启动）
  - [x] 连上即发 hello（terminal_id/role/version）；断线组件注册表保留，
    重连成功重发组件清单 + 广播 resync_required
  - [x] 30s 无入站（ping/pong 15s 周期）判定半开，断开重连
  - [x] ini 键变更：bind/port → gateway_host/gateway_port（token 保留）
  - [x] ServiceLoop / BridgeMarketEA 的 bind FATAL 自检移除
  - [x] Rust 集成测试 4 项全绿（含阶段 D 重连：清单重放 + resync_required + 401）
- [x] P9b 网关参考实现（gateway/，Node + ws，2026-11-14）
  - [x] 双监听：终端面 18850（token 校验，hello 建会话）/ SDK 面 18860
  - [x] 终端会话表：terminal_id → 连接；同 id 重连顶替；event.terminal 广播
  - [x] MARKET_METHODS 终端级路由（DLL 内组件级路由不变）；params.terminal_id 指定
  - [x] gid↔id 双层关联 + 30s 超时；事件扇出注入 terminal_id
  - [x] 单测 10 项全 PASS（token 401 / hello / RPC 往返 / 路由 / 事件 / 断开）
- [~] P9c 测试迁移与实机重跑（2026-11-14 周六：行情休市，交易/订阅类留待交易日）
  - [x] smoke-test PASS（SDK→网关→DLL→MQL：hello=终端清单、account.get 33ms、26 方法）
  - [x] verify-page（CDP 调试页）PASS
  - [x] 4 个 mjs 脚本 + debug-page 迁到 SDK 面 18860；resync-test seq 断言语义更新
  - [x] sub-lifecycle-test PASS（不依赖行情：subscribe→挂图EA→registered→refs=1→拆图→表空）
  - [x] gateway-restart-test PASS（网关杀→重启：SDK 断线重连→终端恢复→RPC 探活通）。
    实测竞态：DLL 广播与 SDK 重连谁先入网关事件循环不定 → event.terminal 可能丢，
    hello.terminals 快照是恢复基线——两路信号都触发重同步（SDK 实现姿势，P9d 沿用）
  - [x] 品种全量扫描（12158 个）：周末 0 活跃，确认休市影响面
- [x] P9f 策略测试器回放测试通道（2026-11-14 休市日落地）
  - BridgeTesterEA：Service+Market 合体（测试器 agent 只能跑单 EA、OnTimer≥1s、
    图表不加载 EA）；OnTick=历史 tick 回放推流，OnTimer=RPC 单步切片
  - agent data path 含 \Tester\ → 天然独立 terminal_id，与真实终端并存
    （多终端路由/账户隔离同场实测：同 login，回测视图 balance=10000 vs 真实 99999.22）
  - tester-test PASS：双终端路由 / account 隔离 / tick 推流 / execute→成交→
    position→close 全链路（36s，EURUSD 两周 real ticks 回放）
  - 坑：common.ini AllowDllImport=1（agent 不继承全局）；/config 须 PowerShell 起
    （MSYS 截断）；回测窗口 ~2min，测试脚本先在场。编排详见 debug-page/README.md
  - [2026-11-14 晚] 1:1 假想市场闭环（dsh tester 变体 3/3 + 下单探针秒级全链）：
    - BridgeTesterEA OnTick 也抽干 RPC（原仅 OnTimer）：1:1 回放下 OnTimer 每模拟秒
      一轮且被视觉流挤压，agent RPC 曾积压 30s+ 撞 DLL REQUEST_TTL(30s,
      router.rs)——"request timed out; outcome unknown" 是 DLL 侧回的，不是网关；
      OnTick 抽干后稳态 RPC 2-3s（真实终端 10ms 量级）
    - 测试启动头 1-2 分钟是重载窗口（tick 预处理+视觉流建立），RPC 仍可能 30s+，
      探活/重试要容忍
    - /config 自动启动速度不保证 1:1（MT5 记住上次 GUI 拖的速度；无 tick 死区快进
      使进度%不可用于估速）；速度滑条无 ini 键，1:1 只能 GUI 拖并确认。1:1 下应答
      延迟=下一笔行情间隔（安静 1-3s/活跃 <1s），本质是测试器沙箱只在喂 tick 时
      唤醒 EA；查价类可走网关缓存优化（待办），下单/账户类必须等引擎唤醒
    - market.bars 锚点钳 TimeCurrent()：agent 的墙钟 to（SDK Date.now()）越过
      回放头不再 4401
    - 下单全链秒级：execute→accepted(3s)→position/deal/account 事件同秒→
      trade.status filled→position.list；成交时间戳=回放模拟钟
    - agent journal 缓冲写，运行中看不到；进程级事实看 %TEMP%\mt5bridge-dll.log
      （register/stale 行，pid 区分进程；COMPONENT_STALE_MS=300s 无 Poll 即踢）
    - gateway REQUEST_TTL_MS 支持 BRIDGE_REQUEST_TTL_MS env 放宽（默认 30s 不变；
      注意 DLL 侧 30s 才是回放场景的硬界，env 只救网关层）
  - [ ] market.book 盘口（回放不模拟盘口）与 subscribe/挂图（测试器图表无 EA）
    仍依赖真实开市——周一跑 market-test / resync-test
- [x] P9g 挂单能力 + 交易域 13 方法全套实测（2026-11-14 回放通道）
  - TradeHandler：action 扩展 buy_limit/sell_limit/buy_stop/sell_stop
    （TRADE_ACTION_PENDING，price 必填校验 -32055）；preview/execute 同步支持
  - trade-suite-tester（PHASE=A/B 两段各配一次回测）双 PASS：
    - A 市价链（execute/status/modify SL·TP/部分平仓 ticket 不变）+
      挂单链（挂/order.list/改价/撤/**穿越成交 @1.12029 转持仓**）
    - B preview 双向（retcode 10019 No money）/5 连发并发/history 对账
      （deals 15 条权威账本）/错误路径（坏品种/action/ticket/volume 全拒）
  - 记录：idempotency_key 当前无服务端去重（同 key 各成单，观察项）；
    hedging 账户形态（5 连发=5 条独立持仓）
- [x] P9h Node SDK 独立包 + dsh 进程内宿主换装（2026-11-15）
  - node-sdk（mt5bridge@0.1.1，四笔）：e17f225 账户中心 API（Mt5Bridge.start
    进程内开终端面，一次登录=一个 Account{market,trading}，FakeTerminal 真 TCP
    测试）→ b01e9c6 通道补齐（盘口/preview/status 对账/sessions/订阅表/
    state.snapshot 全量）→ b1c0081 onRawEvent（外接运行时拿带 seq 的原始事件流）
    → b3f0032 **idle 时钟 bug 修复**（face 只在连接时 arm 一次 30s 空闲钟，
    健康终端心跳也 30s 必断——dsh 实测抓到，DLL 每 30s 重连循环；任意入站行续命）
  - dsh 换装（feat/trading-workspace 两笔）：af3be0ce83 sdk-link.ts
    （Mt5SdkLink 与 Mt5GatewayLink 同接口面，后端进程内 SDK；runtime 加
    Mt5LinkPort 注入口，探活/sync/订阅冲刷/事件折叠实战逻辑全保留；
    **P9d-2 落地**：trade() 五请求映射 + historyTrades()；vendor tgz 交付）
    → 75b4dc60fe 0.1.1 升版
  - [2026-11-15] 周末回放假市场端到端实测（CDP 驱动 dsh Electron）：
    老网关 mjs 退役 → 18850 单宿主移交 dsh 主进程 → MT5 DLL 自动重连
    （全组件重注册）；探针全绿：phase=ready / 15 品种目录 / tick 种子+推流
    （UI 自选列表实时跳动、EURUSD 详情卡今开/昨收/日内区间全有值）/
    system.status 应答；**bars 4401 二次现场**：to+count 分支
    CopyRates(start,count) 实为"锚点向后取"，钳到回放前沿后必空 →
    双时间区间 + 截尾（9b9198d），agent 回放出图
  - [2026-11-15 终局] TradingView 端到端闭环：修复后重启 dsh，蜡烛图渲染
    成功（红绿蜡烛+成交量柱+当前价线，与自选列表实时价一致，数据缺口
    红叹号消失）。UI 事实：图表首次加载失败（当时 bars 仍 4401）后
    TradingView 不自愈——datafeed 的 resetData 只由活跃数据流触发，首屏
    失败连订阅都没建；resize 无效，须重启应用或切品种。观察项：重启后
    目录水合只出 EURUSD（上次 15 品种）——回放只喂 EURUSD tick，疑按
    活跃品种过滤，待真实终端复验
  - 部署事实：一台机器只一个 18850 宿主（老网关必须先关，dsh 启动失败自动
    退避重试等端口）；Windows libuv 双方默认 SO_REUSEADDR 允许监听端口
    静默重叠——"端口被占"场景无法用两个 node server 测试，须 mock 启动失败
- [~] P9d dsh main 对接（2026-11-14 落地，dsh-desktop feat/trading-workspace）
  - 桥侧配套：symbol.get 扩展（tick_size/contract_size/volume_limit/stops_level/
    freeze_level/execution_mode/calc_mode/sector/visible/order_modes[]/margin_buy·sell，
    无报价时 margin=null）——dsh Mt5Symbol/Mt5SymbolInfo 全字段对齐
  - 桥侧配套：market.bars 三模式（count=最近 N；from+to=区间；to+count=to 排他前
    N 根锚定版，停盘/未来 to 收敛最近一根）——修复 to+count 原先落入 from=0 区间分支
  - dsh 侧新增 src/mt5/gateway-link.ts（WS 客户端 18860：退避重连/hello 终端表/
    RPC/事件 seq）+ gateway-runtime.ts（状态机，公共面同老 Mt5BridgeRuntime，
    mt5-ipc/renderer 零改动；快照探活+真实终端优先、事件失效 500ms 折叠重拉、
    seq 断档 resync、订阅 diff 成 (symbol,period) 图表键）+ main.ts 直装
    （老 TLS 桥退役不接线）；单测 14 例 + live spec（MT5_GATEWAY_LIVE=1）
  - 实机（周六）：live 2/3 PASS——ready/sync/目录/水合/新 symbol 字段/订阅种子
    quote 全通；historyBars 卡终端环境：journal 16:15 jkl.ex5 profiling 触发
    history download 0% 卡死，HistoryCenter 串行队列阻塞 → CopyRates 全 4401
    （tick 快照不受影响），重启无效。待交易日复验
  - [2026-11-14 晚] dsh 加 terminal 偏好（'real'|'tester'，提交 9b7b6d8728）；
    tester 变体 live 3/3 PASS（26.75s）：ready/symbol 字段/订阅种子 quote/
    回放 tick 流/historyBars（走 agent 自有序列，绕开主终端 HistoryCenter 卡死）
    ——周末下单经回放撮合引擎全链验证（见 P9f）
- [x] P9e 终端面传输简化：WS → 裸 TCP + NDJSON（2026-11-14）
  - 洞察：终端面消费者只有自家 DLL，无浏览器，WS 握手/掩码/分片纯属负担；
    SDK 面保持 WS（调试页/多语言生态）
  - [x] Rust：websocket/sha1/base64 三文件删除，ndjson.rs（readline/writeline，
    8MB 上限）；token 随 hello 首行上报；心跳应用层 system.ping/pong（15s），
    30s 无入站断开
  - [x] 网关终端面 net.createServer（内置零包装）+ 行分帧 + AUTH_FAILED 拒绝；
    SDK 面 ws 不变；system.ping/pong 不出网关
  - [x] Rust 测试 5 项全绿（hello 带 token / NDJSON 往返 / 重连 / pong）；
    网关单测 10 项全 PASS（含 AUTH_FAILED）
  - [x] 实机 smoke PASS（account.get 33ms→19ms）

## 产物

```text
mt5bridge.dll + mt5bridge.ini.example   ← native/mt5bridge（cargo build --release）
BridgeService.ex5 / BridgeMarketEA.ex5 + BridgeMarket.tpl ← mql5/
debug-page/（index.html + serve.mjs + 测试脚本，见其 README）
```

## 纪律

1. 不频繁编译测试：按阶段批量验证（用户要求）
2. JSON 只出现在 mql5 Rpc/ 四文件；DLL 只解析 envelope
3. registry.yaml 为能力唯一账本，改能力先改它
4. 旧仓库 MT5LocalBridge 不再改动
