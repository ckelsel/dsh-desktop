/**
 * Market data interface of the market page. The chart datafeed, the watchlist and the order ticket
 * depend only on this module: the demo data and the Desktop's MT5 bridge both implement it.
 * Instruments follow over-the-counter conventions: prices in the quote currency, sizes in lots.
 * Times are Unix milliseconds (UTC).
 */

/** Asset classes: the chart's symbol types and its search filter. */
export type AssetClass = 'forex' | 'metal' | 'index' | 'commodity' | 'crypto' | 'stock' | 'other'
export const ASSET_CLASSES: readonly AssetClass[] = ['forex', 'metal', 'index', 'commodity', 'crypto', 'stock', 'other']

/** Chart resolutions, in TradingView notation (minutes, `1D`, `1W`); every one comes from the provider. */
export type Resolution = '1' | '3' | '5' | '15' | '30' | '60' | '120' | '240' | '1D' | '1W'
export const RESOLUTIONS: readonly Resolution[] = ['1', '3', '5', '15', '30', '60', '120', '240', '1D', '1W']

export interface MarketSymbol {
  /** Unique ticker, also the chart symbol name, such as `EURUSD`. */
  ticker: string
  description: string
  exchange: string
  assetClass: AssetClass
  /** Watchlist group: the broker's top folder, such as `Forex`; for the demo data, the asset class. */
  group: string
  /** Traded currency or metal, such as `EUR` or `XAU`. */
  baseCurrency: string
  /** Quote currency: prices and profit are in this currency. */
  currency: string
  /** Price decimals. */
  decimals: number
  /** Smallest price change, such as `0.00001`, or `0.25` for some indices. */
  tickSize: number
  /** Price change of one pip. */
  pip: number
  /** Base units in one lot. */
  contractSize: number
  /** Order size bounds and step, in lots. */
  minLots: number
  maxLots: number
  lotStep: number
  /** Trading hours in TradingView session notation, read in `timezone`; `24x7` when unknown. */
  session: string
  /** IANA timezone of `session`. */
  timezone: string
}

export interface Candle {
  /** Bar time: the bar start for intraday bars, 00:00 UTC of the trading day for daily and weekly bars. */
  time: number
  open: number
  high: number
  low: number
  close: number
  /** Tick volume. */
  volume: number
}

/** Latest market snapshot of one symbol. */
export interface Quote {
  ticker: string
  /** The price the chart draws: the mid price of the demo data, the bid of MT5. */
  last: number
  /** Sell and buy prices. */
  bid: number
  ask: number
  /** The current trading day's open, high and low; the previous trading day's close. */
  open: number
  high: number
  low: number
  prevClose: number
  change: number
  changePercent: number
  volume: number
  time: number
  marketOpen: boolean
}

export interface HistoryRequest {
  ticker: string
  resolution: Resolution
  /** Leftmost requested bar time (inclusive). */
  from: number
  /** Rightmost requested bar time (exclusive). */
  to: number
  /** Bars wanted before `to`; takes precedence over `from`. */
  countBack: number
  /**
   * Answer with the bars the source has while it still loads older ones of the page, instead of
   * once it has all of them; default false.
   */
  partial?: boolean
}

export interface HistoryResult {
  /** Bars in ascending time order. */
  bars: Candle[]
  /** No data exists before the returned range. */
  noData: boolean
  /** Older bars of the page are still loading, and asking again returns them; only for a partial request. */
  partial?: boolean
}

/**
 * Where market data comes from:
 * - `key`: `demo`, or `mt5:<trade server>`; the page keeps preferences and chart layouts per key.
 * - `state`: `waiting` until the source has a symbol catalogue, then `ready`.
 * - `live`: quotes and bars stream; false while the MT5 EA is away, the catalogue kept.
 * - `watch`: the symbols a new watchlist starts with (MT5: the Market Watch window, in its order).
 */
export interface MarketSource {
  key: string
  state: 'waiting' | 'ready'
  live: boolean
  watch: readonly string[]
}

/** Read-only market data source. */
export interface MarketDataProvider {
  symbols(): readonly MarketSymbol[]
  symbol(ticker: string): MarketSymbol | undefined
  /** Case-insensitive match on ticker and description. */
  search(query: string, assetClass?: AssetClass): MarketSymbol[]
  history(request: HistoryRequest): Promise<HistoryResult>
  /**
   * Receive the live bar of a ticker at a resolution whenever it changes.
   * @param onReset - the bars loaded so far may be stale or have gaps, as after a reconnect: load them again.
   * @returns the unsubscribe function.
   */
  subscribeBars(ticker: string, resolution: Resolution, onBar: (bar: Candle) => void, onReset?: () => void): () => void
  quote(ticker: string): Quote | undefined
  /**
   * Receive quote updates of the given tickers.
   * @returns the unsubscribe function.
   */
  subscribeQuotes(tickers: readonly string[], onQuote: (quote: Quote) => void): () => void
  /** Where the data comes from now; a new object whenever any of it changes. */
  source(): MarketSource
  /** @returns the unsubscribe function. */
  subscribeSource(listener: () => void): () => void
}

/** Round a price to the symbol's tick. */
export function roundPrice(symbol: Pick<MarketSymbol, 'decimals' | 'tickSize'>, price: number): number {
  return Number((Math.round(price / symbol.tickSize) * symbol.tickSize).toFixed(symbol.decimals))
}

/** Decimals of a step value such as `0.01`. */
export function stepDecimals(step: number): number {
  const text = String(step)
  const exponent = /e-(\d+)$/.exec(text)
  if (exponent !== null) return Number(exponent[1])
  const dot = text.indexOf('.')
  return dot < 0 ? 0 : text.length - dot - 1
}

/** Snap a lot size to the symbol's step and bounds. */
export function normalizeLots(symbol: Pick<MarketSymbol, 'minLots' | 'maxLots' | 'lotStep'>, lots: number): number {
  if (!Number.isFinite(lots)) return symbol.minLots
  const steps = Math.round(lots / symbol.lotStep)
  const snapped = Number((steps * symbol.lotStep).toFixed(stepDecimals(symbol.lotStep)))
  return Math.min(symbol.maxLots, Math.max(symbol.minLots, snapped))
}
