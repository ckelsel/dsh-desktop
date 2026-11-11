/**
 * Market data interface of the market page. The chart datafeed, the watchlist and the paper trading
 * engine depend only on this module, so a real data source replaces the mock without UI changes.
 * Instruments follow over-the-counter FX conventions: prices in the quote currency, sizes in lots.
 * Times are Unix milliseconds (UTC).
 */

/** Watchlist groups. */
export type AssetClass = 'forex' | 'metal'
export const ASSET_CLASSES: readonly AssetClass[] = ['forex', 'metal']

/** Chart resolutions the page offers, in TradingView notation (minutes, `1D`, `1W`). */
export type Resolution = '1' | '5' | '15' | '60' | '240' | '1D' | '1W'
export const RESOLUTIONS: readonly Resolution[] = ['1', '5', '15', '60', '240', '1D', '1W']

export interface MarketSymbol {
  /** Unique ticker, also the chart symbol name, such as `EURUSD`. */
  ticker: string
  description: string
  exchange: string
  assetClass: AssetClass
  /** Traded currency or metal, such as `EUR` or `XAU`. */
  baseCurrency: string
  /** Quote currency: prices and profit are in this currency. */
  currency: string
  /** Price decimals; the minimum tick is 10^-decimals. */
  decimals: number
  /** Price change of one pip. */
  pip: number
  /** Base units in one lot. */
  contractSize: number
  /** Order size bounds and step, in lots. */
  minLots: number
  maxLots: number
  lotStep: number
  /** Trading hours in TradingView session notation, read in `timezone`. */
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
  /** Mid price, the price the chart draws. */
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
}

export interface HistoryResult {
  /** Bars in ascending time order. */
  bars: Candle[]
  /** No data exists before the returned range. */
  noData: boolean
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
   * @returns the unsubscribe function.
   */
  subscribeBars(ticker: string, resolution: Resolution, onBar: (bar: Candle) => void): () => void
  quote(ticker: string): Quote | undefined
  /**
   * Receive quote updates of the given tickers.
   * @returns the unsubscribe function.
   */
  subscribeQuotes(tickers: readonly string[], onQuote: (quote: Quote) => void): () => void
}

/** Minimum price step of a symbol. */
export function tickSize(symbol: Pick<MarketSymbol, 'decimals'>): number {
  return 10 ** -symbol.decimals
}

/** Round a price to the symbol's tick. */
export function roundPrice(symbol: Pick<MarketSymbol, 'decimals'>, price: number): number {
  const factor = 10 ** symbol.decimals
  return Math.round(price * factor) / factor
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
