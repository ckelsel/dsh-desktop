/**
 * What the MT5 bridge shares with the preload and the market page: IPC channel names, the public
 * bridge status, and the terminal data the EA reports. Types and constants only, so renderer
 * bundles import it without Node. The wire protocol itself is specified in `mt5/PROTOCOL.md` at
 * the repository root; its snake_case fields are camelCase here.
 */

/** IPC channels between the main process bridge and the application renderer. */
export const MT5_IPC = {
  status: 'dsh-mt5:status',
  statusChanged: 'dsh-mt5:status-changed',
  resync: 'dsh-mt5:resync',
  request: 'dsh-mt5:request',
  token: 'dsh-mt5:token',
  regenerateToken: 'dsh-mt5:regenerate-token',
  catalog: 'dsh-mt5:catalog',
  catalogChanged: 'dsh-mt5:catalog-changed',
  trading: 'dsh-mt5:trading',
  tradingChanged: 'dsh-mt5:trading-changed',
  subscribe: 'dsh-mt5:subscribe',
  ticks: 'dsh-mt5:ticks',
  bars: 'dsh-mt5:bars',
  tradeEvents: 'dsh-mt5:trade-events',
  historyBars: 'dsh-mt5:history-bars',
  historyTrades: 'dsh-mt5:history-trades',
  trade: 'dsh-mt5:trade',
  symbolInfo: 'dsh-mt5:symbol-info',
  acceptDisclaimer: 'dsh-mt5:accept-disclaimer',
  withdrawDisclaimer: 'dsh-mt5:withdraw-disclaimer',
} as const

/** Port the bridge listens on unless the user picks another. */
export const MT5_DEFAULT_PORT = 19500

/** The oldest EA the Desktop works with: 1.2.0 brought protocol 2 (TLS, mutual authentication and
 * signed trade requests). An older EA speaks plain TCP and fails the TLS handshake. */
export const MT5_MIN_EA_VERSION = '1.2.0'

/** The trading risk disclaimer's version. A change of substance raises it, and every user agrees again. */
export const MT5_DISCLAIMER_VERSION = 1

/** Subscriptions the page may hold at once. */
export const MT5_MAX_QUOTES = 200
export const MT5_MAX_BAR_STREAMS = 20
/** Most bars one history request returns. */
export const MT5_MAX_HISTORY_BARS = 5000

/**
 * Where the bridge stands:
 * - `disabled`: turned off in settings, or Safe Mode.
 * - `error`: it could not listen, for example because the port is taken.
 * - `listening`: waiting for the EA.
 * - `handshaking`: an EA connected and has not authenticated yet.
 * - `syncing`: the EA authenticated; the account state is being read.
 * - `ready`: the account state is in sync.
 */
export type Mt5BridgePhase = 'disabled' | 'error' | 'listening' | 'handshaking' | 'syncing' | 'ready'

/**
 * Why new trades are refused, in the order the UI reports them:
 * - `bridge-disabled`, `bridge-error`, `ea-disconnected`, `syncing`: the bridge is not ready.
 * - `broker-disconnected`: the terminal lost its trade server.
 * - `terminal-trade-disabled`: the terminal's Algo Trading button is off.
 * - `ea-trade-disabled`: the EA's own "Allow Algo Trading" option is off.
 * - `account-trade-disabled`: the account cannot trade, for example with the investor password.
 * - `account-expert-disabled`: the broker forbids Expert Advisors on this account.
 * - `disclaimer`: the user has not agreed to the current trading risk disclaimer.
 */
export type Mt5BlockReason =
  | 'bridge-disabled' | 'bridge-error' | 'ea-disconnected' | 'syncing'
  | 'broker-disconnected' | 'terminal-trade-disabled' | 'ea-trade-disabled'
  | 'account-trade-disabled' | 'account-expert-disabled' | 'disclaimer'

