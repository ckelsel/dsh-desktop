/**
 * Wire format of the MT5 bridge, protocol v1 (`mt5/PROTOCOL.md`): one JSON object per line.
 * Requests carry an `id` that the response repeats; events have none. Every frame and payload the
 * EA sends is validated here before the bridge uses it. Payload fields are snake_case on the wire
 * and camelCase in the Desktop.
 */
import {
  MT5_TIMEFRAMES, type Mt5Account, type Mt5Bar, type Mt5BarData, type Mt5Deal, type Mt5HistoryOrder, type Mt5Order,
  type Mt5OrderType, type Mt5PendingType, type Mt5Position, type Mt5Symbol, type Mt5TerminalStatus, type Mt5Tick, type Mt5TradeEvent,
} from './contract.ts'

export const MT5_PROTOCOL_VERSION = 1
/** Longest frame either side accepts, newline excluded. */
export const MT5_MAX_LINE_BYTES = 2 * 1024 * 1024

export type Mt5Payload = Record<string, unknown>

/** Error object of a failed response. */
export interface Mt5WireError {
  code: string
  message: string
  /** MT5 `TRADE_RETCODE_*`, when the terminal produced one. */
  retcode?: number
}

export type Mt5Frame =
  | { kind: 'request'; id: string; type: string; payload: Mt5Payload }
  | { kind: 'response'; id: string; ok: true; payload: Mt5Payload }
  | { kind: 'response'; id: string; ok: false; error: Mt5WireError }
  | { kind: 'event'; type: string; payload: Mt5Payload }

/** The EA's opening request. */
export interface Mt5Hello {
  token: string
  protocol: number
  eaVersion: string
  terminalBuild: number
  terminalName: string
  login: string
  server: string
}

/** A frame or payload that breaks the protocol. */
export class Mt5ProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Mt5ProtocolError'
  }
}

const TYPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u
const MAX_ID = 128
const MAX_TYPE = 64
const MAX_TEXT = 1024
/** Symbol names; MT5 allows 31 characters, custom symbols a little more. */
const MAX_NAME = 128
/** Open-ended MT5 enum words, such as deal types and reasons. */
const MAX_WORD = 64

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Parse one line into a frame.
 * @throws Mt5ProtocolError when the line is not a valid v1 frame.
 */
export function parseFrame(line: string): Mt5Frame {
  let value: unknown
  try { value = JSON.parse(line) } catch { throw new Mt5ProtocolError('frame is not JSON') }
  if (!isRecord(value)) throw new Mt5ProtocolError('frame is not an object')
  if (value.v !== MT5_PROTOCOL_VERSION) throw new Mt5ProtocolError(`unsupported frame version ${JSON.stringify(value.v)}`)
  const { type, id } = value
  if (typeof type !== 'string' || type.length === 0 || type.length > MAX_TYPE) throw new Mt5ProtocolError('frame type is missing')
  if (id !== undefined && (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID)) throw new Mt5ProtocolError('frame id is invalid')
  if (type === 'response') {
    if (id === undefined) throw new Mt5ProtocolError('response without id')
    if (value.ok === true) {
      if (value.payload !== undefined && !isRecord(value.payload)) throw new Mt5ProtocolError('response payload is not an object')
      return { kind: 'response', id, ok: true, payload: value.payload ?? {} }
    }
    if (value.ok === false) return { kind: 'response', id, ok: false, error: parseWireError(value.error) }
    throw new Mt5ProtocolError('response without ok')
  }
  if (!TYPE.test(type)) throw new Mt5ProtocolError(`invalid frame type ${type}`)
  const payload = value.payload ?? {}
  if (!isRecord(payload)) throw new Mt5ProtocolError('payload is not an object')
  return id === undefined ? { kind: 'event', type, payload } : { kind: 'request', id, type, payload }
}

function parseWireError(value: unknown): Mt5WireError {
  if (!isRecord(value)) throw new Mt5ProtocolError('failed response without error')
  const code = typeof value.code === 'string' && value.code.length > 0 ? value.code.slice(0, MAX_TYPE) : 'unknown'
  const message = typeof value.message === 'string' ? value.message.slice(0, MAX_TEXT) : ''
  const retcode = typeof value.retcode === 'number' && Number.isSafeInteger(value.retcode) ? value.retcode : undefined
  return retcode === undefined ? { code, message } : { code, message, retcode }
}

