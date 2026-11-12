/**
 * What the renderer sends the MT5 bridge over IPC, validated before the bridge uses it. A
 * malformed value throws; a subscription beyond the caps keeps its first entries.
 */
import {
  MT5_MAX_BAR_STREAMS, MT5_MAX_HISTORY_BARS, MT5_MAX_QUOTES, MT5_TIMEFRAMES, type Mt5AccountKey, type Mt5BarStream,
  type Mt5HistoryBarsOptions, type Mt5HistoryBarsRequest, type Mt5Subscription, type Mt5Timeframe, type Mt5TradeInput,
} from './contract.ts'

const MAX_NAME = 128

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME
const isTimeframe = (value: unknown): value is Mt5Timeframe => typeof value === 'string' && (MT5_TIMEFRAMES as readonly string[]).includes(value)
const isTime = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
/** Lots and prices: finite and positive. */
const isAmount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0
/** A stop loss or take profit: a price, or null for none. */
const isLevel = (value: unknown): value is number | null => value === null || isAmount(value)
const isTicket = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,19}$/u.test(value)
const isAccount = (value: unknown): value is Mt5AccountKey => isRecord(value) && typeof value.login === 'string'
  && /^\d{1,20}$/u.test(value.login) && typeof value.server === 'string' && value.server.length > 0 && value.server.length <= MAX_NAME

function invalidTrade(): never {
  throw new Error('MT5 bridge: invalid trade request')
}

/** The page's subscriptions without duplicates, within `MT5_MAX_QUOTES` and `MT5_MAX_BAR_STREAMS`. */
export function parseSubscriptionInput(value: unknown): Mt5Subscription {
  if (!isRecord(value) || !Array.isArray(value.quotes) || !Array.isArray(value.bars)) throw new Error('MT5 bridge: invalid subscription')
  const quotes = new Set<string>()
  for (const symbol of value.quotes) {
    if (!isName(symbol)) throw new Error('MT5 bridge: invalid quote subscription')
    if (quotes.size < MT5_MAX_QUOTES) quotes.add(symbol)
  }
  const bars = new Map<string, Mt5BarStream>()
  for (const stream of value.bars) {
    if (!isRecord(stream) || !isName(stream.symbol) || !isTimeframe(stream.timeframe)) throw new Error('MT5 bridge: invalid bar subscription')
    const key = `${stream.symbol}\n${stream.timeframe}`
    if (bars.size < MT5_MAX_BAR_STREAMS && !bars.has(key)) bars.set(key, { symbol: stream.symbol, timeframe: stream.timeframe })
  }
  return { quotes: [...quotes], bars: [...bars.values()] }
}

export function parseHistoryBarsInput(value: unknown): Mt5HistoryBarsRequest {
  if (!isRecord(value) || !isName(value.symbol) || !isTimeframe(value.timeframe) || !isTime(value.to) || value.to === 0
    || typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 1 || value.count > MT5_MAX_HISTORY_BARS) {
    throw new Error('MT5 bridge: invalid history bars request')
  }
  return { symbol: value.symbol, timeframe: value.timeframe, to: value.to, count: value.count }
}

/** How a history request waits; absent means the defaults. */
export function parseHistoryBarsOptions(value: unknown): Mt5HistoryBarsOptions {
  if (value === undefined) return {}
  if (!isRecord(value) || (value.partial !== undefined && typeof value.partial !== 'boolean')) throw new Error('MT5 bridge: invalid history bars options')
  return value.partial === undefined ? {} : { partial: value.partial }
}

/** A time range [from, to) in Unix ms. */
export function parseHistoryRangeInput(value: unknown): { from: number; to: number } {
  if (!isRecord(value) || !isTime(value.from) || !isTime(value.to) || value.to <= value.from) throw new Error('MT5 bridge: invalid history range')
  return { from: value.from, to: value.to }
}

/** A symbol name. */
export function parseSymbolInput(value: unknown): string {
  if (!isName(value)) throw new Error('MT5 bridge: invalid symbol')
  return value
}

/** A trade request: a known type with exactly the fields that type takes, each in range. */
export function parseTradeInput(value: unknown): Mt5TradeInput {
  if (!isRecord(value)) invalidTrade()
  const { type, account: key, symbol, ticket, volume, price, sl, tp } = value
  if (!isAccount(key) || !isName(symbol)) invalidTrade()
  const account = { login: key.login, server: key.server }
  if (type === 'order.place') {
    const { side, orderType } = value
    if ((side !== 'buy' && side !== 'sell') || (orderType !== 'market' && orderType !== 'limit' && orderType !== 'stop') || !isAmount(volume)
      || !isLevel(price) || (orderType === 'market') !== (price === null) || !isLevel(sl) || !isLevel(tp)) invalidTrade()
    return { type, account, symbol, side, orderType, volume, price, sl, tp }
  }
  if (!isTicket(ticket)) invalidTrade()
  switch (type) {
    case 'position.close':
      if (!isAmount(volume)) invalidTrade()
      return { type, account, symbol, ticket, volume }
    case 'position.modify':
      if (!isLevel(sl) || !isLevel(tp)) invalidTrade()
      return { type, account, symbol, ticket, sl, tp }
    case 'order.modify':
      if (!isAmount(price) || !isLevel(sl) || !isLevel(tp)) invalidTrade()
      return { type, account, symbol, ticket, price, sl, tp }
    case 'order.cancel':
      return { type, account, symbol, ticket }
    default:
      return invalidTrade()
  }
}
