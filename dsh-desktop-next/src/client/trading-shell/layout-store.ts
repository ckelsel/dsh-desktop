/**
 * Root store of the trading workspace: main-panel selection (the `ctx.layout` contract), the
 * right column's reported presentation, and the activity bar's persisted column choices.
 * The right column fields follow ui-layout 0.2.2 so ui-sidebar-right keeps its contract.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  CHAT_DEFAULT, CHAT_MAX_RATIO, CHAT_MIN, clampWidth, DRAWER_BREAKPOINT, RIGHTBAR_DEFAULT_RATIO, RIGHTBAR_MAX_RATIO,
  RIGHTBAR_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN, visibleColumns, type ColumnInput, type WorkspaceColumn,
} from './columns.ts'

/** Column choices kept across launches. */
export interface WorkbenchPreferences {
  /** Session list shown (wide frames). */
  sessions: boolean
  market: boolean
  chat: boolean
  /** Column kept when market and chat cannot both fit. */
  lastOpened: WorkspaceColumn
  /** Session list width preference. */
  sidebar: number
  /** Chat width preference beside the market. */
  chatWidth: number
}

export const DEFAULT_WORKBENCH: Readonly<WorkbenchPreferences> = Object.freeze({
  sessions: true, market: true, chat: true, lastOpened: 'market', sidebar: SIDEBAR_DEFAULT, chatWidth: CHAT_DEFAULT,
})

/** Storage key of {@link WorkbenchPreferences}; versioned so a later format starts from defaults. */
export const WORKBENCH_STORAGE_KEY = 'dsh-desktop-beta.trading-workbench.v1'

/**
 * Read saved preferences field by field; anything malformed falls back to its default.
 * @param value - parsed JSON, or anything else.
 * @returns preferences with at least one of market and chat switched on.
 */
export function parseWorkbench(value: unknown): WorkbenchPreferences {
  const source = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const flag = (key: 'sessions' | 'market' | 'chat') => typeof source[key] === 'boolean' ? source[key] : DEFAULT_WORKBENCH[key]
  const width = (key: 'sidebar' | 'chatWidth', min: number, max: number) => {
    const raw = source[key]
    return typeof raw === 'number' && Number.isFinite(raw) ? clampWidth(raw, min, max) : DEFAULT_WORKBENCH[key]
  }
  const result: WorkbenchPreferences = {
    sessions: flag('sessions'), market: flag('market'), chat: flag('chat'),
    lastOpened: source.lastOpened === 'chat' || source.lastOpened === 'market' ? source.lastOpened : DEFAULT_WORKBENCH.lastOpened,
    sidebar: width('sidebar', SIDEBAR_MIN, SIDEBAR_MAX),
    chatWidth: width('chatWidth', CHAT_MIN, 4096),
  }
  if (!result.market && !result.chat) result.market = true
  return result
}

/** Transient frame state plus the persisted workbench slice. */
export type TradingLayoutState = {
  panelInfo: {
    /** Null selects the Conversation; global panels keep the current Session intact. */
    activePanelId: MainPanelId | null
  }
  layoutInfo: {
    /** Last positive frame measurement. */
    viewportWidth: number
    /** Whether frames below {@link DRAWER_BREAKPOINT} draw the session list as a drawer (not under a Windows caption). */
    drawerEnabled: boolean
    /** Drawer open on a narrow frame; wide frames use `workbench.sessions`. */
    drawerOpen: boolean
    /** Saved right column width, or null before its first opening. */
    rightbar: number | null
    /** Reported by the right column occupant: drawn at all. */
    rightbarShown: boolean
    /** Reported: the normal width reserves a track (also beneath fullscreen). */
    rightbarTrack: boolean
    /** Reported: fullscreen presentation; hides the outer resize handle. */
    rightbarFullscreen: boolean
    /** Suppress transitions for a fullscreen exit until another geometry action. */
    rightbarInstant: boolean
  }
  workbench: WorkbenchPreferences
}

