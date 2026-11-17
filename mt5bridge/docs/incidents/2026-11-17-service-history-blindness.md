# Service 读不到历史库：全品种 CopyRates 4401

> 2026-11-14 首发于周末，2026-11-17 定位并修复（44eaab8 / dsh 侧 6c29392302）。
> 排障过程的诚实记录：症状、走过的弯路、最终根因与修复。目的是同一个坑不踩第二次。

---

### 症状

- dsh 图表加载 K 线永远失败（TV 显示"这里没有数据"，OHLC 全 Ø）；`market.bars` RPC 对**所有品种、所有周期、所有取法**统一返回 `CopyRates failed: 4401`。
- 同一时刻：报价 tick 正常跳动、交易正常、`HistorySelect`（订单/成交）正常、终端自己开的图表**有蜡烛**。
- 重启终端无效；该症状在 11-14（周六）出现过一次，11-16（周一）白天自愈，11-17（周二）盘中复发。

### 走过的弯路（按时间序，均为无效动作）

1. 怀疑周末服务器历史服务停摆 → 等"交易日自愈"（11-17 盘中复发，推翻）。
2. 怀疑 UTC 时差换算把取数窗口算飞 → 内部值打印实测：shift=+2h、`first/last` 落在当前交易时段，全部正确（排除）。
3. 清 `bases/<server>/history/*/cache` + 重启 → 无效。
4. 整个 history 目录改名隔离、从零重建历史库 → 新库下载 772KB 后停滞；服务侧依旧 4401。
5. 怀疑接入服务器（LON vs DE）历史服务差异 → 时间线吻合但无法解释"终端自己图表有数据"，存疑后放弃。

### 根因（双上下文同场实验实锤）

MT5 build 6320：**无图表的 Service 程序看不到 rates 历史库**。同一时刻、同一终端内的对照探针：

| 探测项 | Service 上下文 | EA（图表域）上下文 |
|---|---|---|
| `CopyRates(sym, 任意周期, 0, 5)` | -1 / 4401 | 5 根（own / 同品种异周期 / **异品种** 全部秒读） |
| `SeriesInfoInteger(..., SERIES_SYNCHRONIZED)` | 0 | 1 |
| `Bars()` | 0 | 3473（foreign 品种） |
| `iTime(..., 0)` | 0 | 正常 |
| `SymbolInfoTick` / `HistorySelect` | **正常** | 正常 |

即：Service 视野里序列是空宇宙（连"触发同步"都推不动，进程内 Sleep(50)×4s 持续泵也无效）；任何 EA 挂在任意一张图上就能读**全部品种全部周期**。本周两次"历史卡死"（周六、周二）均为此根因，与 broker 无关。

### 修复（44eaab8 / dsh 侧 6c29392302）

历史读取整体搬到 EA（图表域）：

1. **路由**：`router.rs` 新增 `MARKET_ANY_METHODS = ["market.bars", "market.ticks"]` → `push_market_any()` 挑队列最短的 EA 组件（平票取最小 handle）。与 `market.book` 的按 symbol 精确匹配不同——任意 EA 都能读任意序列，无需匹配。
2. **EA 应答**：`BridgeMarketEA.OnTimer` 增加 `market.bars` / `market.ticks` 分支，复用 `HandleMarketBars/HandleMarketTicks`（`MarketHandler.mqh` 本就共享）。
3. **保活读取图**：`ServiceLoop.ReaderChartEnsure()` 在服务启动（孤儿清理之后）开一张隐藏 M1 图挂 EA，主循环 2s 对账，图表没了就重开。订阅图表全关时由它兜底，保证 `push_market_any` 永远有目标。watchdog 只修订阅表内图表、不管它；孤儿清理只在服务启动时跑（顺序：清理 → 开读取图）。
4. **进程内泵同步**：`CopyRatesPumped()`（Sleep(50)×4s 有界循环）——EA 上下文里惰性序列同步（尤其异周期/冷序列）需要程序持续触碰才推进，跨 RPC 的单发重试泵不动。
5. **网关冷启动重试**：dsh `historyBars` 对 `MARKET_NOT_FOUND` 也进 12s 重试窗口（覆盖终端冷启动时读取图 EA 尚未注册的 1-2s 空窗）。

修复后实测：全品种全周期 bars 正常返回（~1s/次），图表满屏蜡烛、历史与实时同钟连续（UTC 线上约定顺带完成端到端验证）。

### 遗留与观察

- **未解之谜**：11-16（周一）白天同样的 Service 读法曾正常工作。推测"已被图表焐热的数据 Service 可读、Service 自己无法触发同步"，未验证，别依赖此行为。
- `bases/WindsorBrokers1-Demo/history.wedged`：排障时隔离的旧历史库（含 8 年 XAUUSD@ 数据），观察稳定后可删；现行 `history/` 为当天重建的新库。
- 服务重启后首次 sync 偶见 `account.login="0"`（本次长时间未自愈），不影响行情交易，待查。

### 再遇到 4401 时的正确姿势

给 Service 和 EA 各加一行探针（`CopyRates` + `SERIES_SYNCHRONIZED` + `Bars()`）同场对比，一分钟出结论；先分离上下文，再谈服务器、时区、取数姿势。
