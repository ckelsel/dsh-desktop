/** A renderer MT5 bridge for the market page specs: the test sets its answers and pushes its events. */
import { vi, type Mock } from 'vitest'
import type {
  Mt5Bar, Mt5Catalog, Mt5HistoryBars, Mt5HistoryBarsRequest, Mt5RendererBridge, Mt5Status, Mt5Subscription, Mt5Tick, Mt5TradeEvent,
  Mt5TradeHistory, Mt5Trading,
} from '../src/mt5/contract.ts'
import {
  parseAccount, parseBars, parseOrders, parsePositions, parseSymbolsPage, parseTerminalStatus, parseTicks, parseTradeHistory,
} from '../src/mt5/protocol.ts'
import { ACCOUNT, DEAL, DEPOSIT, HISTORY_ORDER, ORDER, POSITION, SYMBOLS, TERMINAL, WATCH } from './mt5-fixtures.ts'

export const READY: Mt5Status = {
  phase: 'ready', listen: { host: '0.0.0.0', port: 19500, addresses: ['10.0.0.9'] }, error: null,
  peer: { address: '10.0.0.13', port: 50123, eaVersion: '1.1.0', connectedAt: 1 },
  terminal: parseTerminalStatus(TERMINAL), account: parseAccount(ACCOUNT), blocked: [], syncedAt: 2, lastRejection: null, eaOutdated: false,
}
export const LISTENING: Mt5Status = { ...READY, phase: 'listening', peer: null, terminal: null, account: null, blocked: ['ea-disconnected'], syncedAt: null }
export const DISABLED: Mt5Status = { ...LISTENING, phase: 'disabled', listen: null, blocked: ['bridge-disabled'] }

/** The fixture catalogue as the main process sends it. */
export function catalogOf(symbols: readonly Record<string, unknown>[] = SYMBOLS, watch: readonly string[] = WATCH, server = 'Example-Demo'): Mt5Catalog {
  return { server, symbols: parseSymbolsPage({ total: symbols.length, symbols: [...symbols] }).symbols.items, watch }
}

export function tradingOf(positions: readonly Record<string, unknown>[] = [POSITION], orders: readonly Record<string, unknown>[] = [ORDER]): Mt5Trading {
  return { positions: parsePositions({ positions: [...positions] }).items, orders: parseOrders({ orders: [...orders] }).items }
}

export function historyOf(
  orders: readonly Record<string, unknown>[] = [HISTORY_ORDER], deals: readonly Record<string, unknown>[] = [DEAL, DEPOSIT], truncated = false,
): Mt5TradeHistory {
  const parsed = parseTradeHistory({ orders: [...orders], deals: [...deals], truncated })
  return { orders: parsed.orders.items, deals: parsed.deals.items, truncated: parsed.truncated }
}

export const ticksOf = (...ticks: Record<string, unknown>[]): Mt5Tick[] => parseTicks({ ticks }).items
export const barsOf = (...bars: Record<string, unknown>[]): Mt5Bar[] => parseBars({ bars }).items

type Listeners<T> = Set<(value: T) => void>

export interface FakeBridgeOptions {
  /** The first status answer; null leaves it pending until {@link FakeBridge.answerStatus}. */
  status?: Mt5Status | null
  catalog?: Mt5Catalog | null
  trading?: Mt5Trading | null
}

export interface FakeBridge {
  bridge: Mt5RendererBridge & {
    subscribe: Mock<(subscription: Mt5Subscription) => Promise<void>>
    historyBars: Mock<(request: Mt5HistoryBarsRequest) => Promise<Mt5HistoryBars>>
    historyTrades: Mock<(range: { from: number; to: number }) => Promise<Mt5TradeHistory>>
    resync: Mock<() => Promise<void>>
  }
  answerStatus(status: Mt5Status): void
  pushStatus(status: Mt5Status): void
  pushCatalog(catalog: Mt5Catalog | null): void
  pushTrading(trading: Mt5Trading | null): void
  pushTicks(ticks: readonly Mt5Tick[]): void
  pushBars(bars: readonly Mt5Bar[]): void
  pushTradeEvents(events: readonly Mt5TradeEvent[]): void
  /** Listeners on every push channel. */
  listeners(): number
  /** The subscription sent last. */
  lastSubscription(): Mt5Subscription | undefined
}

export function fakeBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const status: Listeners<Mt5Status> = new Set()
  const catalog: Listeners<Mt5Catalog | null> = new Set()
  const trading: Listeners<Mt5Trading | null> = new Set()
  const ticks: Listeners<readonly Mt5Tick[]> = new Set()
  const bars: Listeners<readonly Mt5Bar[]> = new Set()
  const events: Listeners<readonly Mt5TradeEvent[]> = new Set()
  const listen = <T>(set: Listeners<T>) => (listener: (value: T) => void): (() => void) => {
    set.add(listener)
    return () => { set.delete(listener) }
  }
  const push = <T>(set: Listeners<T>, value: T): void => { for (const listener of [...set]) listener(value) }
  let answer: (status: Mt5Status) => void = () => {}
  const bridge: FakeBridge['bridge'] = {
    status: vi.fn(() => options.status === null ? new Promise<Mt5Status>((resolve) => { answer = resolve }) : Promise.resolve(options.status ?? READY)),
    onStatus: listen(status),
    resync: vi.fn(async () => {}),
    request: vi.fn(async () => ({})),
    token: vi.fn(async () => 'token'),
    regenerateToken: vi.fn(async () => 'token'),
    catalog: vi.fn(async () => options.catalog ?? null),
    onCatalog: listen(catalog),
    trading: vi.fn(async () => options.trading ?? null),
    onTrading: listen(trading),
    subscribe: vi.fn<(subscription: Mt5Subscription) => Promise<void>>(async () => {}),
    onTicks: listen(ticks),
    onBars: listen(bars),
    onTradeEvents: listen(events),
    historyBars: vi.fn<(request: Mt5HistoryBarsRequest) => Promise<Mt5HistoryBars>>(async () => ({ bars: [], noData: true })),
    historyTrades: vi.fn<(range: { from: number; to: number }) => Promise<Mt5TradeHistory>>(async () => historyOf()),
  }
  return {
    bridge,
    answerStatus: (value) => { answer(value) },
    pushStatus: (value) => { push(status, value) },
    pushCatalog: (value) => { push(catalog, value) },
    pushTrading: (value) => { push(trading, value) },
    pushTicks: (value) => { push(ticks, value) },
    pushBars: (value) => { push(bars, value) },
    pushTradeEvents: (value) => { push(events, value) },
    listeners: () => status.size + catalog.size + trading.size + ticks.size + bars.size + events.size,
    lastSubscription: () => bridge.subscribe.mock.calls.at(-1)?.[0],
  }
}
