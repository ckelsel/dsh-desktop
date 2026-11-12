/**
 * Market page registration: the market data and trading services, the page labels and styles, and
 * the 'trading.market' entry of the trading workspace frame. In the Desktop window market data and
 * the account come from the MT5 bridge, and the demo data stands in while the bridge is turned off;
 * a browser session, which has no bridge, shows the demo data.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
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
import type { MarketInjected } from './page-types.ts'
import { createQuoteHub } from './quotes.ts'
import { createMarketStore, persistPreferences, readPreferences, type PreferenceStorage } from './store.ts'
import { installMarketStyles } from './styles.ts'
import type { ChartLanguage, ColorScheme } from './tradingview/TradingViewChart.tsx'

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
      const stopEntry = scope.slots.inject('trading.market', () => scope.slots.register({
        name: 'trading.market',
        locale: 'desktop-market',
        store,
        inject: () => injected,
      }, MarketPage))
      return () => {
        stopEntry()
        stopPersisting()
        quotes.dispose()
        trading.dispose()
        market.dispose()
      }
    }, 'market: page services and entry')
  })
}
