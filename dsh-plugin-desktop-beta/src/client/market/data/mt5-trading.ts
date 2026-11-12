/**
 * The account through the Desktop's MT5 bridge. MT5 is the source of truth: the snapshot changes
 * only when the bridge reports, and nothing is shown ahead of it. The account and its funds come
 * with the bridge status, positions and pending orders with its trading pushes, and the order and
 * deal history of the selected period from MT5's history, read again after each sync, after new
 * deals while the period includes the present, and on request. Trade requests answer `blocked`
 * without reaching MT5 until the bridge executes them. While the bridge is turned off in Settings
 * the demo account stands in, as it does where there is no bridge at all.
 */
import type {
  Mt5Account, Mt5BridgePhase, Mt5Deal, Mt5HistoryOrder, Mt5Order, Mt5OrderType, Mt5Position, Mt5RendererBridge, Mt5Status,
  Mt5TradeHistory, Mt5Trading as Mt5TradingState,
} from '../../../mt5/contract.ts'
import type { MockTrading } from './mock-trading.ts'
import { createMt5StatusSource } from './mt5-bridge.ts'
import {
  DEFAULT_HISTORY, historyRange,
  type AccountInfo, type Deal, type DealEntry, type HistoryOrder, type HistoryOrderType, type HistorySelection, type HistoryState,
  type PendingOrder, type PendingType, type Position, type Side, type TradeBlock, type TradeResult, type TradingConnection,
  type TradingProvider, type TradingSnapshot,
} from './trading.ts'

export interface Mt5TradingOptions {
  bridge: Mt5RendererBridge
  /** The demo account shown while the bridge is turned off; this provider disposes it. */
  demo: MockTrading
  /** Receives a failed first status or trading read. */
  onError?: (error: unknown) => void
  /** Clock of the history periods; defaults to `Date.now`. */
  now?: () => number
  /** Wait after a change before the history is read, so a burst of deals reads it once. */
  historyDelayMs?: number
}

/** The MT5 account, with teardown. */
export interface Mt5Trading extends TradingProvider {
  resync(): Promise<void>
  dispose(): void
}

/** The market page's account fields of an MT5 account snapshot. */
export function accountInfo(account: Mt5Account): AccountInfo {
  return {
    login: account.login, name: account.name, server: account.server, company: account.company,
    currency: account.currency, leverage: account.leverage, mode: account.tradeMode,
    accounting: account.marginMode === 'hedging' ? 'hedging' : 'netting',
    balance: account.balance, credit: account.credit, equity: account.equity, profit: account.profit,
    margin: account.margin, freeMargin: account.marginFree, marginLevel: account.marginLevel,
  }
}

const LINK: Record<Mt5BridgePhase, TradingConnection['status']> = {
  disabled: 'disconnected', error: 'disconnected', listening: 'disconnected',
  handshaking: 'connecting', syncing: 'connecting', ready: 'connected',
}

/**
 * The connection an MT5 status shows. Sending trades is not implemented yet, so `unsupported` keeps
 * the gate closed where the bridge itself would open it.
 * @param status - null until the main process answered.
 */
export function mt5Connection(status: Mt5Status | null): TradingConnection {
  if (status === null) return { source: 'mt5', status: 'connecting', blocked: ['syncing'], mt5: null }
  const blocked: TradeBlock[] = status.blocked.length > 0 ? [...status.blocked] : ['unsupported']
  return { source: 'mt5', status: LINK[status.phase], blocked, mt5: status }
}

/** Side and page type of each MT5 order type. */
const ORDER_TYPES: Readonly<Record<Mt5OrderType, { side: Side | null; type: HistoryOrderType }>> = {
  buy: { side: 'buy', type: 'market' }, sell: { side: 'sell', type: 'market' },
  buy_limit: { side: 'buy', type: 'limit' }, sell_limit: { side: 'sell', type: 'limit' },
  buy_stop: { side: 'buy', type: 'stop' }, sell_stop: { side: 'sell', type: 'stop' },
  buy_stop_limit: { side: 'buy', type: 'stopLimit' }, sell_stop_limit: { side: 'sell', type: 'stopLimit' },
  close_by: { side: null, type: 'closeBy' },
}
const ENTRIES: Readonly<Record<Mt5Deal['entry'], DealEntry>> = { in: 'in', out: 'out', inout: 'inout', out_by: 'outBy' }

export function positionOf(position: Mt5Position): Position {
  return {
    ticket: position.ticket, ticker: position.symbol, side: position.side, lots: position.volume, openPrice: position.priceOpen,
    currentPrice: position.priceCurrent, takeProfit: position.tp, stopLoss: position.sl, profit: position.profit, swap: position.swap,
    openTime: position.time, comment: position.comment,
  }
}

export function pendingOrderOf(order: Mt5Order): PendingOrder {
  const { side, type } = ORDER_TYPES[order.type]
  return {
    ticket: order.ticket, ticker: order.symbol, side: side ?? 'buy', type: type as PendingType, lots: order.volume, price: order.price,
    stopLimit: order.stopLimit, currentPrice: order.priceCurrent, takeProfit: order.tp, stopLoss: order.sl, placedAt: order.time, comment: order.comment,
  }
}

