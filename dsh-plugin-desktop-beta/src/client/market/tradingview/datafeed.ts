/**
 * TradingView datafeed over a {@link MarketDataProvider}. The library builds the extra intraday
 * resolutions it offers (3, 30, 120 minutes) from the provider's multipliers; daily and weekly bars
 * come from the provider directly.
 */
import type { AssetClass, Candle, MarketDataProvider, MarketSymbol, Resolution } from '../data/market-data.ts'
import type { TvBar, TvDatafeed, TvDatafeedConfiguration, TvSymbolInfo } from './tv-types.ts'

/** Resolutions the chart offers, in TradingView notation. */
export const CHART_RESOLUTIONS = ['1', '3', '5', '15', '30', '60', '120', '240', '1D', '1W']
const INTRADAY_MULTIPLIERS = ['1', '5', '15', '60', '240']
const PROVIDER_RESOLUTIONS: Record<string, Resolution> = {
  1: '1', 5: '5', 15: '15', 60: '60', 240: '240', D: '1D', '1D': '1D', W: '1W', '1W': '1W',
}
const SYMBOL_TYPES: Record<AssetClass, string> = { forex: 'forex', metal: 'commodity' }

/** Canonical spelling of a chart resolution (`D` and `1D` are the same). */
export function normalizeResolution(resolution: string): string {
  return resolution === 'D' ? '1D' : resolution === 'W' ? '1W' : resolution
}

/** The ticker of a chart symbol, which may carry an `EXCHANGE:` prefix. */
export function tickerOf(symbol: string): string {
  const colon = symbol.lastIndexOf(':')
  return colon < 0 ? symbol : symbol.slice(colon + 1)
}

/** Full symbol description for the library. */
export function symbolInfo(symbol: MarketSymbol, description: string): TvSymbolInfo {
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
    pricescale: 10 ** symbol.decimals,
    minmov: 1,
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

/**
 * Create the datafeed.
 * @returns the datafeed; callbacks run asynchronously, as the library requires.
 */
export function createDatafeed(market: MarketDataProvider, labels: DatafeedLabels): MarketDatafeed {
  const live = new Map<string, () => void>()
  const later = (callback: () => void): void => { setTimeout(callback, 0) }
  const configuration: TvDatafeedConfiguration = {
    supported_resolutions: CHART_RESOLUTIONS,
    exchanges: [],
    symbols_types: [
      { name: labels.allTypes, value: '' },
      ...(Object.keys(SYMBOL_TYPES) as AssetClass[]).map(assetClass => ({ name: labels.types[assetClass], value: SYMBOL_TYPES[assetClass] })),
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
      market.history({ ticker: info.ticker ?? info.name, resolution: provider, from: period.from * 1000, to: period.to * 1000, countBack: period.countBack })
        .then(result => { onResult(result.bars.map(toBar), { noData: result.noData }) }, (error: unknown) => { onError(String(error)) })
    },
    subscribeBars(info, resolution, onTick, listenerGuid) {
      const provider = PROVIDER_RESOLUTIONS[resolution]
      if (provider === undefined) return
      live.get(listenerGuid)?.()
      live.set(listenerGuid, market.subscribeBars(info.ticker ?? info.name, provider, candle => { onTick(toBar(candle)) }))
    },
    unsubscribeBars(listenerGuid) {
      live.get(listenerGuid)?.()
      live.delete(listenerGuid)
    },
    dispose() {
      for (const stop of live.values()) stop()
      live.clear()
    },
  }
}
