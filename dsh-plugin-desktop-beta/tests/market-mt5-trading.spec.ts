/** The market page's MT5 account: the bridge status, positions, orders and history as a trading snapshot, the gate, and the demo fallback. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionBadge, utcOffsetText } from '../src/client/market/connection.ts'
import { createMockMarketData } from '../src/client/market/data/mock-market-data.ts'
import { createMockTrading } from '../src/client/market/data/mock-trading.ts'
import { createMt5Trading, historyOf as pageHistory, mt5Connection, pendingOrderOf, positionOf, tradeResult } from '../src/client/market/data/mt5-trading.ts'
import { historyRange, type HistorySelection, type TradeRequest } from '../src/client/market/data/trading.ts'
import type { Mt5Status } from '../src/mt5/contract.ts'
import { DISABLED, fakeBridge, FILLED, historyOf, LISTENING, READY, tradingOf, type FakeBridgeOptions } from './market-fake-bridge.ts'
import { DEAL, DEPOSIT, HISTORY_ORDER, ORDER, POSITION } from './mt5-fixtures.ts'

const ORDER_REQUEST: TradeRequest = { ticker: 'EURUSD', side: 'buy', type: 'market', lots: 0.1, price: null, takeProfit: 1.08, stopLoss: null }
const ACCOUNT_KEY = { login: '50123456', server: 'Example-Demo' }
/** Wednesday 2026-11-11 15:00 local time. */
const NOW = new Date(2026, 10, 11, 15).getTime()

const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose() })

function provider(options: FakeBridgeOptions = {}) {
  const market = createMockMarketData({ interval: 0 })
  const demo = createMockTrading({ market, latency: 0 })
  const fake = fakeBridge(options)
  const trading = createMt5Trading({ bridge: fake.bridge, demo, now: () => NOW, historyDelayMs: 0 })
  disposers.push(() => { trading.dispose(); market.dispose() })
  return { trading, fake, demo }
}

