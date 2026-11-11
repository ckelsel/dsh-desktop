/**
 * The slice of the TradingView Advanced Charts v29 API the market page uses, written against
 * `vendor/tradingview/charting_library/charting_library.d.ts`. Only these members are relied on, so
 * the 29k-line declaration file stays out of the bundle and the type check.
 */

export interface TvBar {
  /** Unix ms. */
  time: number
  open: number
  high: number
  low: number
  close: number
  volume?: number
}

/** History window of a bar request, in Unix seconds. */
export interface TvPeriodParams {
  from: number
  to: number
  countBack: number
  firstDataRequest: boolean
}

export interface TvHistoryMetadata {
  noData?: boolean
  nextTime?: number | null
}

export interface TvSymbolInfo {
  name: string
  ticker?: string
  description: string
  type: string
  session: string
  timezone: string
  exchange: string
  listed_exchange: string
  format: 'price' | 'volume'
  pricescale: number
  minmov: number
  has_intraday?: boolean
  supported_resolutions?: string[]
  intraday_multipliers?: string[]
  has_daily?: boolean
  daily_multipliers?: string[]
  has_weekly_and_monthly?: boolean
  weekly_multipliers?: string[]
  visible_plots_set?: 'ohlcv' | 'ohlc' | 'c' | 'hlc'
  volume_precision?: number
  data_status?: 'streaming' | 'endofday' | 'delayed_streaming'
  currency_code?: string
}

export interface TvSearchResult {
  symbol: string
  ticker?: string
  description: string
  exchange: string
  type: string
}

export interface TvDatafeedConfiguration {
  supported_resolutions?: string[]
  exchanges?: { value: string; name: string; desc: string }[]
  symbols_types?: { name: string; value: string }[]
  supports_marks?: boolean
  supports_timescale_marks?: boolean
  supports_time?: boolean
}

/** `IBasicDataFeed`: callbacks must run asynchronously. */
export interface TvDatafeed {
  onReady(callback: (configuration: TvDatafeedConfiguration) => void): void
  searchSymbols(userInput: string, exchange: string, symbolType: string, onResult: (items: TvSearchResult[]) => void): void
  resolveSymbol(symbolName: string, onResolve: (symbolInfo: TvSymbolInfo) => void, onError: (reason: string) => void): void
  getBars(
    symbolInfo: TvSymbolInfo, resolution: string, periodParams: TvPeriodParams,
    onResult: (bars: TvBar[], meta?: TvHistoryMetadata) => void, onError: (reason: string) => void,
  ): void
  subscribeBars(symbolInfo: TvSymbolInfo, resolution: string, onTick: (bar: TvBar) => void, listenerGuid: string, onResetCacheNeeded: () => void): void
  unsubscribeBars(listenerGuid: string): void
}

/** `ISubscription`: `obj` scopes the member for unsubscription. */
export interface TvSubscription<F extends (...args: never[]) => void> {
  subscribe(obj: object | null, member: F, singleshot?: boolean): void
  unsubscribe(obj: object | null, member: F): void
}

export type TvLineLengthUnit = 'pixel' | 'percentage'

/** `IOrderLineAdapter` (setters chain). */
export interface TvOrderLine {
  remove(): void
  onModify(callback: () => void): this
  onMove(callback: () => void): this
  onCancel(callback: () => void): this
  getPrice(): number
  setPrice(value: number): this
  setText(value: string): this
  setTooltip(value: string): this
  setModifyTooltip(value: string): this
  setCancelTooltip(value: string): this
  setQuantity(value: string): this
  setEditable(value: boolean): this
  setCancellable(value: boolean): this
  setExtendLeft(value: boolean): this
  setLineLength(value: number, unit?: TvLineLengthUnit): this
  setLineStyle(value: number): this
  setLineWidth(value: number): this
  setBodyFont(value: string): this
  setQuantityFont(value: string): this
  setLineColor(value: string): this
  setBodyBorderColor(value: string): this
  setBodyBackgroundColor(value: string): this
  setBodyTextColor(value: string): this
  setQuantityBorderColor(value: string): this
  setQuantityBackgroundColor(value: string): this
  setQuantityTextColor(value: string): this
  setCancelButtonBorderColor(value: string): this
  setCancelButtonBackgroundColor(value: string): this
  setCancelButtonIconColor(value: string): this
}

