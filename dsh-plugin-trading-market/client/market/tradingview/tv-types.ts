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

/** `EntityInfo`: a study or drawing on the chart. */
export interface TvEntityInfo {
  id: string
  name: string
}

/** `IStudyApi`. */
export interface TvStudy {
  applyOverrides(overrides: TvOverrides): void
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
  getAllStudies(): TvEntityInfo[]
  getStudyById(id: string): TvStudy
  /** Request the bars again, after the datafeed reset their cache. */
  resetData(): void
  /** Place a drawing on the chart; a horizontal line needs only its price. */
  createShape(point: TvShapePoint, options: TvCreateShapeOptions): Promise<TvEntityId>
  /** The drawing an id names; ids come from `createShape`. */
  getShapeById(id: TvEntityId): TvLineDataSource
  removeEntity(id: TvEntityId): void
}

/** A drawing's anchor: a horizontal line carries only its price. */
export interface TvShapePoint {
  time?: number
  price?: number
}

/** `EntityId`: an opaque string naming a chart drawing or study. */
export type TvEntityId = string

/** `CreateShapeOptions`, the members a trade line sets. */
export interface TvCreateShapeOptions {
  shape: 'horizontal_line'
  text?: string
  /** A locked drawing holds still instead of being dragged. */
  lock?: boolean
  disableSelection?: boolean
  disableSave?: boolean
  disableUndo?: boolean
  overrides?: TvOverrides
}

/** `ILineDataSourceApi`, the members the trade lines use. */
export interface TvLineDataSource {
  getPoints(): TvShapePoint[]
  setPoints(points: TvShapePoint[]): void
  getProperties(): Record<string, unknown>
  setProperties(properties: Record<string, unknown>): void
  setSavingEnabled(enable: boolean): void
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
