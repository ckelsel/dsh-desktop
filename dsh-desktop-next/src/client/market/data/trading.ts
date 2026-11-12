/**
 * Trading interface of the market page, shaped after a MetaTrader 5 terminal: the account, positions
 * by ticket (a hedging account holds several per symbol), pending orders, the order and deal history
 * of a chosen period, and trade requests the terminal executes. The account snapshot changes when the
 * terminal reports the outcome. The Desktop's MT5 bridge implements this interface; without it a
 * demo account supplies display data. Money is in the account currency; sizes are lots.
 */
import type { Mt5BlockReason, Mt5Status } from '../../../mt5/contract.ts'
import { stepDecimals, type MarketSymbol, type Quote } from './market-data.ts'

export type Side = 'buy' | 'sell'
/** What the order ticket sends: a market deal, or a limit or stop pending order. */
export type OrderType = 'market' | 'limit' | 'stop'
/** A pending order: limit, stop, or a stop that places a limit order once triggered. */
export type PendingType = 'limit' | 'stop' | 'stopLimit'
/** A finished order's type; `closeBy` closes a position by an opposite one. */
export type HistoryOrderType = 'market' | PendingType | 'closeBy'

/** Exit prices; null when unset. */
export interface Brackets {
  takeProfit: number | null
  stopLoss: number | null
}

export interface AccountInfo {
  login: string
  name: string
  server: string
  /** The broker. */
  company: string
  currency: string
  leverage: number
  mode: 'demo' | 'contest' | 'real'
  /** Hedging keeps a position per opening deal; netting one position per symbol. */
  accounting: 'hedging' | 'netting'
  balance: number
  credit: number
  /** Balance and credit plus floating profit and swap. */
  equity: number
  /** Floating profit of the open positions. */
  profit: number
  margin: number
  freeMargin: number
  /** Equity over margin in percent; null while no margin is in use. */
  marginLevel: number | null
}

export interface Position extends Brackets {
  ticket: string
  ticker: string
  side: Side
  lots: number
  openPrice: number
  /** Closing price: the bid for a long position, the ask for a short one. */
  currentPrice: number
  /** Floating profit, without swap. */
  profit: number
  swap: number
  openTime: number
  comment: string
}

export interface PendingOrder extends Brackets {
  ticket: string
  ticker: string
  side: Side
  type: PendingType
  /** Lots still to fill. */
  lots: number
  /** The trigger price; for a stop-limit order, the stop price. */
  price: number
  /** The limit price a stop-limit order places once triggered; null for other types. */
  stopLimit: number | null
  /** The touch the order waits on: the ask for a buy order, the bid for a sell order. */
  currentPrice: number
  placedAt: number
  comment: string
}

export interface HistoryOrder {
  ticket: string
  ticker: string
  /** Null for a close-by order, which has no side of its own. */
  side: Side | null
  type: HistoryOrderType
  /** Lots requested. */
  lots: number
  /** Requested price; null for a market order. */
  price: number | null
  /** The limit price of a stop-limit order. */
  stopLimit: number | null
  /** Average price of the order's deals, weighted by lots; null without deals. */
  fillPrice: number | null
  /** `partial`: cancelled after filling part of its lots; `placed`: still being processed. */
  state: 'filled' | 'partial' | 'cancelled' | 'rejected' | 'expired' | 'placed'
  placedAt: number
  doneAt: number
}

/** How a deal changes its position: `in` opens or adds, `out` closes or reduces, `inout` reverses a
 * netting position, `outBy` closes it by an opposite position. */
export type DealEntry = 'in' | 'out' | 'inout' | 'outBy'

/** A deal: a fill of an order, or a balance operation such as a deposit. */
export interface Deal {
  ticket: string
  /** Null for a balance operation. */
  orderTicket: string | null
  positionTicket: string | null
  /** Empty for a balance operation. */
  ticker: string
  kind: 'trade' | 'balance'
  /** A balance operation's MT5 deal type, such as `balance` (a deposit or withdrawal), `credit`,
   * `charge`, `bonus` or `commission`; null for a trade. */
  operation: string | null
  /** Null for a balance operation. */
  side: Side | null
  entry: DealEntry | null
  lots: number
  price: number
  profit: number
  commission: number
  swap: number
  /** Other charges on the deal. */
  fee: number
  /** What made the deal, the MT5 deal reason such as `client`, `mobile`, `web`, `expert`, `sl`, `tp` or `so`. */
  reason: string
  time: number
}