function orderState(order: Mt5HistoryOrder): HistoryOrder['state'] {
  switch (order.state) {
    case 'filled': return 'filled'
    case 'partial': return 'partial'
    case 'canceled': return order.volumeCurrent < order.volumeInitial ? 'partial' : 'cancelled'
    case 'rejected': return 'rejected'
    case 'expired': return 'expired'
    default: return 'placed'
  }
}

export function dealOf(deal: Mt5Deal): Deal {
  const trade = deal.type === 'buy' || deal.type === 'sell'
  return {
    ticket: deal.ticket, orderTicket: deal.order, positionTicket: deal.position, ticker: deal.symbol,
    kind: trade ? 'trade' : 'balance', operation: trade ? null : deal.type,
    side: trade ? deal.type as Side : null, entry: trade ? ENTRIES[deal.entry] : null,
    lots: deal.volume, price: deal.price, profit: deal.profit, commission: deal.commission, swap: deal.swap, fee: deal.fee,
    reason: deal.reason, time: deal.time,
  }
}

/** The page's history rows of an MT5 history answer; fill prices are the lot-weighted average of each order's deals. */
export function historyOf(answer: Mt5TradeHistory): { orders: HistoryOrder[]; deals: Deal[] } {
  const deals = answer.deals.map(dealOf)
  const fills = new Map<string, { lots: number; value: number }>()
  for (const deal of deals) {
    if (deal.kind !== 'trade' || deal.orderTicket === null || deal.lots <= 0) continue
    const fill = fills.get(deal.orderTicket) ?? { lots: 0, value: 0 }
    fill.lots += deal.lots
    fill.value += deal.lots * deal.price
    fills.set(deal.orderTicket, fill)
  }
  const orders = answer.orders.map((order): HistoryOrder => {
    const { side, type } = ORDER_TYPES[order.type]
    const fill = fills.get(order.ticket)
    return {
      ticket: order.ticket, ticker: order.symbol, side, type, lots: order.volumeInitial,
      price: type === 'market' ? null : order.price, stopLimit: order.stopLimit,
      fillPrice: fill === undefined ? null : fill.value / fill.lots, state: orderState(order),
      placedAt: order.timeSetup, doneAt: order.timeDone,
    }
  })
  return { orders, deals }
}

const NONE: readonly never[] = Object.freeze([])
const HISTORY_DELAY_MS = 300
const selectionKey = (selection: HistorySelection): string => `${selection.period}\n${selection.from}\n${selection.to}`

/** The rows of one history read, and the session and period they belong to. */
interface HistoryRows { session: string; key: string; orders: readonly HistoryOrder[]; deals: readonly Deal[]; truncated: boolean }

/**
 * Create the MT5 account provider.
 * @returns the provider; it follows the bridge from creation, reads the history while anything is
 * subscribed, and follows the demo account's quotes while the demo account is shown and subscribed.
 */
