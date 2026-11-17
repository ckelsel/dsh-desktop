/**
 * Market page registration: the market data and trading services, the page labels and styles, and
 * the page's two official slots — the 'market' global panel in the keyed 'main' slot (the sidebar's
 * panel list offers the entry, `selectPanel` switches to it) and the panel-list row that names it.
 * In the Desktop window market data and the account come from the MT5 bridge, and the demo data
 * stands in while the bridge is turned off; a browser session, which has no bridge, shows the
 * demo data.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { MarketSource } from './data/market-data.ts'
import { createMockMarketData } from './data/mock-market-data.ts'
import { createMockTrading } from './data/mock-trading.ts'
import { desktopMt5Bridge } from './data/mt5-bridge.ts'
import { createMt5MarketData } from './data/mt5-market-data.ts'
import { createMt5Trading } from './data/mt5-trading.ts'
import { en, zh } from './locales.ts'
import { MarketPage } from './MarketPage.tsx'
import { MarketPanelIcon } from './MarketPanelIcon.tsx'
import type { MarketInjected } from './page-types.ts'
import { createQuoteHub } from './quotes.ts'
import { createMarketStore, persistPreferences, readPreferences, type PreferenceStorage } from './store.ts'
import { installMarketStyles } from './styles.ts'
import type { ChartLanguage, ColorScheme } from './tradingview/TradingViewChart.tsx'

/** The market page's identity in the official keyed 'main' slot and the sidebar panel list. */
const MARKET_PANEL_ID = 'market' as MainPanelId

function windowStorage(): PreferenceStorage | undefined {
  try { return window.localStorage } catch { return undefined /* Storage access can throw when site data is blocked. */ }
}

/**
 * Register the market page into the trading workspace frame.
 * @param ctx - the Desktop client plugin context.
 */
export function registerMarketPage(ctx: Context): void {
  ctx.inject(['slots', 'locale', 'theme'], (scope) => {
    scope.effect(() => scope.locale.register('desktop-market', { zh, en }), 'market: page labels')
    scope.effect(installMarketStyles, 'market: page styles')
    scope.effect(() => {
      const mock = createMockMarketData()
      // The demo account trades the demo symbols, whichever data the page shows.
      const demo = createMockTrading({ market: mock })
      const bridge = desktopMt5Bridge()
      const market = bridge === null ? mock : createMt5MarketData({
        bridge, demo: mock,
        onError: (error) => { console.warn('[desktop-market] MT5 market data is unavailable', error) },
      })
      const trading = bridge === null ? demo : createMt5Trading({
        bridge, demo,
        onError: (error) => { console.warn('[desktop-market] MT5 bridge status is unavailable', error) },
      })
      const quotes = createQuoteHub(market)
      const storage = windowStorage()
      const handle = createMarketStore(readPreferences(storage))
      const instance = handle.create()
      // One instance outlives page remounts, so preferences persist from one place.
      const store: typeof handle = { ...handle, create: () => instance }
      const stopPersisting = persistPreferences(instance, storage)
      const scheme: HostObservable<ColorScheme> = {
        getSnapshot: () => scope.theme.getTheme().active.colorScheme,
        subscribe: (listener) => {
          const off = scope.on('theme/change', () => { listener() })
          return () => { off() }
        },
      }
      const language: HostObservable<ChartLanguage> = {
        getSnapshot: () => String(scope.locale.getSnapshot().active).startsWith('zh') ? 'zh' : 'en',
        subscribe: listener => scope.locale.subscribe(listener),
      }
      const source: HostObservable<MarketSource> = { getSnapshot: () => market.source(), subscribe: listener => market.subscribeSource(listener) }
      const injected: MarketInjected = { market, trading, quotes, hooks: { quotes, account: trading, source, scheme, language } }
      const t = scope.locale.bind('desktop-market')
      // The page body: one keyed entry of the official 'main' slot; `selectPanel('market')` shows it.
      const stopEntry = scope.slots.inject('main', () => scope.slots.register({
        name: 'main',
        key: MARKET_PANEL_ID,
        locale: 'desktop-market',
        store,
        inject: () => injected,
      }, MarketPage))
      // The page's entry in the official sidebar panel list; the row renders the icon beside the label.
      const stopPanelRow = scope.slots.inject('sidebar.panellist', () => scope.slots.register({
        name: 'sidebar.panellist',
        id: MARKET_PANEL_ID,
        order: 20,
        locale: 'desktop-market',
        label: () => t('panel'),
      }, MarketPanelIcon))
      return () => {
        stopPanelRow()
        stopEntry()
        stopPersisting()
        quotes.dispose()
        trading.dispose()
        market.dispose()
      }
    }, 'market: page services and entry')
  })
}
