/**
 * Column geometry of the trading workspace frame:
 * activity bar | session list | market | main (chat or global panel) | right column.
 * Pure functions, so the frame, the store and tests share one solve.
 */

/** Fixed activity bar width. */
export const ACTIVITY_WIDTH = 48
/** Session list drag range and initial width (the upstream sidebar contract). */
export const SIDEBAR_MIN = 264
export const SIDEBAR_MAX = 420
export const SIDEBAR_DEFAULT = 280
/** Frame width below which the session list overlays the content as a drawer. */
export const DRAWER_BREAKPOINT = 768
/** Narrowest market column kept beside the chat. */
export const MARKET_MIN = 560
/** Chat column drag range beside the market. */
export const CHAT_MIN = 360
export const CHAT_DEFAULT = 420
/** Widest chat column beside the market, as a fraction of the frame. */
export const CHAT_MAX_RATIO = 0.5
/** Centre width protected while the main column fills the content and the right column is open (upstream value). */
export const CENTER_MIN = 400
/** Right column drag floor, ceiling ratio and first-open ratio. */
export const RIGHTBAR_MIN = 300
export const RIGHTBAR_MAX_RATIO = 0.7
export const RIGHTBAR_DEFAULT_RATIO = 0.3

/** Content columns the activity bar toggles. */
export type WorkspaceColumn = 'market' | 'chat'

/** Inputs of one frame solve. */
export interface ColumnInput {
  /** Frame width in px, activity bar included. */
  viewport: number
  /** Session list width preference; 0 when it takes no track (closed, or drawn as a drawer). */
  sidebar: number
  /** Market column switched on. */
  market: boolean
  /** Chat column switched on. */
  chat: boolean
  /** The column opened most recently; it stays when both cannot fit. */
  lastOpened: WorkspaceColumn
  /** Chat width preference beside the market. */
  chatWidth: number
  /** A global panel occupies the main column and takes the market's place. */
  globalPanel: boolean
  /** Requested right column track; 0 requests none. */
  rightbar: number
}

/** Resolved widths and visibility for one frame. */
export interface Columns {
  sidebar: number
  market: number
  /** Width of the main column (Conversation or global panel). */
  main: number
  rightbar: number
  showMarket: boolean
  showMain: boolean
  /** The main column takes all content width, as in the upstream layout. */
  mainFills: boolean
}

/**
 * Clamp a width into its range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound; a bound below `min` yields `min`.
 * @returns the rounded, clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(px)))
}

/**
 * Decide which content columns a frame shows. A global panel replaces the market; when market and
 * chat cannot both keep their minimum, only the column opened last stays.
 * @returns visibility of the market and main columns; at least one is shown.
 */
export function visibleColumns(input: ColumnInput): { showMarket: boolean; showMain: boolean } {
  const sidebar = input.sidebar === 0 ? 0 : clampWidth(input.sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const content = Math.max(0, input.viewport - ACTIVITY_WIDTH - sidebar)
  let showMain = input.chat || input.globalPanel
  let showMarket = input.market && !input.globalPanel
  if (!showMain && !showMarket) showMain = true
  if (showMain && showMarket && content < MARKET_MIN + CHAT_MIN) {
    if (input.lastOpened === 'market') showMain = false
    else showMarket = false
  }
  return { showMarket, showMain }
}

/**
 * Solve the frame's column widths. The market flexes; the chat keeps its preference within
 * [CHAT_MIN, min(CHAT_MAX_RATIO of the frame, what leaves the market its minimum)]; the right column
 * takes a track only beside a visible main column, and loses it before either column drops below
 * its minimum.
 * @param input - frame width, preferences and toggles.
 * @returns resolved widths; hidden columns are 0.
 */
export function computeColumns(input: ColumnInput): Columns {
  const sidebar = input.sidebar === 0 ? 0 : clampWidth(input.sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const content = Math.max(0, input.viewport - ACTIVITY_WIDTH - sidebar)
  const { showMarket, showMain } = visibleColumns(input)
  const mainFills = showMain && !showMarket
  const available = content - (showMarket ? MARKET_MIN + CHAT_MIN : CENTER_MIN)
  const rightbar = !showMain || input.rightbar === 0 || available < RIGHTBAR_MIN
    ? 0
    : Math.min(available, clampWidth(input.rightbar, RIGHTBAR_MIN, content * RIGHTBAR_MAX_RATIO))
  const main = !showMain ? 0
    : mainFills ? Math.max(0, content - rightbar)
      : clampWidth(input.chatWidth, CHAT_MIN, Math.min(input.viewport * CHAT_MAX_RATIO, content - MARKET_MIN - rightbar))
  const market = showMarket ? Math.max(0, content - main - rightbar) : 0
  return { sidebar, market, main, rightbar, showMarket, showMain, mainFills }
}
