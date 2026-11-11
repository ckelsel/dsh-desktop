/**
 * Wire format of the MT5 bridge, protocol v1 (`mt5/PROTOCOL.md`): one JSON object per line.
 * Requests carry an `id` that the response repeats; events have none. Every frame and payload the
 * EA sends is validated here before the bridge uses it. Payload fields are snake_case on the wire
 * and camelCase in the Desktop.
 */
import type { Mt5Account, Mt5TerminalStatus } from './contract.ts'

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