export const requestFrame = (id: string, type: string, payload: Mt5Payload = {}): object => ({ v: MT5_PROTOCOL_VERSION, id, type, payload })
export const eventFrame = (type: string, payload: Mt5Payload = {}): object => ({ v: MT5_PROTOCOL_VERSION, type, payload })
export const okFrame = (id: string, payload: Mt5Payload = {}): object => ({ v: MT5_PROTOCOL_VERSION, id, type: 'response', ok: true, payload })
export const errorFrame = (id: string, error: Mt5WireError): object => ({ v: MT5_PROTOCOL_VERSION, id, type: 'response', ok: false, error })

/** Reads the payload fields of one message, naming the message in every error. */
class Fields {
  constructor(private readonly payload: Mt5Payload, private readonly message: string) {}
  private fail(key: string, expected: string): never {
    throw new Mt5ProtocolError(`${this.message}.${key} must be ${expected}`)
  }
  text(key: string): string {
    const value = this.payload[key]
    if (typeof value !== 'string' || value.length > MAX_TEXT) this.fail(key, 'a string')
    return value
  }
  /** Identifiers such as logins and tickets: strings on the wire, integers accepted. */
  id(key: string): string {
    const value = this.payload[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value)
    if (typeof value !== 'string' || !/^\d{1,20}$/u.test(value)) this.fail(key, 'a decimal identifier')
    return value
  }
  number(key: string): number {
    const value = this.payload[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) this.fail(key, 'a finite number')
    return value
  }
  integer(key: string): number {
    const value = this.number(key)
    if (!Number.isSafeInteger(value)) this.fail(key, 'an integer')
    return value
  }
  boolean(key: string): boolean {
    const value = this.payload[key]
    if (typeof value !== 'boolean') this.fail(key, 'a boolean')
    return value
  }
  choice<T extends string>(key: string, choices: readonly T[]): T {
    const value = this.payload[key]
    if (typeof value !== 'string' || !(choices as readonly string[]).includes(value)) this.fail(key, `one of ${choices.join(', ')}`)
    return value as T
  }
  optionalNumber(key: string): number | null {
    return this.payload[key] === undefined || this.payload[key] === null ? null : this.number(key)
  }
  optionalInteger(key: string): number | null {
    return this.payload[key] === undefined || this.payload[key] === null ? null : this.integer(key)
  }
  /** A ticket that MT5 reports as 0 when there is none. */
  optionalId(key: string): string | null {
    const value = this.payload[key]
    if (value === undefined || value === null) return null
    const id = this.id(key)
    return /^0+$/u.test(id) ? null : id
  }
  /** A symbol name. */
  name(key: string): string {
    const value = this.payload[key]
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME) this.fail(key, 'a symbol name')
    return value
  }
  /** An MT5 enum value without its prefix; the set is open, so any short word passes. */
  word(key: string): string {
    const value = this.payload[key]
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_WORD) this.fail(key, 'an MT5 enum word')
    return value
  }
  list(key: string): readonly unknown[] {
    const value = this.payload[key]
    if (!Array.isArray(value)) this.fail(key, 'an array')
    return value
  }
  names(key: string): string[] {
    const names: string[] = []
    for (const value of this.list(key)) {
      if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME) this.fail(key, 'an array of symbol names')
      names.push(value)
    }
    return names
  }
}

/** The valid items of a list, and how many invalid ones were left out. */
export interface Mt5Parsed<T> {
  items: T[]
  skipped: number
  /** Why the first left-out item was invalid. */
  firstError: string | null
}

function parseList<T>(values: readonly unknown[], parse: (item: Mt5Payload) => T): Mt5Parsed<T> {
  const items: T[] = []
  let skipped = 0
  let firstError: string | null = null
  for (const value of values) {
    try {
      if (!isRecord(value)) throw new Mt5ProtocolError('a list item is not an object')
      items.push(parse(value))
    } catch (error) {
      if (!(error instanceof Mt5ProtocolError)) throw error
      skipped++
      firstError ??= error.message
    }
  }
  return { items, skipped, firstError }
}

