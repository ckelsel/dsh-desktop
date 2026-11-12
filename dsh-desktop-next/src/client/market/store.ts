/**
 * Market page preferences: chart symbol and interval, watchlist, panel layout, price colours, order
 * ticket defaults and the history period. The chart symbol, the watchlist and its collapsed groups
 * belong to a data source (the demo data, or an MT5 trade server) and are kept per source; the top
 * level holds the current source's. Persisted field by field, so a malformed or older value only
 * loses the affected fields; a value from before per-source fields belongs to the demo data.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import { DEFAULT_HISTORY, HISTORY_PERIODS, type HistorySelection, type OrderType } from './data/trading.ts'
import { CHART_RESOLUTIONS, normalizeResolution } from './tradingview/datafeed.ts'

export type SortKey = 'ticker' | 'last' | 'change' | 'changePercent'
export type WidgetPanel = 'watchlist' | 'ticket'
export type BottomTab = 'positions' | 'orders' | 'history' | 'deals' | 'account'
/** Which colour marks a rising price. */
export type UpColor = 'green' | 'red'

export const PANEL_MIN = 240
export const PANEL_MAX = 420
export const PANEL_DEFAULT = 300
export const BOTTOM_MIN = 120
export const BOTTOM_DEFAULT = 240
export const BOTTOM_TABS: readonly BottomTab[] = ['positions', 'orders', 'history', 'deals', 'account']
/** Most symbols a new source's watchlist starts with. */
export const WATCHLIST_START_MAX = 100

/** What the page keeps per data source. */
export interface SourcePreferences {
  symbol: string
  watchlist: string[]
  /** Collapsed watchlist groups. */
  collapsed: string[]
}

export interface MarketPreferences extends SourcePreferences {
  /** The data source the top-level symbol, watchlist and groups belong to; null before the first. */
  source: string | null
  /** The other sources' preferences, by source key. */
  sources: Record<string, SourcePreferences>
  resolution: string
  sort: { key: SortKey; direction: 1 | -1 } | null
  /** Open side panel, or null when collapsed. */
  panel: WidgetPanel | null
  panelWidth: number
  bottomOpen: boolean
  bottomHeight: number
  bottomTab: BottomTab
  upColor: UpColor
  orderType: OrderType
  lots: number
  historyPeriod: HistorySelection
}

/** The symbols of a source that just became current. */
export interface SourceCatalog {
  /** Every ticker the source has. */
  tickers: readonly string[]
  /** The tickers a watchlist starts with. */
  watch: readonly string[]
}

/** Storage key of {@link MarketPreferences}; versioned so a later format starts from defaults. */
export const MARKET_STORAGE_KEY = 'dsh-desktop-beta.market-page.v1'

export function defaultPreferences(): MarketPreferences {
  return {
    source: null,
    sources: {},
    symbol: '',
    resolution: '15',
    watchlist: [],
    collapsed: [],
    sort: null,
    panel: 'watchlist',
    panelWidth: PANEL_DEFAULT,
    bottomOpen: true,
    bottomHeight: BOTTOM_DEFAULT,
    bottomTab: 'positions',
    upColor: 'green',
    orderType: 'market',
    lots: 0.1,
    historyPeriod: { ...DEFAULT_HISTORY },
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const strings = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry !== ''))] : []
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** A source's saved fields; tickers are checked once the source's catalogue is known. */
function parseSource(value: unknown): SourcePreferences {
  const source = isRecord(value) ? value : {}
  return {
    symbol: typeof source.symbol === 'string' ? source.symbol : '',
    watchlist: strings(source.watchlist),
    collapsed: strings(source.collapsed),
  }
}

function parseHistory(value: unknown): HistorySelection {
  const source = isRecord(value) ? value : {}
  const date = (raw: unknown): string => typeof raw === 'string' && DATE.test(raw) ? raw : ''
  return {
    period: HISTORY_PERIODS.includes(source.period as HistorySelection['period']) ? source.period as HistorySelection['period'] : DEFAULT_HISTORY.period,
    from: date(source.from),
    to: date(source.to),
  }
}

