/**
 * Deterministic mock FX and gold data. A symbol's log price is a pure function of time — multi-scale
 * value noise with Brownian amplitude scaling, plus a shared U.S. dollar factor so dollar pairs move
 * together — so history at every resolution, the live bar and quotes agree, and the same request
 * always returns the same bars. Crosses are products of their dollar legs. Prices are anchored to
 * plausible levels at {@link PRICE_ANCHOR}.
 *
 * Trading hours follow the New York 17:00 rollover: a trading day opens at 17:00 (gold: 18:00) New
 * York time on the previous evening and closes at 17:00, Monday to Friday, without holidays.
 */
import type { Candle, HistoryRequest, HistoryResult, MarketDataProvider, MarketSource, MarketSymbol, Quote, Resolution } from './market-data.ts'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** Upper bound on bars visited by one history request. */
const MAX_HISTORY_STEPS = 20_000
/** Mock prices equal each symbol's `anchor` level at this time. */
export const PRICE_ANCHOR = Date.UTC(2026, 10, 2)
const LISTED = Date.UTC(2018, 0, 1)

/** Trading day bounds in New York minutes: opens at `open` on the previous day, closes at `close`. */
interface SessionHours { open: number; close: number }
const FX_HOURS: SessionHours = { open: 17 * 60, close: 17 * 60 }
const METAL_HOURS: SessionHours = { open: 18 * 60, close: 17 * 60 }

/** A symbol with its own path, or a product of other symbols' paths. */
type MockPath =
  | { anchor: number; volatility: number; usdBeta: number }
  | { legs: readonly (readonly [ticker: string, power: 1 | -1])[] }

/** Mock-only parameters of a symbol. */
export interface MockSymbolSpec extends MarketSymbol {
  path: MockPath
  hours: SessionHours
  /** Typical ticks per trading day. */
  dailyTicks: number
  /** Typical spread in pips. */
  spreadPips: number
  /** No bars exist before this time. */
  listed: number
}

