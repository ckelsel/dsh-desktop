/**
 * Display data standing in for an MT5 account where none is connected (a browser session, or the
 * Desktop with its MT5 bridge turned off): a demo account with a deposit, a few positions, pending
 * orders and closed trades placed around the current mock quotes. Floating profit, margin and equity
 * follow live quotes; the history shows the selected period. Requests are not executed: every
 * request answers `offline`.
 */
import { roundPrice, type MarketDataProvider, type MarketSymbol, type Quote } from './market-data.ts'
import {
  conversionRate, conversionTickers, DEFAULT_HISTORY, entryPrice, exitPrice, historyRange, marginFor, profitFor,
  type AccountInfo, type Deal, type HistoryOrder, type HistorySelection, type PendingOrder, type Position, type Side,
  type TradeResult, type TradingProvider, type TradingSnapshot,
} from './trading.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export interface MockTradingOptions {
  market: MarketDataProvider
  now?: () => number
  /** Delay before a request answers, in ms. */
  latency?: number
}

/** The mock account, with teardown. */
export interface MockTrading extends TradingProvider {
  dispose(): void
}

interface PositionSeed { ticker: string; side: Side; lots: number; offsetPips: number; slPips: number | null; tpPips: number | null; swap: number; age: number }
interface OrderSeed { ticker: string; side: Side; type: 'limit' | 'stop'; lots: number; offsetPips: number; slPips: number; tpPips: number; age: number }
interface TradeSeed { ticker: string; side: Side; lots: number; open: number; close: number; commission: number; swap: number; openAgo: number; closeAgo: number }

/** Positions opened `offsetPips` in their favour (negative: against them). */
const POSITIONS: readonly PositionSeed[] = [
  { ticker: 'EURUSD', side: 'buy', lots: 0.5, offsetPips: 21, slPips: 30, tpPips: 60, swap: -1.25, age: 3 * HOUR + 12 * MINUTE },
  { ticker: 'XAUUSD', side: 'sell', lots: 0.1, offsetPips: 64, slPips: 150, tpPips: 250, swap: -2.1, age: 26 * HOUR },
  { ticker: 'USDJPY', side: 'buy', lots: 1, offsetPips: -35, slPips: null, tpPips: 120, swap: 3.4, age: 50 * HOUR },
]
/** Pending orders `offsetPips` away from the touch on their valid side. */
const ORDERS: readonly OrderSeed[] = [
  { ticker: 'GBPUSD', side: 'buy', type: 'limit', lots: 0.3, offsetPips: 40, slPips: 30, tpPips: 80, age: 5 * HOUR },
  { ticker: 'XAUUSD', side: 'buy', type: 'stop', lots: 0.05, offsetPips: 120, slPips: 80, tpPips: 200, age: 2 * HOUR },
]
/** Closed trades, with their realized profit in dollars. */
const TRADES: readonly TradeSeed[] = [
  { ticker: 'AUDUSD', side: 'buy', lots: 0.2, open: 0.65412, close: 0.65604, commission: -1.4, swap: 0, openAgo: 30 * HOUR, closeAgo: 28 * HOUR },
  { ticker: 'EURJPY', side: 'sell', lots: 0.1, open: 176.204, close: 176.395, commission: -0.7, swap: -0.35, openAgo: 47 * HOUR, closeAgo: 20 * HOUR },
  { ticker: 'XAUUSD', side: 'buy', lots: 0.05, open: 3_992.4, close: 4_005.3, commission: -0.35, swap: 0, openAgo: 8 * HOUR, closeAgo: 6 * HOUR },
]
const INITIAL_DEPOSIT = 10_000
/** When the deposit was made, before the trades. */
const DEPOSIT_AGE = 20 * DAY
const NONE: readonly never[] = Object.freeze([])
const round2 = (value: number): number => Math.round(value * 100) / 100

/**
 * Create the mock account.
 * @returns the provider; it follows quotes of the symbols it holds while anything is subscribed.
 */