/** Why the bridge turned a connection away. `tls`: the TLS handshake failed, as it does for an EA older than `MT5_MIN_EA_VERSION`. */
export type Mt5RejectReason = 'tls' | 'token' | 'protocol' | 'busy' | 'handshake-timeout' | 'invalid'

/** The EA session in use. */
export interface Mt5Peer {
  address: string
  port: number
  eaVersion: string
  /** Unix ms. */
  connectedAt: number
}

/** Terminal side of `system.status`. */
export interface Mt5TerminalStatus {
  /** Connected to the broker's trade server (`TERMINAL_CONNECTED`). */
  connected: boolean
  /** The terminal's Algo Trading button (`TERMINAL_TRADE_ALLOWED`). */
  tradeAllowed: boolean
  /** The EA's own permission (`MQL_TRADE_ALLOWED`). */
  eaTradeAllowed: boolean
  build: number
  name: string
  company: string
  /** Last ping to the trade server; null when the terminal has none. */
  pingMs: number | null
  /** Trade server time minus UTC, in seconds. */
  serverUtcOffset: number
}

/** `account.snapshot`, money in the account currency. */
export interface Mt5Account {
  login: string
  name: string
  server: string
  /** The broker. */
  company: string
  currency: string
  currencyDigits: number
  leverage: number
  tradeMode: 'demo' | 'contest' | 'real'
  /** `exchange` nets positions like `netting`, under exchange rules. */
  marginMode: 'netting' | 'exchange' | 'hedging'
  /** `ACCOUNT_TRADE_ALLOWED`. */
  tradeAllowed: boolean
  /** `ACCOUNT_TRADE_EXPERT`. */
  tradeExpert: boolean
  /** Pending order limit; 0 means none. */
  limitOrders: number
  balance: number
  credit: number
  profit: number
  equity: number
  margin: number
  marginFree: number
  /** Percent; null while no margin is in use. */
  marginLevel: number | null
  /** Margin call and stop out levels, in `marginSoMode` units. */
  marginCall: number
  stopOut: number
  marginSoMode: 'percent' | 'money'
}

/** One symbol of the broker's catalogue (`symbols.list`). */
export interface Mt5Symbol {
  name: string
  description: string
  /** The broker's folder path, such as `Forex\Majors\EURUSD`. */
  path: string
  currencyBase: string
  currencyProfit: string
  currencyMargin: string
  digits: number
  point: number
  /** Smallest price change (`SYMBOL_TRADE_TICK_SIZE`). */
  tickSize: number
  contractSize: number
  volumeMin: number
  volumeMax: number
  volumeStep: number
  tradeMode: 'disabled' | 'long_only' | 'short_only' | 'close_only' | 'full'
  /** `SYMBOL_TRADE_CALC_MODE` without its prefix, such as `forex` or `cfdindex`. */
  calcMode: string
  /** `SYMBOL_SECTOR` without its prefix, such as `currency` or `indexes`. */
  sector: string
  /** In the Market Watch window. */
  selected: boolean
}

/** The catalogue of the connected trade server. */
export interface Mt5Catalog {
  /** The trade server the symbols belong to. */
  server: string
  symbols: readonly Mt5Symbol[]
  /** The Market Watch symbols, in the window's order. */
  watch: readonly string[]
}

/** MT5 timeframes the bridge serves. */
export type Mt5Timeframe = 'M1' | 'M3' | 'M5' | 'M15' | 'M30' | 'H1' | 'H2' | 'H4' | 'D1' | 'W1'
export const MT5_TIMEFRAMES: readonly Mt5Timeframe[] = ['M1', 'M3', 'M5', 'M15', 'M30', 'H1', 'H2', 'H4', 'D1', 'W1']

/** A quote of a subscribed symbol (`market.tick`); the day's figures are null until MT5 has them. */
export interface Mt5Tick {
  symbol: string
  /** Unix ms. */
  time: number
  bid: number
  ask: number
  dayOpen: number | null
  dayHigh: number | null
  dayLow: number | null
  /** The previous day's close. */
  prevClose: number | null
  /** Ticks today. */
  dayVolume: number | null
  /** Within the symbol's trading sessions. */
  sessionOpen: boolean
}

