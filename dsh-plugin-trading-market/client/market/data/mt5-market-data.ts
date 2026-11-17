/**
 * Market data through the Desktop's MT5 bridge: the broker's symbol catalogue, quotes and bid bars,
 * as the terminal shows them. While the bridge is on, MT5 is the only source: until its first
 * catalogue arrives the source is `waiting` and shows nothing, and while the EA is away the
 * catalogue and the last quotes stay, paused (`live` false); once it is back, charts that missed
 * bars load them again. While the bridge is turned off in Settings the demo data stands in.
 *
 * Every quote and bar subscription of the page is merged into one set, which goes to the main
 * process whole whenever it changes; the main process forwards it to the EA and restores it after
 * every reconnect.
 */
import {
  MT5_MAX_BAR_STREAMS, MT5_MAX_HISTORY_BARS, MT5_MAX_QUOTES,
  type Mt5BarStream, type Mt5Catalog, type Mt5RendererBridge, type Mt5Subscription, type Mt5Symbol, type Mt5Tick, type Mt5Timeframe,
} from '../../contract.ts'
import type { AssetClass, Candle, HistoryRequest, HistoryResult, MarketDataProvider, MarketSource, MarketSymbol, Quote, Resolution } from './market-data.ts'
import type { MockMarketData } from './mock-market-data.ts'
import { createMt5StatusSource } from './mt5-bridge.ts'

export interface Mt5MarketDataOptions {
  bridge: Mt5RendererBridge
  /** The demo data shown while the bridge is turned off; this provider disposes it. */
  demo: MockMarketData
  /** Receives failed reads and subscription updates. */
  onError?: (error: unknown) => void
}

/** The MT5 market data, with teardown. */
export interface Mt5MarketData extends MarketDataProvider {
  dispose(): void
}

/** The MT5 timeframe of each chart resolution. */
export const MT5_TIMEFRAME: Readonly<Record<Resolution, Mt5Timeframe>> = {
  1: 'M1', 3: 'M3', 5: 'M5', 15: 'M15', 30: 'M30', 60: 'H1', 120: 'H2', 240: 'H4', '1D': 'D1', '1W': 'W1',
}

/** Most symbols a search returns. */
export const SEARCH_LIMIT = 200

const METALS = new Set(['XAU', 'XAG', 'XPT', 'XPD'])
/** Folder name keywords, tried in this order on each folder from the top. */
const FOLDER_CLASSES: readonly (readonly [RegExp, AssetClass])[] = [
  [/crypto|bitcoin|digital/i, 'crypto'],
  [/metal|gold|silver|bullion/i, 'metal'],
  [/forex|\bfx\b|currenc/i, 'forex'],
  [/indice|index|indexes/i, 'index'],
  [/stock|share|equit|\betfs?\b/i, 'stock'],
  [/commodit|energ|\boil\b|agri|\bsofts?\b/i, 'commodity'],
]
const SECTOR_CLASSES: Readonly<Record<string, AssetClass>> = {
  currency: 'forex', currency_crypto: 'crypto', indexes: 'index', commodities: 'commodity',
  basic_materials: 'stock', communication_services: 'stock', consumer_cyclical: 'stock', consumer_defensive: 'stock', energy: 'stock',
  financial: 'stock', healthcare: 'stock', industrials: 'stock', real_estate: 'stock', technology: 'stock', utilities: 'stock',
}
const CALC_CLASSES: Readonly<Record<string, AssetClass>> = {
  forex: 'forex', forex_no_leverage: 'forex', cfdindex: 'index', exch_stocks: 'stock', exch_stocks_moex: 'stock',
}

/** The folders of a symbol's path, top first, without the symbol itself. */
function foldersOf(symbol: Pick<Mt5Symbol, 'name' | 'path'>): string[] {
  const parts = symbol.path.split(/[\\/]/).map(part => part.trim()).filter(part => part !== '')
  if (parts.at(-1) === symbol.name) parts.pop()
  return parts
}

/**
 * The asset class of an MT5 symbol: a metal by its base currency; else by the first folder that
 * names a class; else by `SYMBOL_SECTOR`; else by the calculation mode.
 */
export function assetClassOf(symbol: Pick<Mt5Symbol, 'name' | 'path' | 'currencyBase' | 'sector' | 'calcMode'>): AssetClass {
  if (METALS.has(symbol.currencyBase.toUpperCase())) return 'metal'
  for (const folder of foldersOf(symbol)) {
    for (const [pattern, assetClass] of FOLDER_CLASSES) if (pattern.test(folder)) return assetClass
  }
  return SECTOR_CLASSES[symbol.sector] ?? CALC_CLASSES[symbol.calcMode] ?? 'other'
}

