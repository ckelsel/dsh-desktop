/**
 * Trading workspace shell. While the Host composes the trading layout it disables the official
 * ui-layout row; this module then owns what that plugin provided: `ctx.layout`, the root-scoped
 * `usePanelInfo` hook, the 'root' frame with its child slots, the session list command, and the
 * theme DOM writes.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { PanelInfo } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { createTradingLayoutStore, persistWorkbench, readWorkbench, type WorkbenchStorage } from './layout-store.ts'
import { TradingLayoutController } from './layout-service.ts'
import { TradingFrame, type TradingFrameInjected } from './TradingFrame.tsx'
import { TradingThemePresenter } from './theme-presenter.ts'
import { installTradingShellStyles } from './styles.ts'
import { en, layoutCommandLocales, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'desktop-trading': keyof typeof zh
  }
  interface SlotMap {
    /**
     * The market column of the trading workspace frame. Mounted the first time the column is shown
     * and kept mounted while hidden, so a chart survives column toggles.
     */
    'trading.market': { kind: 'single'; scope: 'root' }
  }
}

function windowStorage(): WorkbenchStorage | undefined {
  try { return window.localStorage } catch { return undefined /* Storage access can throw when site data is blocked. */ }
}

/** Shadowing rank of the root placeholder; the frame keeps the default 0, and the lowest rank renders. */
const ROOT_PLACEHOLDER_PRIORITY = 1

/** Stands in for the frame while none is registered; renders nothing. */
const RootPlaceholder = (): null => null

/**
 * Install the trading workspace shell into the client root.
 * @param ctx - the Desktop client plugin context.
 */
export function applyTradingShell(ctx: Context): void {
  ctx.inject(['slots', 'locale', 'theme', 'shortcuts'], scope => {
    // Replacing this plugin's code (a rebuilt bundle) unregisters the frame before the new code
    // registers it again, and the root outlet throws while 'root' has no entry, which takes the
    // whole page down. A placeholder registered for the page's lifetime covers that gap.
    if (!scope.slots.entries('root').some(entry => entry.options.priority === ROOT_PLACEHOLDER_PRIORITY)) {
      scope.root.slots.register({ name: 'root', priority: ROOT_PLACEHOLDER_PRIORITY }, RootPlaceholder)
    }
    scope.effect(() => scope.locale.register('desktop-trading', { zh, en }), 'trading: frame labels')
    scope.effect(() => scope.locale.register('shortcuts.layout', layoutCommandLocales), 'trading: layout command labels')
    const commandLabel = scope.locale.bind('shortcuts.layout')
    scope.effect(installTradingShellStyles, 'trading: frame styles')
    scope.effect(() => {
      document.documentElement.dataset.dshLayout = 'trading'
      return () => { delete document.documentElement.dataset.dshLayout }
    }, 'trading: document layout marker')

    scope.effect(() => {
      const storage = windowStorage()
      const handle = createTradingLayoutStore({
        viewportWidth: window.innerWidth,
        // Under the Windows caption the session list keeps its caption controls instead of a drawer.
        drawerEnabled: !document.documentElement.hasAttribute('data-windows-titlebar'),
        workbench: readWorkbench(storage),
      })
      const instance = handle.create()
      // One instance serves the root entry and ctx.layout.
      const store: typeof handle = { ...handle, create: () => instance }
      const stopPersisting = persistWorkbench(instance, storage)
      const mainKeys = (): string[] => scope.slots.entries('main').flatMap(entry => entry.options.key === undefined ? [] : [entry.options.key])
      const panelInfo: HostObservable<PanelInfo> = {
        getSnapshot: () => instance.getSnapshot().panelInfo,
        subscribe: listener => instance.subscribe(listener),
      }
      const layout = new TradingLayoutController(instance.actions, id => mainKeys().includes(id), panelInfo)
      const retainMainPanels = (): void => { instance.actions.retainMainPanels(mainKeys()) }
      const disposePanelInfo = scope.slots.provideRoot({ hooks: { panelInfo: layout.panelInfo } })
      const disposeService = scope.reflect.provide('layout', layout)
      const productTitle = document.title
      const disposeRegistration = scope.slots.register({
        name: 'root',
        locale: 'desktop-trading',
        children: {
          'sidebar': { kind: 'single', scope: 'root' },
          'main': { kind: 'keyed', scope: 'root' },
          'rightbar': { kind: 'single', scope: 'root' },
          'shell.bottom': { kind: 'single', scope: 'root' },
          'shell.overlay': { kind: 'list', scope: 'root' },
          'shell.leading': { kind: 'single', scope: 'root' },
          'trading.market': { kind: 'single', scope: 'root' },
        },
        store,
        inject: (): TradingFrameInjected => ({ productTitle }),
      }, TradingFrame)
      // The official layout's command, with its 0.2.2 defaults; it now toggles the session list.
      const disposeShortcut = scope.shortcuts.register({
        id: 'sidebar.left.toggle' as ShortcutCommandId, label: () => commandLabel('toggle'), aliases: ['sidebar', 'toggle left sidebar'],
        defaults: {
          'desktop:macos': { code: 'KeyB', modifiers: ['primary'] },
          'desktop:windows': { code: 'KeyB', modifiers: ['primary'] },
          'desktop:linux': { code: 'KeyB', modifiers: ['primary'] },
          'web:macos': { code: 'KeyB', modifiers: ['primary', 'alt'] },
          'web:windows': { code: 'KeyB', modifiers: ['primary', 'alt'] },
        },
        regions: ['page', 'editable'], modals: ['sidebar'],
        resolve: ({ modal }) => modal !== null && modal !== 'sidebar'
          ? { status: 'pass' }
          : { status: 'handled', run: () => { layout.toggleSidebar() } },
      })
      const disposePanels = scope.slots.subscribe('main', retainMainPanels)
      retainMainPanels()
      return () => {
        disposeShortcut()
        layout.dispose()
        disposePanels()
        disposeRegistration()
        disposePanelInfo()
        stopPersisting()
        // provide()'s disposer settles asynchronously; teardown stays synchronous.
        void disposeService()
      }
    }, 'trading: layout service and root frame')

    scope.effect(() => {
      const presenter = new TradingThemePresenter()
      presenter.apply(scope.theme.getTheme())
      const off = scope.on('theme/change', snapshot => { presenter.apply(snapshot) })
      return () => {
        off()
        presenter.dispose()
      }
    }, 'trading: theme presenter')
  })
}