/** One bid bar. Intraday bars open at their UTC moment; daily and weekly bars at 00:00 UTC of their server date. */
export interface Mt5BarData {
  /** Unix ms. */
  time: number
  open: number
  high: number
  low: number
  close: number
  /** Tick volume. */
  volume: number
}

/** The current bar of a subscribed stream (`market.bar`). */
export interface Mt5Bar extends Mt5BarData {
  symbol: string
  timeframe: Mt5Timeframe
}

export interface Mt5BarStream {
  symbol: string
  timeframe: Mt5Timeframe
}

/** Everything the page streams: replaced as a whole on each change. */
export interface Mt5Subscription {
  quotes: readonly string[]
  bars: readonly Mt5BarStream[]
}

export interface Mt5HistoryBarsRequest extends Mt5BarStream {
  /** Bars that open before this Unix ms. */
  to: number
  count: number
}

/** How a history request waits for the terminal. */
export interface Mt5HistoryBarsOptions {
  /**
   * Answer with the bars the terminal has while it still downloads older ones of the page,
   * instead of once it has all of them; default false. Either way the answer waits while the
   * terminal builds the series.
   */
  partial?: boolean
}

export interface Mt5HistoryBars {
  /** Oldest first. */
  bars: readonly Mt5BarData[]
  /** No bars open before `to`. */
  noData: boolean
  /** Older bars of the page are still downloading, and asking again returns them; only for a partial request. */
  partial?: boolean
}

export type Mt5PendingType = 'buy_limit' | 'sell_limit' | 'buy_stop' | 'sell_stop' | 'buy_stop_limit' | 'sell_stop_limit'
export type Mt5OrderType = 'buy' | 'sell' | Mt5PendingType | 'close_by'

/** An open position; prices in the symbol's, money in the account currency. */
export interface Mt5Position {
  ticket: string
  symbol: string
  side: 'buy' | 'sell'
  volume: number
  priceOpen: number
  sl: number | null
  tp: number | null
  priceCurrent: number
  profit: number
  swap: number
  /** Unix ms. */
  time: number
  comment: string
  magic: number
}

/** A pending order. */
export interface Mt5Order {
  ticket: string
  symbol: string
  type: Mt5PendingType
  /** `ORDER_STATE` without its prefix, such as `placed` or `request_modify`. */
  state: string
  /** Lots not yet filled. */
  volume: number
  volumeInitial: number
  /** The trigger price; for a stop-limit order, the stop price. */
  price: number
  /** The limit price a stop-limit order places once triggered. */
  stopLimit: number | null
  sl: number | null
  tp: number | null
  priceCurrent: number
  /** Unix ms. */
  time: number
  /** `gtc`, `day`, `specified` or `specified_day`. */
  timeType: string
  /** Unix ms; null for none. */
  expiration: number | null
  comment: string
  magic: number
}

/** Open positions and pending orders of the session in use. */
export interface Mt5Trading {
  positions: readonly Mt5Position[]
  orders: readonly Mt5Order[]
}

/** A finished order (`history.query`). */
export interface Mt5HistoryOrder {
  ticket: string
  symbol: string
  type: Mt5OrderType
  /** `ORDER_STATE` without its prefix, such as `filled`, `canceled` or `expired`. */
  state: string
  volumeInitial: number
  /** Lots left unfilled. */
  volumeCurrent: number
  /** The requested price; null when MT5 reports none. */
  price: number | null
  stopLimit: number | null
  sl: number | null
  tp: number | null
  /** Unix ms. */
  timeSetup: number
  timeDone: number
  position: string | null
  /** The opposite position of a close-by order. */
  positionBy: string | null
  /** `ORDER_REASON` without its prefix: `client`, `mobile`, `web`, `expert`, `sl`, `tp` or `so`. */
  reason: string
  comment: string
  magic: number
}

