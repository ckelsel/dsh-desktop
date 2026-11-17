/**
 * TradingView datafeed over a {@link MarketDataProvider}. Every resolution the chart offers comes
 * from the provider as it is, as MT5 serves its own timeframes; the library builds none itself.
 * When the provider says loaded bars are stale, the chart drops them and loads them again.
 *
 * The library shows a series only once it has the bars of its first screen, which it asks for
 * page by page; until then the chart keeps showing the series before. So while a series loads
 * its first screen, the provider answers with the bars it has, and the chart shows them at once.
 * When older bars of the first page were still loading, the datafeed waits in the background
 * until the page is whole, and then has the chart load the series again: the library takes a
 * short page to mean there are no bars in the rest of its range. Pages asked for later, as the
 * chart scrolls back, wait until they are whole.
 *
 * Resetting a stream's cache makes the library unsubscribe it at once, and the library keeps
 * the stream of the series before for a while after a switch; so streams tell neither whether
 * to reload the chart nor which series it shows.
 */
import { ASSET_CLASSES, type AssetClass, type Candle, type HistoryRequest, type MarketDataProvider, type MarketSymbol, type Resolution } from '../data/market-data.ts'
import type { TvBar, TvDatafeed, TvDatafeedConfiguration, TvSymbolInfo } from './tv-types.ts'

/** Resolutions the chart offers, in TradingView notation. */
export const CHART_RESOLUTIONS = ['1', '3', '5', '15', '30', '60', '120', '240', '1D', '1W']
const INTRADAY_MULTIPLIERS = ['1', '3', '5', '15', '30', '60', '120', '240']
const PROVIDER_RESOLUTIONS: Record<string, Resolution> = {
  1: '1', 3: '3', 5: '5', 15: '15', 30: '30', 60: '60', 120: '120', 240: '240', D: '1D', '1D': '1D', W: '1W', '1W': '1W',
}
/** The library's symbol type of each asset class, also the value of its search filter. */
const SYMBOL_TYPES: Record<AssetClass, string> = {
  forex: 'forex', metal: 'metal', index: 'index', commodity: 'commodity', crypto: 'crypto', stock: 'stock', other: 'cfd',
}

/** Canonical spelling of a chart resolution (`D` and `1D` are the same). */
export function normalizeResolution(resolution: string): string {
  return resolution === 'D' ? '1D' : resolution === 'W' ? '1W' : resolution
}

/** The ticker of a chart symbol, which may carry an `EXCHANGE:` prefix. */
export function tickerOf(symbol: string): string {
  const colon = symbol.lastIndexOf(':')
  return colon < 0 ? symbol : symbol.slice(colon + 1)
}

/** Full symbol description for the library; prices move in steps of the symbol's tick. */
export function symbolInfo(symbol: MarketSymbol, description: string): TvSymbolInfo {
  const pricescale = 10 ** symbol.decimals
  return {
    name: symbol.ticker,
    ticker: symbol.ticker,
    description,
    type: SYMBOL_TYPES[symbol.assetClass],
    session: symbol.session,
    timezone: symbol.timezone,
    exchange: symbol.exchange,
    listed_exchange: symbol.exchange,
    format: 'price',
    pricescale,
    minmov: Math.max(1, Math.round(symbol.tickSize * pricescale)),
    has_intraday: true,
    intraday_multipliers: INTRADAY_MULTIPLIERS,
    has_daily: true,
    daily_multipliers: ['1'],
    has_weekly_and_monthly: true,
    weekly_multipliers: ['1'],
    supported_resolutions: CHART_RESOLUTIONS,
    visible_plots_set: 'ohlcv',
    volume_precision: 0,
    data_status: 'streaming',
    currency_code: symbol.currency,
  }
}

const toBar = (candle: Candle): TvBar => ({
  time: candle.time, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume,
})

/** Labels the datafeed shows in the library's dialogs. */
export interface DatafeedLabels {
  /** Localized description of a symbol. */
  describe(symbol: MarketSymbol): string
  /** Symbol search filter names. */
  allTypes: string
  types: Record<AssetClass, string>
}

/** The datafeed with teardown of its live bar subscriptions. */
export interface MarketDatafeed extends TvDatafeed {
  dispose(): void
}

interface LiveStream {
  series: string
  stop(): void
  /** Makes the library drop the bars it has of the series. */
  resetCache(): void
}

const seriesKey = (ticker: string, resolution: Resolution): string => `${ticker}\n${resolution}`

/**
 * Create the datafeed.
 * @param onReset - runs after the library dropped stale bars, so the chart can load them again.
 * @returns the datafeed; callbacks run asynchronously, as the library requires.
 */