describe('createMt5Trading', () => {
  it('waits for the first status without showing an account', async () => {
    const { trading, fake } = provider({ status: null })
    expect(trading.getSnapshot()).toMatchObject({ connection: { source: 'mt5', status: 'connecting', blocked: ['syncing'], mt5: null }, account: null, positions: [] })
    fake.answerStatus(READY)
    await vi.waitFor(() => expect(trading.getSnapshot().connection.status).toBe('connected'))
  })

  it('shows the synced MT5 account and sends each trade for it, with MT5\'s answer as the result', async () => {
    const { trading, fake } = provider({ trading: tradingOf() })
    await vi.waitFor(() => expect(trading.getSnapshot().positions).toHaveLength(1))
    const snapshot = trading.getSnapshot()
    expect(snapshot.account).toEqual({
      login: '50123456', name: 'Demo User', server: 'Example-Demo', company: 'Example Ltd', currency: 'USD', leverage: 500, mode: 'demo',
      accounting: 'hedging', balance: 10_000, credit: 0, equity: 10_012.5, profit: 12.5, margin: 220.4, freeMargin: 9_792.1, marginLevel: 4_542.88,
    })
    expect(snapshot.connection).toMatchObject({ source: 'mt5', status: 'connected', blocked: [], mt5: READY })
    expect(trading.getSnapshot()).toBe(snapshot)
    await expect(trading.sendOrder(ORDER_REQUEST)).resolves.toEqual({
      status: 'done', retcode: 10009, code: 'sent', message: 'Request executed', orderTicket: '3002', price: 1.07255, volume: 0.1,
    })
    await trading.sendOrder({ ...ORDER_REQUEST, type: 'limit', price: 1.06, stopLoss: 1.05 })
    await trading.closePosition('1001')
    await trading.closePosition('1001', 0.05)
    await trading.modifyPosition('1001', { takeProfit: null, stopLoss: 1.07 })
    await trading.modifyOrder('2001', { price: 1.065, takeProfit: 1.09, stopLoss: null })
    await trading.cancelOrder('2001')
    const held = trading.getSnapshot().positions[0]!.lots
    expect(fake.bridge.trade.mock.calls.map(([input]) => input)).toEqual([
      { type: 'order.place', account: ACCOUNT_KEY, symbol: 'EURUSD', side: 'buy', orderType: 'market', volume: 0.1, price: null, sl: null, tp: 1.08 },
      { type: 'order.place', account: ACCOUNT_KEY, symbol: 'EURUSD', side: 'buy', orderType: 'limit', volume: 0.1, price: 1.06, sl: 1.05, tp: 1.08 },
      { type: 'position.close', account: ACCOUNT_KEY, symbol: 'EURUSD', ticket: '1001', volume: held },
      { type: 'position.close', account: ACCOUNT_KEY, symbol: 'EURUSD', ticket: '1001', volume: 0.05 },
      { type: 'position.modify', account: ACCOUNT_KEY, symbol: 'EURUSD', ticket: '1001', sl: 1.07, tp: null },
      // Each ticket's symbol comes from the listed position or order.
      { type: 'order.modify', account: ACCOUNT_KEY, symbol: 'XAUUSD', ticket: '2001', price: 1.065, sl: null, tp: 1.09 },
      { type: 'order.cancel', account: ACCOUNT_KEY, symbol: 'XAUUSD', ticket: '2001' },
    ])
    // A ticket the page no longer lists sends nothing.
    await expect(trading.closePosition('9999')).resolves.toMatchObject({ status: 'rejected', code: 'no_position' })
    await expect(trading.cancelOrder('9999')).resolves.toMatchObject({ status: 'rejected', code: 'no_order' })
    expect(fake.bridge.trade).toHaveBeenCalledTimes(7)
  })

  it('turns MT5\'s outcomes into results, an unknown one into unconfirmed', async () => {
    expect(tradeResult({ ...FILLED, status: 'unknown', code: 'timeout', retcode: 0, order: null, deal: null, price: null, volume: null }))
      .toEqual({ status: 'unconfirmed', retcode: null, code: 'timeout', message: 'Request executed', orderTicket: null, price: null, volume: null })
    expect(tradeResult({ ...FILLED, status: 'blocked', id: null, blocked: 'disclaimer', code: 'blocked', retcode: 0 })).toMatchObject({ status: 'blocked', blocked: 'disclaimer' })
    expect(tradeResult({ ...FILLED, status: 'rejected', retcode: 10018, code: 'sent', message: 'Market closed' })).toMatchObject({ status: 'rejected', retcode: 10018 })
    const { trading, fake } = provider()
    await vi.waitFor(() => expect(trading.getSnapshot().account).not.toBeNull())
    fake.bridge.trade.mockRejectedValueOnce(new Error('MT5 bridge: invalid trade request'))
    await expect(trading.sendOrder(ORDER_REQUEST)).resolves.toMatchObject({ status: 'rejected', message: 'MT5 bridge: invalid trade request' })
  })

  it('reads a symbol\'s rules from MT5, none without them, and records the disclaimer agreement', async () => {
    const { trading, fake } = provider()
    await vi.waitFor(() => expect(trading.getSnapshot().account).not.toBeNull())
    await expect(trading.rules('EURUSD')).resolves.toEqual({
      stopsDistance: 0, tradeMode: 'full', orderTypes: ['market', 'limit', 'stop'], marginPerLot: { buy: 214.5, sell: 214.48 },
    })
    expect(fake.bridge.symbolInfo).toHaveBeenCalledWith('EURUSD')
    fake.bridge.symbolInfo.mockRejectedValueOnce(new Error('unknown_symbol'))
    await expect(trading.rules('NOPE')).resolves.toBeNull()
    await trading.acceptDisclaimer?.()
    expect(fake.bridge.acceptDisclaimer).toHaveBeenCalledTimes(1)
  })

  it('reports the bridge reasons first and follows status pushes', async () => {
    const { trading, fake } = provider()
    const listener = vi.fn()
    trading.subscribe(listener)
    await vi.waitFor(() => expect(trading.getSnapshot().account).not.toBeNull())
    fake.pushStatus({ ...READY, blocked: ['broker-disconnected', 'disclaimer'] })
    expect(listener).toHaveBeenCalled()
    expect(trading.getSnapshot().connection.blocked).toEqual(['broker-disconnected', 'disclaimer'])
    await expect(trading.modifyPosition('1', { takeProfit: null, stopLoss: null })).resolves.toMatchObject({ status: 'blocked', blocked: 'broker-disconnected' })
    expect(fake.bridge.trade).not.toHaveBeenCalled()
    fake.pushStatus(LISTENING)
    expect(trading.getSnapshot()).toMatchObject({ connection: { status: 'disconnected', blocked: ['ea-disconnected'] }, account: null })
  })

  it('shows the demo account while the bridge is turned off, following its quotes only while subscribed', async () => {
    const { trading, fake, demo } = provider({ status: DISABLED })
    await vi.waitFor(() => expect(trading.getSnapshot().connection.source).toBe('mock'))
    expect(trading.getSnapshot().connection.mt5).toEqual(DISABLED)
    expect(trading.getSnapshot().account?.login).toBe(demo.getSnapshot().account?.login)
    expect(trading.getSnapshot().positions.length).toBeGreaterThan(0)
    await expect(trading.sendOrder(ORDER_REQUEST)).resolves.toMatchObject({ status: 'offline' })
    const subscribe = vi.spyOn(demo, 'subscribe')
    const stop = trading.subscribe(() => {})
    expect(subscribe).toHaveBeenCalledOnce()
    fake.pushStatus(READY)
    expect(trading.getSnapshot().connection.source).toBe('mt5')
    fake.pushStatus(DISABLED)
    expect(subscribe).toHaveBeenCalledTimes(2)
    stop()
    expect(fake.bridge.historyTrades).not.toHaveBeenCalled()
  })

  it('resyncs through the bridge and stops following it on dispose', async () => {
    const { trading, fake } = provider()
    await trading.resync()
    expect(fake.bridge.resync).toHaveBeenCalledOnce()
    expect(fake.listeners()).toBeGreaterThan(0)
    trading.dispose()
    expect(fake.listeners()).toBe(0)
  })

  it('shows the positions and pending orders the bridge pushes, and none once the session ends', async () => {
    const { trading, fake } = provider({ trading: tradingOf() })
    await vi.waitFor(() => expect(trading.getSnapshot().positions).toHaveLength(1))
    expect(trading.getSnapshot().positions[0]).toEqual({
      ticket: '1001', ticker: 'EURUSD', side: 'buy', lots: 0.1, openPrice: 1.0712, currentPrice: 1.0725, takeProfit: 1.08, stopLoss: null,
      profit: 13, swap: -0.5, openTime: POSITION.time, comment: '',
    })
    expect(trading.getSnapshot().orders[0]).toMatchObject({ ticket: '2001', ticker: 'XAUUSD', side: 'buy', type: 'limit', lots: 0.05, price: 2300, stopLimit: null, stopLoss: 2280, takeProfit: null })
    fake.pushTrading(tradingOf([], [{ ...ORDER, ticket: '2002', type: 'sell_stop_limit', price: 2290, stop_limit: 2295 }]))
    expect(trading.getSnapshot().positions).toEqual([])
    expect(trading.getSnapshot().orders).toEqual([expect.objectContaining({ ticket: '2002', side: 'sell', type: 'stopLimit', price: 2290, stopLimit: 2295 })])
    fake.pushTrading(null)
    expect(trading.getSnapshot().orders).toEqual([])
  })

  it('reads the history of the period after the sync, new deals and period changes', async () => {
    const { trading, fake } = provider()
    trading.subscribe(() => {})
    await vi.waitFor(() => expect(trading.getSnapshot().historyState.status).toBe('ready'))
    const week = historyRange({ period: 'week', from: '', to: '' }, NOW)
    expect(fake.bridge.historyTrades).toHaveBeenCalledOnce()
    expect(fake.bridge.historyTrades).toHaveBeenLastCalledWith(week)
    const snapshot = trading.getSnapshot()
    expect(snapshot.history).toEqual([{
      ticket: '3001', ticker: 'EURUSD', side: 'buy', type: 'market', lots: 0.1, price: null, stopLimit: null, fillPrice: 1.0712, state: 'filled',
      placedAt: HISTORY_ORDER.time_setup, doneAt: HISTORY_ORDER.time_done,
    }])
    expect(snapshot.deals.map(deal => [deal.ticket, deal.kind, deal.operation, deal.side, deal.entry])).toEqual([['4001', 'trade', null, 'buy', 'in'], ['4000', 'balance', 'balance', null, null]])

    fake.pushTradeEvents([{ type: 'deal_add', deal: '4002', order: '3002', position: '1001', symbol: 'EURUSD' }])
    await vi.waitFor(() => expect(fake.bridge.historyTrades).toHaveBeenCalledTimes(2))
    fake.pushStatus({ ...READY, syncedAt: 3 })
    await vi.waitFor(() => expect(fake.bridge.historyTrades).toHaveBeenCalledTimes(3))

    // A past period does not change with new deals.
    const past: HistorySelection = { period: 'custom', from: '2026-10-01', to: '2026-10-31' }
    fake.bridge.historyTrades.mockResolvedValueOnce(historyOf([], [], true))
    trading.setHistoryPeriod(past)
    expect(trading.getSnapshot().history).toEqual([])
    await vi.waitFor(() => expect(trading.getSnapshot().historyState).toMatchObject({ selection: past, status: 'ready', truncated: true }))
    expect(fake.bridge.historyTrades).toHaveBeenLastCalledWith({ from: new Date(2026, 9, 1).getTime(), to: new Date(2026, 10, 1).getTime() })
    fake.pushTradeEvents([{ type: 'history_add', deal: null, order: '3003', position: null, symbol: 'EURUSD' }])
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(fake.bridge.historyTrades).toHaveBeenCalledTimes(4)
  })

  it('reports a failed history read and reads again on request', async () => {
    const { trading, fake } = provider()
    fake.bridge.historyTrades.mockRejectedValueOnce(new Error('request_timeout'))
    trading.subscribe(() => {})
    await vi.waitFor(() => expect(trading.getSnapshot().historyState).toMatchObject({ status: 'error', error: 'request_timeout' }))
    trading.refreshHistory()
    await vi.waitFor(() => expect(trading.getSnapshot().historyState.status).toBe('ready'))
    expect(trading.getSnapshot().deals).toHaveLength(2)
  })

  it('drops the history when the session ends and reads it after the next sync', async () => {
    const { trading, fake } = provider()
    trading.subscribe(() => {})
    await vi.waitFor(() => expect(trading.getSnapshot().deals).toHaveLength(2))
    fake.pushStatus(LISTENING)
    expect(trading.getSnapshot()).toMatchObject({ history: [], deals: [] })
    fake.pushStatus({ ...READY, syncedAt: 5 })
    await vi.waitFor(() => expect(trading.getSnapshot().deals).toHaveLength(2))
    expect(fake.bridge.historyTrades).toHaveBeenCalledTimes(2)
  })
})