export function createMt5Trading(options: Mt5TradingOptions): Mt5Trading {
  const { bridge, demo } = options
  const now = options.now ?? Date.now
  const historyDelay = options.historyDelayMs ?? HISTORY_DELAY_MS
  const source = createMt5StatusSource(bridge, options.onError)
  const listeners = new Set<() => void>()
  let stopDemo: (() => void) | undefined
  let disposed = false
  let positions: readonly Position[] = NONE
  let orders: readonly PendingOrder[] = NONE
  let selection: HistorySelection = DEFAULT_HISTORY
  let rows: HistoryRows | null = null
  let historyStatus: { key: string; status: HistoryState['status']; error: string | null } = { key: selectionKey(selection), status: 'idle', error: null }
  let historyTimer: ReturnType<typeof setTimeout> | undefined
  let reading = false
  let readAgain = false
  let lastSync: number | null = null
  let version = 0
  let cache: { version: number; demo: TradingSnapshot | null; status: Mt5Status | null; value: TradingSnapshot } | undefined

  const usesDemo = (): boolean => source.get()?.phase === 'disabled'
  /** The account session the history belongs to; null while none is in sync. */
  const session = (): string | null => {
    const status = source.get()
    return status?.phase === 'ready' && status.account !== null && !status.eaOutdated ? `${status.account.server}\n${status.account.login}` : null
  }
  const notify = (): void => {
    version++
    for (const listener of [...listeners]) listener()
  }

  const historyState = (): HistoryState => {
    const key = selectionKey(selection)
    const current = historyStatus.key === key ? historyStatus : { status: 'idle' as const, error: null }
    return { selection, status: current.status, error: current.error, truncated: rows?.key === key && rows.truncated }
  }
  const getSnapshot = (): TradingSnapshot => {
    const status = source.get()
    const shown = status?.phase === 'disabled' ? demo.getSnapshot() : null
    if (cache !== undefined && cache.version === version && cache.status === status && cache.demo === shown) return cache.value
    const visible = rows !== null && rows.session === session() && rows.key === selectionKey(selection) ? rows : null
    const value: TradingSnapshot = shown !== null
      ? { ...shown, connection: { ...shown.connection, mt5: status } }
      : {
        connection: mt5Connection(status),
        account: status?.account == null ? null : accountInfo(status.account),
        positions, orders, history: visible?.orders ?? NONE, deals: visible?.deals ?? NONE, historyState: historyState(),
      }
    cache = { version, status, demo: shown, value }
    return value
  }

  const setHistoryStatus = (key: string, status: HistoryState['status'], error: string | null = null): void => {
    historyStatus = { key, status, error }
    notify()
  }
  /** Read the history after a short wait, unless nothing shows it. */
  const scheduleHistory = (): void => {
    clearTimeout(historyTimer)
    historyTimer = undefined
    if (disposed || listeners.size === 0 || session() === null) return
    historyTimer = setTimeout(() => { historyTimer = undefined; void readHistory() }, historyDelay)
  }
  const readHistory = async (): Promise<void> => {
    if (reading) { readAgain = true; return }
    const current = session()
    if (disposed || current === null) return
    const key = selectionKey(selection)
    const range = historyRange(selection, now())
    reading = true
    setHistoryStatus(key, 'loading')
    try {
      const answer = await bridge.historyTrades(range)
      if (disposed || session() !== current || selectionKey(selection) !== key) return
      const { orders: historyOrders, deals } = historyOf(answer)
      rows = { session: current, key, orders: historyOrders, deals, truncated: answer.truncated }
      setHistoryStatus(key, 'ready')
    } catch (error) {
      if (!disposed && selectionKey(selection) === key) setHistoryStatus(key, 'error', error instanceof Error ? error.message : String(error))
    } finally {
      reading = false
      if (readAgain && !disposed) {
        readAgain = false
        scheduleHistory()
      }
    }
  }

  const setTrading = (next: Mt5TradingState | null): void => {
    if (disposed) return
    positions = next === null ? NONE : next.positions.map(positionOf)
    orders = next === null ? NONE : next.orders.map(pendingOrderOf)
    notify()
  }

  // The demo account follows quotes only while it is on screen.
  const followDemo = (): void => {
    const wanted = listeners.size > 0 && usesDemo()
    if (wanted && stopDemo === undefined) stopDemo = demo.subscribe(notify)
    else if (!wanted && stopDemo !== undefined) { stopDemo(); stopDemo = undefined }
  }
  const stopStatus = source.subscribe(() => {
    followDemo()
    const status = source.get()
    // A session that ends takes its rows along; each sync reads the history again.
    if (session() === null) {
      rows = null
      clearTimeout(historyTimer)
      historyTimer = undefined
    } else if (status !== null && status.syncedAt !== lastSync) scheduleHistory()
    lastSync = status?.syncedAt ?? null
    notify()
  })
  const stopTrading = bridge.onTrading(setTrading)
  // The answer and the pushes share one channel, so whichever arrives last is the newest.
  bridge.trading().then(setTrading, (error: unknown) => { if (!disposed) options.onError?.(error) })
  const stopEvents = bridge.onTradeEvents(() => {
    const range = historyRange(selection, now())
    const at = now()
    if (at >= range.from && at < range.to) scheduleHistory()
  })

  const refuse = async (): Promise<TradeResult> => ({
    status: 'blocked', blocked: getSnapshot().connection.blocked[0] ?? 'unsupported',
    retcode: null, message: '', orderTicket: null, price: null,
  })

  return {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      followDemo()
      if (listeners.size === 1 && rows === null) scheduleHistory()
      return () => {
        listeners.delete(listener)
        followDemo()
      }
    },
    sendOrder: request => usesDemo() ? demo.sendOrder(request) : refuse(),
    closePosition: (ticket, lots) => usesDemo() ? demo.closePosition(ticket, lots) : refuse(),
    modifyPosition: (ticket, brackets) => usesDemo() ? demo.modifyPosition(ticket, brackets) : refuse(),
    modifyOrder: (ticket, changes) => usesDemo() ? demo.modifyOrder(ticket, changes) : refuse(),
    cancelOrder: ticket => usesDemo() ? demo.cancelOrder(ticket) : refuse(),
    resync: () => bridge.resync(),
    setHistoryPeriod(next) {
      demo.setHistoryPeriod(next)
      if (selectionKey(next) === selectionKey(selection)) return
      selection = next
      notify()
      scheduleHistory()
    },
    refreshHistory() {
      demo.refreshHistory()
      scheduleHistory()
    },
    dispose() {
      disposed = true
      clearTimeout(historyTimer)
      stopStatus()
      stopTrading()
      stopEvents()
      stopDemo?.()
      stopDemo = undefined
      listeners.clear()
      source.dispose()
      demo.dispose()
    },
  }
}