/**
 * Compare dotted EA versions such as `1.1.0` numerically; a missing or non-numeric part counts as 0.
 * @returns negative, zero or positive, like a sort comparator.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (version: string): number[] => version.split('.').map(part => /^\d+$/u.test(part) ? Number(part) : 0)
  const left = parts(a)
  const right = parts(b)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

/** Validate `system.hello`. */
export function parseHello(payload: Mt5Payload): Mt5Hello {
  const fields = new Fields(payload, 'system.hello')
  return {
    token: fields.text('token'),
    protocol: fields.integer('protocol'),
    eaVersion: fields.text('ea_version'),
    terminalBuild: fields.integer('terminal_build'),
    terminalName: fields.text('terminal_name'),
    login: fields.id('login'),
    server: fields.text('server'),
  }
}

/** Validate `system.status`. */
export function parseTerminalStatus(payload: Mt5Payload): Mt5TerminalStatus {
  const fields = new Fields(payload, 'system.status')
  return {
    connected: fields.boolean('terminal_connected'),
    tradeAllowed: fields.boolean('terminal_trade_allowed'),
    eaTradeAllowed: fields.boolean('ea_trade_allowed'),
    build: fields.integer('terminal_build'),
    name: fields.text('terminal_name'),
    company: fields.text('terminal_company'),
    pingMs: fields.optionalNumber('ping_ms'),
    serverUtcOffset: fields.integer('server_utc_offset'),
  }
}

/** Validate `account.snapshot`. */
export function parseAccount(payload: Mt5Payload): Mt5Account {
  const fields = new Fields(payload, 'account.snapshot')
  const margin = fields.number('margin')
  const level = fields.number('margin_level')
  return {
    login: fields.id('login'),
    name: fields.text('name'),
    server: fields.text('server'),
    company: fields.text('company'),
    currency: fields.text('currency'),
    currencyDigits: fields.integer('currency_digits'),
    leverage: fields.integer('leverage'),
    tradeMode: fields.choice('trade_mode', ['demo', 'contest', 'real']),
    marginMode: fields.choice('margin_mode', ['netting', 'exchange', 'hedging']),
    tradeAllowed: fields.boolean('trade_allowed'),
    tradeExpert: fields.boolean('trade_expert'),
    limitOrders: fields.integer('limit_orders'),
    balance: fields.number('balance'),
    credit: fields.number('credit'),
    profit: fields.number('profit'),
    equity: fields.number('equity'),
    margin,
    marginFree: fields.number('margin_free'),
    // MT5 reports 0 while no margin is in use.
    marginLevel: margin > 0 ? level : null,
    marginCall: fields.number('margin_so_call'),
    stopOut: fields.number('margin_so_so'),
    marginSoMode: fields.choice('margin_so_mode', ['percent', 'money']),
  }
}

const TRADE_MODES = ['disabled', 'long_only', 'short_only', 'close_only', 'full'] as const
const PENDING_TYPES: readonly Mt5PendingType[] = ['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit']
const ORDER_TYPES: readonly Mt5OrderType[] = ['buy', 'sell', ...PENDING_TYPES, 'close_by']
const DEAL_ENTRIES = ['in', 'out', 'inout', 'out_by'] as const

function parseSymbol(item: Mt5Payload): Mt5Symbol {
  const fields = new Fields(item, 'symbols.list symbol')
  const digits = fields.integer('digits')
  if (digits < 0 || digits > 10) throw new Mt5ProtocolError('symbols.list symbol.digits must be 0 to 10')
  const point = fields.number('point')
  if (point <= 0) throw new Mt5ProtocolError('symbols.list symbol.point must be positive')
  const tickSize = fields.number('tick_size')
  return {
    name: fields.name('name'),
    description: fields.text('description'),
    path: fields.text('path'),
    currencyBase: fields.text('currency_base'),
    currencyProfit: fields.text('currency_profit'),
    currencyMargin: fields.text('currency_margin'),
    digits,
    point,
    // Some symbols report no tick size; their prices move by points.
    tickSize: tickSize > 0 ? tickSize : point,
    contractSize: fields.number('contract_size'),
    volumeMin: fields.number('volume_min'),
    volumeMax: fields.number('volume_max'),
    volumeStep: fields.number('volume_step'),
    tradeMode: fields.choice('trade_mode', TRADE_MODES),
    calcMode: fields.word('calc_mode'),
    sector: fields.word('sector'),
    selected: fields.boolean('selected'),
  }
}