describe('MT5 rows', () => {
  it('weights an order fill price by its deals and names partial fills', () => {
    const { orders, deals } = pageHistory(historyOf(
      [{ ...HISTORY_ORDER, state: 'canceled', volume_initial: 0.5, volume_current: 0.1 }, { ...HISTORY_ORDER, ticket: '3002', type: 'close_by', state: 'filled' }],
      [{ ...DEAL, volume: 0.1, price: 1.0712 }, { ...DEAL, ticket: '4002', volume: 0.3, price: 1.072, entry: 'out_by', reason: 'sl' }, DEPOSIT],
    ))
    expect(orders[0]).toMatchObject({ ticket: '3001', state: 'partial', lots: 0.5 })
    expect(orders[0]!.fillPrice).toBeCloseTo(1.0718, 10)
    expect(orders[1]).toMatchObject({ ticket: '3002', side: null, type: 'closeBy', fillPrice: null })
    expect(deals[1]).toMatchObject({ entry: 'outBy', reason: 'sl', fee: 0 })
    expect(deals[2]).toMatchObject({ kind: 'balance', operation: 'balance', orderTicket: null, positionTicket: null, profit: 10_000 })
  })

  it('maps positions and pending orders', () => {
    const [position] = tradingOf().positions
    expect(positionOf(position!)).toMatchObject({ ticket: '1001', side: 'buy', lots: 0.1 })
    const [order] = tradingOf([], [{ ...ORDER, type: 'buy_stop', price: 2400 }]).orders
    expect(pendingOrderOf(order!)).toMatchObject({ side: 'buy', type: 'stop', price: 2400 })
  })
})