/** `IPositionLineAdapter` (setters chain). */
export interface TvPositionLine {
  remove(): void
  onClose(callback: () => void): this
  onModify(callback: () => void): this
  onReverse(callback: () => void): this
  setPrice(value: number): this
  setText(value: string): this
  setTooltip(value: string): this
  setProtectTooltip(value: string): this
  setCloseTooltip(value: string): this
  setReverseTooltip(value: string): this
  setQuantity(value: string): this
  setExtendLeft(value: boolean): this
  setLineLength(value: number, unit?: TvLineLengthUnit): this
  setLineStyle(value: number): this
  setLineWidth(value: number): this
  setBodyFont(value: string): this
  setQuantityFont(value: string): this
  setLineColor(value: string): this
  setBodyBorderColor(value: string): this
  setBodyBackgroundColor(value: string): this
  setBodyTextColor(value: string): this
  setQuantityBorderColor(value: string): this
  setQuantityBackgroundColor(value: string): this
  setQuantityTextColor(value: string): this
  setReverseButtonBorderColor(value: string): this
  setReverseButtonBackgroundColor(value: string): this
  setReverseButtonIconColor(value: string): this
  setCloseButtonBorderColor(value: string): this
  setCloseButtonBackgroundColor(value: string): this
  setCloseButtonIconColor(value: string): this
}

/** `IExecutionLineAdapter` (setters chain). */
export interface TvExecutionShape {
  remove(): void
  setPrice(value: number): this
  /** Unix seconds. */
  setTime(value: number): this
  setDirection(value: 'buy' | 'sell'): this
  setText(value: string): this
  setTooltip(value: string): this
  setArrowHeight(value: number): this
  setArrowSpacing(value: number): this
  setFont(value: string): this
  setTextColor(value: string): this
  setArrowColor(value: string): this
}

/** `IChartWidgetApi`. */
export interface TvChart {
  onSymbolChanged(): TvSubscription<() => void>
  onIntervalChanged(): TvSubscription<(interval: string) => void>
  onDataLoaded(): TvSubscription<() => void>
  dataReady(callback?: () => void): boolean
  setSymbol(symbol: string, options?: { dataReady?: () => void; doNotActivateChart?: boolean }): Promise<boolean>
  setResolution(resolution: string): Promise<boolean>
  symbol(): string
  resolution(): string
  createOrderLine(): Promise<TvOrderLine>
  createPositionLine(): Promise<TvPositionLine>
  createExecutionShape(): Promise<TvExecutionShape>
}

export type TvOverrides = Record<string, string | number | boolean>

/** `IChartingLibraryWidget`. */
export interface TvWidget {
  onChartReady(callback: () => void): void
  headerReady(): Promise<void>
  activeChart(): TvChart
  remove(): void
  save(callback: (state: object) => void): void
  subscribe(event: 'onAutoSaveNeeded', callback: () => void): void
  unsubscribe(event: 'onAutoSaveNeeded', callback: () => void): void
  changeTheme(theme: 'light' | 'dark', options?: { disableUndo: boolean }): Promise<void>
  applyOverrides(overrides: TvOverrides): void
  applyStudiesOverrides(overrides: object): void
  setCSSCustomProperty(name: string, value: string): void
  closePopupsAndDialogs(): void
}

/** `ChartingLibraryWidgetOptions`, the members the page sets. */
export interface TvWidgetOptions {
  container: HTMLElement
  datafeed: TvDatafeed
  symbol: string
  interval: string
  library_path: string
  locale: 'zh' | 'en'
  theme: 'light' | 'dark'
  timezone: string
  autosize: boolean
  disabled_features: string[]
  enabled_features: string[]
  saved_data?: object
  auto_save_delay?: number
  overrides?: TvOverrides
  studies_overrides?: object
  loading_screen?: { backgroundColor?: string; foregroundColor?: string }
  custom_font_family?: string
  favorites?: { intervals?: string[]; chartTypes?: string[] }
  time_frames?: { text: string; resolution: string; description?: string; title?: string }[]
}

/** The `TradingView` global the standalone bundle defines. */
export interface TvGlobal {
  widget: new (options: TvWidgetOptions) => TvWidget
  version?: () => string
}