/**
 * The market page's view of an MT5 symbol. A pip is ten points on 3 and 5 digit quotes, as FX
 * pips are, and one point otherwise. MT5 reports no session hours here, so the chart treats the
 * symbol as always open and shows the bars MT5 has.
 * @param exchange - the trade server, which the chart shows as the exchange.
 */
export function marketSymbol(symbol: Mt5Symbol, exchange: string): MarketSymbol {
  const assetClass = assetClassOf(symbol)
  const pip = symbol.digits === 3 || symbol.digits === 5 ? Number((symbol.point * 10).toPrecision(12)) : symbol.point
  return {
    ticker: symbol.name, description: symbol.description === '' ? symbol.name : symbol.description, exchange, assetClass,
    group: foldersOf(symbol)[0] ?? assetClass, baseCurrency: symbol.currencyBase, currency: symbol.currencyProfit,
    decimals: symbol.digits, tickSize: symbol.tickSize, pip, contractSize: symbol.contractSize,
    minLots: symbol.volumeMin, maxLots: symbol.volumeMax, lotStep: symbol.volumeStep,
    session: '24x7', timezone: 'Etc/UTC',
  }
}

/**
 * The quote of an MT5 tick. The chart draws bid bars, as MT5 does, so the last price is the bid;
 * the day's figures the terminal does not have yet fall back to it.
 */
export function quoteOf(symbol: Pick<MarketSymbol, 'ticker' | 'decimals'>, tick: Mt5Tick): Quote {
  const last = tick.bid
  const prevClose = tick.prevClose ?? last
  return {
    ticker: symbol.ticker, last, bid: tick.bid, ask: tick.ask,
    open: tick.dayOpen ?? last, high: Math.max(tick.dayHigh ?? last, last), low: Math.min(tick.dayLow ?? last, last), prevClose,
    change: Number((last - prevClose).toFixed(symbol.decimals)),
    changePercent: prevClose === 0 ? 0 : (last - prevClose) / prevClose * 100,
    volume: tick.dayVolume ?? 0, time: tick.time, marketOpen: tick.sessionOpen,
  }
}

/** Symbols matching a query: exact tickers first, then ticker prefixes, ticker parts and descriptions, in catalogue order. */
export function searchSymbols(symbols: readonly MarketSymbol[], query: string, assetClass?: AssetClass): MarketSymbol[] {
  const needle = query.trim().toLowerCase()
  const ranked: { rank: number; index: number; symbol: MarketSymbol }[] = []
  symbols.forEach((symbol, index) => {
    if (assetClass !== undefined && symbol.assetClass !== assetClass) return
    const ticker = symbol.ticker.toLowerCase()
    const rank = needle === '' ? 0
      : ticker === needle ? 0 : ticker.startsWith(needle) ? 1 : ticker.includes(needle) ? 2
        : symbol.description.toLowerCase().includes(needle) ? 3 : -1
    if (rank >= 0) ranked.push({ rank, index, symbol })
  })
  ranked.sort((left, right) => left.rank - right.rank || left.index - right.index)
  return ranked.slice(0, SEARCH_LIMIT).map(entry => entry.symbol)
}

interface QuoteSubscription {
  tickers: ReadonlySet<string>
  onQuote(quote: Quote): void
  /** The demo subscription while the demo data is shown. */
  stop?: () => void
}

interface BarSubscription {
  ticker: string
  resolution: Resolution
  onBar(bar: Candle): void
  onReset?: () => void
  /** The latest bar time delivered. */
  last?: number
  stop?: () => void
}

const EMPTY: Mt5Subscription = Object.freeze({ quotes: Object.freeze([]), bars: Object.freeze([]) })
const streamKey = (symbol: string, timeframe: Mt5Timeframe): string => `${symbol}\n${timeframe}`
const sameSource = (left: MarketSource, right: MarketSource): boolean =>
  left.key === right.key && left.state === right.state && left.live === right.live && left.watch === right.watch

/**
 * Create the MT5 market data provider.
 * @returns the provider; it follows the bridge from creation.
 */