/** History periods; `custom` runs between two chosen dates. */
export type HistoryPeriod = 'today' | 'week' | 'month' | 'quarter' | 'custom'
export const HISTORY_PERIODS: readonly HistoryPeriod[] = ['today', 'week', 'month', 'quarter', 'custom']

/** The history the page asks for; `from` and `to` are the local dates (`YYYY-MM-DD`, both included) of a custom period. */
export interface HistorySelection {
  period: HistoryPeriod
  from: string
  to: string
}

export const DEFAULT_HISTORY: HistorySelection = Object.freeze({ period: 'week', from: '', to: '' })

/** Where the history of the selected period stands. */
export interface HistoryState {
  selection: HistorySelection
  status: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  /** MT5 left out the oldest rows of a long period. */
  truncated: boolean
}

/**
 * Why a provider refuses new trades: an MT5 bridge reason, or `unsupported` while this build
 * sends no trade requests to MT5 yet.
 */
export type TradeBlock = Mt5BlockReason | 'unsupported'

/** Where the account comes from, whether it is reachable, and whether it takes new trades. */
export interface TradingConnection {
  source: 'mt5' | 'mock'
  status: 'connected' | 'connecting' | 'disconnected'
  /** Reasons new trades are refused, in reporting order; empty when they may be sent. */
  blocked: readonly TradeBlock[]
  /** The MT5 bridge's status; null for the mock account. */
  mt5: Mt5Status | null
}

export interface TradingSnapshot {
  connection: TradingConnection
  account: AccountInfo | null
  positions: readonly Position[]
  orders: readonly PendingOrder[]
  /** Finished orders of the selected period, newest first. */
  history: readonly HistoryOrder[]
  /** Deals of the selected period, newest first. */
  deals: readonly Deal[]
  historyState: HistoryState
}

export interface TradeRequest extends Brackets {
  ticker: string
  side: Side
  type: OrderType
  lots: number
  /** Pending order price; null for a market order. */
  price: number | null
  /** Slippage a market order accepts, in points. */
  deviation: number
  comment: string
}

/**
 * Outcome of a request: `done` filled or applied, `placed` a pending order accepted, `rejected`
 * refused by the terminal or the server, `offline` not sent by the demo account, `blocked` not sent
 * because of `blocked` (see `TradingConnection.blocked`).
 */
export interface TradeResult {
  status: 'done' | 'placed' | 'rejected' | 'offline' | 'blocked'
  /** Why a `blocked` request was not sent. */
  blocked?: TradeBlock
  /** MT5 `TRADE_RETCODE_*` when the terminal answered. */
  retcode: number | null
  /** The terminal's comment, when it gave one. */
  message: string
  orderTicket: string | null
  price: number | null
}

export interface TradingProvider {
  getSnapshot(): TradingSnapshot
  subscribe(listener: () => void): () => void
  sendOrder(request: TradeRequest): Promise<TradeResult>
  /** Close a position or part of it at the market. */
  closePosition(ticket: string, lots?: number): Promise<TradeResult>
  modifyPosition(ticket: string, brackets: Brackets): Promise<TradeResult>
  modifyOrder(ticket: string, changes: { price: number } & Brackets): Promise<TradeResult>
  cancelOrder(ticket: string): Promise<TradeResult>
  /** Read the account state from the terminal again; absent when there is no terminal. */
  resync?(): Promise<void>
  /** Show the history of another period. */
  setHistoryPeriod(selection: HistorySelection): void
  /** Read the history of the selected period again. */
  refreshHistory(): void
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** The local date of a time, as `YYYY-MM-DD`. */
export function localDate(time: number): string {
  const date = new Date(time)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Local midnight of a `YYYY-MM-DD` date, plus `days`; null when it is not a date. */
function localMidnight(text: string, days = 0): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])]
  const date = new Date(year, month, day)
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/**
 * The bounds of a history period in local time, Unix ms (`from` included, `to` not). Today, this
 * week (from Monday), this month and the last three months run to the end of today; a custom period
 * whose dates are missing or reversed falls back to this week.
 */
export function historyRange(selection: HistorySelection, now: number): { from: number; to: number } {
  const date = new Date(now)
  const [year, month, day] = [date.getFullYear(), date.getMonth(), date.getDate()]
  const end = new Date(year, month, day + 1).getTime()
  const week = { from: new Date(year, month, day - (date.getDay() + 6) % 7).getTime(), to: end }
  switch (selection.period) {
    case 'today': return { from: new Date(year, month, day).getTime(), to: end }
    case 'week': return week
    case 'month': return { from: new Date(year, month, 1).getTime(), to: end }
    case 'quarter': return { from: new Date(year, month - 3, day).getTime(), to: end }
    case 'custom': {
      const from = localMidnight(selection.from)
      const to = localMidnight(selection.to, 1)
      return from === null || to === null || to <= from ? week : { from, to }
    }
  }
}

