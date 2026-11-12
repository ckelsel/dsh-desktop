import { describe, expect, it } from 'vitest'
import {
  createMarketStore, defaultPreferences, MARKET_STORAGE_KEY, PANEL_MAX, PANEL_MIN, parsePreferences, persistPreferences, readPreferences,
  WATCHLIST_START_MAX, type PreferenceStorage, type SourceCatalog,
} from '../src/client/market/store.ts'
import { createMockTrading } from '../src/client/market/data/mock-trading.ts'
import { createMockMarketData } from '../src/client/market/data/mock-market-data.ts'

const TICKERS = ['EURUSD', 'GBPUSD', 'XAUUSD']
const DEMO: SourceCatalog = { tickers: TICKERS, watch: TICKERS }
const MT5_KEY = 'mt5:Example-Demo'
const MT5: SourceCatalog = { tickers: ['EURUSD', 'XAUUSD', 'US500'], watch: ['US500', 'XAUUSD', 'NOPE', 'US500'] }

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return { data, getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = value } }
}

describe('market page preferences', () => {
  it('starts without a source, and a source seen first starts from its watch list with gold on the chart', () => {
    const store = createMarketStore(defaultPreferences()).create()
    expect(store.getSnapshot()).toMatchObject({ source: null, symbol: '', watchlist: [], upColor: 'green', historyPeriod: { period: 'week' } })
    store.actions.selectSource(MT5_KEY, MT5)
    expect(store.getSnapshot()).toMatchObject({ source: MT5_KEY, symbol: 'XAUUSD', watchlist: ['US500', 'XAUUSD'], collapsed: [], sources: {} })
    const many = Array.from({ length: WATCHLIST_START_MAX + 5 }, (_, index) => `S${String(index)}`)
    store.actions.selectSource('mt5:Big', { tickers: many, watch: many })
    expect(store.getSnapshot()).toMatchObject({ symbol: 'S0', watchlist: many.slice(0, WATCHLIST_START_MAX) })
  })

  it('keeps valid fields and replaces malformed ones field by field', () => {
    const parsed = parsePreferences({
      source: MT5_KEY, symbol: 'BTCUSD', resolution: 'D', watchlist: ['GBPUSD', 'GBPUSD', 7, ''], collapsed: ['Metals', 3],
      sources: { demo: { symbol: 'EURUSD', watchlist: ['EURUSD', 1] }, '': { symbol: 'X' }, [MT5_KEY]: { symbol: 'Y' }, bad: 'x' },
      sort: { key: 'last', direction: 2 }, panel: 'ticket', panelWidth: 9_999, bottomOpen: 'yes', bottomHeight: 12,
      bottomTab: 'deals', upColor: 'red', orderType: 'stop', lots: -1, historyPeriod: { period: 'custom', from: '2026-10-01', to: 'soon' },
    })
    expect(parsed).toMatchObject({
      source: MT5_KEY, symbol: 'BTCUSD', resolution: '1D', watchlist: ['GBPUSD'], collapsed: ['Metals'], sort: null, panel: 'ticket',
      panelWidth: PANEL_MAX, bottomOpen: true, bottomTab: 'deals', upColor: 'red', orderType: 'stop', lots: 0.1,
      historyPeriod: { period: 'custom', from: '2026-10-01', to: '' },
    })
    expect(parsed.sources).toEqual({ demo: { symbol: 'EURUSD', watchlist: ['EURUSD'], collapsed: [] }, bad: { symbol: '', watchlist: [], collapsed: [] } })
    expect(parsed.bottomHeight).toBeGreaterThanOrEqual(120)
    expect(parsePreferences('garbage')).toEqual(defaultPreferences())
    expect(parsePreferences({ panel: null }).panel).toBeNull()
    expect(parsePreferences({ historyPeriod: { period: 'year' } }).historyPeriod).toEqual({ period: 'week', from: '', to: '' })
  })

  it('reads preferences from before per-source fields as the demo source', () => {
    const parsed = parsePreferences({ symbol: 'EURUSD', resolution: '60', watchlist: ['EURUSD', 'NOPE'], collapsed: ['metal'] })
    expect(parsed).toMatchObject({ source: 'demo', symbol: 'EURUSD', resolution: '60', watchlist: ['EURUSD', 'NOPE'], collapsed: ['metal'] })
    const store = createMarketStore(parsed).create()
    store.actions.selectSource('demo', DEMO)
    expect(store.getSnapshot()).toMatchObject({ source: 'demo', symbol: 'EURUSD', watchlist: ['EURUSD'], collapsed: ['metal'] })
  })

  it('keeps the symbol, watchlist and groups of each source apart', () => {
    const store = createMarketStore(defaultPreferences()).create()
    store.actions.selectSource('demo', DEMO)
    store.actions.setSymbol('EURUSD')
    store.actions.removeSymbol('GBPUSD')
    store.actions.toggleGroup('forex')
    store.actions.selectSource(MT5_KEY, MT5)
    expect(store.getSnapshot()).toMatchObject({ source: MT5_KEY, symbol: 'XAUUSD', watchlist: ['US500', 'XAUUSD'], collapsed: [] })
    expect(store.getSnapshot().sources).toEqual({ demo: { symbol: 'EURUSD', watchlist: ['EURUSD', 'XAUUSD'], collapsed: ['forex'] } })
    store.actions.setSymbol('US500')
    store.actions.toggleGroup('Indices')
    store.actions.selectSource('demo', DEMO)
    expect(store.getSnapshot()).toMatchObject({ source: 'demo', symbol: 'EURUSD', watchlist: ['EURUSD', 'XAUUSD'], collapsed: ['forex'] })
    expect(Object.keys(store.getSnapshot().sources)).toEqual([MT5_KEY])
    // The broker dropped gold since: the watchlist follows its catalogue.
    store.actions.selectSource(MT5_KEY, { tickers: ['EURUSD', 'US500'], watch: [] })
    expect(store.getSnapshot()).toMatchObject({ symbol: 'US500', watchlist: ['US500'], collapsed: ['Indices'] })
    const before = store.getSnapshot()
    store.actions.selectSource(MT5_KEY, { tickers: ['EURUSD', 'US500'], watch: [] })
    expect(store.getSnapshot()).toBe(before)
  })

  it('cycles sorting: numbers descend first, text ascends first, the third click restores list order', () => {
    const store = createMarketStore(defaultPreferences()).create()
    store.actions.cycleSort('change')
    expect(store.getSnapshot().sort).toEqual({ key: 'change', direction: -1 })
    store.actions.cycleSort('change')
    expect(store.getSnapshot().sort).toEqual({ key: 'change', direction: 1 })
    store.actions.cycleSort('change')
    expect(store.getSnapshot().sort).toBeNull()
    store.actions.cycleSort('ticker')
    expect(store.getSnapshot().sort).toEqual({ key: 'ticker', direction: 1 })
  })

  it('clamps panel sizes and ignores invalid lots and periods', () => {
    const store = createMarketStore(defaultPreferences()).create()
    store.actions.setPanelWidth(10)
    expect(store.getSnapshot().panelWidth).toBe(PANEL_MIN)
    store.actions.setLots(Number.NaN)
    store.actions.setLots(0)
    expect(store.getSnapshot().lots).toBe(0.1)
    store.actions.setBottomTab('history')
    expect(store.getSnapshot()).toMatchObject({ bottomTab: 'history', bottomOpen: true })
    store.actions.setHistoryPeriod({ period: 'month', from: 'x', to: '2026-11-01' })
    expect(store.getSnapshot().historyPeriod).toEqual({ period: 'month', from: '', to: '2026-11-01' })
  })

  it('persists changes and reads them back', () => {
    const storage = memoryStorage()
    const store = createMarketStore(readPreferences(storage)).create()
    const stop = persistPreferences(store, storage)
    store.actions.selectSource('demo', DEMO)
    store.actions.setSymbol('EURUSD')
    store.actions.removeSymbol('GBPUSD')
    store.actions.setHistoryPeriod({ period: 'quarter', from: '', to: '' })
    stop()
    store.actions.setSymbol('GBPUSD')
    expect(readPreferences(storage)).toMatchObject({ source: 'demo', symbol: 'EURUSD', watchlist: ['EURUSD', 'XAUUSD'], historyPeriod: { period: 'quarter' } })
    expect(readPreferences(memoryStorage({ [MARKET_STORAGE_KEY]: '{not json' }))).toEqual(defaultPreferences())
  })
})

