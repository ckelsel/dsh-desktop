/**
 * Trading interface of the market page, shaped after a MetaTrader 5 terminal: the account, positions
 * by ticket (a hedging account holds several per symbol), pending orders, order and deal history,
 * and trade requests the terminal executes. The account snapshot changes when the terminal reports
 * the outcome. The Desktop's MT5 bridge implements this interface; until it exists a mock account
 * supplies display data. Money is in the account currency; sizes are lots.
 */
import { stepDecimals, type MarketSymbol, type Quote } from './market-data.ts'

export type Side = 'buy' | 'sell'
/** What the order ticket sends: a market deal, or a limit or stop pending order. */
export type OrderType = 'market' | 'limit' | 'stop'
export type PendingType = Exclude<OrderType, 'market'>

/** Exit prices; null when unset. */
export interface Brackets {
  takeProfit: number | null
  stopLoss: number | null
}

export interface AccountInfo {
  login: string
  name: string
  server: string
  currency: string
  leverage: number
  mode: 'demo' | 'real'
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
  lots: number
  price: number
  /** The touch the order waits on: the ask for a buy order, the bid for a sell order. */
  currentPrice: number
  placedAt: number
  comment: string
}

export interface HistoryOrder {
  ticket: string
  ticker: string
  side: Side
  type: OrderType
  lots: number
  /** Requested price; null for a market order. */
  price: number | null
  fillPrice: number | null
  state: 'filled' | 'cancelled' | 'rejected' | 'expired'
  placedAt: number
  doneAt: number
}

/** A fill: `in` opens or adds to a position, `out` closes or reduces one. */
export interface Deal {
  ticket: string
  orderTicket: string
  positionTicket: string
  ticker: string
  side: Side
  entry: 'in' | 'out'
  lots: number
  price: number
  profit: number
  commission: number
  swap: number
  time: number
}

export interface TradingSnapshot {
  /** Where the account comes from and whether it is reachable. */
  connection: { source: 'mt5' | 'mock'; status: 'connected' | 'connecting' | 'disconnected' }
  account: AccountInfo | null
  positions: readonly Position[]
  orders: readonly PendingOrder[]
  /** Finished orders, newest first. */
  history: readonly HistoryOrder[]
  /** Fills, newest first. */
  deals: readonly Deal[]
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
 * refused by the terminal or the server, `offline` not sent because no terminal is connected.
 */
export interface TradeResult {
  status: 'done' | 'placed' | 'rejected' | 'offline'
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
