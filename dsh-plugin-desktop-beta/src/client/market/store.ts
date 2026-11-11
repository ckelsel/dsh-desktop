/**
 * Market page preferences: chart symbol and interval, watchlist, panel layout, price colours and
 * order ticket defaults. Persisted field by field, so a malformed or older value only loses the
 * affected fields.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import { ASSET_CLASSES, type AssetClass } from './data/market-data.ts'
import type { OrderType } from './data/trading.ts'
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

export interface MarketPreferences {
  symbol: string
  resolution: string
  watchlist: string[]
  collapsed: AssetClass[]
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
}

/** Storage key of {@link MarketPreferences}; versioned so a later format starts from defaults. */
export const MARKET_STORAGE_KEY = 'dsh-desktop-beta.market-page.v1'

export function defaultPreferences(tickers: readonly string[]): MarketPreferences {
  return {
    symbol: tickers.includes('XAUUSD') ? 'XAUUSD' : tickers[0] ?? 'EURUSD',
    resolution: '15',
    watchlist: [...tickers],
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
  }
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/**
 * Read saved preferences field by field; unknown tickers and malformed fields fall back.
 * @param tickers - the provider's tickers, in display order.
 */
export function parsePreferences(value: unknown, tickers: readonly string[]): MarketPreferences {
  const defaults = defaultPreferences(tickers)
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const known = (ticker: unknown): ticker is string => typeof ticker === 'string' && tickers.includes(ticker)
  const pick = <T>(key: keyof MarketPreferences, valid: (raw: unknown) => raw is T, fallback: T): T => valid(source[key]) ? source[key] : fallback
  const finite = (raw: unknown): raw is number => typeof raw === 'number' && Number.isFinite(raw)
  const sort = source.sort as { key?: unknown; direction?: unknown } | null | undefined
  return {
    symbol: pick('symbol', known, defaults.symbol),
    resolution: typeof source.resolution === 'string' && CHART_RESOLUTIONS.includes(normalizeResolution(source.resolution))
      ? normalizeResolution(source.resolution) : defaults.resolution,
    watchlist: Array.isArray(source.watchlist) ? [...new Set(source.watchlist.filter(known))] : defaults.watchlist,
    collapsed: Array.isArray(source.collapsed) ? source.collapsed.filter((entry): entry is AssetClass => ASSET_CLASSES.includes(entry as AssetClass)) : [],
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
  }
}

type MarketActions = {
  setSymbol: (draft: MarketPreferences, ticker: string) => void
  setResolution: (draft: MarketPreferences, resolution: string) => void
  addSymbol: (draft: MarketPreferences, ticker: string) => void
  removeSymbol: (draft: MarketPreferences, ticker: string) => void
  toggleGroup: (draft: MarketPreferences, group: AssetClass) => void
  cycleSort: (draft: MarketPreferences, key: SortKey) => void
  togglePanel: (draft: MarketPreferences, panel: WidgetPanel) => void
  setPanelWidth: (draft: MarketPreferences, px: number) => void
  toggleBottom: (draft: MarketPreferences) => void
  setBottomHeight: (draft: MarketPreferences, px: number) => void
  setBottomTab: (draft: MarketPreferences, tab: BottomTab) => void
  setUpColor: (draft: MarketPreferences, color: UpColor) => void
  setOrderType: (draft: MarketPreferences, type: OrderType) => void
  setLots: (draft: MarketPreferences, lots: number) => void
}

export type MarketStore = EngineStoreHandle<MarketPreferences, MarketActions>

/** Create the store handle; the page shares one instance across mounts. */
export function createMarketStore(initial: MarketPreferences): MarketStore {
  return defineStore({
    init: (): MarketPreferences => structuredClone(initial),
    actions: {
      setSymbol: (d, ticker: string) => { d.symbol = ticker },
      setResolution: (d, resolution: string) => { d.resolution = normalizeResolution(resolution) },
      addSymbol: (d, ticker: string) => { if (!d.watchlist.includes(ticker)) d.watchlist.push(ticker) },
      removeSymbol: (d, ticker: string) => { d.watchlist = d.watchlist.filter(entry => entry !== ticker) },
      toggleGroup: (d, group: AssetClass) => {
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
    },
  })
}

/** Storage the preferences persist to; `localStorage` in the window. */
export interface PreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function readPreferences(storage: PreferenceStorage | undefined, tickers: readonly string[]): MarketPreferences {
  try {
    const raw = storage?.getItem(MARKET_STORAGE_KEY)
    return parsePreferences(raw === null || raw === undefined ? undefined : JSON.parse(raw), tickers)
  } catch {
    // Disabled storage or a corrupt value only loses the saved preferences.
    return defaultPreferences(tickers)
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
