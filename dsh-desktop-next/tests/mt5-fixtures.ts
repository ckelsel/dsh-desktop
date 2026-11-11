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
