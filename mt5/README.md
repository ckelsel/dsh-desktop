# DshBridge (MT5 EA)

DshBridge connects a MetaTrader 5 terminal to DSH Desktop.

- **Stage 1:** the Desktop market page shows MT5's connection state, the account and its funds.
- **Stage 2 (EA 1.1.0):** symbols, quotes, bars, positions, orders and history all come from MT5.
- **Stage 3 (current, EA 1.2.0, protocol 2):** trading from the Desktop. The connection is TLS-encrypted, both sides authenticate each other, and every trade request is signed.

The protocol is in [PROTOCOL.md](PROTOCOL.md).

## How it works

- **Direction:** the EA is the TLS client and dials the Desktop, because MQL5 sockets cannot listen. The Desktop listens in its main process, by default on `127.0.0.1:19500`.
- **Usual setup:** MT5 and the Desktop run on the same computer. MT5 on another computer in the LAN works too; see step 5 of [Installation](#installation).
- **Source of truth:** MT5. The Desktop shows only what the EA reports. It makes no optimistic updates, and keeps no record of trade requests.
- **One account:** a Desktop serves one account at a time. The EA runs on one chart, any chart.

```
MQL5/
  Experts/DshBridge.mq5            EA entry: inputs, connection file, timer
  Include/DshBridge/Json.mqh       JSON parsing and writing
  Include/DshBridge/Crypto.mqh     SHA-256, HMAC-SHA256, nonces and the start-up self-test
  Include/DshBridge/Transport.mqh  TLS connection, UTF-8 lines in and out
  Include/DshBridge/Protocol.mqh   protocol envelopes
  Include/DshBridge/Account.mqh    system.status and account.snapshot
  Include/DshBridge/Time.mqh       server time and UTC
  Include/DshBridge/Market.mqh     symbol catalogue, quote and bar subscriptions, history bars
  Include/DshBridge/Positions.mqh  positions and pending orders
  Include/DshBridge/History.mqh    history orders and deals
  Include/DshBridge/Journal.mqh    trade request journal: each request runs at most once
  Include/DshBridge/Trade.mqh      place, close, modify and cancel; order.result and symbol.info
  Include/DshBridge/Bridge.mqh     session: handshake, signature checks, answers, heartbeat, pushes, reconnect, self-reload
  Indicators/DshBridgeLoader.mq5   downloads older history bars in the background; the EA embeds it as a resource
```

The sources use ASCII only, with CRLF line endings.

## Installation

1. **Find the data folder:** in MT5, choose File → Open Data Folder.
2. **Copy the files:**
   - `MQL5/Experts/DshBridge.mq5` to `MQL5\Experts\` in the data folder.
   - The whole `MQL5/Include/DshBridge/` folder to `MQL5\Include\DshBridge\` in the data folder.
   - `MQL5/Indicators/DshBridgeLoader.mq5` to `MQL5\Indicators\` in the data folder.
3. **Compile:** first `DshBridgeLoader.mq5`, then `DshBridge.mq5`, because the EA embeds the indicator. Open each in MetaEditor and press F7. Or compile from PowerShell:

   ```powershell
   foreach ($source in @("Indicators\DshBridgeLoader.mq5", "Experts\DshBridge.mq5")) {
     $p = Start-Process -FilePath "<MT5 install folder>\metaeditor64.exe" -Wait -PassThru -ArgumentList @(
       "/compile:`"<data folder>\MQL5\$source`"", "/log:`"$env:TEMP\dshbridge.log`"")
     Get-Content "$env:TEMP\dshbridge.log" -Encoding Unicode | Select-Object -Last 1
   }
   ```

   - **Result:** the last line for each file should be `0 errors, 0 warnings`. The log is UTF-16. Exit code 1 means the compile succeeded.
   - **The indicator needs no chart:** do not attach `DshBridgeLoader`; the EA starts it when it needs it.
   - **Paths:** quote paths that contain spaces.
   - **Updating a running EA:** a command-line compile does not notify the running terminal, so the chart keeps the old EA. Remove the EA from its chart and attach it again.
     - Since 1.1.0, the Desktop main process can send `system.reload`, which makes the EA load itself again from disk, through the template `MQL5\Profiles\Templates\DshBridgeReload.tpl`. It is for development only; the UI has no button for it.
     - **Upgrading from 1.1.0 or older to 1.2.0:** the old EA cannot speak TLS, so it cannot connect to the new Desktop, and the new Desktop cannot reload it. After compiling, remove the EA from its chart and attach it again, once.
4. **Let the EA reach the Desktop:** in Tools → Options → Expert Advisors, check *Allow WebRequest for listed URL* and add the Desktop's address. This is the only address list to set up; the Desktop keeps none.
   - same computer: `127.0.0.1`. MT5 needs the entry even for its own computer;
   - Desktop on another computer: that computer's IP, for example `10.0.0.9`.
5. **Configure the Desktop:** open Settings → MT5 connection in the Desktop.
   - Turn on *Enable the MT5 connection*. It is on by default.
   - On the same computer, change nothing else: by default the Desktop accepts connections from this computer only.
   - With MT5 on another computer: turn on *Allow LAN connections*. The Desktop then accepts an EA from any computer once it proves the token, so there is no address to enter.
   - Copy the *EA token*.
6. **Give the EA the connection details,** in either of two ways:
   - **EA inputs:** `DesktopHost`, `DesktopPort`, `Token`.
   - **Connection file:** `MQL5\Files\DshBridge\connection.txt`, read when the inputs are empty. Lines starting with `#` are comments.

     ```
     host=127.0.0.1
     port=19500
     token=<the token copied from Settings>
     ```

   - **Precedence:** inputs win over the file. With neither address nor port set, the EA dials `127.0.0.1:19500`, so on the same computer the token is all it needs.
   - **When it applies:** the EA reads the connection file only when it starts. After changing the file, remove the EA from its chart and attach it again.
7. **Attach the EA:** drag DshBridge from Navigator → Expert Advisors onto any chart.
8. **Allow algo trading** (needed for trading): turn on the *Algo Trading* button in MT5's toolbar, and check *Allow Algo Trading* on the Common tab of the EA's properties. Watching the markets needs neither. The connection details in the Desktop show both, and the order ticket says which one is off.

Within a few seconds, the connection badge at the bottom of the market page turns to *Connected*:

- **Account:** the account and funds on the Account tab match MT5's Trade window.
- **Markets:** the market page shows the broker's symbols, quotes and bars.
- **Trading data:** positions, pending orders and history match MT5.
- **Connection security:** Settings → MT5 connection shows *TLS encrypted · certificate fingerprint*.

## Trading

- **Trading risk warning:** before the first trade, the Desktop shows the *Trading risk warning and disclaimer*. Trading starts once the user checks the box and agrees.
  - It applies alike to demo, contest and real accounts: once agreed, all of them trade, and a real account trades real money.
  - Agreeing does not carry out the action that brought up the warning; the user repeats it.
  - When the warning changes, the user agrees again.
  - Settings → MT5 connection shows the warning and withdraws the agreement. After withdrawing, the user cannot trade, but can still watch the markets.
- **Account type:** the order ticket tags the account beside the submit button: *Real*, *Demo* or *Contest*. The real tag stands out. Check it before every order.
- **What it does:**
  - Orders: market, limit and stop orders, with lots, take profit and stop loss.
  - Modify: a position's take profit and stop loss; a pending order's price, take profit and stop loss.
  - Cancel pending orders.
  - Close: a position in whole or in part, typing the lots in the position's row; by symbol or all positions, through a dialog that lists them with their total floating profit and then closes them one by one.
- **Checks:**
  - The order ticket checks the symbol's rules, which MT5 reports live: lots, the side of the market a pending price and the stops are on, the stops level, the symbol's trade mode and the order types it takes.
  - The EA checks the account, the permissions, the symbol's rules and the ticket, then runs `OrderCheck`, which checks the margin and the rest without trading. Lots and prices must sit on the symbol's lot step and tick size; the EA never adjusts them.
  - The broker's trade server decides last. The Desktop shows the reason of a refusal.
- **Order comment:** orders placed from the Desktop carry the comment `dsh:` and the first 8 characters of the request id, so they stand out in MT5. Some brokers rewrite comments.
- **No duplicate orders:**
  - One trade request at a time. Once a request is sent, its button stays off until the outcome arrives.
  - Each action has a new request id. The EA journals ids and runs each id at most once.
  - Nothing is ever resent on its own.
- **Unconfirmed outcome:** a request without an answer within 30 seconds, or whose connection drops while it waits, shows *Outcome unconfirmed*.
  - The request is not resent. The Desktop ends the connection. The EA reconnects only after MT5 has finished the request, and the positions and orders then show MT5's actual state.
  - Check the positions and the history to see whether the trade went through, then decide what to do.
- **Request journal:** the EA records each trade request and its outcome in `MQL5\Files\DshBridge\requests.log` in MT5's data folder, keeping the latest 1,000. The Desktop keeps no record of trade requests.
- **One EA per terminal:** a running EA holds the journal file. A second DshBridge in the same terminal stays offline.

## Markets and charts

- **Watchlist:** the first time the Desktop connects to a trade server, the watchlist takes the symbols of MT5's Market Watch window, in the same order. From then on, the watchlist, the chart symbol and the chart layout are kept per server, apart from the demo data's.
- **Market Watch changes:** the EA adds the symbols the Desktop shows (the watchlist and the chart) to MT5's Market Watch, because MT5 streams quotes only for the symbols there. The EA never removes them; hide the ones you do not need in MT5.
- **Bars:** bid prices, as on MT5 charts. The timeframes are MT5's own M1, M3, M5, M15, M30, H1, H2, H4, D1 and W1.
- **History:**
  - **What is there first:** when you open a symbol or switch timeframes, the chart first shows the bars MT5 already has, without waiting for older history. A symbol opened for the first time may show only the last few weeks at first.
  - **Background download:** when MT5 has less than a screen of bars, the EA has the terminal download older history in the background. Once that screen is complete, the chart reloads once.
  - **Scrolling back:** past the history MT5 has, the chart waits until the stretch has downloaded, so no bars are missing in between.
  - **No time limit:** a download takes as long as the network of MT5's computer needs. The Desktop waits for the data, and never takes a slow download for the end of the history.
  - **Same as MT5:** the oldest bar of a series that is still downloading may lack its earlier ticks, for example a week that starts on Wednesday. The EA sends that bar only once the history before it is there, so every bar on the chart matches MT5's.
  - **How far back:** as far as the server's first data, and MT5's *Max bars in chart* on the Charts tab of its options.
  - **Switching timeframes:** while the terminal downloads many years of a symbol's history, a timeframe of that symbol that was never opened may only show once the download ends.
- **Broker disconnect:** while MT5 is disconnected from its trade server, the watchlist shows that prices are paused. Once MT5 reconnects, the terminal fills in the missed bars and the chart reloads, matching MT5.
- **Times:**
  - The Desktop's chart shows local time, MT5's chart shows server time, so intraday bar labels differ by the difference between the two. For example, with the computer at UTC+8 and the server at UTC+2, they differ by 6 hours. The same bar has the same prices.
  - Daily and weekly bars follow the server's dates, as in MT5.
- **Daylight-saving time:** intraday bars, positions and deals are converted with the server's current offset, so intraday data from before the server's last daylight-saving switch is an hour off. Daily and weekly bars are not affected.
- **Sessions:** the chart runs around the clock (24x7), without gaps for closed markets. The watchlist's open state comes from MT5's trading sessions.

## Status

The EA shows its state in the top left corner of its chart:

| Text | Meaning |
|---|---|
| `Connecting...` | Connecting to the Desktop. |
| `Connected over TLS; authenticating...` | Encrypted; the EA and the Desktop are proving the token to each other. |
| `Connected over TLS: account … on …` | Connected and pushing the account. |
| An extra line `Trading is off: …` | Connected, but the EA cannot write its request journal, so it cannot trade. Watching the markets still works. |
| `Disconnected: …` or other text | Why it failed; see [Troubleshooting](#troubleshooting). |

- **Log:** the Experts log in MT5's Toolbox records each kind of failure once, and each successful connection.
- **Reconnecting:** after a failed connection, the EA retries after 1, 2 and 4 seconds, then every 5 seconds. After a token mismatch or a busy Desktop, it retries every 30 seconds.
- **Sync:** after a Desktop restart, an EA restart or a network outage, the EA reconnects and the Desktop syncs again.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `The terminal does not allow this address …` | Error 4014: the Desktop's address is not in the WebRequest list. | Add it, as in step 4. |
| `Cannot connect to …, error 5272` | The Desktop cannot be reached: it is not running, the port is wrong, LAN connections are off, or a firewall blocks the port. | Check the listening address in Settings → MT5 connection. |
| `TLS handshake with … failed, error …` | The Desktop is older than the EA and cannot speak TLS, or another program uses the port. | Update the Desktop, or check the port. |
| `Disconnected: auth_failed: …` | The EA's token differs from the Desktop's. | Copy the token again. *Regenerate* in Settings invalidates the old token at once. |
| `Disconnected: The Desktop did not prove the token: …` | The other side could not prove it holds the same token: the tokens differ, or something impersonates the Desktop. | Copy the token again. If the token is right and this persists, check that the EA's address and port really are the Desktop's. |
| `Disconnected: busy: …` | Another account's EA is connected to the Desktop. | Remove that EA first. |
| `No token: …` | Neither the inputs nor the connection file hold a token. | Set it, as in step 6. |
| `The terminal's cryptography failed its self-test …` | The terminal's hash functions give wrong results, so the EA cannot authenticate. | Update the MT5 terminal. |
| `cannot open DshBridge\requests.log …: DshBridge may already run on another chart …` | Another DshBridge runs in the same terminal. | Keep only one DshBridge. |
| The status shows `Trading is off: …` | The EA cannot write `MQL5\Files\DshBridge\requests.log`, for example because the disk is full or access is denied. | Fix the cause it names, then remove the EA from its chart and attach it again. |
| Settings shows *Last refused … TLS handshake failed* | The EA on the chart is older than 1.2.0 and cannot speak TLS. | Update and compile it as in steps 2 and 3, then remove it from its chart and attach it again. |
| The order ticket says *Orders are unavailable: Algo Trading is off in MT5*, or *"Allow Algo Trading" is off for the EA* | The *Algo Trading* button, or the EA's *Allow Algo Trading*, is off. | Turn it on, as in step 8. |
| The order ticket says *Read and agree to the trading risk warning before you trade.* | The warning has not been agreed to, or it changed. | Choose *Read and agree*. |
| A trade shows *Outcome unconfirmed* | The request got no answer within 30 seconds, or the connection dropped while it waited. | Check the positions and the history. The request is never resent; act again yourself if needed. |
| The chart and watchlist keep showing *Waiting for MT5 market data* | The EA is not connected yet, or still reads the symbol catalogue. | See the reason in the placeholder and in the connection details. |
| Scrolling back stops with no older bars | The server has no older data, or MT5's *Max bars in chart* is reached. | Raise *Max bars in chart* on the Charts tab of MT5's options, restart MT5, then switch the Desktop's chart to another symbol and back. |
| Older bars take long to appear after scrolling back | The terminal is downloading history from the server, at the speed of its network. | Wait for the download. If MT5 is disconnected from its trade server, wait until it reconnects. |
| After a timeframe switch, the chart dims and takes long to show the new timeframe | The terminal is downloading many years of the symbol's history and builds the timeframe only after that. | Wait for the download to end. |
| Compiling the EA cannot find `DshBridgeLoader.ex5` | The indicator has not been compiled. | Compile `MQL5\Indicators\DshBridgeLoader.mq5` first. |
| It does not run in the Strategy Tester | The tester has no network. | Run it on a live chart only. |

## Security

- **Encryption:** the EA and the Desktop always use TLS; there is no plain-text fallback. The Desktop's certificate is self-signed and kept with its private key in `mt5-bridge-tls.json` in the Desktop's user folder, readable only by the current user.
- **Mutual authentication:** the token never crosses the network; it only computes proofs. Each side proves it holds the token, and the proofs bind the certificate fingerprint the EA saw, so a man in the middle can impersonate neither the Desktop nor the EA.
- **Signed trades:** every trade request is signed with the session key of its connection, and the EA checks the signature before it acts. A request recorded on another connection fails the check when replayed.
- **Token:** kept in `mt5-bridge.json` in the Desktop's user folder, readable only by the current user, and never in the preferences. Whoever has the token can impersonate either side, so keep it to yourself. If it may have leaked, regenerate it in Settings → MT5 connection; the old token stops working at once.
- **LAN:** by default the Desktop accepts connections from its own computer only. With *Allow LAN connections*, any computer on the network can reach its port, and only an EA that proves the token gets a session. A computer without the token can still delay the EA's connection by opening connections of its own, so leave LAN connections off when MT5 runs on the same computer.
- **The computers themselves:** none of this protects a computer running MT5 or the Desktop that is itself compromised.