/** One page of `symbols.list`. */
export interface Mt5SymbolsPage {
  /** Symbols on the server, across all pages. */
  total: number
  symbols: Mt5Parsed<Mt5Symbol>
  /** Market Watch, in window order; on the first page only. */
  watch: string[] | null
}

/** Validate a `symbols.list` page. */
export function parseSymbolsPage(payload: Mt5Payload): Mt5SymbolsPage {
  const fields = new Fields(payload, 'symbols.list')
  const total = fields.integer('total')
  if (total < 0) throw new Mt5ProtocolError('symbols.list.total must not be negative')
  return {
    total,
    symbols: parseList(fields.list('symbols'), parseSymbol),
    watch: payload.watch === undefined ? null : fields.names('watch'),
  }
}

/** Validate a `market.subscribe` answer: the symbols the terminal does not have. */
export function parseSubscribeAnswer(payload: Mt5Payload): string[] {
  return new Fields(payload, 'market.subscribe').names('unknown')
}

function parseTick(item: Mt5Payload): Mt5Tick {
  const fields = new Fields(item, 'market.tick tick')
  return {
    symbol: fields.name('symbol'),
    time: fields.integer('time'),
    bid: fields.number('bid'),
    ask: fields.number('ask'),
    dayOpen: fields.optionalNumber('day_open'),
    dayHigh: fields.optionalNumber('day_high'),
    dayLow: fields.optionalNumber('day_low'),
    prevClose: fields.optionalNumber('prev_close'),
    dayVolume: fields.optionalInteger('day_volume'),
    sessionOpen: fields.boolean('session_open'),
  }
}

/** Validate a `market.tick` event. */
export function parseTicks(payload: Mt5Payload): Mt5Parsed<Mt5Tick> {
  return parseList(new Fields(payload, 'market.tick').list('ticks'), parseTick)
}

function parseBar(item: Mt5Payload): Mt5Bar {
  const fields = new Fields(item, 'market.bar bar')
  return {
    symbol: fields.name('symbol'),
    timeframe: fields.choice('timeframe', MT5_TIMEFRAMES),
    time: fields.integer('time'),
    open: fields.number('open'),
    high: fields.number('high'),
    low: fields.number('low'),
    close: fields.number('close'),
    volume: fields.number('volume'),
  }
}

/** Validate a `market.bar` event. */
export function parseBars(payload: Mt5Payload): Mt5Parsed<Mt5Bar> {
  return parseList(new Fields(payload, 'market.bar').list('bars'), parseBar)
}

/**
 * A `market.history` answer: bars, or `pending` while the terminal is still loading them.
 * `complete` is false when a partial request got bars while older ones are still downloading.
 */
export type Mt5HistoryAnswer =
  | { pending: true }
  | { pending: false; bars: Mt5BarData[]; noData: boolean; complete: boolean; skipped: number }

/** Validate a `market.history` answer. Rows that are invalid or out of order are left out. */
export function parseHistoryAnswer(payload: Mt5Payload): Mt5HistoryAnswer {
  if (payload.pending === true) return { pending: true }
  const fields = new Fields(payload, 'market.history')
  const bars: Mt5BarData[] = []
  let skipped = 0
  for (const row of fields.list('bars')) {
    const valid = Array.isArray(row) && row.length === 6 && row.every(value => typeof value === 'number' && Number.isFinite(value))
      && Number.isSafeInteger(row[0])
    const time = valid ? row[0] as number : 0
    // TradingView needs strictly ascending bars.
    if (!valid || (bars.length > 0 && time <= bars.at(-1)!.time)) { skipped++; continue }
    const [, open, high, low, close, volume] = row as number[]
    bars.push({ time, open: open!, high: high!, low: low!, close: close!, volume: volume! })
  }
  // Answers to requests that are not partial are complete; EAs before `complete` answered only those.
  const complete = payload.complete === undefined ? true : fields.boolean('complete')
  return { pending: false, bars, noData: fields.boolean('no_data'), complete, skipped }
}

function parsePosition(item: Mt5Payload): Mt5Position {
  const fields = new Fields(item, 'positions.snapshot position')
  return {
    ticket: fields.id('ticket'),
    symbol: fields.name('symbol'),
    side: fields.choice('side', ['buy', 'sell']),
    volume: fields.number('volume'),
    priceOpen: fields.number('price_open'),
    sl: fields.optionalNumber('sl'),
    tp: fields.optionalNumber('tp'),
    priceCurrent: fields.number('price_current'),
    profit: fields.number('profit'),
    swap: fields.number('swap'),
    time: fields.integer('time'),
    comment: fields.text('comment'),
    magic: fields.number('magic'),
  }
}