export function createMockTrading(options: MockTradingOptions): MockTrading {
  const { market } = options
  const now = options.now ?? Date.now
  const latency = options.latency ?? 350
  const created = now()
  const symbolOf = (ticker: string): MarketSymbol | undefined => market.symbol(ticker)
  let nextTicket = 61_203_401
  const ticket = (): string => String(nextTicket++)

  // The deposit and closed trades first, so their tickets are older.
  const deals: Deal[] = [{
    ticket: ticket(), orderTicket: null, positionTicket: null, ticker: '', kind: 'balance', operation: 'balance', side: null, entry: null,
    lots: 0, price: 0, profit: INITIAL_DEPOSIT, commission: 0, swap: 0, fee: 0, reason: 'client', time: created - DEPOSIT_AGE,
  }]
  const history: HistoryOrder[] = []
  let balance = INITIAL_DEPOSIT
  const trade = (fields: Omit<Deal, 'kind' | 'operation' | 'fee' | 'reason'>): Deal => ({ ...fields, kind: 'trade', operation: null, fee: 0, reason: 'client' })
  for (const seed of TRADES) {
    const symbol = symbolOf(seed.ticker)
    if (symbol === undefined) continue
    const rate = seed.ticker.endsWith('JPY') ? 1 / 155 : 1
    const profit = round2(profitFor(symbol, seed.side, seed.lots, seed.open, seed.close, rate))
    const position = ticket()
    const openOrder = position
    const closeOrder = ticket()
    const opened = created - seed.openAgo
    const closed = created - seed.closeAgo
    const closeSide: Side = seed.side === 'buy' ? 'sell' : 'buy'
    history.push(
      { ticket: openOrder, ticker: seed.ticker, side: seed.side, type: 'market', lots: seed.lots, price: null, stopLimit: null, fillPrice: seed.open, state: 'filled', placedAt: opened, doneAt: opened },
      { ticket: closeOrder, ticker: seed.ticker, side: closeSide, type: 'market', lots: seed.lots, price: null, stopLimit: null, fillPrice: seed.close, state: 'filled', placedAt: closed, doneAt: closed },
    )
    deals.push(
      trade({ ticket: ticket(), orderTicket: openOrder, positionTicket: position, ticker: seed.ticker, side: seed.side, entry: 'in', lots: seed.lots, price: seed.open, profit: 0, commission: seed.commission / 2, swap: 0, time: opened }),
      trade({ ticket: ticket(), orderTicket: closeOrder, positionTicket: position, ticker: seed.ticker, side: closeSide, entry: 'out', lots: seed.lots, price: seed.close, profit, commission: seed.commission / 2, swap: seed.swap, time: closed }),
    )
    balance += profit + seed.commission + seed.swap
  }

  const positions: Position[] = []
  for (const seed of POSITIONS) {
    const symbol = symbolOf(seed.ticker)
    const quote = market.quote(seed.ticker)
    if (symbol === undefined || quote === undefined) continue
    const sign = seed.side === 'buy' ? 1 : -1
    const openPrice = roundPrice(symbol, exitPrice(quote, seed.side) - sign * seed.offsetPips * symbol.pip)
    const at = (pips: number | null, toward: 1 | -1): number | null => pips === null ? null : roundPrice(symbol, openPrice + toward * sign * pips * symbol.pip)
    const position: Position = {
      ticket: ticket(), ticker: seed.ticker, side: seed.side, lots: seed.lots, openPrice, currentPrice: exitPrice(quote, seed.side),
      takeProfit: at(seed.tpPips, 1), stopLoss: at(seed.slPips, -1), profit: 0, swap: seed.swap, openTime: created - seed.age, comment: '',
    }
    positions.push(position)
    const commission = round2(-3.5 * seed.lots)
    balance += commission
    deals.push(trade({
      ticket: ticket(), orderTicket: position.ticket, positionTicket: position.ticket, ticker: seed.ticker, side: seed.side, entry: 'in',
      lots: seed.lots, price: openPrice, profit: 0, commission, swap: 0, time: position.openTime,
    }))
    history.push({ ticket: position.ticket, ticker: seed.ticker, side: seed.side, type: 'market', lots: seed.lots, price: null, stopLimit: null, fillPrice: openPrice, state: 'filled', placedAt: position.openTime, doneAt: position.openTime })
  }

  const orders: PendingOrder[] = []
  for (const seed of ORDERS) {
    const symbol = symbolOf(seed.ticker)
    const quote = market.quote(seed.ticker)
    if (symbol === undefined || quote === undefined) continue
    const touch = entryPrice(quote, seed.side)
    // Limits wait on the better side of the touch, stops on the worse side.
    const away = (seed.type === 'limit' ? -1 : 1) * (seed.side === 'buy' ? 1 : -1)
    const price = roundPrice(symbol, touch + away * seed.offsetPips * symbol.pip)
    const sign = seed.side === 'buy' ? 1 : -1
    orders.push({
      ticket: ticket(), ticker: seed.ticker, side: seed.side, type: seed.type, lots: seed.lots, price, stopLimit: null, currentPrice: touch,
      takeProfit: roundPrice(symbol, price + sign * seed.tpPips * symbol.pip), stopLoss: roundPrice(symbol, price - sign * seed.slPips * symbol.pip),
      placedAt: created - seed.age, comment: '',
    })
  }
  history.push({
    ticket: ticket(), ticker: 'EURUSD', side: 'sell', type: 'limit', lots: 0.2, price: 1.1712, stopLimit: null, fillPrice: null, state: 'cancelled',
    placedAt: created - 33 * HOUR, doneAt: created - 31 * HOUR,
  })
  history.sort((left, right) => right.doneAt - left.doneAt)
  deals.sort((left, right) => right.time - left.time)
  balance = round2(balance)

  const accountBase: Omit<AccountInfo, 'equity' | 'profit' | 'margin' | 'freeMargin' | 'marginLevel'> = {
    login: '50123456', name: '演示账户', server: 'MT5-Demo', company: 'Demo', currency: 'USD', leverage: 100, mode: 'demo', accounting: 'hedging',
    balance, credit: 0,
  }

  const quoteFor = (ticker: string): Quote | undefined => market.quote(ticker)
  let selection: HistorySelection = DEFAULT_HISTORY
  const build = (): TradingSnapshot => {
    let profit = 0
    let swap = 0
    let margin = 0
    const marked = positions.map((position): Position => {
      const symbol = symbolOf(position.ticker)
      const quote = quoteFor(position.ticker)
      const rate = symbol === undefined ? null : conversionRate(symbol.currency, accountBase.currency, quoteFor)
      if (symbol === undefined || quote === undefined || rate === null) return position
      const currentPrice = exitPrice(quote, position.side)
      const floating = round2(profitFor(symbol, position.side, position.lots, position.openPrice, currentPrice, rate))
      profit += floating
      swap += position.swap
      margin += marginFor(symbol, position.lots, quote.last, rate, accountBase.leverage)
      return { ...position, currentPrice, profit: floating }
    })
    const pending = orders.map((order): PendingOrder => {
      const quote = quoteFor(order.ticker)
      return quote === undefined ? order : { ...order, currentPrice: entryPrice(quote, order.side) }
    })
    const equity = round2(accountBase.balance + accountBase.credit + profit + swap)
    margin = round2(margin)
    const range = historyRange(selection, now())
    const within = (time: number): boolean => time >= range.from && time < range.to
    return {
      connection: { source: 'mock', status: 'connected', blocked: NONE, mt5: null },
      account: {
        ...accountBase, equity, profit: round2(profit), margin, freeMargin: round2(equity - margin),
        marginLevel: margin > 0 ? equity / margin * 100 : null,
      },
      positions: marked, orders: pending,
      history: history.filter(order => within(order.doneAt)), deals: deals.filter(deal => within(deal.time)),
      historyState: { selection, status: 'ready', error: null, truncated: false },
    }
  }

  let snapshot = build()
  const listeners = new Set<() => void>()
  let stop: (() => void) | undefined
  let queued = false
  const tickers = new Set<string>([...positions, ...orders].map(entry => entry.ticker))
  for (const held of [...tickers]) {
    const symbol = symbolOf(held)
    if (symbol !== undefined) for (const candidate of conversionTickers(symbol, accountBase.currency)) if (symbolOf(candidate) !== undefined) tickers.add(candidate)
  }
  const refresh = (): void => {
    snapshot = build()
    for (const listener of [...listeners]) listener()
  }
  const onQuote = (): void => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      refresh()
    })
  }

  const offline = async (): Promise<TradeResult> => {
    await new Promise(resolve => setTimeout(resolve, latency))
    return { status: 'offline', retcode: null, code: null, message: '', orderTicket: null, price: null, volume: null }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      if (stop === undefined && tickers.size > 0) {
        snapshot = build()
        stop = market.subscribeQuotes([...tickers], onQuote)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) { stop?.(); stop = undefined }
      }
    },
    rules: async () => null,
    sendOrder: offline,
    closePosition: offline,
    modifyPosition: offline,
    modifyOrder: offline,
    cancelOrder: offline,
    setHistoryPeriod(next) {
      selection = next
      refresh()
    },
    refreshHistory: refresh,
    dispose() {
      stop?.()
      stop = undefined
      listeners.clear()
    },
  }
}