const hhmm = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}`
const sessionOf = (hours: SessionHours): string => `${hhmm(hours.open)}-${hhmm(hours.close)}:23456`

function pair(ticker: string, description: string, path: MockPath, dailyTicks: number, spreadPips: number): MockSymbolSpec {
  const jpy = ticker.endsWith('JPY')
  return {
    ticker, description, exchange: 'FX', assetClass: 'forex', group: 'forex', baseCurrency: ticker.slice(0, 3), currency: ticker.slice(3),
    decimals: jpy ? 3 : 5, tickSize: jpy ? 0.001 : 0.00001, pip: jpy ? 0.01 : 0.0001, contractSize: 100_000, minLots: 0.01, maxLots: 100, lotStep: 0.01,
    session: sessionOf(FX_HOURS), timezone: 'America/New_York', path, hours: FX_HOURS, dailyTicks, spreadPips, listed: LISTED,
  }
}

/** Symbols of the mock provider. */
export const MOCK_SYMBOLS: readonly MockSymbolSpec[] = Object.freeze([
  pair('EURUSD', 'Euro / U.S. Dollar', { anchor: 1.16, volatility: 0.003, usdBeta: -1 }, 160_000, 0.8),
  pair('GBPUSD', 'British Pound / U.S. Dollar', { anchor: 1.315, volatility: 0.004, usdBeta: -0.9 }, 140_000, 1.2),
  pair('USDJPY', 'U.S. Dollar / Japanese Yen', { anchor: 152.5, volatility: 0.005, usdBeta: 0.9 }, 150_000, 1),
  pair('AUDUSD', 'Australian Dollar / U.S. Dollar', { anchor: 0.655, volatility: 0.0055, usdBeta: -0.8 }, 90_000, 1),
  pair('USDCHF', 'U.S. Dollar / Swiss Franc', { anchor: 0.8, volatility: 0.003, usdBeta: 1 }, 70_000, 1.4),
  pair('USDCAD', 'U.S. Dollar / Canadian Dollar', { anchor: 1.4, volatility: 0.003, usdBeta: 0.7 }, 80_000, 1.6),
  pair('NZDUSD', 'New Zealand Dollar / U.S. Dollar', { anchor: 0.575, volatility: 0.0058, usdBeta: -0.8 }, 60_000, 1.6),
  pair('EURJPY', 'Euro / Japanese Yen', { legs: [['EURUSD', 1], ['USDJPY', 1]] }, 110_000, 1.6),
  pair('GBPJPY', 'British Pound / Japanese Yen', { legs: [['GBPUSD', 1], ['USDJPY', 1]] }, 130_000, 2.4),
  pair('EURGBP', 'Euro / British Pound', { legs: [['EURUSD', 1], ['GBPUSD', -1]] }, 60_000, 1.2),
  {
    ticker: 'XAUUSD', description: 'Gold Spot / U.S. Dollar', exchange: 'FX', assetClass: 'metal', group: 'metal', baseCurrency: 'XAU', currency: 'USD',
    decimals: 2, tickSize: 0.01, pip: 0.1, contractSize: 100, minLots: 0.01, maxLots: 50, lotStep: 0.01,
    session: sessionOf(METAL_HOURS), timezone: 'America/New_York',
    path: { anchor: 4_000, volatility: 0.0095, usdBeta: -0.5 }, hours: METAL_HOURS, dailyTicks: 220_000, spreadPips: 2.5, listed: LISTED,
  },
])

// ---------------------------------------------------------------------------------------------
// Price paths

function hashString(text: string): number {
  let h = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    h ^= text.charCodeAt(index)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Uniform [0, 1) value of an integer lattice point. */
function lattice(seed: number, n: number): number {
  let h = seed ^ Math.imul(n | 0, 0x9e3779b1) ^ Math.imul(Math.floor(n / 4_294_967_296) | 0, 0x85ebca77)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  h ^= h >>> 16
  return (h >>> 0) / 4_294_967_296
}

function valueNoise(seed: number, x: number): number {
  const i = Math.floor(x)
  const f = x - i
  const a = lattice(seed, i) * 2 - 1
  const b = lattice(seed, i + 1) * 2 - 1
  return a + (b - a) * f * f * (3 - 2 * f)
}

/** Noise periods from a year down to 15 s; amplitudes scale with the square root of the period. */
const OCTAVES = [365 * DAY, 89 * DAY, 21 * DAY, 5 * DAY, DAY, 4 * HOUR, HOUR, 15 * MINUTE, 4 * MINUTE, MINUTE, 15_000]
const AMPLITUDES = OCTAVES.map(period => Math.sqrt(period / DAY))
const USD_SEED = hashString('USD')
const USD_VOLATILITY = 0.0035
const WICK_SALT = 0x27d4eb2f
const VOLUME_SALT = 0x5bd1e995
const SPREAD_SALT = 0x68e31da4

/** Daily log-return noise of one seed, before scaling by its volatility. */
function noise(seed: number, time: number): number {
  let sum = 0
  for (let index = 0; index < OCTAVES.length; index++) sum += AMPLITUDES[index]! * valueNoise(seed + index * 0x9e37, time / OCTAVES[index]!)
  return sum
}

/** Log-amplitude of the octaves a sampling step cannot resolve, per unit volatility. */
function unresolved(step: number): number {
  let sum = 0
  for (let index = 0; index < OCTAVES.length; index++) if (OCTAVES[index]! < 2 * step) sum += AMPLITUDES[index]!
  return sum
}

interface PricedSymbol {
  spec: MockSymbolSpec
  seed: number
  factor: number
  calendar: Calendar
  /** Daily log-return scale. */
  volatility: number
  /** Trading time per trading day. */
  dayLength: number
  logPrice(time: number): number
}

const usdAtAnchor = noise(USD_SEED, PRICE_ANCHOR)

function pricePaths(specs: readonly MockSymbolSpec[]): Map<string, PricedSymbol> {
  const result = new Map<string, PricedSymbol>()
  const build = (spec: MockSymbolSpec): PricedSymbol => {
    const existing = result.get(spec.ticker)
    if (existing !== undefined) return existing
    const seed = hashString(spec.ticker)
    const path = spec.path
    let logPrice: (time: number) => number
    let volatility: number
    if ('legs' in path) {
      const legs = path.legs.map(([ticker, power]) => {
        const leg = specs.find(candidate => candidate.ticker === ticker)
        if (leg === undefined) throw new Error(`mock cross ${spec.ticker} has no leg ${ticker}`)
        return [build(leg), power] as const
      })
      logPrice = time => legs.reduce((sum, [leg, power]) => sum + power * leg.logPrice(time), 0)
      volatility = Math.sqrt(legs.reduce((sum, [leg]) => sum + leg.volatility ** 2, 0))
    } else {
      const offset = Math.log(path.anchor) - path.usdBeta * USD_VOLATILITY * usdAtAnchor - path.volatility * noise(seed, PRICE_ANCHOR)
      logPrice = time => offset + path.usdBeta * USD_VOLATILITY * noise(USD_SEED, time) + path.volatility * noise(seed, time)
      volatility = Math.hypot(path.volatility, path.usdBeta * USD_VOLATILITY)
    }
    const symbol: PricedSymbol = {
      spec, seed, factor: 10 ** spec.decimals, calendar: sessionCalendar(spec.hours), volatility,
      dayLength: (spec.hours.close - spec.hours.open) * MINUTE + DAY, logPrice,
    }
    result.set(spec.ticker, symbol)
    return symbol
  }
  for (const spec of specs) build(spec)
  return result
}

const priceAt = (symbol: PricedSymbol, time: number): number => Math.exp(symbol.logPrice(time))
const round = (symbol: PricedSymbol, value: number): number => Math.round(value * symbol.factor) / symbol.factor

// ---------------------------------------------------------------------------------------------
// Trading calendar

/** One bar's label time and the trading intervals, ascending, its prices come from. */
interface Slot {
  time: number
  segments: readonly (readonly [number, number])[]
}

interface Calendar {
  /** The slot containing a trading moment; undefined outside trading hours. */
  slotAt(time: number, resolution: Resolution): Slot | undefined
  /** The latest trading moment at or before `time`. */
  lastTradingTime(time: number): number
}

const INTRADAY: Partial<Record<Resolution, number>> = {
  1: MINUTE, 3: 3 * MINUTE, 5: 5 * MINUTE, 15: 15 * MINUTE, 30: 30 * MINUTE, 60: HOUR, 120: 2 * HOUR, 240: 4 * HOUR,
}
const dayOfWeek = (dayStart: number): number => (Math.floor(dayStart / DAY) + 4) % 7
const isWeekend = (dayStart: number): boolean => { const dow = dayOfWeek(dayStart); return dow === 0 || dow === 6 }

/** 00:00 UTC of the n-th (1-based) Sunday of a month. */
function nthSunday(year: number, month: number, n: number): number {
  const first = Date.UTC(year, month, 1)
  return first + ((7 - new Date(first).getUTCDay()) % 7 + (n - 1) * 7) * DAY
}

/** America/New_York offset from UTC at an instant under the US rules in force since 2007, in ms. */
export function newYorkOffset(time: number): number {
  const year = new Date(time).getUTCFullYear()
  // Daylight time: from 02:00 EST on the second Sunday of March to 02:00 EDT on the first Sunday of November.
  const start = nthSunday(year, 2, 2) + 7 * HOUR
  const end = nthSunday(year, 10, 1) + 6 * HOUR
  return time >= start && time < end ? -4 * HOUR : -5 * HOUR
}

/** The instant of a New York wall-clock time, given as ms since the epoch read as New York time. */
const fromNewYork = (wall: number): number => wall - newYorkOffset(wall + 5 * HOUR)

function sessionCalendar(hours: SessionHours): Calendar {
  /** Bounds of the trading day labelled `day` (00:00 UTC of its date). */
  const bounds = (day: number): readonly [number, number] => [fromNewYork(day - DAY + hours.open * MINUTE), fromNewYork(day + hours.close * MINUTE)]
  /** The trading day whose hours would contain an instant, weekends included. */
  const tradingDay = (time: number): number => {
    const wall = time + newYorkOffset(time)
    const date = Math.floor(wall / DAY) * DAY
    return wall - date >= hours.open * MINUTE ? date + DAY : date
  }
  return {
    slotAt(time, resolution) {
      const day = tradingDay(time)
      if (isWeekend(day)) return undefined
      const [open, close] = bounds(day)
      if (time < open || time >= close) return undefined
      const step = INTRADAY[resolution]
      if (step !== undefined) {
        // Intraday bars align to the session open, as the chart library aligns them.
        const start = open + Math.floor((time - open) / step) * step
        return { time: start, segments: [[start, Math.min(start + step, close)]] }
      }
      if (resolution === '1D') return { time: day, segments: [[open, close]] }
      const monday = day - ((dayOfWeek(day) + 6) % 7) * DAY
      return { time: monday, segments: [0, 1, 2, 3, 4].map(index => bounds(monday + index * DAY)) }
    },
    lastTradingTime(time) {
      let day = tradingDay(time)
      for (let attempt = 0; attempt < 8; attempt++, day -= DAY) {
        if (isWeekend(day)) continue
        const [open, close] = bounds(day)
        if (time >= close) return close - 1
        if (time >= open) return time
      }
      return time
    },
  }
}

function slotBefore(calendar: Calendar, slot: Slot, resolution: Resolution): Slot | undefined {
  const first = slot.segments[0]
  return first === undefined ? undefined : calendar.slotAt(calendar.lastTradingTime(first[0] - 1), resolution)
}

// ---------------------------------------------------------------------------------------------
// Bars

/** Relative tick activity by UTC hour: quiet in Asia, busiest in the London and New York overlap. */
const ACTIVITY = [0.5, 0.55, 0.6, 0.6, 0.55, 0.6, 0.75, 1, 1.25, 1.3, 1.2, 1.15, 1.35, 1.6, 1.7, 1.55, 1.3, 1, 0.8, 0.7, 0.6, 0.5, 0.45, 0.45]
const MEAN_ACTIVITY = ACTIVITY.reduce((sum, value) => sum + value, 0) / ACTIVITY.length

function activity(start: number, end: number): number {
  if (end - start >= 6 * HOUR) return MEAN_ACTIVITY
  const hour = Math.floor(((start + end) / 2 % DAY) / HOUR)
  return ACTIVITY[hour] ?? MEAN_ACTIVITY
}

/**
 * The bar of a slot as seen at `now`: open at the first trading moment, close at the latest one,
 * high and low from a fixed sampling grid (so a live bar only gains points) widened by a wick for
 * the octaves the grid cannot resolve, and tick volume proportional to elapsed trading time.
 */
function candleFor(symbol: PricedSymbol, slot: Slot, now: number): Candle | undefined {
  const first = slot.segments[0]
  if (first === undefined || first[0] > now) return undefined
  const openRaw = priceAt(symbol, first[0])
  let closeTime = first[0]
  let high = openRaw
  let low = openRaw
  let wick = 0
  let volume = 0
  for (const [start, end] of slot.segments) {
    if (start > now) break
    const length = end - start
    const samples = Math.min(96, Math.max(12, Math.ceil(length / MINUTE)))
    const step = length / samples
    for (let index = 1; index < samples; index++) {
      const at = start + step * index
      if (at > now) break
      const value = priceAt(symbol, at)
      if (value > high) high = value
      if (value < low) low = value
    }
    const elapsed = Math.min(end, now) - start
    closeTime = start + elapsed
    wick = Math.max(wick, symbol.volatility * unresolved(step) * Math.sqrt(elapsed / length))
    const minute = Math.floor(start / MINUTE)
    const weight = 0.4 + 0.6 * lattice(symbol.seed ^ VOLUME_SALT, Math.floor(minute / 60)) + 0.5 * lattice(symbol.seed ^ VOLUME_SALT, minute)
    volume += symbol.spec.dailyTicks * (elapsed / symbol.dayLength) * weight * activity(start, end)
  }
  const closeRaw = priceAt(symbol, closeTime)
  high = Math.max(high, closeRaw)
  low = Math.min(low, closeRaw)
  const key = Math.floor(slot.time / MINUTE)
  high *= Math.exp(wick * (0.2 + 0.8 * lattice(symbol.seed ^ WICK_SALT, key)))
  low *= Math.exp(-wick * (0.2 + 0.8 * lattice(symbol.seed ^ WICK_SALT, key + 1)))
  return {
    time: slot.time,
    open: round(symbol, openRaw),
    high: round(symbol, high),
    low: round(symbol, low),
    close: round(symbol, closeRaw),
    volume: Math.round(volume),
  }
}

/** Options of {@link createMockMarketData}. */
export interface MockMarketDataOptions {
  /** Clock; defaults to `Date.now`. */
  now?: () => number
  /** Live update period in ms; 0 disables the timer and leaves updates to {@link MockMarketData.tick}. */
  interval?: number
}

interface BarSubscription { symbol: PricedSymbol; resolution: Resolution; onBar(bar: Candle): void; last?: Candle }
interface QuoteSubscription { tickers: readonly string[]; onQuote(quote: Quote): void; sent: Map<string, number> }

/** The demo source: always ready and live, its watchlist every symbol. */
const DEMO_SOURCE: MarketSource = Object.freeze({ key: 'demo', state: 'ready', live: true, watch: Object.freeze(MOCK_SYMBOLS.map(symbol => symbol.ticker)) })

/** The mock provider with a manual clock step. */
export interface MockMarketData extends MarketDataProvider {
  /** Emit the live bars and quotes of the current clock. */
  tick(): void
  /** Drop every subscription and stop the timer. */
  dispose(): void
}

/**
 * Create the deterministic mock provider.
 * @returns the provider; its timer runs only while something is subscribed.
 */
export function createMockMarketData(options: MockMarketDataOptions = {}): MockMarketData {
  const now = options.now ?? Date.now
  const interval = options.interval ?? 1000
  const symbols = pricePaths(MOCK_SYMBOLS)
  const bars = new Set<BarSubscription>()
  const quotes = new Set<QuoteSubscription>()
  /** Running daily range per ticker, so a quote's high and low never retreat within a trading day. */
  const ranges = new Map<string, { time: number; high: number; low: number }>()
  let timer: ReturnType<typeof setInterval> | undefined

  const sync = (): void => {
    const wanted = interval > 0 && (bars.size > 0 || quotes.size > 0)
    if (wanted && timer === undefined) timer = setInterval(() => { provider.tick() }, interval)
    if (!wanted && timer !== undefined) { clearInterval(timer); timer = undefined }
  }

  const quoteOf = (symbol: PricedSymbol, at: number): Quote => {
    const lastTime = symbol.calendar.lastTradingTime(at)
    const mid = priceAt(symbol, lastTime)
    const last = round(symbol, mid)
    const daySlot = symbol.calendar.slotAt(lastTime, '1D')
    const day = daySlot === undefined ? undefined : candleFor(symbol, daySlot, at)
    const previousSlot = daySlot === undefined ? undefined : slotBefore(symbol.calendar, daySlot, '1D')
    const previousEnd = previousSlot?.segments.at(-1)?.[1]
    const prevClose = previousEnd === undefined ? day?.open ?? last : round(symbol, priceAt(symbol, previousEnd))
    let high = Math.max(day?.high ?? last, last)
    let low = Math.min(day?.low ?? last, last)
    const range = ranges.get(symbol.spec.ticker)
    if (day !== undefined && range?.time === day.time) {
      high = Math.max(high, range.high)
      low = Math.min(low, range.low)
    }
    if (day !== undefined) ranges.set(symbol.spec.ticker, { time: day.time, high, low })
    // Spreads flicker and widen for ten minutes after the daily rollover.
    const sessionOpen = daySlot?.segments[0]?.[0] ?? lastTime
    const widen = lastTime - sessionOpen < 10 * MINUTE ? 3 : 1
    const half = symbol.spec.spreadPips * symbol.spec.pip / 2 * widen * (1 + 0.5 * lattice(symbol.seed ^ SPREAD_SALT, Math.floor(lastTime / 10_000)))
    const tick = 1 / symbol.factor
    const bid = round(symbol, mid - half)
    const ask = Math.max(round(symbol, mid + half), round(symbol, bid + tick))
    return {
      ticker: symbol.spec.ticker, last, bid, ask,
      open: day?.open ?? last, high, low, prevClose,
      change: round(symbol, last - prevClose),
      changePercent: prevClose === 0 ? 0 : (last - prevClose) / prevClose * 100,
      volume: day?.volume ?? 0, time: lastTime, marketOpen: lastTime === at,
    }
  }

  const provider: MockMarketData = {
    source: () => DEMO_SOURCE,
    subscribeSource: () => () => {},
    symbols: () => MOCK_SYMBOLS,
    symbol: ticker => symbols.get(ticker)?.spec,
    search(query, assetClass) {
      const needle = query.trim().toLowerCase()
      return MOCK_SYMBOLS.filter(spec => (assetClass === undefined || spec.assetClass === assetClass)
        && (needle === '' || spec.ticker.toLowerCase().includes(needle) || spec.description.toLowerCase().includes(needle)))
    },
    async history(request: HistoryRequest): Promise<HistoryResult> {
      const symbol = symbols.get(request.ticker)
      if (symbol === undefined) return { bars: [], noData: true }
      const at = now()
      const listed = symbol.spec.listed
      const to = Math.min(request.to, at + 1)
      // At least one bar, so a range that falls on a closed market still pages further back.
      const wanted = Math.max(1, request.countBack)
      const result: Candle[] = []
      let slot = to <= listed ? undefined : symbol.calendar.slotAt(symbol.calendar.lastTradingTime(to - 1), request.resolution)
      for (let step = 0; slot !== undefined && step < MAX_HISTORY_STEPS; step++) {
        if (slot.time < listed || (result.length >= wanted && slot.time < request.from)) break
        // A daily or weekly bar's label follows its session open, so the slot at `to` may already be loaded.
        if (slot.time < to) {
          const candle = candleFor(symbol, slot, at)
          if (candle !== undefined) result.push(candle)
        }
        slot = slotBefore(symbol.calendar, slot, request.resolution)
      }
      result.reverse()
      return { bars: result, noData: result.length === 0 }
    },
    subscribeBars(ticker, resolution, onBar) {
      const symbol = symbols.get(ticker)
      if (symbol === undefined) return () => {}
      const subscription: BarSubscription = { symbol, resolution, onBar }
      bars.add(subscription)
      sync()
      return () => { bars.delete(subscription); sync() }
    },
    quote(ticker) {
      const symbol = symbols.get(ticker)
      return symbol === undefined ? undefined : quoteOf(symbol, now())
    },
    subscribeQuotes(tickers, onQuote) {
      const subscription: QuoteSubscription = { tickers: [...tickers], onQuote, sent: new Map() }
      quotes.add(subscription)
      sync()
      return () => { quotes.delete(subscription); sync() }
    },
    tick() {
      const at = now()
      for (const subscription of [...bars]) {
        const calendar = subscription.symbol.calendar
        // A closed market settles its last bar once, then stays quiet.
        const slot = calendar.slotAt(calendar.lastTradingTime(at), subscription.resolution)
        let bar = slot === undefined ? undefined : candleFor(subscription.symbol, slot, at)
        if (bar === undefined) continue
        const previous = subscription.last
        if (previous !== undefined) {
          if (bar.time < previous.time) continue
          if (previous.time === bar.time) {
            bar = { ...bar, high: Math.max(bar.high, previous.high), low: Math.min(bar.low, previous.low), volume: Math.max(bar.volume, previous.volume) }
            if (bar.close === previous.close && bar.high === previous.high && bar.low === previous.low && bar.volume === previous.volume) continue
          }
        }
        subscription.last = bar
        subscription.onBar(bar)
      }
      const cache = new Map<string, Quote>()
      for (const subscription of [...quotes]) {
        for (const ticker of subscription.tickers) {
          const symbol = symbols.get(ticker)
          if (symbol === undefined) continue
          let quote = cache.get(ticker)
          if (quote === undefined) { quote = quoteOf(symbol, at); cache.set(ticker, quote) }
          if (!quote.marketOpen && subscription.sent.get(ticker) === quote.time) continue
          subscription.sent.set(ticker, quote.time)
          subscription.onQuote(quote)
        }
      }
    },
    dispose() {
      bars.clear()
      quotes.clear()
      sync()
    },
  }
  return provider
}
