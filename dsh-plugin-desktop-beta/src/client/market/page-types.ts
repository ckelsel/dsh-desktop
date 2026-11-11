/** Props shared by the market page and its panels. */
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, InjectFace, PropsLocale, PropsStore, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { MarketDataProvider } from './data/market-data.ts'
import type { TradingProvider, TradingSnapshot } from './data/trading.ts'
import type { QuoteHub, QuoteMap } from './quotes.ts'
import type { MarketStore } from './store.ts'
import type { ChartLanguage, ColorScheme } from './tradingview/TradingViewChart.tsx'
import type { zh } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'desktop-market': keyof typeof zh
  }
}

/** Services and live sources the page registration injects. */
export interface MarketInjected {
  market: MarketDataProvider
  trading: TradingProvider
  quotes: QuoteHub
  hooks: {
    quotes: HostObservable<QuoteMap>
    account: HostObservable<TradingSnapshot>
    scheme: HostObservable<ColorScheme>
    language: HostObservable<ChartLanguage>
  }
}

export type MarketPageProps = PropsStore<MarketStore> & PropsLocale<'desktop-market'> & InjectFace<MarketInjected>

export type MarketT = TranslateNS<'desktop-market'>
export type MarketActions = MarketPageProps['actions']
export type UseQuotes = SnapshotSelectorHook<QuoteMap>
export type UseAccount = SnapshotSelectorHook<TradingSnapshot>

/** A short message over the page, such as a trade request's outcome. */
export interface Notice {
  id: number
  text: string
  tone: 'info' | 'success' | 'warning' | 'error'
}

export type Notify = (text: string, tone?: Notice['tone']) => void
