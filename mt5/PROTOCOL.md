# DshBridge protocol v1

DshBridge connects a MetaTrader 5 terminal to DSH Desktop. The EA in MT5 is the TCP client, because MQL5 sockets cannot listen. The Desktop main process is the server. The Desktop implements its side in `dsh-plugin-desktop-beta/src/mt5/`. The EA source is in `mt5/MQL5/`.

MT5 is the source of truth. The Desktop shows only what the EA reports, and it never resends a request whose outcome is unknown.

Stages:

- **Stage 1 (implemented):** connection, account, funds, status.
- **Stage 2 (implemented, EA 1.1.0):** symbols, quotes, bars, positions, orders, history.
- **Stage 3 (planned):** trading and its safety.

Messages marked *planned* below may still change before their stage ships. Stage 2 only added message types, so the protocol version is still 1.

## Transport

- **Connection:** plain TCP. The Desktop listens on port 19500 by default, configurable in Settings → MT5 connection.
  - On loopback, only an EA on the same computer can connect.
  - With *Allow LAN connections*, the Desktop listens on every interface.
- **Admission:** a connection must come from loopback or from an address on the Desktop's allowlist (an empty allowlist admits any address). It must then authenticate with the bridge token.
- **Plain text:** the connection is not encrypted, so use LAN mode only on a trusted network. TLS is planned before real-money trading.
- **Terminal permission:** the terminal must allow the Desktop's address under Tools → Options → Expert Advisors → *Allow WebRequest for listed URL*.

## Framing

