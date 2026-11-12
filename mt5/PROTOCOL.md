# DshBridge protocol v2

DshBridge connects a MetaTrader 5 terminal to DSH Desktop. The EA in MT5 is the TLS client, because MQL5 sockets cannot listen. The Desktop main process is the server. The Desktop implements its side in `dsh-plugin-desktop-beta/src/mt5/`. The EA source is in `mt5/MQL5/`.

MT5 is the source of truth. The Desktop shows only what the EA reports, keeps no record of trade requests, and never resends a request whose outcome is unknown.

Stages:

- **Stage 1 (implemented):** connection, account, funds, status.
- **Stage 2 (implemented, EA 1.1.0):** symbols, quotes, bars, positions, orders, history.
- **Stage 3 (implemented, EA 1.2.0):** TLS, mutual authentication, signed trade requests, and trading.

Stage 2 only added message types. Stage 3 changed the transport and the handshake, so it is protocol 2. An EA older than 1.2.0 speaks protocol 1 over plain TCP and cannot connect to this Desktop.

## Transport

- **Connection:** TLS 1.2 or later over TCP. The Desktop listens on `127.0.0.1:19500` by default; the port is configurable in Settings → MT5 connection.
  - On loopback, only an EA on the same computer can connect. This is the usual setup.
  - With *Allow LAN connections*, the Desktop listens on every interface.
- **Admission:** the Desktop keeps no address list; where the EA may connect is set in the EA and the terminal. Any connection that reaches the Desktop must finish TLS and the handshake within 5 seconds, and only an EA that proves the token gets a session. At most 4 connections may wait to authenticate; the Desktop turns more away before TLS.
- **Certificate:** a self-signed RSA 2048 certificate, valid for 10 years. It is kept with its key in `<DSH home>/mt5-bridge-tls.json`, readable by the owner only.
  - The Desktop makes a new one when the file is unreadable or the certificate ends within 30 days. A new certificate drops every connection, and the EA reconnects.
  - MT5 accepts any certificate: it checks neither the issuer, the name nor the dates. So TLS alone only encrypts. The EA authenticates the Desktop by the handshake proofs, which bind the certificate's fingerprint.
- **No plain text:** there is no unencrypted fallback, so a connection cannot be downgraded.
- **Terminal permission:** the terminal must allow the Desktop's address under Tools → Options → Expert Advisors → *Allow WebRequest for listed URL*: `127.0.0.1` on the same computer, else the Desktop's LAN address. Loopback is no exception: without the entry, `SocketConnect` fails with error 4014. The list goes by host only, so any port works.

## Framing

