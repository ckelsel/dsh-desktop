/** The market page's MT5 market data: the catalogue as symbols, the source states, quotes, bars, history and the merged subscription. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketSymbol, Quote } from '../src/client/market/data/market-data.ts'
import { createMockMarketData } from '../src/client/market/data/mock-market-data.ts'
import { assetClassOf, createMt5MarketData, marketSymbol, quoteOf, SEARCH_LIMIT } from '../src/client/market/data/mt5-market-data.ts'
import { createQuoteHub } from '../src/client/market/quotes.ts'
import { createDatafeed, type DatafeedLabels } from '../src/client/market/tradingview/datafeed.ts'
import type { TvBar, TvSymbolInfo } from '../src/client/market/tradingview/tv-types.ts'
import type { Mt5BarData, Mt5HistoryBars, Mt5Status, Mt5Symbol } from '../src/mt5/contract.ts'
import { barsOf, catalogOf, DISABLED, fakeBridge, LISTENING, READY, ticksOf, type FakeBridgeOptions } from './market-fake-bridge.ts'
import { BAR, EURUSD, SYMBOLS, TICK, US500, XAUUSD } from './mt5-fixtures.ts'

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.unstubAllGlobals()
})

function provider(options: FakeBridgeOptions = { catalog: catalogOf() }) {
  const demo = createMockMarketData({ interval: 0, now: () => Date.UTC(2026, 10, 11, 15) })
  const fake = fakeBridge(options)
  const market = createMt5MarketData({ bridge: fake.bridge, demo })
  disposers.push(() => { market.dispose() })
  return { market, fake, demo }
}

/** Let queued microtasks and the bridge's first answers run. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

const symbolOf = (wire: Record<string, unknown>): Mt5Symbol => catalogOf([wire]).symbols[0]!

describe('MT5 symbols', () => {
  it('maps the catalogue: classes, groups, pips and tick sizes', () => {
    expect(marketSymbol(symbolOf(EURUSD), 'Example-Demo')).toEqual({
      ticker: 'EURUSD', description: 'Euro vs US Dollar', exchange: 'Example-Demo', assetClass: 'forex', group: 'Forex',
      baseCurrency: 'EUR', currency: 'USD', decimals: 5, tickSize: 0.00001, pip: 0.0001, contractSize: 100_000,
      minLots: 0.01, maxLots: 100, lotStep: 0.01, session: '24x7', timezone: 'Etc/UTC',
    })
    expect(marketSymbol(symbolOf(XAUUSD), 'X')).toMatchObject({ assetClass: 'metal', group: 'Metals', decimals: 2, pip: 0.01, tickSize: 0.01 })
    expect(marketSymbol(symbolOf(US500), 'X')).toMatchObject({ assetClass: 'index', group: 'Indices', pip: 0.01, tickSize: 0.25, minLots: 0.1 })
    expect(marketSymbol(symbolOf({ ...EURUSD, name: 'USDJPY', digits: 3, point: 0.001, tick_size: 0.001 }), 'X')).toMatchObject({ pip: 0.01 })
    expect(marketSymbol(symbolOf({ ...EURUSD, name: 'X1', path: 'X1', description: '' }), 'X')).toMatchObject({ group: 'forex', description: 'X1' })
  })

  it('classes symbols by metal currency, then folder, then sector, then calculation mode', () => {
    const symbol = (path: string, sector = 'undefined', calcMode = 'cfd', currencyBase = 'USD') => ({ name: 'S', path, currencyBase, sector, calcMode })
    expect(assetClassOf(symbol('Commodities\\Spot\\S', 'commodities', 'cfd', 'XAG'))).toBe('metal')
    expect(assetClassOf(symbol('Stocks\\Energy\\S', 'energy'))).toBe('stock')
    expect(assetClassOf(symbol('CFD\\Oil\\S'))).toBe('commodity')
    expect(assetClassOf(symbol('Crypto\\S'))).toBe('crypto')
    expect(assetClassOf(symbol('S', 'currency_crypto'))).toBe('crypto')
    expect(assetClassOf(symbol('S', 'undefined', 'cfdindex'))).toBe('index')
    expect(assetClassOf(symbol('Misc\\S', 'undefined', 'forex'))).toBe('forex')
    expect(assetClassOf(symbol('S'))).toBe('other')
  })

  it('quotes the bid as the last price, with the day the terminal has', () => {
    const [tick] = ticksOf(TICK)
    const quote = quoteOf({ ticker: 'EURUSD', decimals: 5 }, tick!)
    expect(quote).toMatchObject({ ticker: 'EURUSD', last: 1.07251, bid: 1.07251, ask: 1.07253, open: 1.0701, high: 1.0731, low: 1.0695, prevClose: 1.0702, change: 0.00231, volume: 51_234, marketOpen: true })
    expect(quote.changePercent).toBeCloseTo(0.2158, 3)
    const [bare] = ticksOf({ ...TICK, day_open: null, day_high: null, day_low: null, prev_close: null, day_volume: null, session_open: false })
    expect(quoteOf({ ticker: 'EURUSD', decimals: 5 }, bare!)).toMatchObject({ open: 1.07251, high: 1.07251, low: 1.07251, prevClose: 1.07251, change: 0, changePercent: 0, volume: 0, marketOpen: false })
  })
})

describe('createMt5MarketData', () => {
  it('waits for the catalogue, then serves the broker symbols', async () => {
    const { market, fake } = provider({ catalog: null })
    const changes = vi.fn()
    market.subscribeSource(changes)
    expect(market.source()).toEqual({ key: 'mt5', state: 'waiting', live: false, watch: [] })
    await settle()
    expect(market.symbols()).toEqual([])
    fake.pushCatalog(catalogOf())
    expect(market.source()).toEqual({ key: 'mt5:Example-Demo', state: 'ready', live: true, watch: ['XAUUSD', 'EURUSD'] })
    expect(changes).toHaveBeenCalled()
    expect(market.symbols().map(symbol => symbol.ticker)).toEqual(['EURUSD', 'XAUUSD', 'US500'])
    expect(market.symbol('US500')?.assetClass).toBe('index')
    expect(market.search('usd').map(symbol => symbol.ticker)).toEqual(['EURUSD', 'XAUUSD'])
    expect(market.search('xau').map(symbol => symbol.ticker)).toEqual(['XAUUSD'])
    expect(market.search('gold').map(symbol => symbol.ticker)).toEqual(['XAUUSD'])
    expect(market.search('', 'index').map(symbol => symbol.ticker)).toEqual(['US500'])
  })

  it('ranks exact tickers first and returns at most a page of matches', async () => {
    const many = Array.from({ length: SEARCH_LIMIT + 20 }, (_, index) => ({ ...EURUSD, name: `EURUSD${String(index)}`, path: `Forex\\EURUSD${String(index)}` }))
    const { market } = provider({ catalog: catalogOf([...many, EURUSD], ['EURUSD']) })
    await settle()
    const found = market.search('eurusd')
    expect(found).toHaveLength(SEARCH_LIMIT)
    expect(found[0]?.ticker).toBe('EURUSD')
  })

  it('shows the demo data while the bridge is turned off', async () => {
    const { market, fake, demo } = provider({ status: DISABLED, catalog: null })
    await settle()
    expect(market.source()).toBe(demo.source())
    expect(market.symbols()).toBe(demo.symbols())
    expect(market.quote('EURUSD')).toEqual(demo.quote('EURUSD'))
    const onQuote = vi.fn()
    market.subscribeQuotes(['EURUSD'], onQuote)
    demo.tick()
    expect(onQuote).toHaveBeenCalledWith(expect.objectContaining({ ticker: 'EURUSD' }))
    await settle()
    expect(fake.bridge.subscribe).not.toHaveBeenCalled()
  })

  it('merges every subscription into one set within the catalogue and sends it when it changes', async () => {
    const { market, fake } = provider()
    await settle()
    const first = market.subscribeQuotes(['XAUUSD', 'EURUSD'], () => {})
    const second = market.subscribeQuotes(['EURUSD', 'NOPE'], () => {})
    const bars = market.subscribeBars('EURUSD', '5', () => {})
    const twice = market.subscribeBars('EURUSD', '5', () => {})
    market.subscribeBars('US500', '1D', () => {})
    await settle()
    expect(fake.bridge.subscribe).toHaveBeenCalledOnce()
    expect(fake.lastSubscription()).toEqual({
      quotes: ['EURUSD', 'XAUUSD'], bars: [{ symbol: 'EURUSD', timeframe: 'M5' }, { symbol: 'US500', timeframe: 'D1' }],
    })
    first()
    twice()
    await settle()
    expect(fake.lastSubscription()).toEqual({ quotes: ['EURUSD'], bars: [{ symbol: 'EURUSD', timeframe: 'M5' }, { symbol: 'US500', timeframe: 'D1' }] })
    second()
    bars()
    await settle()
    expect(fake.lastSubscription()).toEqual({ quotes: [], bars: [{ symbol: 'US500', timeframe: 'D1' }] })
    expect(fake.bridge.subscribe).toHaveBeenCalledTimes(3)
  })

  it('turns ticks into quotes and bars into candles of the matching stream', async () => {
    const { market, fake } = provider()
    await settle()
    const quotes: Quote[] = []
    market.subscribeQuotes(['EURUSD'], (quote) => { quotes.push(quote) })
    fake.pushTicks(ticksOf(TICK, { ...TICK, symbol: 'XAUUSD', bid: 2350.5, ask: 2350.8 }, { ...TICK, symbol: 'NOPE' }))
    expect(quotes.map(quote => quote.ticker)).toEqual(['EURUSD'])
    expect(market.quote('EURUSD')).toBe(quotes[0])
    expect(market.quote('XAUUSD')?.bid).toBe(2350.5)
    expect(market.quote('NOPE')).toBeUndefined()

    const onBar = vi.fn()
    market.subscribeBars('EURUSD', '5', onBar)
    fake.pushBars(barsOf(BAR, { ...BAR, timeframe: 'M1' }, { ...BAR, symbol: 'XAUUSD' }))
    expect(onBar).toHaveBeenCalledOnce()
    expect(onBar).toHaveBeenLastCalledWith({ time: BAR.time, open: 1.0724, high: 1.0726, low: 1.0723, close: 1.07251, volume: 87 })
    // An update of an older bar never moves the chart back.
    fake.pushBars(barsOf({ ...BAR, time: BAR.time - 300_000 }, { ...BAR, close: 1.0725, volume: 90 }))
    expect(onBar).toHaveBeenCalledTimes(2)
    expect(onBar).toHaveBeenLastCalledWith(expect.objectContaining({ time: BAR.time, close: 1.0725, volume: 90 }))
  })

  it('loads history through the bridge, within its limit, and no stream bar older than what it loaded', async () => {
    const { market, fake } = provider()
    await settle()
    const t0 = 1_762_000_000_000
    fake.bridge.historyBars.mockResolvedValueOnce({
      bars: [{ time: t0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }, { time: t0 + 300_000, open: 1.5, high: 2, low: 1, close: 1.8, volume: 12 }], noData: false,
    })
    const result = await market.history({ ticker: 'EURUSD', resolution: '5', from: t0 - 3_600_000, to: t0 + 600_000, countBack: 300 })
    expect(fake.bridge.historyBars).toHaveBeenLastCalledWith({ symbol: 'EURUSD', timeframe: 'M5', to: t0 + 600_000, count: 300 }, { partial: false })
    expect(result).toEqual({ bars: [{ time: t0, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }, { time: t0 + 300_000, open: 1.5, high: 2, low: 1, close: 1.8, volume: 12 }], noData: false })
    const onBar = vi.fn()
    market.subscribeBars('EURUSD', '5', onBar)
    fake.pushBars(barsOf({ ...BAR, time: t0 }))
    expect(onBar).not.toHaveBeenCalled()

    await expect(market.history({ ticker: 'EURUSD', resolution: '120', from: 0, to: t0, countBack: 99_999 })).resolves.toEqual({ bars: [], noData: true })
    expect(fake.bridge.historyBars).toHaveBeenLastCalledWith({ symbol: 'EURUSD', timeframe: 'H2', to: t0, count: 5000 }, { partial: false })
    await expect(market.history({ ticker: 'NOPE', resolution: '5', from: 0, to: t0, countBack: 10 })).resolves.toEqual({ bars: [], noData: true })
    expect(fake.bridge.historyBars).toHaveBeenCalledTimes(2)
    // A partial page that is still downloading does not end the paging, even without bars.
    fake.bridge.historyBars.mockResolvedValueOnce({ bars: [], noData: true, partial: true })
    await expect(market.history({ ticker: 'EURUSD', resolution: '1D', from: 0, to: t0, countBack: 50, partial: true })).resolves.toEqual({ bars: [], noData: false, partial: true })
    expect(fake.bridge.historyBars).toHaveBeenLastCalledWith({ symbol: 'EURUSD', timeframe: 'D1', to: t0, count: 50 }, { partial: true })
  })

  it('keeps the catalogue paused while the EA is away and reloads the charts once it is back', async () => {
    const { market, fake } = provider()
    await settle()
    const onReset = vi.fn()
    market.subscribeBars('EURUSD', '5', () => {}, onReset)
    fake.pushStatus(LISTENING)
    expect(market.source()).toMatchObject({ key: 'mt5:Example-Demo', state: 'ready', live: false })
    expect(market.symbol('EURUSD')).toBeDefined()
    fake.bridge.historyBars.mockRejectedValueOnce(new Error('not_connected'))
    await expect(market.history({ ticker: 'EURUSD', resolution: '5', from: 0, to: 1, countBack: 10 })).rejects.toThrow('not_connected')
    fake.pushStatus({ ...READY, syncedAt: 9 })
    expect(market.source().live).toBe(true)
    expect(onReset).toHaveBeenCalledOnce()
    fake.pushStatus({ ...READY, syncedAt: 10 })
    expect(onReset).toHaveBeenCalledOnce()
    // Another trade server's catalogue replaces it.
    fake.pushCatalog(null)
    expect(market.source()).toMatchObject({ key: 'mt5', state: 'waiting' })
    fake.pushCatalog(catalogOf(SYMBOLS, ['EURUSD'], 'Other-Live'))
    expect(market.source()).toMatchObject({ key: 'mt5:Other-Live', state: 'ready', watch: ['EURUSD'] })
  })

  it('pauses while the terminal is away from its trade server and reloads the charts once it is back', async () => {
    const { market, fake } = provider()
    await settle()
    const onReset = vi.fn()
    market.subscribeBars('EURUSD', '5', () => {}, onReset)
    expect(market.source().live).toBe(true)
    const away: Mt5Status = { ...READY, terminal: { ...READY.terminal!, connected: false }, blocked: ['broker-disconnected'] }
    fake.pushStatus(away)
    expect(market.source()).toMatchObject({ key: 'mt5:Example-Demo', state: 'ready', live: false })
    expect(onReset).not.toHaveBeenCalled()
    fake.pushStatus(READY)
    expect(market.source().live).toBe(true)
    expect(onReset).toHaveBeenCalledOnce()
  })

  it('moves its subscriptions to the demo data and back when the bridge is turned off and on', async () => {
    const { market, fake, demo } = provider()
    await settle()
    const onQuote = vi.fn()
    market.subscribeQuotes(['EURUSD'], onQuote)
    await settle()
    expect(fake.lastSubscription()).toEqual({ quotes: ['EURUSD'], bars: [] })
    fake.pushStatus(DISABLED)
    expect(market.source().key).toBe('demo')
    demo.tick()
    expect(onQuote).toHaveBeenCalledOnce()
    fake.pushTicks(ticksOf(TICK))
    expect(onQuote).toHaveBeenCalledOnce()
    await settle()
    expect(fake.lastSubscription()).toEqual({ quotes: [], bars: [] })
    fake.pushStatus(READY)
    await settle()
    expect(market.source().key).toBe('mt5:Example-Demo')
    expect(fake.lastSubscription()).toEqual({ quotes: ['EURUSD'], bars: [] })
  })

  it('releases its subscription and stops following the bridge on dispose', async () => {
    const { market, fake } = provider()
    await settle()
    market.subscribeQuotes(['EURUSD'], () => {})
    await settle()
    expect(fake.listeners()).toBeGreaterThan(0)
    market.dispose()
    expect(fake.lastSubscription()).toEqual({ quotes: [], bars: [] })
    expect(fake.listeners()).toBe(0)
  })
})

describe('quote hub', () => {
  it('drops the quotes of a previous source', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => setTimeout(callback, 0) as unknown as number)
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => { clearTimeout(handle) })
    const { market, fake } = provider({ status: DISABLED, catalog: catalogOf() })
    await settle()
    const hub = createQuoteHub(market)
    disposers.push(() => { hub.dispose() })
    hub.follow(['EURUSD'])
    const demoQuote = hub.getSnapshot().EURUSD
    expect(demoQuote).toBeDefined()
    fake.pushStatus(READY)
    expect(hub.getSnapshot()).toEqual({})
    fake.pushTicks(ticksOf(TICK))
    await settle()
    expect(hub.getSnapshot().EURUSD).toMatchObject({ bid: 1.07251, ask: 1.07253 })
  })
})

describe('MT5 datafeed', () => {
  const labels: DatafeedLabels = {
    describe: symbol => symbol.description, allTypes: 'All',
    types: { forex: 'Forex', metal: 'Metals', index: 'Indices', commodity: 'Commodities', crypto: 'Crypto', stock: 'Stocks', other: 'Other' },
  }

  it('offers the classes the source has, serves every resolution itself and steps prices by the tick', async () => {
    const { market, fake } = provider()
    await settle()
    const onReset = vi.fn()
    const datafeed = createDatafeed(market, labels, onReset)
    disposers.push(() => { datafeed.dispose() })
    const configuration = await new Promise<{ symbols_types?: { name: string; value: string }[] }>((resolve) => { datafeed.onReady(resolve) })
    expect(configuration.symbols_types).toEqual([{ name: 'All', value: '' }, { name: 'Forex', value: 'forex' }, { name: 'Metals', value: 'metal' }, { name: 'Indices', value: 'index' }])
    const info = await new Promise<TvSymbolInfo>((resolve, reject) => { datafeed.resolveSymbol('Example-Demo:US500', resolve, reject) })
    expect(info).toMatchObject({ name: 'US500', type: 'index', pricescale: 100, minmov: 25, session: '24x7', timezone: 'Etc/UTC', exchange: 'Example-Demo' })
    expect(info.intraday_multipliers).toEqual(['1', '3', '5', '15', '30', '60', '120', '240'])
    const searched = await new Promise<{ symbol: string; type: string }[]>((resolve) => { datafeed.searchSymbols('us', '', 'metal', resolve) })
    expect(searched.map(entry => entry.symbol)).toEqual(['XAUUSD'])

    await new Promise<void>((resolve, reject) => {
      datafeed.getBars(info, '30', { from: 0, to: 1_762_000_000, countBack: 100, firstDataRequest: true }, () => { resolve() }, reject)
    })
    expect(fake.bridge.historyBars).toHaveBeenLastCalledWith({ symbol: 'US500', timeframe: 'M30', to: 1_762_000_000_000, count: 100 }, { partial: true })

    // Like the library, which unsubscribes a stream as soon as its cache resets.
    const onResetCacheNeeded = vi.fn((guid: string) => { datafeed.unsubscribeBars(guid) })
    datafeed.subscribeBars(info, '30', () => {}, 'guid-1', () => { onResetCacheNeeded('guid-1') })
    datafeed.subscribeBars({ ...info, name: 'EURUSD', ticker: 'EURUSD' }, '30', () => {}, 'guid-2', () => { onResetCacheNeeded('guid-2') })
    fake.pushStatus(LISTENING)
    fake.pushStatus(READY)
    expect(onResetCacheNeeded).toHaveBeenCalledTimes(2)
    await settle()
    expect(onReset).toHaveBeenCalledOnce()
  })

  describe('while a series loads its first screen', () => {
    const DAY = 86_400_000
    const T0 = Date.UTC(2026, 10, 2)
    const bar = (time: number): Mt5BarData => ({ time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 })
    /** `count` daily bars that end the day before `to`. */
    const before = (to: number, count: number): Mt5BarData[] => Array.from({ length: count }, (_, index) => bar(to - (count - index) * DAY))

    async function chart() {
      const { market, fake } = provider()
      await settle()
      const onReset = vi.fn()
      const datafeed = createDatafeed(market, labels, onReset)
      disposers.push(() => { datafeed.dispose() })
      const info = await new Promise<TvSymbolInfo>((resolve, reject) => { datafeed.resolveSymbol('EURUSD', resolve, reject) })
      const page = (to: number, countBack: number, firstDataRequest: boolean) => new Promise<{ bars: TvBar[]; meta: unknown }>((resolve, reject) => {
        datafeed.getBars(info, '1D', { from: 0, to: to / 1000, countBack, firstDataRequest }, (bars, meta) => { resolve({ bars, meta }) }, reject)
      })
      // The terminal has two bars of the first page, and downloads the rest.
      const request = { symbol: 'EURUSD', timeframe: 'D1', to: T0 + 2 * DAY, count: 300 }
      let whole!: (answer: Mt5HistoryBars) => void
      fake.bridge.historyBars
        .mockResolvedValueOnce({ bars: before(T0 + 2 * DAY, 2), noData: false, partial: true })
        .mockImplementationOnce(() => new Promise((resolve) => { whole = resolve }))
        .mockResolvedValueOnce({ bars: [], noData: false, partial: true })
      const first = await page(T0 + 2 * DAY, 300, true)
      // The library asks for the rest of its first screen right away.
      const rest = await page(T0, 298, false)
      /** Streams the series as the library does: resetting its cache unsubscribes it at once. */
      const stream = (guid: string) => {
        const onResetCacheNeeded = vi.fn(() => { datafeed.unsubscribeBars(guid) })
        datafeed.subscribeBars(info, '1D', () => {}, guid, onResetCacheNeeded)
        return onResetCacheNeeded
      }
      return { fake, datafeed, info, page, stream, onReset, request, first, rest, whole: (answer: Mt5HistoryBars) => { whole(answer) } }
    }

    it('shows the bars there are at once, waits in the background for the whole first page and reloads the series once', async () => {
      const { fake, datafeed, page, stream, onReset, request, first, rest, whole } = await chart()
      // Both pages answer at once, so the chart shows the two bars.
      expect(first).toEqual({ bars: [expect.objectContaining({ time: T0 }), expect.objectContaining({ time: T0 + DAY })], meta: { noData: false } })
      expect(rest).toEqual({ bars: [], meta: { noData: true } })
      expect(fake.bridge.historyBars).toHaveBeenNthCalledWith(1, request, { partial: true })
      expect(fake.bridge.historyBars).toHaveBeenNthCalledWith(2, request, { partial: false })
      expect(fake.bridge.historyBars).toHaveBeenNthCalledWith(3, { symbol: 'EURUSD', timeframe: 'D1', to: T0, count: 298 }, { partial: true })
      // One wait for the series, however many pages were partial.
      expect(fake.bridge.historyBars).toHaveBeenCalledTimes(3)
      const onResetCacheNeeded = stream('guid-1')
      // The whole page comes long after the library dropped the stream of the series before.
      whole({ bars: before(T0 + 2 * DAY, 300), noData: false })
      await vi.waitFor(() => { expect(onReset).toHaveBeenCalledOnce() })
      expect(onResetCacheNeeded).toHaveBeenCalledOnce()

      // The library loads the series again; the page is whole now, so nothing waits.
      fake.bridge.historyBars.mockResolvedValueOnce({ bars: before(T0 + 2 * DAY, 300), noData: false, partial: false })
      await expect(page(T0 + 2 * DAY, 300, true)).resolves.toMatchObject({ bars: { length: 300 }, meta: { noData: false } })
      expect(fake.bridge.historyBars).toHaveBeenCalledTimes(4)
      stream('guid-2')
      // Scrolling back waits for whole pages.
      fake.bridge.historyBars.mockResolvedValueOnce({ bars: before(T0 - 298 * DAY, 5), noData: false })
      await expect(page(T0 - 298 * DAY, 300, false)).resolves.toMatchObject({ bars: { length: 5 } })
      expect(fake.bridge.historyBars).toHaveBeenLastCalledWith({ symbol: 'EURUSD', timeframe: 'D1', to: T0 - 298 * DAY, count: 300 }, { partial: false })
      expect(onReset).toHaveBeenCalledOnce()
    })

    it('reloads a series whose first page became whole before the chart streamed it', async () => {
      const { stream, onReset, whole } = await chart()
      whole({ bars: before(T0 + 2 * DAY, 300), noData: false })
      await settle()
      await settle()
      expect(onReset).not.toHaveBeenCalled()
      const onResetCacheNeeded = stream('guid-1')
      expect(onResetCacheNeeded).toHaveBeenCalledOnce()
      await vi.waitFor(() => { expect(onReset).toHaveBeenCalledOnce() })
    })

    it('leaves a series the chart switched away from, though the library still streams it', async () => {
      const { fake, datafeed, stream, onReset, whole } = await chart()
      const onResetCacheNeeded = stream('guid-1')
      // The chart switches to XAUUSD; the library keeps the EURUSD stream a while longer.
      const gold = await new Promise<TvSymbolInfo>((resolve, reject) => { datafeed.resolveSymbol('XAUUSD', resolve, reject) })
      fake.bridge.historyBars.mockResolvedValueOnce({ bars: before(T0 + 2 * DAY, 300), noData: false, partial: false })
      await new Promise((resolve, reject) => { datafeed.getBars(gold, '1D', { from: 0, to: (T0 + 2 * DAY) / 1000, countBack: 300, firstDataRequest: true }, resolve, reject) })
      whole({ bars: before(T0 + 2 * DAY, 300), noData: false })
      await settle()
      await settle()
      expect(fake.bridge.historyBars).toHaveBeenCalledTimes(4)
      expect(onResetCacheNeeded).not.toHaveBeenCalled()
      expect(onReset).not.toHaveBeenCalled()
    })
  })

  it('describes the demo data as before', async () => {
    const demo = createMockMarketData({ interval: 0 })
    disposers.push(() => { demo.dispose() })
    const datafeed = createDatafeed(demo, labels)
    const configuration = await new Promise<{ symbols_types?: { value: string }[] }>((resolve) => { datafeed.onReady(resolve) })
    expect(configuration.symbols_types?.map(type => type.value)).toEqual(['', 'forex', 'metal'])
    const info = await new Promise<TvSymbolInfo>((resolve, reject) => { datafeed.resolveSymbol('EURUSD', resolve, reject) })
    expect(info).toMatchObject({ pricescale: 100_000, minmov: 1, session: '1700-1700:23456', timezone: 'America/New_York' })
    const symbol: MarketSymbol | undefined = demo.symbol('USDJPY')
    expect(symbol).toMatchObject({ group: 'forex', tickSize: 0.001 })
  })
})