- **Lines:** each frame is one UTF-8 JSON object followed by `\n`. A `\r` before the newline is ignored, and so are blank lines.
- **Size limit:** a frame is at most 2 MiB, newline excluded. A longer frame ends the connection.
- **Field names:** payload fields are `snake_case`.
- **Identifiers:** logins and tickets are decimal strings (an integer is accepted). An id of `"0"` means none.
- **Times:** Unix milliseconds in UTC. See [Times](#times) for how the EA converts the terminal's times.
- **Money:** in the account currency.
- **Enum words:** values taken from an MQL5 enum are its constant's name without the prefix, in lowercase: `SYMBOL_SECTOR_CURRENCY` becomes `currency`.

## Envelopes

Every frame carries `"v": 1`.

```json
{"v":1,"id":"5b0c…","type":"account.snapshot","payload":{}}
{"v":1,"id":"5b0c…","type":"response","ok":true,"payload":{…}}
{"v":1,"id":"5b0c…","type":"response","ok":false,"error":{"code":"not_ready","message":"…","retcode":10018}}
{"v":1,"type":"account.snapshot","payload":{…}}
```

- **Request:** has an `id` of at most 128 characters, unique among the sender's requests in flight, and a `type`. The receiver answers exactly once with a response carrying the same `id`.
- **Response:** `type` is `response`.
  - On success it has `ok: true` and a `payload` object.
  - On failure it has `ok: false` and `error`, with `code` (machine-readable), `message` (for people), and `retcode` (an MT5 `TRADE_RETCODE_*` value, when the terminal produced one).
- **Event:** has no `id` and gets no answer.
- **Type names:** lowercase, dot-separated namespaces, such as `system.ping` and `account.snapshot`.
- **Unknown requests:** the receiver answers a request type it does not serve with error `unknown_type`. It ignores unknown event types.

## Session

1. **Hello.** The EA connects and sends `system.hello` within 5 seconds. Otherwise the Desktop closes the connection.

   ```json
   {"token":"…","protocol":1,"ea_version":"1.1.0","terminal_build":5120,
    "terminal_name":"MetaTrader 5","login":"50123456","server":"Example-Demo"}
   ```

   - **Success:** the Desktop answers with `{"protocol":1,"desktop":"DSH Desktop Beta …","heartbeat_ms":5000,"idle_ms":15000}`.
   - **Failure:** the Desktop answers with one of these errors, then closes the connection:

     | Error | Meaning |
     |---|---|
     | `auth_failed` | wrong token |
     | `unsupported_protocol` | another protocol version |
     | `bad_request` | invalid hello |
     | `busy` | another account is connected |

     The EA retries a refused hello slowly, every 30 seconds.
   - **First frame:** a first frame that is not a hello, or not valid JSON, closes the connection without an answer.
2. **One session.** At most one authenticated session exists.
   - A hello from the same `login` and `server` replaces the old session, which an EA restart or a half-open connection leaves behind.
   - Another account gets `busy`.
3. **Heartbeat.** Both sides send `system.ping` events, `{"time": <ms>}`, whenever they sent nothing for `heartbeat_ms`. Either side ends a session that received no frame for `idle_ms`.
4. **Sync.** On each new session, and when the user asks for a resync, the Desktop sends these requests in order:
   1. `system.resync`
   2. `system.status`
   3. `account.snapshot`
   4. `symbols.list`, page by page, until it has read `total` symbols
   5. `positions.snapshot`
   6. `orders.snapshot`
   7. `market.subscribe`, with the subscriptions the Desktop needs now. A new session starts without any.

   - **Older EA:** an EA whose `ea_version` is below 1.1.0 gets steps 1 to 3 only, and the Desktop sends it no stage 2 request. The Desktop shows the account and asks the user to update the EA.
   - **Failure:** if any of them fails, the Desktop drops the session, and the EA reconnects and syncs again.
   - **Ready:** the session counts as *ready* once the sync completes.
5. **Updates.** After answering `system.resync`, the EA pushes these events whenever their content differs from what it last sent or answered:
   - `system.status` and `account.snapshot`.
   - `positions.snapshot` and `orders.snapshot`, once the Desktop asked for them after the last `system.resync`. An older Desktop that never asks gets none.

   The EA compares about every 500 ms, and on the timer cycle after a trade transaction. A ping change alone is pushed at most every 10 seconds.

   On every timer cycle (100 ms, the EA input `TimerMs`), the EA also pushes the queued `trade.event` events, then `market.tick` and `market.bar` for the subscriptions that changed.
6. **Reconnect.** The EA reconnects with exponential backoff from 1 to 5 seconds, and retries a refused hello every 30 seconds. A Desktop restart, an EA restart, and a network outage all end in a new session and a fresh sync.

## Times

MT5 stamps ticks, bars and trades in trade server time. The EA converts them with the current `server_utc_offset`:

- **Ticks, intraday bars, positions, orders and deals:** server time minus the current offset. The offset changes when the server switches daylight-saving time, so times from before the last switch come out an hour off.
- **Daily and weekly bars:** 00:00 UTC of the server's date, which is what TradingView expects of daily bars. They match MT5's daily and weekly bars whatever the offset.
- **Requests:** the EA converts the times in `market.history` and `history.query` back the same way.

## Trading gate

The Desktop accepts new trades only while every condition below holds. It reports the failed conditions in this order:

| Reason | Condition |
|---|---|
| `bridge-disabled` / `bridge-error` | The bridge is turned off, or cannot listen. |
| `ea-disconnected` | No authenticated EA. |
| `syncing` | The sync has not completed. |
| `broker-disconnected` | `terminal_connected` is false. |
| `terminal-trade-disabled` | `terminal_trade_allowed` is false (the Algo Trading button). |
| `ea-trade-disabled` | `ea_trade_allowed` is false (the EA's "Allow Algo Trading"). |
| `account-trade-disabled` | `trade_allowed` is false (for example an investor login). |
| `account-expert-disabled` | `trade_expert` is false. |
| `real-account-locked` | `trade_mode` is `real` and real-money trading is not enabled in the Desktop. |

## Stage 1 messages

### `system.hello` (EA → Desktop, request)

See [Session](#session).

### `system.ping` (both, event)

`{"time": <ms>}`. Keeps the session alive and carries no other meaning.

### `system.resync` (Desktop → EA, request)

The EA forgets what it last pushed and answers `{}`.

### `system.status` (Desktop → EA request; EA → Desktop event)

| Field | Type | Source |
|---|---|---|
| `terminal_connected` | boolean | `TERMINAL_CONNECTED` |
| `terminal_trade_allowed` | boolean | `TERMINAL_TRADE_ALLOWED` |
| `ea_trade_allowed` | boolean | `MQL_TRADE_ALLOWED` |
| `terminal_build` | integer | `TERMINAL_BUILD` |
| `terminal_name` | string | `TERMINAL_NAME` |
| `terminal_company` | string | `TERMINAL_COMPANY` |
| `ping_ms` | number or null | `TERMINAL_PING_LAST` / 1000; null while disconnected |
| `server_utc_offset` | integer | trade server time minus UTC in seconds, from `TimeTradeServer() - TimeGMT()`, rounded to 15 minutes |

### `account.snapshot` (Desktop → EA request; EA → Desktop event)

| Field | Type | Source |
|---|---|---|
| `login` | string | `ACCOUNT_LOGIN` |
| `name`, `server`, `company`, `currency` | string | `ACCOUNT_NAME`, `ACCOUNT_SERVER`, `ACCOUNT_COMPANY`, `ACCOUNT_CURRENCY` |
| `currency_digits` | integer | `ACCOUNT_CURRENCY_DIGITS`; money fields use these decimals |
| `leverage` | integer | `ACCOUNT_LEVERAGE` |
| `trade_mode` | `demo` / `contest` / `real` | `ACCOUNT_TRADE_MODE` |
| `margin_mode` | `netting` / `exchange` / `hedging` | `ACCOUNT_MARGIN_MODE` |
| `trade_allowed`, `trade_expert` | boolean | `ACCOUNT_TRADE_ALLOWED`, `ACCOUNT_TRADE_EXPERT` |
| `limit_orders` | integer | `ACCOUNT_LIMIT_ORDERS`; 0 means no limit |
| `balance`, `credit`, `profit`, `equity`, `margin`, `margin_free` | number | `ACCOUNT_BALANCE`, `ACCOUNT_CREDIT`, `ACCOUNT_PROFIT`, `ACCOUNT_EQUITY`, `ACCOUNT_MARGIN`, `ACCOUNT_MARGIN_FREE` |
| `margin_level` | number | `ACCOUNT_MARGIN_LEVEL` in percent; MT5 reports 0 while no margin is in use, which the Desktop shows as none |
| `margin_so_call`, `margin_so_so` | number | `ACCOUNT_MARGIN_SO_CALL`, `ACCOUNT_MARGIN_SO_SO` |
| `margin_so_mode` | `percent` / `money` | `ACCOUNT_MARGIN_SO_MODE`: the unit of the two levels above |

## Stage 2 messages

These need EA 1.1.0 or later. The Desktop sends them only to such an EA.

### `symbols.list` (Desktop → EA, request)

`{"offset": 0, "limit": 500}`: one page of the broker's symbol catalogue, in the terminal's order. `offset` is at least 0, and `limit` is 1 to 1,000 (500 when left out). The Desktop reads pages of 500.

| Field | Type | Meaning |
|---|---|---|
| `total` | integer | Symbols on the trade server, `SymbolsTotal(false)`. |
| `symbols` | array | At most `limit` symbols from `offset`. |
| `watch` | array of names | First page only: the Market Watch symbols, in the window's order. |

Each symbol:

| Field | Type | Source |
|---|---|---|
| `name` | string | `SymbolName` |
| `description`, `path` | string | `SYMBOL_DESCRIPTION`, `SYMBOL_PATH` (such as `Forex\Majors\EURUSD`) |
| `currency_base`, `currency_profit`, `currency_margin` | string | `SYMBOL_CURRENCY_BASE`, `SYMBOL_CURRENCY_PROFIT`, `SYMBOL_CURRENCY_MARGIN` |
| `digits` | integer, 0 to 10 | `SYMBOL_DIGITS` |
| `point`, `tick_size` | number | `SYMBOL_POINT`, `SYMBOL_TRADE_TICK_SIZE`; a tick size of 0 means prices move by points |
| `contract_size` | number | `SYMBOL_TRADE_CONTRACT_SIZE` |
| `volume_min`, `volume_max`, `volume_step` | number | `SYMBOL_VOLUME_MIN`, `SYMBOL_VOLUME_MAX`, `SYMBOL_VOLUME_STEP`, in lots |
| `trade_mode` | `disabled` / `long_only` / `short_only` / `close_only` / `full` | `SYMBOL_TRADE_MODE` |
| `calc_mode` | enum word | `SYMBOL_TRADE_CALC_MODE`, such as `forex`, `cfd`, `cfdindex`, `exch_stocks` |
| `sector` | enum word | `SYMBOL_SECTOR`, such as `currency`, `indexes`, `commodities`, `undefined` |
| `selected` | boolean | `SYMBOL_SELECT`: the symbol is in Market Watch |

The Desktop skips and logs a symbol it cannot read, and keeps the rest.

### `market.subscribe` (Desktop → EA, request)

```json
{"quotes":["EURUSD","XAUUSD"],"bars":[{"symbol":"EURUSD","timeframe":"M5"}]}
```

- **Replacement:** the request replaces every subscription of the session. `{"quotes":[],"bars":[]}` ends them all.
- **Timeframes:** `M1`, `M3`, `M5`, `M15`, `M30`, `H1`, `H2`, `H4`, `D1`, `W1`.
- **Limits:** the EA accepts up to 500 quotes and 50 bar streams. The Desktop sends at most 200 quotes and 20 bar streams.
- **Answer:** `{"unknown": [...]}` lists the symbols the terminal does not have, and the EA serves the rest. A request that is invalid as a whole fails with `bad_request` and changes nothing.
- **Market Watch:** the EA adds each subscribed symbol to Market Watch with `SymbolSelect`, because the terminal streams quotes only for the symbols there. It never removes them.
- **First values:** each new subscription pushes its current value on the next timer cycle. After a `system.resync`, every subscription pushes its current value again.
- **Lifetime:** subscriptions end with the session. The Desktop sends them again in each sync.

### `market.tick` (EA → Desktop, event)

`{"ticks": [...]}`: the subscribed quotes that changed since the last cycle.

| Field | Type | Source |
|---|---|---|
| `symbol` | string | |
| `time` | integer | the tick's `time_msc` |
| `bid`, `ask` | number | `SymbolInfoTick` |
| `day_open`, `day_high`, `day_low` | number or null | today's daily bar; null until the terminal has the daily series |
| `day_volume` | integer or null | today's daily bar's tick volume |
| `prev_close` | number or null | the close of the daily bar before today's |
| `session_open` | boolean | The server time is inside one of today's trading sessions (`SymbolInfoSessionTrade`) and the symbol's trade mode is not `disabled`. Worked out once a minute. |

- **No quote yet:** a symbol whose bid and ask are both 0 is not pushed.
- **Desktop:** it forwards the latest tick of each symbol to the page at most every 100 ms.

### `market.bar` (EA → Desktop, event)

`{"bars": [...]}`: the current bars of the subscribed streams that changed since the last cycle.

| Field | Type | Meaning |
|---|---|---|
| `symbol`, `timeframe` | string | the stream |
| `time` | integer | the bar's open time (see [Times](#times)) |
| `open`, `high`, `low`, `close` | number | bid prices, as on MT5 charts |
| `volume` | integer | tick volume |

- **New bar:** when a new bar opens, the final state of the bar before it comes first in the same event.
- **Loading series:** the EA pushes a stream only once its series is synchronized, so the first bar can come a little after the subscription.

### `market.history` (Desktop → EA, request)

```json
{"symbol":"EURUSD","timeframe":"M5","to":1762000000000,"count":300}
```

The answer is the page of bars that open before `to`, oldest first: `count` (1 to 5,000) of them, or every bar there is. Each row is `[time, open, high, low, close, tick_volume]`. `no_data` is true when there are none, and `complete` says whether the page is whole:

```json
{"bars":[[1761999700000,1.0724,1.0726,1.0723,1.07251,87]],"no_data":false,"complete":true}
```

The EA never waits for the terminal, so the session keeps its heartbeat. In an EA, `CopyRates` waits while the terminal builds or downloads a series, sometimes for minutes. An indicator's request never waits, so the EA leaves those requests to indicators.

- **Local bars:** the EA answers only with bars the terminal already has.
- **Oldest bar:** while the series can still reach further back, the EA leaves out its oldest bar. That bar can lack the ticks from before the history the terminal has: for example, the terminal may have the oldest week only from Wednesday on. A later page carries it, once the history before it is there. So every bar the Desktop gets matches MT5's final bar.
- **Older history:** when the terminal has fewer than `count` such bars, the EA has it download older history in the background, through the `DshBridgeLoader` indicator. A later request gets more.
  - The indicator asks the terminal once, when it starts: an indicator without a chart gets no timer events.
  - The terminal drops a request that comes while it first synchronizes a symbol's history. So the EA starts the indicator again whenever the series has not reached further back for 3 seconds. Asking again never ends a download.
- **Whole pages:** the answer waits until the page is whole. A shorter page would tell the chart that there are no bars in the rest of its range. TradingView continues from the start of the range it asked for, unless the bars it got reach further back.
- **Partial pages:** a request with `"partial": true` gets the bars the terminal has while it still downloads older ones of the page, with `"complete": false`. The Desktop asks this way for a chart's first screen, so the chart can show the bars at once.
- **Pending:** the EA answers `{"pending": true}` in two cases:
  - the series is not synchronized yet. The EA has the terminal build it, through an indicator on the series. While the terminal downloads many years of a symbol's history, a timeframe of that symbol it has not built yet can wait until the download ends;
  - the page is not whole yet, and a download that can complete it is under way, or waits for one of the EA's 8 download slots. A partial request is not pending in this case.
- **No time limit:** a download takes as long as the terminal's network needs, so neither side gives up after a set time. The Desktop asks again every 400 ms for as long as the answer is pending, until the EA disconnects.
- **End of history:** `no_data` is set only when the series has no older history. Neither side infers that from a slow download. The series has no older history when:
  - it reaches back to the first bar the server has (`SERIES_SERVER_FIRSTDATE`);
  - or it holds the terminal's *Max bars in chart*.
- **Downloads:** a download runs until the series reaches back far enough or has no older history. The EA stops it once the Desktop has not asked for those bars for 10 seconds.
- **Unknown symbol:** the request fails with `unknown_symbol`.
- **Invalid rows:** the Desktop skips rows that are invalid or out of time order, and logs how many.

### `positions.snapshot` (Desktop → EA request; EA → Desktop event)

`{"positions": [...]}`: every open position.

| Field | Type | Source |
|---|---|---|
| `ticket` | string | `PositionGetTicket` |
| `symbol` | string | `POSITION_SYMBOL` |
| `side` | `buy` / `sell` | `POSITION_TYPE` |
| `volume` | number | `POSITION_VOLUME`, in lots |
| `price_open` | number | `POSITION_PRICE_OPEN`; a netting position's average price has up to 3 more decimals than the symbol |
| `sl`, `tp` | number or null | `POSITION_SL`, `POSITION_TP`; null when not set |
| `price_current` | number | `POSITION_PRICE_CURRENT` |
| `profit`, `swap` | number | `POSITION_PROFIT`, `POSITION_SWAP` |
| `time` | integer | `POSITION_TIME_MSC` |
| `comment` | string | `POSITION_COMMENT` |
| `magic` | integer | `POSITION_MAGIC` |

While positions are open, their profit changes with the quotes, so this event comes about every 500 ms.

### `orders.snapshot` (Desktop → EA request; EA → Desktop event)

`{"orders": [...]}`: every pending order. Market orders that are still executing are left out.

| Field | Type | Source |
|---|---|---|
| `ticket` | string | `OrderGetTicket` |
| `symbol` | string | `ORDER_SYMBOL` |
| `type` | `buy_limit` / `sell_limit` / `buy_stop` / `sell_stop` / `buy_stop_limit` / `sell_stop_limit` | `ORDER_TYPE` |
| `state` | enum word | `ORDER_STATE`, such as `placed` or `partial` |
| `volume`, `volume_initial` | number | `ORDER_VOLUME_CURRENT`, `ORDER_VOLUME_INITIAL`, in lots |
| `price` | number | `ORDER_PRICE_OPEN` |
| `stop_limit` | number or null | `ORDER_PRICE_STOPLIMIT` of a stop-limit order: the price of the limit order placed when the stop price is reached |
| `sl`, `tp` | number or null | `ORDER_SL`, `ORDER_TP` |
| `price_current` | number | `ORDER_PRICE_CURRENT` |
| `time` | integer | `ORDER_TIME_SETUP_MSC` |
| `time_type` | `gtc` / `day` / `specified` / `specified_day` | `ORDER_TYPE_TIME` |
| `expiration` | integer or null | `ORDER_TIME_EXPIRATION` |
| `comment` | string | `ORDER_COMMENT` |
| `magic` | integer | `ORDER_MAGIC` |

### `history.query` (Desktop → EA, request)

`{"from": <ms>, "to": <ms>}`, with `from` before `to`: the history orders and deals whose times fall in [from, to), from `HistorySelect`. The answer is `{"orders": [...], "deals": [...], "truncated": false}`.

- **Order:** both lists are newest first.
- **Limits:** each list stops at 5,000 rows, or at about 700,000 characters so that the answer stays under the frame limit. `truncated` is true when older rows were left out.
- **Timeout:** the Desktop waits up to 30 seconds for the answer.
- **Failure:** `not_ready` when `HistorySelect` fails.

History order:

| Field | Type | Source |
|---|---|---|
| `ticket` | string | `HistoryOrderGetTicket` |
| `symbol` | string | `ORDER_SYMBOL` |
| `type` | `buy` / `sell` / a pending type / `close_by` | `ORDER_TYPE` |
| `state` | enum word | `ORDER_STATE`, such as `filled`, `canceled`, `rejected`, `expired` |
| `volume_initial`, `volume_current` | number | `ORDER_VOLUME_INITIAL`, `ORDER_VOLUME_CURRENT` (the part not filled), in lots |
| `price`, `stop_limit`, `sl`, `tp` | number or null | `ORDER_PRICE_OPEN`, `ORDER_PRICE_STOPLIMIT`, `ORDER_SL`, `ORDER_TP`; null for MT5's 0 |
| `time_setup`, `time_done` | integer | `ORDER_TIME_SETUP_MSC`, `ORDER_TIME_DONE_MSC` |
| `position`, `position_by` | string | `ORDER_POSITION_ID`, `ORDER_POSITION_BY_ID` |
| `reason` | enum word | `ORDER_REASON`: `client`, `mobile`, `web`, `expert`, `sl`, `tp`, `so` |
| `comment` | string | `ORDER_COMMENT` |
| `magic` | integer | `ORDER_MAGIC` |

Deal:

| Field | Type | Source |
|---|---|---|
| `ticket` | string | `HistoryDealGetTicket` |
| `order`, `position` | string | `DEAL_ORDER`, `DEAL_POSITION_ID`; `"0"` for a balance operation |
| `symbol` | string | `DEAL_SYMBOL`; empty for a balance operation |
| `type` | enum word | `DEAL_TYPE`: `buy` and `sell` for trades; `balance`, `credit`, `charge`, `correction`, `bonus`, `commission`, `commission_daily`, `commission_monthly`, `commission_agent_daily`, `commission_agent_monthly`, `interest`, `buy_canceled`, `sell_canceled`, `dividend`, `dividend_franked` and `tax` for balance operations |
| `entry` | `in` / `out` / `inout` / `out_by` | `DEAL_ENTRY` |
| `volume`, `price` | number | `DEAL_VOLUME`, `DEAL_PRICE` |
| `commission`, `swap`, `fee`, `profit` | number | `DEAL_COMMISSION`, `DEAL_SWAP`, `DEAL_FEE`, `DEAL_PROFIT` |
| `time` | integer | `DEAL_TIME_MSC` |
| `reason` | enum word | `DEAL_REASON`: `client`, `mobile`, `web`, `expert`, `sl`, `tp`, `so`, `rollover`, `vmargin`, `split`, `corporate_action` |
| `comment` | string | `DEAL_COMMENT` |
| `magic` | integer | `DEAL_MAGIC` |

### `trade.event` (EA → Desktop, event)

```json
{"type":"deal_add","deal":"9001","order":"8001","position":"7001","symbol":"EURUSD"}
```

- **When:** from `OnTradeTransaction`. `deal_add` is a new deal (`TRADE_TRANSACTION_DEAL_ADD`), and `history_add` is an order that moved to the history (`TRADE_TRANSACTION_HISTORY_ADD`).
- **Ids:** `"0"` when the transaction has none.
- **Queue:** the EA queues at most 200 events between two timer cycles and drops the rest. An event is only a hint, and the snapshots that follow stay complete.
- **Desktop:** it reads the history again when the period on screen includes the current time.

### `system.reload` (Desktop → EA, request)

The EA saves its chart as the template `MQL5\Profiles\Templates\DshBridgeReload.tpl`, answers `{}`, and applies that template to its chart. The terminal then removes the EA and loads it again from disk with the same inputs, so a recompiled EA takes effect without being attached by hand. The session ends, and the reloaded EA connects again.

- **Sender:** only the Desktop main process sends it; the page cannot.
- **Failure:** `not_ready` when the chart template cannot be saved.

## Stage 3 messages (planned)

| Type | Direction | Purpose |
|---|---|---|
| `symbol.info` | Desktop → EA | One symbol's full trading rules: stops and freeze levels, filling and order modes, expiration modes, and the rest that order checks need. |
| `order.place` | Desktop → EA | A market deal, or a limit or stop pending order, with lots, price, SL/TP, deviation and comment. |
| `order.modify` / `order.cancel` | Desktop → EA | Change a pending order's price or SL/TP, or delete it. |
| `position.close` / `position.modify` | Desktop → EA | Close a position fully or partly, or change its SL/TP. |
| `order.result` | EA → Desktop | The response of a trade request: the retcode and its description, the order ticket, and the fill price. |

After a trade, the Desktop takes the new state from the `trade.event`, `positions.snapshot` and `orders.snapshot` events that follow.

Trade requests are idempotent by `id`:

- **Journal:** the EA keeps the last 1,000 completed ids with their results in `MQL5/Files/DshBridge/requests.log`.
- **Repeated id:** the EA answers a repeated id with the original result and `duplicate: true`, without trading again.
- **Comment:** orders carry the comment `dsh:<first 8 characters of the id>`.
- **Unconfirmed result:** a request with no answer within 30 seconds is marked unconfirmed, and the Desktop resyncs. It never resends the request on its own.

## Error codes

| Code | Meaning |
|---|---|
| `auth_failed` | The hello's token does not match. |
| `unsupported_protocol` | The hello's protocol version is not 1. |
| `bad_request` | A request's payload is invalid. |
| `busy` | Another account is connected, or too many connections are waiting to authenticate. |
| `unknown_type` | The receiver does not serve the request type. |
| `unknown_symbol` | The terminal has no such symbol. |
| `not_ready` | The EA has not authenticated, or the terminal cannot answer yet: `HistorySelect` failed. |
| `timeout`, `disconnected`, `not_connected` | Reported locally by the Desktop for requests that got no answer. |
| `duplicate_id` | Reported locally by the Desktop: a request with this `id` is already in flight. |
| `ea_outdated` | Reported locally by the Desktop: the connected EA is older than 1.1.0 and does not serve stage 2. |
