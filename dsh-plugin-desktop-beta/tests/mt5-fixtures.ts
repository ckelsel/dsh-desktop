/** Wire payloads and a scripted EA for the MT5 bridge specs. */
import { connect, type Socket } from 'node:net'
import { encodeLine, Mt5LineDecoder } from '../src/mt5/framing.ts'

export const TOKEN = 'fixture-token-0123456789abcdef'

export const HELLO = { token: TOKEN, protocol: 1, ea_version: '1.0.0', terminal_build: 5120, terminal_name: 'MetaTrader 5', login: '50123456', server: 'Example-Demo' }
export const TERMINAL = {
  terminal_connected: true, terminal_trade_allowed: true, ea_trade_allowed: true, terminal_build: 5120,
  terminal_name: 'MetaTrader 5', terminal_company: 'Example Ltd', ping_ms: 23.5, server_utc_offset: 7200,
}
export const ACCOUNT = {
  login: '50123456', name: 'Demo User', server: 'Example-Demo', company: 'Example Ltd', currency: 'USD', currency_digits: 2,
  leverage: 500, trade_mode: 'demo', margin_mode: 'hedging', trade_allowed: true, trade_expert: true, limit_orders: 200,
  balance: 10_000, credit: 0, profit: 12.5, equity: 10_012.5, margin: 220.4, margin_free: 9_792.1, margin_level: 4_542.88,
  margin_so_call: 100, margin_so_so: 50, margin_so_mode: 'percent',
}

/** A hello from an EA that serves stage 2: symbols, quotes, bars, positions, orders and history. */
export const HELLO_STAGE2 = { ...HELLO, ea_version: '1.1.0' }

export const EURUSD = {
  name: 'EURUSD', description: 'Euro vs US Dollar', path: 'Forex\\Majors\\EURUSD', currency_base: 'EUR', currency_profit: 'USD', currency_margin: 'EUR',
  digits: 5, point: 0.00001, tick_size: 0.00001, contract_size: 100_000, volume_min: 0.01, volume_max: 100, volume_step: 0.01,
  trade_mode: 'full', calc_mode: 'forex', sector: 'currency', selected: true,
}
export const XAUUSD = {
  ...EURUSD, name: 'XAUUSD', description: 'Gold vs US Dollar', path: 'Metals\\XAUUSD', currency_base: 'XAU', currency_margin: 'XAU',
  digits: 2, point: 0.01, tick_size: 0.01, contract_size: 100, calc_mode: 'cfd', sector: 'commodities',
}
export const US500 = {
  ...EURUSD, name: 'US500', description: 'US 500 Index', path: 'Indices\\US500', currency_base: 'USD', currency_margin: 'USD',
  digits: 2, point: 0.01, tick_size: 0.25, contract_size: 1, volume_min: 0.1, volume_step: 0.1, calc_mode: 'cfdindex', sector: 'indexes', selected: false,
}
export const SYMBOLS = [EURUSD, XAUUSD, US500]
/** Market Watch, in window order. */
export const WATCH = ['XAUUSD', 'EURUSD']

export const POSITION = {
  ticket: '1001', symbol: 'EURUSD', side: 'buy', volume: 0.1, price_open: 1.0712, sl: null, tp: 1.08, price_current: 1.0725,
  profit: 13, swap: -0.5, time: 1_762_000_000_000, comment: '', magic: 0,
}
export const ORDER = {
  ticket: '2001', symbol: 'XAUUSD', type: 'buy_limit', state: 'placed', volume: 0.05, volume_initial: 0.05, price: 2300, stop_limit: null,
  sl: 2280, tp: null, price_current: 2350.5, time: 1_762_000_100_000, time_type: 'gtc', expiration: null, comment: 'dip', magic: 0,
}
export const TICK = {
  symbol: 'EURUSD', time: 1_762_000_200_000, bid: 1.07251, ask: 1.07253, day_open: 1.0701, day_high: 1.0731, day_low: 1.0695,
  prev_close: 1.0702, day_volume: 51_234, session_open: true,
}
export const BAR = { symbol: 'EURUSD', timeframe: 'M5', time: 1_762_000_200_000, open: 1.0724, high: 1.0726, low: 1.0723, close: 1.07251, volume: 87 }
export const HISTORY_ORDER = {
  ticket: '3001', symbol: 'EURUSD', type: 'buy', state: 'filled', volume_initial: 0.1, volume_current: 0, price: 1.0712, stop_limit: null, sl: null, tp: null,
  time_setup: 1_761_990_000_000, time_done: 1_761_990_000_120, position: '1001', position_by: '0', reason: 'client', comment: '', magic: 0,
}
export const DEAL = {
  ticket: '4001', order: '3001', position: '1001', symbol: 'EURUSD', type: 'buy', entry: 'in', volume: 0.1, price: 1.0712,
  commission: -0.35, swap: 0, fee: 0, profit: 0, time: 1_761_990_000_120, reason: 'client', comment: '', magic: 0,
}
export const DEPOSIT = {
  ...DEAL, ticket: '4000', order: '0', position: '0', symbol: '', type: 'balance', volume: 0, price: 0, commission: 0, profit: 10_000,
  time: 1_761_900_000_000, comment: 'Deposit',
}