/** Validate `positions.snapshot`. */
export function parsePositions(payload: Mt5Payload): Mt5Parsed<Mt5Position> {
  return parseList(new Fields(payload, 'positions.snapshot').list('positions'), parsePosition)
}

function parseOrder(item: Mt5Payload): Mt5Order {
  const fields = new Fields(item, 'orders.snapshot order')
  return {
    ticket: fields.id('ticket'),
    symbol: fields.name('symbol'),
    type: fields.choice('type', PENDING_TYPES),
    state: fields.word('state'),
    volume: fields.number('volume'),
    volumeInitial: fields.number('volume_initial'),
    price: fields.number('price'),
    stopLimit: fields.optionalNumber('stop_limit'),
    sl: fields.optionalNumber('sl'),
    tp: fields.optionalNumber('tp'),
    priceCurrent: fields.number('price_current'),
    time: fields.integer('time'),
    timeType: fields.word('time_type'),
    expiration: fields.optionalInteger('expiration'),
    comment: fields.text('comment'),
    magic: fields.number('magic'),
  }
}

/** Validate `orders.snapshot`. */
export function parseOrders(payload: Mt5Payload): Mt5Parsed<Mt5Order> {
  return parseList(new Fields(payload, 'orders.snapshot').list('orders'), parseOrder)
}

function parseHistoryOrder(item: Mt5Payload): Mt5HistoryOrder {
  const fields = new Fields(item, 'history.query order')
  return {
    ticket: fields.id('ticket'),
    symbol: fields.text('symbol'),
    type: fields.choice('type', ORDER_TYPES),
    state: fields.word('state'),
    volumeInitial: fields.number('volume_initial'),
    volumeCurrent: fields.number('volume_current'),
    price: fields.optionalNumber('price'),
    stopLimit: fields.optionalNumber('stop_limit'),
    sl: fields.optionalNumber('sl'),
    tp: fields.optionalNumber('tp'),
    timeSetup: fields.integer('time_setup'),
    timeDone: fields.integer('time_done'),
    position: fields.optionalId('position'),
    positionBy: fields.optionalId('position_by'),
    reason: fields.word('reason'),
    comment: fields.text('comment'),
    magic: fields.number('magic'),
  }
}

function parseDeal(item: Mt5Payload): Mt5Deal {
  const fields = new Fields(item, 'history.query deal')
  return {
    ticket: fields.id('ticket'),
    order: fields.optionalId('order'),
    position: fields.optionalId('position'),
    symbol: fields.text('symbol'),
    type: fields.word('type'),
    entry: fields.choice('entry', DEAL_ENTRIES),
    volume: fields.number('volume'),
    price: fields.number('price'),
    commission: fields.number('commission'),
    swap: fields.number('swap'),
    fee: fields.number('fee'),
    profit: fields.number('profit'),
    time: fields.integer('time'),
    reason: fields.word('reason'),
    comment: fields.text('comment'),
    magic: fields.number('magic'),
  }
}

/** A validated `history.query` answer. */
export interface Mt5HistoryQueryAnswer {
  orders: Mt5Parsed<Mt5HistoryOrder>
  deals: Mt5Parsed<Mt5Deal>
  truncated: boolean
}

/** Validate a `history.query` answer. */
export function parseTradeHistory(payload: Mt5Payload): Mt5HistoryQueryAnswer {
  const fields = new Fields(payload, 'history.query')
  return {
    orders: parseList(fields.list('orders'), parseHistoryOrder),
    deals: parseList(fields.list('deals'), parseDeal),
    truncated: fields.boolean('truncated'),
  }
}

/** Validate a `trade.event` event. */
export function parseTradeEvent(payload: Mt5Payload): Mt5TradeEvent {
  const fields = new Fields(payload, 'trade.event')
  return {
    type: fields.choice('type', ['deal_add', 'history_add']),
    deal: fields.optionalId('deal'),
    order: fields.optionalId('order'),
    position: fields.optionalId('position'),
    symbol: fields.text('symbol'),
  }
}