describe('demo account', () => {
  const WEDNESDAY = Date.UTC(2026, 10, 11, 15)

  it('answers every trade request offline without changing the account', async () => {
    const market = createMockMarketData({ now: () => WEDNESDAY, interval: 0 })
    const trading = createMockTrading({ market, now: () => WEDNESDAY, latency: 0 })
    const before = trading.getSnapshot()
    expect(before.connection.source).toBe('mock')
    expect(before.positions.length).toBe(3)
    expect(before.orders.length).toBe(2)
    const result = await trading.sendOrder({
      ticker: 'EURUSD', side: 'buy', type: 'market', lots: 0.1, price: null, takeProfit: null, stopLoss: null, deviation: 10, comment: '',
    })
    expect(result.status).toBe('offline')
    expect((await trading.closePosition(before.positions[0]!.ticket)).status).toBe('offline')
    expect((await trading.cancelOrder(before.orders[0]!.ticket)).status).toBe('offline')
    expect(trading.getSnapshot().positions).toEqual(before.positions)
    trading.dispose()
    market.dispose()
  })

  it('shows the history of the selected period, with the deposit that funded the account', () => {
    const market = createMockMarketData({ now: () => WEDNESDAY, interval: 0 })
    const trading = createMockTrading({ market, now: () => WEDNESDAY, latency: 0 })
    const week = trading.getSnapshot()
    expect(week.historyState).toEqual({ selection: { period: 'week', from: '', to: '' }, status: 'ready', error: null, truncated: false })
    expect(week.deals.length).toBeGreaterThan(0)
    expect(week.deals.some(deal => deal.kind === 'balance')).toBe(false)
    const listener = { calls: 0 }
    trading.subscribe(() => { listener.calls++ })
    trading.setHistoryPeriod({ period: 'quarter', from: '', to: '' })
    expect(listener.calls).toBe(1)
    const deposit = trading.getSnapshot().deals.find(deal => deal.kind === 'balance')
    expect(deposit).toMatchObject({ operation: 'balance', profit: 10_000, side: null, entry: null, ticker: '' })
    trading.setHistoryPeriod({ period: 'custom', from: '2020-01-01', to: '2020-01-31' })
    expect(trading.getSnapshot()).toMatchObject({ history: [], deals: [] })
    trading.dispose()
    market.dispose()
  })
})
