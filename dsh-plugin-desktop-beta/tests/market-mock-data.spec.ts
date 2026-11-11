import { describe, expect, it } from 'vitest'
import { normalizeLots, stepDecimals, type Candle, type HistoryRequest, type Quote } from '../src/client/market/data/market-data.ts'
import { createMockMarketData, MOCK_SYMBOLS, newYorkOffset, PRICE_ANCHOR } from '../src/client/market/data/mock-market-data.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Wednesday 2026-11-11 15:00 UTC, inside the London and New York overlap. */
const WEDNESDAY = Date.UTC(2026, 10, 11, 15)
const SATURDAY = Date.UTC(2026, 10, 14, 12)

function mock(at: number) {
  let clock = at
  const provider = createMockMarketData({ now: () => clock, interval: 0 })
  return { provider, setClock: (time: number) => { clock = time } }
}

const request = (ticker: string, resolution: HistoryRequest['resolution'], to: number, countBack: number, from = to): HistoryRequest =>
  ({ ticker, resolution, from, to, countBack })

const utcHour = (bar: Candle): number => new Date(bar.time).getUTCHours()

describe('mock FX and gold data', () => {
  it('offers only currency pairs and gold', () => {
    expect(new Set(MOCK_SYMBOLS.map(symbol => symbol.assetClass))).toEqual(new Set(['forex', 'metal']))
    expect(MOCK_SYMBOLS.find(symbol => symbol.ticker === 'XAUUSD')).toMatchObject({ assetClass: 'metal', contractSize: 100, pip: 0.1, session: '1800-1700:23456' })
    expect(MOCK_SYMBOLS.find(symbol => symbol.ticker === 'USDJPY')).toMatchObject({ decimals: 3, pip: 0.01, session: '1700-1700:23456', timezone: 'America/New_York' })
  })

  it('returns the same well-formed bars for the same request', async () => {
    const first = await mock(WEDNESDAY).provider.history(request('EURUSD', '1', WEDNESDAY, 300))
    const second = await mock(WEDNESDAY).provider.history(request('EURUSD', '1', WEDNESDAY, 300))
    expect(first.bars).toEqual(second.bars)
    expect(first.bars.length).toBeGreaterThanOrEqual(300)
    for (const [index, bar] of first.bars.entries()) {
      expect(bar.low).toBeLessThanOrEqual(Math.min(bar.open, bar.close))
      expect(bar.high).toBeGreaterThanOrEqual(Math.max(bar.open, bar.close))
      expect(bar.volume).toBeGreaterThan(0)
      if (index > 0) expect(bar.time - first.bars[index - 1]!.time).toBe(MINUTE)
    }
  })

  it('anchors prices to plausible levels and keeps crosses consistent with their legs', () => {
    const { provider } = mock(PRICE_ANCHOR)
    expect(provider.quote('EURUSD')?.last).toBeCloseTo(1.16, 5)
    expect(provider.quote('XAUUSD')?.last).toBeCloseTo(4000, 2)
    const { provider: live } = mock(WEDNESDAY)
    const eurusd = live.quote('EURUSD')!.last
    const usdjpy = live.quote('USDJPY')!.last
    const eurgbp = live.quote('EURGBP')!.last
    expect(live.quote('EURJPY')!.last).toBeCloseTo(eurusd * usdjpy, 1)
    expect(eurgbp).toBeCloseTo(eurusd / live.quote('GBPUSD')!.last, 4)
  })

  it('opens the FX week at 17:00 New York time on Sunday and closes it on Friday', async () => {
    const { provider } = mock(Date.UTC(2026, 10, 16, 12))
    const { bars } = await provider.history(request('EURUSD', '60', Date.UTC(2026, 10, 16, 0), 1, Date.UTC(2026, 10, 13, 18)))
    const friday = bars.filter(bar => bar.time < Date.UTC(2026, 10, 14))
    const sunday = bars.filter(bar => bar.time >= Date.UTC(2026, 10, 14))
    // Winter time: 17:00 EST is 22:00 UTC.
    expect(friday.at(-1)!.time).toBe(Date.UTC(2026, 10, 13, 21))
    expect(sunday[0]!.time).toBe(Date.UTC(2026, 10, 15, 22))
    // Summer time: the Friday close moves to 21:00 UTC.
    const summer = await mock(Date.UTC(2026, 6, 13)).provider.history(request('EURUSD', '60', Date.UTC(2026, 6, 11), 3))
    expect(summer.bars.at(-1)!.time).toBe(Date.UTC(2026, 6, 10, 20))
  })

  it('pauses gold for an hour every day', async () => {
    const { provider } = mock(WEDNESDAY)
    const { bars } = await provider.history(request('XAUUSD', '1', Date.UTC(2026, 10, 11), 1, Date.UTC(2026, 10, 10, 21)))
    const inBreak = bars.filter(bar => bar.time >= Date.UTC(2026, 10, 10, 22) && bar.time < Date.UTC(2026, 10, 10, 23))
    expect(inBreak).toEqual([])
    expect(bars.some(bar => bar.time === Date.UTC(2026, 10, 10, 21, 59))).toBe(true)
    expect(bars.some(bar => bar.time === Date.UTC(2026, 10, 10, 23))).toBe(true)
  })

  it('aligns intraday bars to the session open and labels daily and weekly bars by trading day', async () => {
    const { provider } = mock(WEDNESDAY)
    const four = await provider.history(request('EURUSD', '240', WEDNESDAY, 12))
    expect(new Set(four.bars.map(utcHour))).toEqual(new Set([22, 2, 6, 10, 14, 18]))
    const daily = await provider.history(request('EURUSD', '1D', WEDNESDAY, 20))
    for (const bar of daily.bars) {
      expect(bar.time % DAY).toBe(0)
      expect([1, 2, 3, 4, 5]).toContain(new Date(bar.time).getUTCDay())
    }
    expect(daily.bars.at(-1)!.time).toBe(Date.UTC(2026, 10, 11))
    const weekly = await provider.history(request('XAUUSD', '1W', WEDNESDAY, 10))
    for (const bar of weekly.bars) expect(new Date(bar.time).getUTCDay()).toBe(1)
  })

  it('pages back without overlaps, including daily bars whose session opens before their label', async () => {
    const { provider } = mock(WEDNESDAY)
    for (const resolution of ['1', '1D'] as const) {
      const page = await provider.history(request('GBPUSD', resolution, WEDNESDAY, 50))
      const previous = await provider.history(request('GBPUSD', resolution, page.bars[0]!.time, 50))
      expect(previous.bars.length).toBeGreaterThanOrEqual(50)
      expect(previous.bars.at(-1)!.time).toBeLessThan(page.bars[0]!.time)
    }
    const beforeListing = await provider.history(request('EURUSD', '1D', Date.UTC(2017, 11, 1), 10))
    expect(beforeListing).toEqual({ bars: [], noData: true })
  })

  it('streams the live bar and rolls over to the next one', () => {
    const { provider, setClock } = mock(WEDNESDAY + 30_000)
    const received: Candle[] = []
    const stop = provider.subscribeBars('USDJPY', '1', bar => { received.push(bar) })
    provider.tick()
    setClock(WEDNESDAY + 45_000)
    provider.tick()
    setClock(WEDNESDAY + MINUTE + 5_000)
    provider.tick()
    stop()
    setClock(WEDNESDAY + 2 * MINUTE + 5_000)
    provider.tick()
    expect(received.map(bar => bar.time)).toEqual([WEDNESDAY, WEDNESDAY, WEDNESDAY + MINUTE])
    expect(received[1]!.high).toBeGreaterThanOrEqual(received[0]!.high)
    expect(received[1]!.volume).toBeGreaterThanOrEqual(received[0]!.volume)
  })

  it('quotes a spread while open and settles once when closed', () => {
    const { provider, setClock } = mock(WEDNESDAY)
    const open = provider.quote('EURUSD')!
    expect(open.marketOpen).toBe(true)
    expect(open.ask).toBeGreaterThan(open.bid)
    expect(open.ask - open.bid).toBeLessThanOrEqual(0.8 * 0.0001 * 1.5 + 0.00001)
    expect(open.change).toBeCloseTo(open.last - open.prevClose, 5)

    setClock(SATURDAY)
    const closed = provider.quote('EURUSD')!
    expect(closed.marketOpen).toBe(false)
    expect(closed.time).toBe(Date.UTC(2026, 10, 13, 22) - 1)
    const received: Quote[] = []
    const stop = provider.subscribeQuotes(['EURUSD', 'XAUUSD', 'UNKNOWN'], quote => { received.push(quote) })
    provider.tick()
    provider.tick()
    stop()
    expect(received.map(quote => quote.ticker)).toEqual(['EURUSD', 'XAUUSD'])
  })

  it('follows US daylight saving time', () => {
    expect(newYorkOffset(Date.UTC(2026, 6, 1))).toBe(-4 * HOUR)
    expect(newYorkOffset(Date.UTC(2026, 11, 1))).toBe(-5 * HOUR)
    expect(newYorkOffset(Date.UTC(2026, 2, 8, 6, 59))).toBe(-5 * HOUR)
    expect(newYorkOffset(Date.UTC(2026, 2, 8, 7))).toBe(-4 * HOUR)
    expect(newYorkOffset(Date.UTC(2026, 10, 1, 5, 59))).toBe(-4 * HOUR)
    expect(newYorkOffset(Date.UTC(2026, 10, 1, 6))).toBe(-5 * HOUR)
  })
})

describe('lot helpers', () => {
  it('snaps sizes to the step and bounds', () => {
    const gold = { minLots: 0.01, maxLots: 50, lotStep: 0.01 }
    expect(normalizeLots(gold, 0.123)).toBe(0.12)
    expect(normalizeLots(gold, 0)).toBe(0.01)
    expect(normalizeLots(gold, 80)).toBe(50)
    expect(normalizeLots(gold, Number.NaN)).toBe(0.01)
    expect(stepDecimals(0.01)).toBe(2)
    expect(stepDecimals(1e-7)).toBe(7)
    expect(stepDecimals(1000)).toBe(0)
  })
})