/** The source's symbol and watchlist checked against its catalogue; a source seen first starts from its watch list. */
function applyCatalog(saved: SourcePreferences | undefined, catalog: SourceCatalog): SourcePreferences {
  const known = new Set(catalog.tickers)
  const watchlist = saved !== undefined
    ? saved.watchlist.filter(ticker => known.has(ticker))
    : [...new Set(catalog.watch.filter(ticker => known.has(ticker)))].slice(0, WATCHLIST_START_MAX)
  const symbol = saved !== undefined && known.has(saved.symbol) ? saved.symbol
    : watchlist.includes('XAUUSD') ? 'XAUUSD' : watchlist[0] ?? catalog.tickers[0] ?? ''
  return { symbol, watchlist, collapsed: [...saved?.collapsed ?? []] }
}

/**
 * Read saved preferences field by field; malformed fields fall back. Tickers stay as saved until
 * {@link MarketActions.selectSource} checks them against their source's catalogue.
 */
export function parsePreferences(value: unknown): MarketPreferences {
  const defaults = defaultPreferences()
  const source = isRecord(value) ? value : {}
  const finite = (raw: unknown): raw is number => typeof raw === 'number' && Number.isFinite(raw)
  const sort = source.sort as { key?: unknown; direction?: unknown } | null | undefined
  // Preferences from before per-source fields belong to the demo data.
  const key = typeof source.source === 'string' && source.source !== '' ? source.source : Array.isArray(source.watchlist) ? 'demo' : null
  const sources: Record<string, SourcePreferences> = {}
  if (isRecord(source.sources)) for (const [name, saved] of Object.entries(source.sources)) if (name !== '' && name !== key) sources[name] = parseSource(saved)
  const current = key === null ? { symbol: '', watchlist: [], collapsed: [] } : parseSource(source)
  return {
    source: key,
    sources,
    ...current,
    resolution: typeof source.resolution === 'string' && CHART_RESOLUTIONS.includes(normalizeResolution(source.resolution))
      ? normalizeResolution(source.resolution) : defaults.resolution,
    sort: sort !== null && typeof sort === 'object' && ['ticker', 'last', 'change', 'changePercent'].includes(sort.key as string) && (sort.direction === 1 || sort.direction === -1)
      ? { key: sort.key as SortKey, direction: sort.direction } : null,
    panel: source.panel === null || source.panel === 'watchlist' || source.panel === 'ticket' ? source.panel : defaults.panel,
    panelWidth: finite(source.panelWidth) ? clamp(source.panelWidth, PANEL_MIN, PANEL_MAX) : defaults.panelWidth,
    bottomOpen: typeof source.bottomOpen === 'boolean' ? source.bottomOpen : defaults.bottomOpen,
    bottomHeight: finite(source.bottomHeight) ? Math.max(BOTTOM_MIN, source.bottomHeight) : defaults.bottomHeight,
    bottomTab: BOTTOM_TABS.includes(source.bottomTab as BottomTab) ? source.bottomTab as BottomTab : defaults.bottomTab,
    upColor: source.upColor === 'red' ? 'red' : 'green',
    orderType: source.orderType === 'limit' || source.orderType === 'stop' ? source.orderType : 'market',
    lots: finite(source.lots) && source.lots > 0 ? source.lots : defaults.lots,
    historyPeriod: parseHistory(source.historyPeriod),
  }
}

type MarketActions = {
  /** Make `key` the current source: keep the current source's fields, and load the saved fields of `key` checked against its catalogue. */
  selectSource: (draft: MarketPreferences, key: string, catalog: SourceCatalog) => void
  setSymbol: (draft: MarketPreferences, ticker: string) => void
  setResolution: (draft: MarketPreferences, resolution: string) => void
  addSymbol: (draft: MarketPreferences, ticker: string) => void
  removeSymbol: (draft: MarketPreferences, ticker: string) => void
  toggleGroup: (draft: MarketPreferences, group: string) => void
  cycleSort: (draft: MarketPreferences, key: SortKey) => void
  togglePanel: (draft: MarketPreferences, panel: WidgetPanel) => void
  setPanelWidth: (draft: MarketPreferences, px: number) => void
  toggleBottom: (draft: MarketPreferences) => void
  setBottomHeight: (draft: MarketPreferences, px: number) => void
  setBottomTab: (draft: MarketPreferences, tab: BottomTab) => void
  setUpColor: (draft: MarketPreferences, color: UpColor) => void
  setOrderType: (draft: MarketPreferences, type: OrderType) => void
  setLots: (draft: MarketPreferences, lots: number) => void
  setHistoryPeriod: (draft: MarketPreferences, selection: HistorySelection) => void
}