describe('history periods', () => {
  const at = (year: number, month: number, day: number): number => new Date(year, month, day).getTime()
  it('runs today, this week, this month and the last three months to the end of today, in local time', () => {
    const selection = (period: HistorySelection['period']): HistorySelection => ({ period, from: '', to: '' })
    const end = at(2026, 10, 12)
    expect(historyRange(selection('today'), NOW)).toEqual({ from: at(2026, 10, 11), to: end })
    expect(historyRange(selection('week'), NOW)).toEqual({ from: at(2026, 10, 9), to: end })
    expect(historyRange(selection('week'), new Date(2026, 10, 15, 9).getTime())).toEqual({ from: at(2026, 10, 9), to: at(2026, 10, 16) })
    expect(historyRange(selection('month'), NOW)).toEqual({ from: at(2026, 10, 1), to: end })
    expect(historyRange(selection('quarter'), NOW)).toEqual({ from: at(2026, 7, 11), to: end })
  })

  it('includes both dates of a custom period and falls back to this week when they are unusable', () => {
    expect(historyRange({ period: 'custom', from: '2026-02-27', to: '2026-03-01' }, NOW)).toEqual({ from: at(2026, 1, 27), to: at(2026, 2, 2) })
    const week = historyRange({ period: 'week', from: '', to: '' }, NOW)
    expect(historyRange({ period: 'custom', from: '2026-03-02', to: '2026-03-01' }, NOW)).toEqual(week)
    expect(historyRange({ period: 'custom', from: '2026-02-30', to: '2026-03-01' }, NOW)).toEqual(week)
    expect(historyRange({ period: 'custom', from: '', to: '' }, NOW)).toEqual(week)
  })
})