/** A deal: a trade fill, or a balance operation such as a deposit. */
export interface Mt5Deal {
  ticket: string
  order: string | null
  position: string | null
  /** Empty for balance operations. */
  symbol: string
  /** `DEAL_TYPE` without its prefix: `buy` and `sell` are trades; the rest, such as `balance`,
   * `credit`, `commission` or `dividend`, are balance operations. */
  type: string
  entry: 'in' | 'out' | 'inout' | 'out_by'
  volume: number
  price: number
  commission: number
  swap: number
  fee: number
  profit: number
  /** Unix ms. */
  time: number
  /** `DEAL_REASON` without its prefix, such as `client`, `mobile`, `sl`, `tp` or `so`. */
  reason: string
  comment: string
  magic: number
}

/** Orders and deals of a time range, newest first. */
export interface Mt5TradeHistory {
  orders: readonly Mt5HistoryOrder[]
  deals: readonly Mt5Deal[]
  /** The EA left out the oldest rows to stay within its limits. */
  truncated: boolean
}

/** A new deal or finished order (`trade.event`); history covering it is out of date. */
export interface Mt5TradeEvent {
  type: 'deal_add' | 'history_add'
  deal: string | null
  order: string | null
  position: string | null
  symbol: string
}

/** The account a trade request is meant for; the EA refuses it on any other (`account_mismatch`). */
export interface Mt5AccountKey {
  login: string
  server: string
}

/**
 * A trade request from the page. Lots and prices must sit on the symbol's grid, since the EA refuses
 * rather than rounds them; a null `sl` or `tp` means none. Market deals accept the EA's default slippage.
 */
export type Mt5TradeInput =
  | { type: 'order.place'; account: Mt5AccountKey; symbol: string; side: 'buy' | 'sell'; orderType: 'market' | 'limit' | 'stop'
    volume: number; price: number | null; sl: number | null; tp: number | null }
  | { type: 'position.close'; account: Mt5AccountKey; symbol: string; ticket: string; volume: number }
  | { type: 'position.modify'; account: Mt5AccountKey; symbol: string; ticket: string; sl: number | null; tp: number | null }
  | { type: 'order.modify'; account: Mt5AccountKey; symbol: string; ticket: string; price: number; sl: number | null; tp: number | null }
  | { type: 'order.cancel'; account: Mt5AccountKey; symbol: string; ticket: string }

export type Mt5TradeType = Mt5TradeInput['type']

/**
 * What a trade request came to:
 * - `done`: executed or applied; `placed`: a pending order placed, or a market order MT5 fills later;
 * - `rejected`: refused by MT5, the EA or the Desktop, so nothing changed;
 * - `unknown`: sent, but the outcome is unconfirmed: MT5's positions, orders and history tell what happened;
 * - `blocked`: not sent, because of `blocked`.
 */
export interface Mt5TradeOutcome {
  status: 'done' | 'placed' | 'rejected' | 'unknown' | 'blocked'
  /** The request id; null when the Desktop sent nothing. */
  id: string | null
  blocked: Mt5BlockReason | null
  /** `TRADE_RETCODE_*`; 0 when the EA or the Desktop answered without MT5. */
  retcode: number
  /**
   * `sent` for OrderSend's answer and `check` for OrderCheck's, with `retcode`; otherwise why the EA or the
   * Desktop refused, such as `account_mismatch`, `busy`, `invalid_volume`, `journal_unavailable`, or why the
   * outcome is unknown: `timeout`, `disconnected`, `interrupted`.
   */
  code: string
  /** MT5's comment, or the reason in English. */
  message: string
  order: string | null
  deal: string | null
  /** The deal price. */
  price: number | null
  /** The lots filled, fewer than requested after a partial fill. */
  volume: number | null
  /** The EA had run this id before; this is that run's outcome. */
  duplicate: boolean
}