/** What the stage 2 sync reads after the account. */
export interface Stage2State {
  symbols?: readonly Record<string, unknown>[]
  watch?: readonly string[]
  positions?: readonly Record<string, unknown>[]
  orders?: readonly Record<string, unknown>[]
}

export type Frame = Record<string, unknown> & { type: string; id?: string; payload?: Record<string, unknown> }

/** A test EA: connects, writes frames, and collects the frames the bridge sends. */
export class FakeEa {
  readonly frames: Frame[] = []
  closed = false
  private readonly decoder = new Mt5LineDecoder()
  private readonly waiters = new Set<() => void>()
  private readonly served = new Set<string>()
  private nextId = 0

  private constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      for (const line of this.decoder.push(chunk)) this.frames.push(JSON.parse(line) as Frame)
      this.wake()
    })
    socket.on('error', () => {})
    socket.on('close', () => { this.closed = true; this.wake() })
  }

  static connect(port: number, host = '127.0.0.1'): Promise<FakeEa> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port }, () => { resolve(new FakeEa(socket)) })
      socket.once('error', reject)
    })
  }

  write(frame: object): void {
    this.socket.write(encodeLine(frame))
  }

  writeRaw(text: string): void {
    this.socket.write(text)
  }

  /** Send a request; returns its id. */
  request(type: string, payload: Record<string, unknown> = {}): string {
    const id = `ea-${String(++this.nextId)}`
    this.write({ v: 1, id, type, payload })
    return id
  }

  hello(overrides: Record<string, unknown> = {}): string {
    return this.request('system.hello', { ...HELLO, ...overrides })
  }

  respond(id: string, payload: Record<string, unknown> = {}): void {
    this.write({ v: 1, id, type: 'response', ok: true, payload })
  }

  fail(id: string, code: string, message: string): void {
    this.write({ v: 1, id, type: 'response', ok: false, error: { code, message } })
  }

  event(type: string, payload: Record<string, unknown> = {}): void {
    this.write({ v: 1, type, payload })
  }

  /** The first frame, received or still to come, that matches. */
  async next(match: (frame: Frame) => boolean, timeoutMs = 2_000): Promise<Frame> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = this.frames.find(match)
      if (found !== undefined) return found
      if (this.closed) throw new Error('the bridge closed the connection')
      const left = deadline - Date.now()
      if (left <= 0) throw new Error('no matching frame arrived')
      await this.wait(left)
    }
  }

  /** The response to request `id`. */
  response(id: string): Promise<Frame> {
    return this.next(frame => frame.type === 'response' && frame.id === id)
  }

  /** The next unserved request of `type`, answered with `payload` when one is given. */
  async serve(type: string, payload?: Record<string, unknown>): Promise<Frame> {
    const frame = await this.next(candidate => candidate.type === type && candidate.id !== undefined && !this.served.has(candidate.id))
    this.served.add(frame.id!)
    if (payload !== undefined) this.respond(frame.id!, payload)
    return frame
  }

  /** Answer the bridge's sync: resync, status, then the account. */
  async sync(account: Record<string, unknown> = ACCOUNT, terminal: Record<string, unknown> = TERMINAL): Promise<void> {
    await this.serve('system.resync', {})
    await this.serve('system.status', terminal)
    await this.serve('account.snapshot', account)
  }

  /** Answer `symbols.list` requests page by page until the bridge has every symbol. */
  async serveCatalog(symbols: readonly Record<string, unknown>[] = SYMBOLS, watch: readonly string[] = WATCH): Promise<Frame[]> {
    const requests: Frame[] = []
    for (;;) {
      const request = await this.serve('symbols.list')
      requests.push(request)
      const offset = request.payload?.offset as number
      const limit = request.payload?.limit as number
      this.respond(request.id!, {
        total: symbols.length, symbols: symbols.slice(offset, offset + limit), ...offset === 0 ? { watch } : {},
      })
      if (offset + limit >= symbols.length) return requests
    }
  }

  /** Answer the stage 2 sync: the account, the catalogue, positions, orders and the subscription. */
  async syncStage2(state: Stage2State = {}, account: Record<string, unknown> = ACCOUNT, terminal: Record<string, unknown> = TERMINAL): Promise<Frame> {
    await this.sync(account, terminal)
    await this.serveCatalog(state.symbols, state.watch)
    await this.serve('positions.snapshot', { positions: state.positions ?? [POSITION] })
    await this.serve('orders.snapshot', { orders: state.orders ?? [ORDER] })
    return this.serve('market.subscribe', { unknown: [] })
  }

  /** Resolve once the bridge has closed the connection. */
  async ended(timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!this.closed) {
      const left = deadline - Date.now()
      if (left <= 0) throw new Error('the connection stayed open')
      await this.wait(left)
    }
  }

  close(): void {
    this.socket.destroy()
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => { clearTimeout(timer); this.waiters.delete(done); resolve() }
      const timer = setTimeout(done, ms)
      this.waiters.add(done)
    })
  }

  private wake(): void {
    for (const waiter of [...this.waiters]) waiter()
  }
}
