/**
 * Quote snapshot shared by the market page: one provider subscription for the tickers the page
 * shows, coalesced into one immutable update per animation frame. Unchanged tickers keep their
 * quote objects, so rows re-render only when their own quote moves. When the data source changes,
 * as when the MT5 connection is switched on, the quotes of the previous source are dropped.
 */
import type { MarketDataProvider, Quote } from './data/market-data.ts'

export type QuoteMap = Readonly<Record<string, Quote>>

export interface QuoteHub {
  getSnapshot(): QuoteMap
  subscribe(listener: () => void): () => void
  /** Follow exactly these tickers. */
  follow(tickers: readonly string[]): void
  dispose(): void
}

export function createQuoteHub(market: MarketDataProvider): QuoteHub {
  let snapshot: QuoteMap = {}
  let pending: Record<string, Quote> | undefined
  let frame: number | undefined
  let followed = ''
  let tickers: readonly string[] = []
  let stop: (() => void) | undefined
  let sourceKey = market.source().key
  const listeners = new Set<() => void>()

  const publish = (): void => {
    for (const listener of [...listeners]) listener()
  }
  const flush = (): void => {
    frame = undefined
    if (pending === undefined) return
    snapshot = { ...snapshot, ...pending }
    pending = undefined
    publish()
  }
  const schedule = (): void => {
    if (frame === undefined) frame = requestAnimationFrame(flush)
  }
  /** Subscribe to the followed tickers, with the quotes the provider already has. */
  const start = (): void => {
    stop?.()
    stop = undefined
    // New rows render with a quote at once; the stream takes over from the next tick.
    const seeded: Record<string, Quote> = {}
    for (const ticker of tickers) {
      if (snapshot[ticker] !== undefined) continue
      const quote = market.quote(ticker)
      if (quote !== undefined) seeded[ticker] = quote
    }
    if (Object.keys(seeded).length > 0) {
      snapshot = { ...snapshot, ...seeded }
      publish()
    }
    if (tickers.length > 0) {
      stop = market.subscribeQuotes(tickers, quote => {
        (pending ??= {})[quote.ticker] = quote
        schedule()
      })
    }
  }
  const stopSource = market.subscribeSource(() => {
    const key = market.source().key
    if (key === sourceKey) return
    sourceKey = key
    snapshot = {}
    pending = undefined
    publish()
    start()
  })

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    follow(next) {
      const wanted = [...new Set(next)].sort()
      const key = wanted.join(',')
      if (key === followed) return
      followed = key
      tickers = wanted
      start()
    },
    dispose() {
      stopSource()
      stop?.()
      stop = undefined
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      listeners.clear()
    },
  }
}