type TradingLayoutActions = {
  selectPanel: (draft: TradingLayoutState, panelId: MainPanelId | null) => void
  retainMainPanels: (draft: TradingLayoutState, panelIds: readonly string[]) => void
  setSidebar: (draft: TradingLayoutState, px: number) => void
  toggleSidebar: (draft: TradingLayoutState) => void
  toggleColumn: (draft: TradingLayoutState, column: WorkspaceColumn) => void
  setChatWidth: (draft: TradingLayoutState, px: number) => void
  setViewportWidth: (draft: TradingLayoutState, width: number) => void
  setRightbar: (draft: TradingLayoutState, px: number) => void
  openRightbar: (draft: TradingLayoutState, track: boolean, fullscreen: boolean) => void
  closeRightbar: (draft: TradingLayoutState) => void
}

/** Store handle type shared by the frame props and the layout service. */
export type TradingLayoutStore = EngineStoreHandle<TradingLayoutState, TradingLayoutActions>

/** Whether the session list is drawn as a drawer at this state's frame width. */
export function isDrawer(state: Pick<TradingLayoutState, 'layoutInfo'>): boolean {
  return state.layoutInfo.drawerEnabled && state.layoutInfo.viewportWidth < DRAWER_BREAKPOINT
}

/** First-open right column width for a frame. */
export function defaultRightbar(viewport: number): number {
  return Math.max(RIGHTBAR_MIN, Math.round(viewport * RIGHTBAR_DEFAULT_RATIO))
}

/**
 * Column solve inputs for a state.
 * @param rightbar - `track` requests the reported track; `preference` requests the saved width (opening eligibility).
 */
export function columnInput(state: TradingLayoutState, rightbar: 'track' | 'preference' = 'track'): ColumnInput {
  const { layoutInfo: info, workbench } = state
  const drawer = isDrawer(state)
  const preference = info.rightbar ?? defaultRightbar(info.viewportWidth)
  return {
    viewport: info.viewportWidth,
    sidebar: drawer || !workbench.sessions ? 0 : workbench.sidebar,
    market: workbench.market,
    chat: workbench.chat,
    lastOpened: workbench.lastOpened,
    chatWidth: workbench.chatWidth,
    globalPanel: state.panelInfo.activePanelId !== null,
    rightbar: rightbar === 'preference' || info.rightbarTrack ? preference : 0,
  }
}

/** Initial values for {@link createTradingLayoutStore}. */
export interface TradingLayoutStoreOptions {
  viewportWidth: number
  drawerEnabled: boolean
  workbench: WorkbenchPreferences
}

/**
 * Create the store handle. Navigating to the Conversation reveals the chat column; the activity bar
 * toggles one column at a time and never leaves both market and chat off.
 * @returns the store handle; the layout service shares one instance with the root registration.
 */