export function createDatafeed(market: MarketDataProvider, labels: DatafeedLabels, onReset?: () => void): MarketDatafeed {
  const live = new Map<string, LiveStream>()
  // Series loading their first screen, with their first request: from that request until the
  // library streams them.
  const starting = new Map<string, HistoryRequest>()
  // Series waiting in the background until the provider has the whole first page.
  const completing = new Set<string>()
  // Series whose first page became whole before the library streamed them.
  const outdated = new Set<string>()
  // The series the chart shows: the one the library last asked a first page of.
  let shown: string | undefined
  let disposed = false
  const later = (callback: () => void): void => { setTimeout(callback, 0) }
  // Every stream resets at once after a reconnect; the chart reloads once.
  let resetQueued = false
  const reset = (): void => {
    if (resetQueued || disposed) return
    resetQueued = true
    later(() => { resetQueued = false; if (!disposed) onReset?.() })
  }
  const streamed = (series: string): boolean => [...live.values()].some(stream => stream.series === series)
  /** The chart shows the series without bars the provider has now: load it again. */
  const reload = (series: string): void => {
    if (!streamed(series)) {
      outdated.add(series)
      return
    }
    for (const stream of [...live.values()]) if (stream.series === series) stream.resetCache()
    reset()
  }
  /** Wait until the provider has the whole first page of the series, then reload the series if the chart still shows it. */
  const complete = (series: string, first: HistoryRequest): void => {
    if (completing.has(series)) return
    completing.add(series)
    market.history(first).then(() => {
      completing.delete(series)
      if (!disposed && shown === series) reload(series)
    }, () => {
      // The provider reloads its charts once it can read again.
      completing.delete(series)
    })
  }
  // Filters only for the classes the source has.
  const present = new Set(market.symbols().map(symbol => symbol.assetClass))
  const configuration: TvDatafeedConfiguration = {
    supported_resolutions: CHART_RESOLUTIONS,
    exchanges: [],
    symbols_types: [
      { name: labels.allTypes, value: '' },
      ...ASSET_CLASSES.filter(assetClass => present.has(assetClass)).map(assetClass => ({ name: labels.types[assetClass], value: SYMBOL_TYPES[assetClass] })),
    ],
    supports_marks: false,
    supports_timescale_marks: false,
    supports_time: false,
  }
  return {
    onReady(callback) { later(() => { callback(configuration) }) },
    searchSymbols(userInput, _exchange, symbolType, onResult) {
      const results = market.search(tickerOf(userInput))
        .filter(symbol => symbolType === '' || SYMBOL_TYPES[symbol.assetClass] === symbolType)
        .map(symbol => ({
          symbol: symbol.ticker, ticker: symbol.ticker, description: labels.describe(symbol), exchange: symbol.exchange, type: SYMBOL_TYPES[symbol.assetClass],
        }))
      later(() => { onResult(results) })
    },
    resolveSymbol(symbolName, onResolve, onError) {
      const symbol = market.symbol(tickerOf(symbolName))
      later(() => { if (symbol === undefined) onError('unknown_symbol'); else onResolve(symbolInfo(symbol, labels.describe(symbol))) })
    },
    getBars(info, resolution, period, onResult, onError) {
      const provider = PROVIDER_RESOLUTIONS[resolution]
      if (provider === undefined) {
        later(() => { onError(`unsupported resolution ${resolution}`) })
        return
      }
      const ticker = info.ticker ?? info.name
      const series = seriesKey(ticker, provider)
      const request: HistoryRequest = { ticker, resolution: provider, from: period.from * 1000, to: period.to * 1000, countBack: period.countBack }
      if (period.firstDataRequest) {
        shown = series
        starting.set(series, request)
        outdated.delete(series)
      }
      // The first screen shows the bars there are at once.
      const first = starting.get(series)
      market.history(first === undefined ? request : { ...request, partial: true }).then((result) => {
        const bars = result.bars.map(toBar)
        if (result.partial !== true || first === undefined) {
          onResult(bars, { noData: result.noData })
          return
        }
        // Without bars the library would go on asking further back.
        onResult(bars, { noData: bars.length === 0 })
        complete(series, first)
      }, (error: unknown) => { onError(String(error)) })
    },
    subscribeBars(info, resolution, onTick, listenerGuid, onResetCacheNeeded) {
      const provider = PROVIDER_RESOLUTIONS[resolution]
      if (provider === undefined) return
      const ticker = info.ticker ?? info.name
      const series = seriesKey(ticker, provider)
      live.get(listenerGuid)?.stop()
      // The library streams a series once its first screen is in.
      starting.delete(series)
      const stop = market.subscribeBars(ticker, provider, candle => { onTick(toBar(candle)) }, () => {
        onResetCacheNeeded()
        reset()
      })
      live.set(listenerGuid, { series, stop, resetCache: onResetCacheNeeded })
      if (outdated.delete(series) && shown === series) reload(series)
    },
    unsubscribeBars(listenerGuid) {
      live.get(listenerGuid)?.stop()
      live.delete(listenerGuid)
    },
    dispose() {
      disposed = true
      for (const stream of live.values()) stream.stop()
      live.clear()
      starting.clear()
      completing.clear()
      outdated.clear()
    },
  }
}
