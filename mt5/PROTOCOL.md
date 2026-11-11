# DshBridge protocol v1

DshBridge connects a MetaTrader 5 terminal to DSH Desktop. The EA in MT5 is the TCP client, because MQL5 sockets cannot listen. The Desktop main process is the server. The Desktop implements its side in `dsh-plugin-desktop-beta/src/mt5/`. The EA source is in `mt5/MQL5/`.

MT5 is the source of truth. The Desktop shows only what the EA reports, and it never resends a request whose outcome is unknown.

Stages:

- **Stage 1 (implemented):** connection, account, funds, status.
- **Stage 2:** symbols, quotes, bars, positions, orders, history.
- **Stage 3:** trading and its safety.

Messages marked *planned* below may still change before their stage ships.

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
- **Identifiers:** logins and tickets are decimal strings (an integer is accepted).
- **Times:** Unix milliseconds in UTC.
- **Money:** in the account currency.

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
   {"token":"…","protocol":1,"ea_version":"1.0.0","terminal_build":5120,
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
   4. stage 2: the symbol catalogue, `positions.snapshot`, `orders.snapshot`, and the subscriptions again.

   - **Failure:** if any of them fails, the Desktop drops the session, and the EA reconnects and syncs again.
   - **Ready:** the session counts as *ready* once the sync completes.
5. **Updates.** After answering `system.resync`, the EA pushes `system.status` and `account.snapshot` events whenever their content differs from what it last sent or answered.
   - The EA compares about every 500 ms, and immediately after a trade transaction.
   - A ping change alone is pushed at most every 10 seconds.
6. **Reconnect.** The EA reconnects with exponential backoff from 1 to 10 seconds, and retries a refused hello every 30 seconds. A Desktop restart, an EA restart, and a network outage all end in a new session and a fresh sync.

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

## Stage 2 messages (planned)

| Type | Direction | Purpose |
|---|---|---|
| `symbols.list` | Desktop → EA | The broker's whole symbol catalogue in compact form (name, description, path, digits, currencies, Market Watch membership), in chunks. |
| `symbol.info` | Desktop → EA | One symbol's full trading rules: digits and point, contract size, lot bounds and step, trade mode, stops and freeze levels, filling and order modes, currencies, path. |
| `market.subscribe` / `market.unsubscribe` | Desktop → EA | Quotes of a symbol (`SymbolSelect`), or bars of a symbol and timeframe. |
| `market.tick` | EA → Desktop | Bid, ask and time of a subscribed symbol. The Desktop coalesces ticks to at most one push every 100 ms. |
| `market.bar` | EA → Desktop | The current bar of a subscribed symbol and timeframe. |
| `market.history` | Desktop → EA | Bars from `CopyRates` in chunks. Answers `pending` while the terminal is still loading history, and the Desktop retries. |
| `positions.snapshot` / `orders.snapshot` | Desktop → EA | Open positions and pending orders. |
| `history.query` | Desktop → EA | Historical orders and deals in a time range (`HistorySelect`), with commission, swap, fee, and the deal's reason. |

**Bars:** they use MT5's bid prices, like MT5 charts do. Daily and weekly bars are stamped 00:00 UTC of the server's trading day.

## Stage 3 messages (planned)

| Type | Direction | Purpose |
|---|---|---|
| `order.place` | Desktop → EA | A market deal, or a limit or stop pending order, with lots, price, SL/TP, deviation and comment. |
| `order.modify` / `order.cancel` | Desktop → EA | Change a pending order's price or SL/TP, or delete it. |
| `position.close` / `position.modify` | Desktop → EA | Close a position fully or partly, or change its SL/TP. |
| `order.result` | EA → Desktop | The response of a trade request: the retcode and its description, the order ticket, and the fill price. |
| `trade.event` | EA → Desktop | A trade transaction, after which the Desktop refreshes the affected snapshots. |

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
| `not_ready` | The EA has not authenticated, or the terminal cannot answer yet. |
| `timeout`, `disconnected`, `not_connected` | Reported locally by the Desktop for requests that got no answer. |
