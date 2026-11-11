/**
 * `ctx.layout` for the trading workspace: the ui-layout 0.2.2 ILayout contract over the trading
 * store, so ui-sidebar, ui-workspace, ui-plugin-manager and ui-sidebar-right keep working unchanged.
 */
import type { BoundActions, HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ILayout, MainPanelId, PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { TradingLayoutStore } from './layout-store.ts'

/** The store's bound action set, shared with the root registration. */
export type TradingLayoutActions = BoundActions<TradingLayoutStore>

/** Cross-plugin panel actions (ctx.layout). */
export class TradingLayoutController implements ILayout {
  private navigation = new AbortController()

  /**
   * @param panels - actions of the store instance the root entry renders.
   * @param hasMainPanel - checks the live main-slot registry for a panel id.
   * @param panelInfo - the root store's central-panel selection.
   */
  constructor(
    private readonly panels: TradingLayoutActions,
    private readonly hasMainPanel: (id: MainPanelId) => boolean,
    readonly panelInfo: HostObservable<PanelInfo>,
  ) {}

  /**
   * Select a global panel or return to the Conversation; the latter reveals the chat column.
   * @throws if the selected main key is not registered; the current selection is kept.
   */
  selectPanel(panelId: MainPanelId | null): void {
    if (panelId !== null && !this.hasMainPanel(panelId)) {
      throw new Error(`layout.selectPanel: main panel "${panelId}" is not registered`)
    }
    this.navigation.abort()
    this.panels.selectPanel(panelId)
  }

  /** @returns the new pending navigation's signal, aborted by the next navigation or disposal. */
  beginNavigation(): AbortSignal {
    this.navigation.abort()
    this.navigation = new AbortController()
    return this.navigation.signal
  }

  /** Invalidate pending navigations when the layout owner is unloaded. */
  dispose(): void {
    this.navigation.abort()
  }

  /** Show or hide the session list (the drawer on narrow frames). */
  toggleSidebar(): void {
    this.panels.toggleSidebar()
  }

  /** Report the right column's track and fullscreen presentation. */
  openRightbar(track: boolean, fullscreen: boolean): void {
    this.panels.openRightbar(track, fullscreen)
  }

  /** Report the right column as hidden. */
  closeRightbar(): void {
    this.panels.closeRightbar()
  }
}