export function createTradingLayoutStore(options: TradingLayoutStoreOptions): TradingLayoutStore {
  return defineStore({
    init: (): TradingLayoutState => ({
      panelInfo: { activePanelId: null },
      layoutInfo: {
        viewportWidth: options.viewportWidth,
        drawerEnabled: options.drawerEnabled,
        drawerOpen: false,
        rightbar: null,
        rightbarShown: false,
        rightbarTrack: false,
        rightbarFullscreen: false,
        rightbarInstant: false,
      },
      workbench: { ...options.workbench },
    }),
    actions: {
      selectPanel: (d, panelId: MainPanelId | null) => {
        d.panelInfo.activePanelId = panelId
        // Opening a Session or returning from a global panel targets the chat column.
        if (panelId === null) {
          d.workbench.chat = true
          d.workbench.lastOpened = 'chat'
        }
        if (isDrawer(d)) d.layoutInfo.drawerOpen = false
      },
      retainMainPanels: (d, panelIds: readonly string[]) => {
        if (d.panelInfo.activePanelId !== null && !panelIds.includes(d.panelInfo.activePanelId)) d.panelInfo.activePanelId = null
      },
      setSidebar: (d, px: number) => {
        d.layoutInfo.rightbarInstant = false
        d.workbench.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX)
      },
      toggleSidebar: (d) => {
        d.layoutInfo.rightbarInstant = false
        if (isDrawer(d)) d.layoutInfo.drawerOpen = !d.layoutInfo.drawerOpen
        else d.workbench.sessions = !d.workbench.sessions
      },
      toggleColumn: (d, column: WorkspaceColumn) => {
        d.layoutInfo.rightbarInstant = false
        const visible = visibleColumns(columnInput(d))
        const shown = column === 'market' ? visible.showMarket : visible.showMain && d.panelInfo.activePanelId === null
        const other: WorkspaceColumn = column === 'market' ? 'chat' : 'market'
        if (shown) {
          d.workbench[column] = false
          d.workbench[other] = true
          d.workbench.lastOpened = other
        } else {
          // A global panel holds the market's place; either button returns to the Conversation.
          d.panelInfo.activePanelId = null
          d.workbench[column] = true
          d.workbench.lastOpened = column
        }
      },
      setChatWidth: (d, px: number) => {
        d.layoutInfo.rightbarInstant = false
        d.workbench.chatWidth = clampWidth(px, CHAT_MIN, Math.max(CHAT_MIN, d.layoutInfo.viewportWidth * CHAT_MAX_RATIO))
      },
      setViewportWidth: (d, width: number) => {
        if (d.layoutInfo.viewportWidth === width) return
        d.layoutInfo.rightbarInstant = false
        if ((d.layoutInfo.viewportWidth < DRAWER_BREAKPOINT) !== (width < DRAWER_BREAKPOINT)) d.layoutInfo.drawerOpen = false
        d.layoutInfo.viewportWidth = width
      },
      setRightbar: (d, px: number) => {
        d.layoutInfo.rightbarInstant = false
        d.layoutInfo.rightbar = clampWidth(px, RIGHTBAR_MIN, Math.max(RIGHTBAR_MIN, d.layoutInfo.viewportWidth * RIGHTBAR_MAX_RATIO))
      },
      openRightbar: (d, track: boolean, fullscreen: boolean) => {
        const info = d.layoutInfo
        if (!info.rightbarShown || info.rightbarTrack !== track || info.rightbarFullscreen !== fullscreen) {
          info.rightbarInstant = info.rightbarFullscreen && !fullscreen
        }
        info.rightbar ??= defaultRightbar(info.viewportWidth)
        info.rightbarShown = true
        info.rightbarTrack = track
        info.rightbarFullscreen = fullscreen
      },
      closeRightbar: (d) => {
        const info = d.layoutInfo
        if (info.rightbarShown) info.rightbarInstant = info.rightbarFullscreen
        info.rightbarShown = false
        info.rightbarTrack = false
        info.rightbarFullscreen = false
      },
    },
  })
}

/** Storage the workbench preferences persist to; `localStorage` in the window. */
export interface WorkbenchStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Read saved preferences.
 * @returns parsed preferences, or the defaults when storage is unavailable or holds no valid value.
 */
export function readWorkbench(storage: WorkbenchStorage | undefined): WorkbenchPreferences {
  try {
    const raw = storage?.getItem(WORKBENCH_STORAGE_KEY)
    return parseWorkbench(raw === null || raw === undefined ? undefined : JSON.parse(raw))
  } catch {
    // Disabled storage or a corrupt value only loses the saved column choices.
    return { ...DEFAULT_WORKBENCH }
  }
}

/**
 * Write the workbench slice whenever it changes.
 * @param source - store instance (or any snapshot source of the state).
 * @returns the unsubscribe function.
 */
export function persistWorkbench(
  source: { getSnapshot(): TradingLayoutState; subscribe(listener: () => void): () => void },
  storage: WorkbenchStorage | undefined,
): () => void {
  let previous = source.getSnapshot().workbench
  return source.subscribe(() => {
    const next = source.getSnapshot().workbench
    if (next === previous) return
    previous = next
    try { storage?.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify(next)) } catch {
      // A full or disabled storage keeps the running layout; only persistence stops.
    }
  })
}