export function createMt5MarketData(options: Mt5MarketDataOptions): Mt5MarketData {
  const { bridge, demo } = options
  const status = createMt5StatusSource(bridge, options.onError)
  let catalog: Mt5Catalog | null = null
  let symbols: readonly MarketSymbol[] = []
  let byTicker = new Map<string, MarketSymbol>()
  const quotes = new Map<string, Quote>()
  const quoteSubscriptions = new Set<QuoteSubscription>()
  const barSubscriptions = new Set<BarSubscription>()
  // The newest bar time each stream has loaded, so a late update never moves a chart backwards.
  const loaded = new Map<string, number>()
  const sourceListeners = new Set<() => void>()
  let showsDemo = false
  let live = false
  // Bars may be missing: the EA went away, or a chart failed to load while it was.
  let stale = false
  let source: MarketSource = { key: 'mt5', state: 'waiting', live: false, watch: [] }
  let sent = JSON.stringify(EMPTY)
  let queued = false
  let disposed = false

  const report = (error: unknown): void => { if (!disposed) options.onError?.(error) }

  /** Everything the page follows, within the bridge's limits, in a stable order. */
  const wanted = (): Mt5Subscription => {
    if (showsDemo || catalog === null) return EMPTY
    const tickers = new Set<string>()
    for (const subscription of quoteSubscriptions) {
      for (const ticker of subscription.tickers) if (tickers.size < MT5_MAX_QUOTES && byTicker.has(ticker)) tickers.add(ticker)
    }
    const streams = new Map<string, Mt5BarStream>()
    for (const subscription of barSubscriptions) {
      const timeframe = MT5_TIMEFRAME[subscription.resolution]
      const key = streamKey(subscription.ticker, timeframe)
      if (streams.size < MT5_MAX_BAR_STREAMS && byTicker.has(subscription.ticker)) streams.set(key, { symbol: subscription.ticker, timeframe })
    }
    return {
      quotes: [...tickers].sort(),
      bars: [...streams.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, stream]) => stream),
    }
  }
  const flush = (): void => {
    queued = false
    if (disposed) return
    const subscription = wanted()
    const text = JSON.stringify(subscription)
    if (text === sent) return
    sent = text
    bridge.subscribe(subscription).catch((error: unknown) => {
      // Sent again with the next change.
      if (sent === text) sent = ''
      report(error)
    })
  }
  const schedule = (): void => {
    if (queued || disposed) return
    queued = true
    queueMicrotask(flush)
  }

  const attachQuotes = (subscription: QuoteSubscription): void => {
    subscription.stop?.()
    subscription.stop = showsDemo ? demo.subscribeQuotes([...subscription.tickers], subscription.onQuote) : undefined
  }
  const attachBars = (subscription: BarSubscription): void => {
    subscription.stop?.()
    subscription.stop = showsDemo ? demo.subscribeBars(subscription.ticker, subscription.resolution, subscription.onBar) : undefined
  }

  const update = (): void => {
    if (disposed) return
    const current = status.get()
    const demoNow = current?.phase === 'disabled'
    if (demoNow !== showsDemo) {
      showsDemo = demoNow
      for (const subscription of quoteSubscriptions) attachQuotes(subscription)
      for (const subscription of barSubscriptions) attachBars(subscription)
    }
    const wasLive = live
    // While the terminal is away from its trade server, it misses ticks and later downloads the
    // bars of that time; the charts reload once it is back, so they match MT5 again.
    live = !showsDemo && catalog !== null && current?.phase === 'ready' && current.terminal?.connected !== false
    if (wasLive && !live) stale = true
    const next: MarketSource = showsDemo ? demo.source()
      : catalog === null ? { key: 'mt5', state: 'waiting', live: false, watch: [] }
        : { key: `mt5:${catalog.server}`, state: 'ready', live, watch: catalog.watch }
    if (!sameSource(source, next)) {
      source = next
      for (const listener of [...sourceListeners]) listener()
    }
    if (live && stale) {
      stale = false
      for (const subscription of [...barSubscriptions]) subscription.onReset?.()
    }
    schedule()
  }

  const setCatalog = (next: Mt5Catalog | null): void => {
    if (disposed) return
    catalog = next
    symbols = next === null ? [] : next.symbols.map(symbol => marketSymbol(symbol, next.server))
    byTicker = new Map(symbols.map(symbol => [symbol.ticker, symbol]))
    for (const ticker of [...quotes.keys()]) if (!byTicker.has(ticker)) quotes.delete(ticker)
    if (next === null) loaded.clear()
    update()
  }

  const stopStatus = status.subscribe(update)
  const stopCatalog = bridge.onCatalog(setCatalog)
  // The answer and the pushes share one channel, so whichever arrives last is the newest.
  bridge.catalog().then(setCatalog, report)
  const stopTicks = bridge.onTicks((ticks) => {
    if (disposed || showsDemo) return
    const changed: Quote[] = []
    for (const tick of ticks) {
      const symbol = byTicker.get(tick.symbol)
      if (symbol === undefined) continue
      const quote = quoteOf(symbol, tick)
      quotes.set(symbol.ticker, quote)
      changed.push(quote)
    }
    if (changed.length === 0) return
    for (const subscription of [...quoteSubscriptions]) {
      for (const quote of changed) if (subscription.tickers.has(quote.ticker)) subscription.onQuote(quote)
    }
  })
  const stopBars = bridge.onBars((bars) => {
    if (disposed || showsDemo) return
    for (const bar of bars) {
      const floor = loaded.get(streamKey(bar.symbol, bar.timeframe)) ?? Number.NEGATIVE_INFINITY
      for (const subscription of [...barSubscriptions]) {
        if (subscription.ticker !== bar.symbol || MT5_TIMEFRAME[subscription.resolution] !== bar.timeframe) continue
        if (bar.time < Math.max(floor, subscription.last ?? Number.NEGATIVE_INFINITY)) continue
        subscription.last = bar.time
        subscription.onBar({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })
      }
    }
  })

  return {
    source: () => source,
    subscribeSource(listener) {
      sourceListeners.add(listener)
      return () => { sourceListeners.delete(listener) }
    },
    symbols: () => showsDemo ? demo.symbols() : symbols,
    symbol: ticker => showsDemo ? demo.symbol(ticker) : byTicker.get(ticker),
    search: (query, assetClass) => showsDemo ? demo.search(query, assetClass) : searchSymbols(symbols, query, assetClass),
    async history(request: HistoryRequest): Promise<HistoryResult> {
      if (showsDemo) return demo.history(request)
      const symbol = byTicker.get(request.ticker)
      if (symbol === undefined) return { bars: [], noData: true }
      const timeframe = MT5_TIMEFRAME[request.resolution]
      try {
        const result = await bridge.historyBars({
          symbol: symbol.ticker, timeframe, to: request.to, count: Math.min(MT5_MAX_HISTORY_BARS, Math.max(1, Math.ceil(request.countBack))),
        }, { partial: request.partial === true })
        const bars = result.bars.map((bar): Candle => ({ time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }))
        const newest = bars.at(-1)
        if (newest !== undefined) {
          const key = streamKey(symbol.ticker, timeframe)
          loaded.set(key, Math.max(loaded.get(key) ?? Number.NEGATIVE_INFINITY, newest.time))
        }
        // An empty page ends the chart's paging; MT5 has nothing before it, unless bars are still downloading.
        if (result.partial === true) return { bars, noData: false, partial: true }
        return { bars, noData: bars.length === 0 }
      } catch (error) {
        stale = true
        throw error
      }
    },
    subscribeBars(ticker, resolution, onBar, onReset) {
      const subscription: BarSubscription = { ticker, resolution, onBar, onReset }
      barSubscriptions.add(subscription)
      attachBars(subscription)
      schedule()
      return () => {
        if (!barSubscriptions.delete(subscription)) return
        subscription.stop?.()
        subscription.stop = undefined
        schedule()
      }
    },
    quote: ticker => showsDemo ? demo.quote(ticker) : quotes.get(ticker),
    subscribeQuotes(tickers, onQuote) {
      const subscription: QuoteSubscription = { tickers: new Set(tickers), onQuote }
      quoteSubscriptions.add(subscription)
      attachQuotes(subscription)
      schedule()
      return () => {
        if (!quoteSubscriptions.delete(subscription)) return
        subscription.stop?.()
        subscription.stop = undefined
        schedule()
      }
    },
    dispose() {
      if (disposed) return
      for (const subscription of [...quoteSubscriptions, ...barSubscriptions]) subscription.stop?.()
      quoteSubscriptions.clear()
      barSubscriptions.clear()
      sourceListeners.clear()
      if (sent !== JSON.stringify(EMPTY)) bridge.subscribe(EMPTY).catch(() => {})
      disposed = true
      stopStatus()
      stopCatalog()
      stopTicks()
      stopBars()
      status.dispose()
      demo.dispose()
    },
  }
}