export type MarketStore = EngineStoreHandle<MarketPreferences, MarketActions>

/** Create the store handle; the page shares one instance across mounts. */
export function createMarketStore(initial: MarketPreferences): MarketStore {
  return defineStore({
    init: (): MarketPreferences => structuredClone(initial),
    actions: {
      selectSource: (d, key: string, catalog: SourceCatalog) => {
        const current: SourcePreferences = { symbol: d.symbol, watchlist: [...d.watchlist], collapsed: [...d.collapsed] }
        const next = applyCatalog(d.source === key ? current : d.sources[key], catalog)
        if (d.source !== null && d.source !== key) d.sources[d.source] = current
        if (key in d.sources) delete d.sources[key]
        // Unchanged fields stay as they are, so a repeated call leaves the state as it was.
        if (d.source !== key) d.source = key
        if (d.symbol !== next.symbol) d.symbol = next.symbol
        if (d.watchlist.join('\n') !== next.watchlist.join('\n')) d.watchlist = next.watchlist
        if (d.collapsed.join('\n') !== next.collapsed.join('\n')) d.collapsed = next.collapsed
      },
      setSymbol: (d, ticker: string) => { d.symbol = ticker },
      setResolution: (d, resolution: string) => { d.resolution = normalizeResolution(resolution) },
      addSymbol: (d, ticker: string) => { if (!d.watchlist.includes(ticker)) d.watchlist.push(ticker) },
      removeSymbol: (d, ticker: string) => { d.watchlist = d.watchlist.filter(entry => entry !== ticker) },
      toggleGroup: (d, group: string) => {
        d.collapsed = d.collapsed.includes(group) ? d.collapsed.filter(entry => entry !== group) : [...d.collapsed, group]
      },
      // Text sorts ascending first, numbers descending first; the third click restores list order.
      cycleSort: (d, key: SortKey) => {
        const first: 1 | -1 = key === 'ticker' ? 1 : -1
        if (d.sort === null || d.sort.key !== key) d.sort = { key, direction: first }
        else d.sort = d.sort.direction === first ? { key, direction: first === 1 ? -1 : 1 } : null
      },
      togglePanel: (d, panel: WidgetPanel) => { d.panel = d.panel === panel ? null : panel },
      setPanelWidth: (d, px: number) => { d.panelWidth = Math.round(clamp(px, PANEL_MIN, PANEL_MAX)) },
      toggleBottom: (d) => { d.bottomOpen = !d.bottomOpen },
      setBottomHeight: (d, px: number) => { d.bottomHeight = Math.round(Math.max(BOTTOM_MIN, px)) },
      setBottomTab: (d, tab: BottomTab) => { d.bottomTab = tab; d.bottomOpen = true },
      setUpColor: (d, color: UpColor) => { d.upColor = color },
      setOrderType: (d, type: OrderType) => { d.orderType = type },
      setLots: (d, lots: number) => { if (Number.isFinite(lots) && lots > 0) d.lots = lots },
      setHistoryPeriod: (d, selection: HistorySelection) => { d.historyPeriod = parseHistory(selection) },
    },
  })
}

/** Storage the preferences persist to; `localStorage` in the window. */
export interface PreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function readPreferences(storage: PreferenceStorage | undefined): MarketPreferences {
  try {
    const raw = storage?.getItem(MARKET_STORAGE_KEY)
    return parsePreferences(raw === null || raw === undefined ? undefined : JSON.parse(raw))
  } catch {
    // Disabled storage or a corrupt value only loses the saved preferences.
    return defaultPreferences()
  }
}

/**
 * Write the preferences whenever they change.
 * @returns the unsubscribe function.
 */
export function persistPreferences(
  source: { getSnapshot(): MarketPreferences; subscribe(listener: () => void): () => void },
  storage: PreferenceStorage | undefined,
): () => void {
  let previous = source.getSnapshot()
  return source.subscribe(() => {
    const next = source.getSnapshot()
    if (next === previous) return
    previous = next
    try { storage?.setItem(MARKET_STORAGE_KEY, JSON.stringify(next)) } catch {
      // A full or disabled storage keeps the running page; only persistence stops.
    }
  })
}
