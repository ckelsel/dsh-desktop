import { describe, expect, it } from 'vitest'
import {
  createMarketStore, defaultPreferences, MARKET_STORAGE_KEY, PANEL_MAX, PANEL_MIN, parsePreferences, persistPreferences, readPreferences,
  type PreferenceStorage,
} from '../src/client/market/store.ts'
import { createMockTrading } from '../src/client/market/data/mock-trading.ts'
import { createMockMarketData } from '../src/client/market/data/mock-market-data.ts'

const TICKERS = ['EURUSD', 'GBPUSD', 'XAUUSD']

function memoryStorage(initial: Record<string, string> = {}): PreferenceStorage & { data: Record<string, string> } {
  const data = { ...initial }
  return { data, getItem: key => data[key] ?? null, setItem: (key, value) => { data[key] = value } }
}

describe('market page preferences', () => {
  it('starts on gold with every symbol listed', () => {
    const preferences = defaultPreferences(TICKERS)
    expect(preferences.symbol).toBe('XAUUSD')
    expect(preferences.watchlist).toEqual(TICKERS)
    expect(preferences.upColor).toBe('green')
  })

  it('keeps valid fields and replaces malformed ones field by field', () => {
    const parsed = parsePreferences({
      symbol: 'BTCUSD', resolution: 'D', watchlist: ['GBPUSD', 'NOPE', 'GBPUSD', 7], collapsed: ['metal', 'crypto'],
      sort: { key: 'last', direction: 2 }, panel: 'ticket', panelWidth: 9_999, bottomOpen: 'yes', bottomHeight: 12,
      bottomTab: 'deals', upColor: 'red', orderType: 'stop', lots: -1,
    }, TICKERS)
    expect(parsed).toMatchObject({
      symbol: 'XAUUSD', resolution: '1D', watchlist: ['GBPUSD'], collapsed: ['metal'], sort: null, panel: 'ticket',
      panelWidth: PANEL_MAX, bottomOpen: true, bottomTab: 'deals', upColor: 'red', orderType: 'stop', lots: 0.1,
    })
    expect(parsed.bottomHeight).toBeGreaterThanOrEqual(120)
    expect(parsePreferences('garbage', TICKERS)).toEqual(defaultPreferences(TICKERS))
    expect(parsePreferences({ panel: null }, TICKERS).panel).toBeNull()
  })

  it('cycles sorting: numbers descend first, text ascends first, the third click restores list order', () => {
    const store = createMarketStore(defaultPreferences(TICKERS)).create()
    store.actions.cycleSort('change')
    expect(store.getSnapshot().sort).toEqual({ key: 'change', direction: -1 })
    store.actions.cycleSort('change')
    expect(store.getSnapshot().sort).toEqual({ key: 'change', direction: 1 })
    store.actions.cycleSort('change')
    expect(store.getSnapshot().sort).toBeNull()
    store.actions.cycleSort('ticker')
    expect(store.getSnapshot().sort).toEqual({ key: 'ticker', direction: 1 })
  })

  it('clamps panel sizes and ignores invalid lots', () => {
    const store = createMarketStore(defaultPreferences(TICKERS)).create()
    store.actions.setPanelWidth(10)
    expect(store.getSnapshot().panelWidth).toBe(PANEL_MIN)
    store.actions.setLots(Number.NaN)
    store.actions.setLots(0)
    expect(store.getSnapshot().lots).toBe(0.1)
    store.actions.setBottomTab('history')
    expect(store.getSnapshot()).toMatchObject({ bottomTab: 'history', bottomOpen: true })
  })

  it('persists changes and reads them back', () => {
    const storage = memoryStorage()
    const store = createMarketStore(readPreferences(storage, TICKERS)).create()
    const stop = persistPreferences(store, storage)
    store.actions.setSymbol('EURUSD')
    store.actions.removeSymbol('GBPUSD')
    stop()
    store.actions.setSymbol('GBPUSD')
    expect(readPreferences(storage, TICKERS)).toMatchObject({ symbol: 'EURUSD', watchlist: ['EURUSD', 'XAUUSD'] })
    expect(readPreferences(memoryStorage({ [MARKET_STORAGE_KEY]: '{not json' }), TICKERS)).toEqual(defaultPreferences(TICKERS))
  })
})

describe('demo account', () => {
  it('answers every trade request offline without changing the account', async () => {
    const market = createMockMarketData({ now: () => Date.UTC(2026, 10, 11, 15), interval: 0 })
    const trading = createMockTrading({ market, now: () => Date.UTC(2026, 10, 11, 15), latency: 0 })
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
})
