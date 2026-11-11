/**
 * Quote snapshot shared by the market page: one provider subscription for the tickers the page
 * shows, coalesced into one immutable update per animation frame. Unchanged tickers keep their
 * quote objects, so rows re-render only when their own quote moves.
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
  let stop: (() => void) | undefined
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

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    follow(tickers) {
      const wanted = [...new Set(tickers)].sort()
      const key = wanted.join(',')
      if (key === followed) return
      followed = key
      stop?.()
      stop = undefined
      // New rows render with a quote at once; the stream takes over from the next tick.
      const seeded: Record<string, Quote> = {}
      for (const ticker of wanted) {
        if (snapshot[ticker] !== undefined) continue
        const quote = market.quote(ticker)
        if (quote !== undefined) seeded[ticker] = quote
      }
      if (Object.keys(seeded).length > 0) {
        snapshot = { ...snapshot, ...seeded }
        publish()
      }
      if (wanted.length > 0) {
        stop = market.subscribeQuotes(wanted, quote => {
          (pending ??= {})[quote.ticker] = quote
          schedule()
        })
      }
    },
    dispose() {
      stop?.()
      stop = undefined
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      listeners.clear()
    },
  }
}