describe('connection labels', () => {
  it('names each bridge state', () => {
    expect(connectionBadge({ source: 'mock', status: 'connected', blocked: [], mt5: null })).toEqual({ key: 'account.mock', tone: 'mock' })
    expect(connectionBadge(mt5Connection(null))).toEqual({ key: 'conn.waiting', tone: 'busy' })
    expect(connectionBadge(mt5Connection({ ...LISTENING, phase: 'error', error: 'EADDRINUSE' }))).toEqual({ key: 'conn.error', tone: 'error' })
    expect(connectionBadge(mt5Connection(LISTENING))).toEqual({ key: 'conn.listening', tone: 'idle' })
    expect(connectionBadge(mt5Connection({ ...LISTENING, phase: 'handshaking' }))).toEqual({ key: 'conn.handshaking', tone: 'busy' })
    expect(connectionBadge(mt5Connection({ ...READY, phase: 'syncing' }))).toEqual({ key: 'conn.syncing', tone: 'busy' })
    expect(connectionBadge(mt5Connection(READY))).toEqual({ key: 'conn.ready', tone: 'ok' })
    expect(connectionBadge(mt5Connection({ ...READY, terminal: { ...READY.terminal!, connected: false } }))).toEqual({ key: 'conn.brokerLost', tone: 'warning' })
  })

  it('writes server time zones as UTC offsets', () => {
    expect(utcOffsetText(0)).toBe('UTC+0')
    expect(utcOffsetText(7_200)).toBe('UTC+2')
    expect(utcOffsetText(19_800)).toBe('UTC+5:30')
    expect(utcOffsetText(-14_400)).toBe('UTC−4')
  })
})