- **Lines:** each frame is one UTF-8 JSON object followed by `\n`. A `\r` before the newline is ignored, and so are blank lines.
- **Size limit:** a frame is at most 2 MiB, newline excluded. A longer frame ends the connection.
- **Field names:** payload fields are `snake_case`.
- **Identifiers:** logins and tickets are decimal strings (an integer is accepted). An id of `"0"` means none.
- **Times:** Unix milliseconds in UTC. See [Times](#times) for how the EA converts the terminal's times.
- **Money:** in the account currency.
- **Enum words:** values taken from an MQL5 enum are its constant's name without the prefix, in lowercase: `SYMBOL_SECTOR_CURRENCY` becomes `currency`.

## Envelopes

Every frame carries `"v": 2`.

```json
{"v":2,"id":"5b0c…","type":"account.snapshot","payload":{}}
{"v":2,"id":"5b0c…","type":"response","ok":true,"payload":{…}}
{"v":2,"id":"5b0c…","type":"response","ok":false,"error":{"code":"not_ready","message":"…","retcode":10018}}
{"v":2,"type":"account.snapshot","payload":{…}}
```

- **Request:** has an `id` of at most 128 characters, unique among the sender's requests in flight, and a `type`. The receiver answers exactly once with a response carrying the same `id`.
- **Response:** `type` is `response`.
  - On success it has `ok: true` and a `payload` object.
  - On failure it has `ok: false` and `error`, with `code` (machine-readable), `message` (for people), and `retcode` (an MT5 `TRADE_RETCODE_*` value, when the terminal produced one).
- **Event:** has no `id` and gets no answer.
- **Type names:** lowercase, dot-separated namespaces, such as `system.ping` and `account.snapshot`.
- **Unknown requests:** the receiver answers a request type it does not serve with error `unknown_type`. It ignores unknown event types.

## Session

1. **TLS.** The EA connects and completes TLS. It reads the SHA-1 fingerprint *F* of the Desktop's certificate, as lowercase hex without separators.
2. **Handshake.** The EA must complete these steps within 5 seconds of connecting, TLS included. Otherwise the Desktop closes the connection.

   Each side proves it holds the bridge token without sending it. A proof is `HMAC-SHA256(token, "dsh-mt5/2 <label>\n" + Ne + "\n" + Nd + "\n" + F)` as lowercase hex, keyed with the token's UTF-8 bytes. *Ne* and *Nd* are 32 random bytes in lowercase hex, which the EA and the Desktop choose for each connection.

   | Step | Frame | Payload |
   |---|---|---|
   | 1 | EA → Desktop: `system.hello` request | `{"protocol":2,"nonce":Ne}`. Nothing about the account before the Desktop has proved the token. |
   | 2 | Desktop → EA: response | `{"protocol":2,"nonce":Nd,"proof":…}`, with the label `desktop`. |
   | 3 | EA checks the Desktop | The EA works out the `desktop` proof with the *F* it saw. If the proofs differ, the tokens differ or something impersonates the Desktop. The EA disconnects, says so on its chart, and tries again in 30 seconds. |
   | 4 | EA → Desktop: `system.auth` request | `{"proof":…,"ea_version":"1.2.0","terminal_build":5120,"terminal_name":"MetaTrader 5","login":"50123456","server":"Example-Demo","instance":"…"}`, with the label `ea`. `instance` names the EA's [request journal](#journal). |
   | 5 | Desktop → EA: response | `{"protocol":2,"desktop":"DSH Desktop Beta …","heartbeat_ms":5000,"idle_ms":15000}`. The session is authenticated. |

   - **Session key:** both sides then derive *Ks*, the proof with the label `session`, as 32 bytes. It signs the [trade requests](#signed-requests) of this session.
   - **Why it holds:** a man in the middle must show the EA its own certificate. The EA then sees another *F* than the Desktop, so the real Desktop's proof fails the EA's check, and relaying it does not help. Proofs and signatures recorded in one session are worthless in another, because the nonces differ.
   - **Failure:** the Desktop answers one of these errors, then closes the connection. The EA tries again every 30 seconds.

     | Error | Meaning |
     |---|---|
     | `auth_failed` | The EA's proof does not match: the tokens differ. |
     | `unsupported_protocol` | Another protocol version. |
     | `bad_request` | An invalid hello or auth. |
     | `busy` | Another account is connected. |

   - **Wrong frames:** a frame other than the expected `system.hello` or `system.auth`, or one that is not valid JSON, closes the connection without an answer.
   - **No TLS:** a failed TLS handshake closes the connection. An EA older than 1.2.0 fails this way, because it speaks plain TCP. Settings shows the rejection as `tls`.
   - **Self-test:** when it starts, the EA checks its SHA-256 and HMAC-SHA256 against the test vectors of FIPS 180-2 and RFC 4231. If they fail, the EA does not connect and says why.
3. **One session.** At most one authenticated session exists.
   - An auth from the same `login` and `server` replaces the old session, which an EA restart or a half-open connection leaves behind.
   - Another account gets `busy`.
4. **Heartbeat.** Both sides send `system.ping` events, `{"time": <ms>}`, whenever they sent nothing for `heartbeat_ms`. Either side ends a session that received no frame for `idle_ms`.
   - **During a trade:** MT5 runs a trade synchronously, and the EA cannot ping meanwhile. So while a trade request waits for its answer, the Desktop does not end the session for silence. The request's own timeout of 30 seconds applies instead.
5. **Sync.** On each new session, and when the user asks for a resync, the Desktop sends these requests in order:
   1. `system.resync`
   2. `system.status`
   3. `account.snapshot`
   4. `symbols.list`, page by page, until it has read `total` symbols
   5. `positions.snapshot`
   6. `orders.snapshot`
   7. `market.subscribe`, with the subscriptions the Desktop needs now. A new session starts without any.

   - **Failure:** if any of them fails, the Desktop drops the session, and the EA reconnects and syncs again.
   - **Ready:** the session counts as *ready* once the sync completes.
6. **Updates.** After answering `system.resync`, the EA pushes these events whenever their content differs from what it last sent or answered:
   - `system.status` and `account.snapshot`.
   - `positions.snapshot` and `orders.snapshot`, once the Desktop asked for them after the last `system.resync`.

   The EA compares about every 500 ms, and on the timer cycle after a trade or a trade transaction. A ping change alone is pushed at most every 10 seconds.

   On every timer cycle (100 ms, the EA input `TimerMs`), the EA also pushes the queued `trade.event` events, then `market.tick` and `market.bar` for the subscriptions that changed.
7. **Reconnect.** The EA reconnects with exponential backoff from 1 to 5 seconds, and retries a refused handshake every 30 seconds. A Desktop restart, an EA restart, and a network outage all end in a new session and a fresh sync.

## Times

MT5 stamps ticks, bars and trades in trade server time. The EA converts them with the current `server_utc_offset`:

- **Ticks, intraday bars, positions, orders and deals:** server time minus the current offset. The offset changes when the server switches daylight-saving time, so times from before the last switch come out an hour off.
- **Daily and weekly bars:** 00:00 UTC of the server's date, which is what TradingView expects of daily bars. They match MT5's daily and weekly bars whatever the offset.
- **Requests:** the EA converts the times in `market.history` and `history.query` back the same way.

## Trading gate

The Desktop's main process checks these conditions before it sends each trade request, so the page cannot bypass them. It reports the failed conditions in this order:

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
| `disclaimer` | The user has not agreed to the current version of the trading risk disclaimer in the Desktop. |

The gate is the same for demo, contest and real accounts. Once the disclaimer is agreed to, all of them trade.

## Stage 1 messages

### `system.hello` and `system.auth` (EA → Desktop, requests)

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

## Stage 3 messages

### Signed requests

The five trade requests are signed: `order.place`, `position.close`, `position.modify`, `order.modify` and `order.cancel`. Their payload holds the request's content as JSON text, and its MAC:

```json
{"body":"{\"account\":{\"login\":\"50123456\",\"server\":\"Example-Demo\"},\"symbol\":\"EURUSD\",…}","mac":"…"}
```

- **MAC:** `HMAC-SHA256(Ks, id + "\n" + type + "\n" + body)` as lowercase hex, with the session key *Ks* from the [handshake](#session). It covers the exact bytes of `body`, so neither side canonicalizes JSON.
- **Check:** the EA checks the MAC before it parses the body. A wrong MAC gets the error `bad_signature`, and a payload that is not `{body, mac}` gets `bad_request`. Nothing of such a request runs, and the EA does not journal it.
- **Replay:** a request replayed in the same session carries an id the EA has journaled, so it gets its first outcome back and does not trade again (see [Journal](#journal)). Replayed in another session, its MAC fails, because the session key differs.
- **Id:** 8 to 64 letters, digits or dashes. The Desktop uses a new UUID for each user action.

### Trade requests (Desktop → EA)

Every body has `account`, `{"login": …, "server": …}`, the account the request is meant for, and `symbol`. The EA refuses a request for any account other than the terminal's with `account_mismatch`. So a page still showing an account the terminal has left cannot trade on the new one.

| Type | Body, besides `account` and `symbol` |
|---|---|
| `order.place` | `side` (`buy` / `sell`), `type` (`market` / `limit` / `stop`), `volume` in lots, `price` (null for a market order, the order price for a pending order), `sl` and `tp` (null for none). |
| `position.close` | `ticket`, and `volume`: the lots to close. Fewer lots than the position holds close part of it, and must leave at least the symbol's minimum. |
| `position.modify` | `ticket`, `sl` and `tp`: the new levels; null removes one. |
| `order.modify` | `ticket`, `price`, `sl` and `tp`. |
| `order.cancel` | `ticket`. |

- **Tickets** are decimal strings.
- **Deviation:** `order.place` and `position.close` take an optional `deviation`, the slippage allowed in points, from 0 to 1,000. The Desktop leaves it out, and the EA uses 10.

### Execution (EA)

- **Checks:** before it trades, the EA checks everything it can:
  - that its journal can be written;
  - the account, and the terminal's connection to the trade server;
  - the permissions: the terminal's Algo Trading, the EA's "Allow Algo Trading", and the account's trade and Expert Advisor permissions;
  - the symbol: that it exists, its trade mode, and that it takes the order type, SL and TP;
  - the lots and prices: lots within the symbol's bounds and on its step, prices on its tick size. The EA refuses values off the grid, and never rounds them;
  - the ticket: that it exists and is on the symbol.

  Last comes `OrderCheck`, which trades nothing: it checks the margin, the stop distances and the rest.
- **Filling:** a deal or a pending order tries the symbol's filling policies in turn: Fill or Kill, Immediate or Cancel, then Return. It takes the first one `OrderCheck` accepts.
- **Expiry:** a pending order lasts until cancelled where the symbol allows that, else until the end of the day. A symbol that takes pending orders only with an expiry date is refused with `expiration`.
- **Close:** `position.close` sends an opposite deal for the lots, naming the position by its ticket.
- **Modify:** a modified pending order keeps its expiry and its stop-limit price.
- **Comment:** new orders carry the comment `dsh:<first 8 characters of the id>`. Some brokers rewrite comments, so it only helps people tell the orders apart.
- **Send:** `OrderSend` runs synchronously, and a market deal's price is refreshed just before it. The next timer cycle pushes the snapshots that changed.

### Trade outcome (EA → Desktop, response)

The response to each trade request:

```json
{"status":"done","retcode":10009,"code":"sent","message":"Request executed","order":"3002","deal":"4002","price":1.07255,"volume":0.1,"duplicate":false}
```

| Field | Type | Meaning |
|---|---|---|
| `status` | `done` / `placed` / `rejected` / `unknown` | `done`: a deal, close, modification or cancel succeeded. `placed`: a pending order was placed. `rejected`: nothing changed. `unknown`: MT5 cannot tell whether the trade server got the request. |
| `retcode` | integer | The trade server's `TRADE_RETCODE_*`; 0 when the EA refused the request itself. |
| `code` | string | `sent` for an `OrderSend` outcome, `check` for an `OrderCheck` refusal, otherwise the reason the EA refused (below). |
| `message` | string | MT5's comment, or the EA's reason, for people. |
| `order`, `deal` | string or null | Tickets. |
| `price`, `volume` | number or null | The fill price and the lots filled. |
| `duplicate` | boolean | The id ran before, and this is its first outcome again. |

**Return codes:** 10008 (placed), 10009 (done) and 10010 (done in part) succeed, as `placed` for a pending order and `done` otherwise. On 10010, `volume` holds the lots actually filled. 10011, 10012 and 10031 mean an error in the terminal, a timeout, or no connection: the request may or may not have reached the trade server, so they are `unknown`. A request that `OrderSend` did not send at all is `rejected` with the code `not_sent`. Every other return code is `rejected`.

**EA refusals,** with `status: "rejected"` and `retcode: 0`:

| Code | Reason |
|---|---|
| `account_mismatch` | The request is for another account than the terminal's. |
| `not_connected` | The terminal is not connected to the trade server. |
| `terminal_trading_off` | Algo Trading is off in the terminal. |
| `ea_trading_off` | "Allow Algo Trading" is off in the EA's properties. |
| `account_trading_off` | The account cannot trade, for example under an investor password. |
| `expert_trading_off` | The trade server does not let Expert Advisors trade on the account. |
| `no_symbol` | The terminal has no such symbol. |
| `trade_mode` | The symbol's trade mode excludes the request: disabled, close only, long only or short only. |
| `order_mode` | The symbol does not take the order type, or SL or TP. |
| `expiration` | The symbol takes pending orders only with an expiry date. |
| `invalid_volume` | The lots are outside the symbol's bounds or off its step, or a partial close would leave less than the minimum. |
| `invalid_price` | A price is off the symbol's tick size. |
| `no_quote` | The symbol has no current price. |
| `no_position` / `no_order` | There is no such position or pending order. |
| `symbol_mismatch` | The ticket is on another symbol. |
| `journal_unavailable` | The EA cannot write its journal, and it trades nothing without it. |

### Journal

The EA journals each trade request in `MQL5\Files\DshBridge\requests.log`, in the terminal's data folder. It is the only record of trade requests: the Desktop keeps none.

- **Format:** JSON lines in UTF-8. The first line, `{"journal":1,"instance":"…","since":<ms>}`, names the journal. Each other line is a state of a request:
  - `{"id":…,"state":"sending","type":…,"at":<ms>,"body":…}` reaches the disk before `OrderSend`;
  - `{"id":…,"state":"done","at":<ms>,"result":{…}}` follows with the outcome. The state is `unknown` instead when the outcome is unknown.
- **At most once:** a repeated id never runs again. The EA answers it with the first outcome and `duplicate: true`. If that outcome was never written, because the EA stopped inside `OrderSend`, the answer is `unknown` with the code `interrupted`.
- **Restart:** when the EA starts, it settles each request the last run left at `sending` as `unknown`, with the code `interrupted`.
- **Length:** once the file passes 2,000 lines, the EA rewrites it with the newest 1,000 requests and moves `since` to that time.
- **One EA:** the EA keeps the file open. A second DshBridge in the same terminal cannot open it, and stays offline.
- **Failures:** if the journal cannot be opened for another reason, the EA connects, but refuses every trade with `journal_unavailable`. A file that is not a journal is kept as `requests.bad`, and a new journal starts with a new instance.

### Unconfirmed outcomes (Desktop)

The Desktop keeps no state of its own about trades. MT5 decides, and the Desktop shows what MT5 reports.

- **One at a time:** while a trade request waits for its answer, the Desktop answers another with `busy` and does not send it.
- **Once:** the Desktop sends each request once, with a new id, and never resends it.
- **No answer:** a trade request without an answer within 30 seconds is *unconfirmed*, and the Desktop ends the session. The EA does one thing at a time, so it reconnects only after `OrderSend` returned. The sync that follows shows MT5's positions and orders as they are.
- **Lost session:** if the session ends while a trade request waits, the request is unconfirmed too.
- **Checking:** the user checks an unconfirmed outcome in the positions and the history. After a trade, the Desktop takes the new state from the `trade.event`, `positions.snapshot` and `orders.snapshot` events that follow.

### `order.result` (Desktop → EA, request)

`{"ids": […]}`, up to 50 request ids: what the EA's journal holds about each of them. The request only reads, so it is not signed. The Desktop does not send it; it is there for diagnostics.

```json
{"instance":"…","since":1762000000000,"results":[{"id":"…","state":"done","result":{…}}]}
```

- **`state`:** `done` with the outcome, `unknown` (the outcome is unknown, or the EA stopped inside `OrderSend`), or `none` with `result` null.
- **`none`:** the journal has no such id. That proves the request never ran only if this is the journal `instance` that would have received it, and the request came after `since`.

### `symbol.info` (Desktop → EA, request)

`{"symbol": "EURUSD"}`: the trade rules of a symbol. The order ticket reads them whenever it shows a symbol, and after every sync. The request only reads, so it is not signed. It fails with `unknown_symbol` when the terminal has no such symbol.

| Field | Type | Source |
|---|---|---|
| `symbol` | string | |
| `digits` | integer | `SYMBOL_DIGITS` |
| `point`, `tick_size` | number | `SYMBOL_POINT`, `SYMBOL_TRADE_TICK_SIZE` |
| `contract_size` | number | `SYMBOL_TRADE_CONTRACT_SIZE` |
| `volume_min`, `volume_max`, `volume_step`, `volume_limit` | number | `SYMBOL_VOLUME_MIN`, `SYMBOL_VOLUME_MAX`, `SYMBOL_VOLUME_STEP`, `SYMBOL_VOLUME_LIMIT`, in lots; a limit of 0 means none |
| `stops_level`, `freeze_level` | integer | `SYMBOL_TRADE_STOPS_LEVEL`, `SYMBOL_TRADE_FREEZE_LEVEL`, in points. With 0 there is no fixed minimum, and the trade server decides. |
| `trade_mode` | `disabled` / `long_only` / `short_only` / `close_only` / `full` | `SYMBOL_TRADE_MODE` |
| `execution` | `request` / `instant` / `market` / `exchange` | `SYMBOL_TRADE_EXEMODE` |
| `filling` | array of `fok`, `ioc`, `boc` | `SYMBOL_FILLING_MODE` |
| `order_modes` | array of `market`, `limit`, `stop`, `stop_limit`, `sl`, `tp`, `close_by` | `SYMBOL_ORDER_MODE` |
| `expiration_modes` | array of `gtc`, `day`, `specified`, `specified_day` | `SYMBOL_EXPIRATION_MODE` |
| `margin_buy`, `margin_sell` | number or null | `OrderCalcMargin` of one lot at the current ask or bid, in the account currency; null when MT5 cannot tell |
| `session_open` | boolean | as in [`market.tick`](#markettick-ea--desktop-event) |

## Error codes

| Code | Meaning |
|---|---|
| `auth_failed` | The EA's proof does not match the Desktop's token. |
| `unsupported_protocol` | The hello's protocol version is not 2. |
| `bad_request` | A request's payload is invalid. |
| `bad_signature` | A trade request's MAC does not match the session. Nothing ran. |
| `busy` | Another account is connected. Reported locally by the Desktop for a trade request while another one waits for its answer. |
| `unknown_type` | The receiver does not serve the request type. |
| `unknown_symbol` | The terminal has no such symbol. |
| `not_ready` | The EA has not authenticated, or the terminal cannot answer yet: `HistorySelect` failed, or the chart template cannot be saved. |
| `timeout`, `disconnected`, `not_connected` | Reported locally by the Desktop for requests that got no answer. A trade request that times out or loses its session is unconfirmed. |
| `duplicate_id` | Reported locally by the Desktop: a request with this `id` is already in flight. |

Settings → MT5 connection shows why the Desktop last turned a connection away:

| Reason | Meaning |
|---|---|
| `tls` | The TLS handshake failed, as it does for an EA older than 1.2.0. |
| `token` | The EA's proof does not match: the tokens differ. |
| `protocol` | Another protocol version. |
| `busy` | Another account is connected, or too many connections wait to authenticate. |
| `handshake-timeout` | The EA did not authenticate within 5 seconds. |
| `invalid` | The first frames were not a valid hello and auth. |