/** Look up quotes by ticker. */
export type QuoteLookup = (ticker: string) => Quote | undefined

/**
 * Value of one unit of `currency` in the account currency, from mid prices.
 * @returns the rate, or null when no quote converts the currency.
 */
export function conversionRate(currency: string, account: string, quote: QuoteLookup): number | null {
  if (currency === account) return 1
  const direct = quote(`${currency}${account}`)
  if (direct !== undefined && direct.last > 0) return direct.last
  const inverse = quote(`${account}${currency}`)
  if (inverse !== undefined && inverse.last > 0) return 1 / inverse.last
  return null
}

/** Tickers whose quotes may convert a symbol's quote currency into the account currency. */
export function conversionTickers(symbol: Pick<MarketSymbol, 'currency'>, account: string): string[] {
  return symbol.currency === account ? [] : [`${symbol.currency}${account}`, `${account}${symbol.currency}`]
}

export const direction = (side: Side): 1 | -1 => side === 'buy' ? 1 : -1
export const opposite = (side: Side): Side => side === 'buy' ? 'sell' : 'buy'

/** Account-currency value of one pip for `lots`. */
export function pipValue(symbol: Pick<MarketSymbol, 'pip' | 'contractSize'>, lots: number, rate: number): number {
  return symbol.pip * symbol.contractSize * lots * rate
}

/** Margin a position of `lots` at `price` requires. */
export function marginFor(symbol: Pick<MarketSymbol, 'contractSize'>, lots: number, price: number, rate: number, leverage: number): number {
  return symbol.contractSize * lots * price * rate / leverage
}

/** Account-currency profit of moving `lots` from `open` to `close`. */
export function profitFor(symbol: Pick<MarketSymbol, 'contractSize'>, side: Side, lots: number, open: number, close: number, rate: number): number {
  return (close - open) * direction(side) * symbol.contractSize * lots * rate
}

/** Pips gained from `open` to `close` in the direction of `side`. */
export function pipsBetween(symbol: Pick<MarketSymbol, 'pip'>, side: Side, open: number, close: number): number {
  return (close - open) * direction(side) / symbol.pip
}

/** The price a market order of `side` fills at. */
export const entryPrice = (quote: Pick<Quote, 'bid' | 'ask'>, side: Side): number => side === 'buy' ? quote.ask : quote.bid
/** The price a position of `side` closes at. */
export const exitPrice = (quote: Pick<Quote, 'bid' | 'ask'>, side: Side): number => side === 'buy' ? quote.bid : quote.ask

/** Which exit, if any, sits on the wrong side of the reference price. */
export function bracketError(side: Side, reference: number, brackets: Partial<Brackets>): 'takeProfit' | 'stopLoss' | null {
  const sign = direction(side)
  const { takeProfit, stopLoss } = brackets
  if (takeProfit !== undefined && takeProfit !== null && !(Number.isFinite(takeProfit) && (takeProfit - reference) * sign > 0)) return 'takeProfit'
  if (stopLoss !== undefined && stopLoss !== null && !(Number.isFinite(stopLoss) && (reference - stopLoss) * sign > 0)) return 'stopLoss'
  return null
}

/**
 * Whether a pending price sits where MT5 accepts it: a buy limit below the ask, a sell limit above
 * the bid, a buy stop above the ask, a sell stop below the bid.
 */
export function pendingPriceValid(side: Side, type: PendingType, price: number, quote: Pick<Quote, 'bid' | 'ask'>): boolean {
  if (!Number.isFinite(price) || price <= 0) return false
  if (type === 'limit') return side === 'buy' ? price < quote.ask : price > quote.bid
  return side === 'buy' ? price > quote.ask : price < quote.bid
}

/** Whether `lots` is within the symbol's bounds and on its step. */
export function lotsValid(symbol: Pick<MarketSymbol, 'minLots' | 'maxLots' | 'lotStep'>, lots: number): boolean {
  if (!Number.isFinite(lots) || lots < symbol.minLots - 1e-9 || lots > symbol.maxLots + 1e-9) return false
  const steps = lots / symbol.lotStep
  return Math.abs(steps - Math.round(steps)) < 1e-6
}

/** Round a lot amount to the symbol's step decimals, removing float noise. */
export function roundLots(symbol: Pick<MarketSymbol, 'lotStep'>, lots: number): number {
  return Number(lots.toFixed(stepDecimals(symbol.lotStep)))
}