/** A symbol's trade rules (`symbol.info`). Levels are in points; 0 lets the trade server decide. */
export interface Mt5SymbolInfo {
  symbol: string
  digits: number
  point: number
  tickSize: number
  contractSize: number
  volumeMin: number
  volumeMax: number
  volumeStep: number
  /** Most lots open and pending in one direction; 0 for no limit. */
  volumeLimit: number
  /** Least distance of stops and pending prices from the market. */
  stopsLevel: number
  /** Distance from the market within which an order or a position's stops may not change. */
  freezeLevel: number
  tradeMode: 'full' | 'long_only' | 'short_only' | 'close_only' | 'disabled'
  /** `SYMBOL_TRADE_EXECUTION_*` without its prefix: `request`, `instant`, `market` or `exchange`. */
  execution: string
  /** Order types and stops the symbol takes: `market`, `limit`, `stop`, `stop_limit`, `sl`, `tp`, `close_by`. */
  orderModes: readonly string[]
  /** Margin of one lot at the current price, in the account currency; null when MT5 cannot tell. */
  marginBuy: number | null
  marginSell: number | null
  /** The symbol is in a trading session now. */
  sessionOpen: boolean
}

/** Public bridge status: everything except the token. */
export interface Mt5Status {
  phase: Mt5BridgePhase
  /** Where the bridge listens and the LAN addresses an EA may use; null while it does not listen. */
  listen: { host: string; port: number; addresses: readonly string[] } | null
  /** Why listening failed, in phase `error`. */
  error: string | null
  peer: Mt5Peer | null
  terminal: Mt5TerminalStatus | null
  account: Mt5Account | null
  /** Empty when new trades may be sent. */
  blocked: readonly Mt5BlockReason[]
  /** When the last full sync finished (Unix ms). */
  syncedAt: number | null
  /** The last connection the bridge turned away, for setup diagnostics. */
  lastRejection: { address: string; reason: Mt5RejectReason; at: number } | null
  /** The bridge certificate: the EA reads the same SHA-1 fingerprint (lowercase hex) from the connection. */
  tls: { fingerprint: string } | null
  /** The disclaimer version the user agreed to, and when (Unix ms); null until they agree to the current one. */
  disclaimer: { version: number; acceptedAt: number } | null
}

/** The renderer API the preload exposes as `window.dshMt5`. */
export interface Mt5RendererBridge {
  status(): Promise<Mt5Status>
  /** @returns the unsubscribe function. */
  onStatus(listener: (status: Mt5Status) => void): () => void
  resync(): Promise<void>
  request(type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>
  token(): Promise<string>
  regenerateToken(): Promise<string>
  /** The catalogue of the trade server last synced; null before the first sync, or while the bridge is off. */
  catalog(): Promise<Mt5Catalog | null>
  onCatalog(listener: (catalog: Mt5Catalog | null) => void): () => void
  /** Positions and orders of the session in use; null while none is in sync. */
  trading(): Promise<Mt5Trading | null>
  onTrading(listener: (trading: Mt5Trading | null) => void): () => void
  /** Replace the page's quote and bar subscriptions. */
  subscribe(subscription: Mt5Subscription): Promise<void>
  onTicks(listener: (ticks: readonly Mt5Tick[]) => void): () => void
  onBars(listener: (bars: readonly Mt5Bar[]) => void): () => void
  onTradeEvents(listener: (events: readonly Mt5TradeEvent[]) => void): () => void
  historyBars(request: Mt5HistoryBarsRequest, options?: Mt5HistoryBarsOptions): Promise<Mt5HistoryBars>
  /** Orders and deals with times in [from, to), Unix ms. */
  historyTrades(range: { from: number; to: number }): Promise<Mt5TradeHistory>
  /** Send a trade request once, never again; the trading gate is checked first. */
  trade(input: Mt5TradeInput): Promise<Mt5TradeOutcome>
  symbolInfo(symbol: string): Promise<Mt5SymbolInfo>
  acceptDisclaimer(): Promise<void>
  withdrawDisclaimer(): Promise<void>
}
