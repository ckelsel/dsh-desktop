/**
 * The in-process SDK link: the mt5bridge SDK serves the terminal face, a dialing terminal
 * becomes the table's entry after the SDK's probe, calls ride `params.terminal_id`, and the
 * terminal's events fan out with their seq.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, type Socket } from 'node:net'
import { Mt5Bridge } from 'mt5bridge'
import { Mt5SdkLink } from '../src/mt5/sdk-link.ts'
import type { GatewayEvent, GatewayTerminal } from '../src/mt5/gateway-link.ts'

interface Frame { id?: number | string; method?: string; params?: Record<string, unknown>; seq?: number }

/** A terminal dialing the link's face: hello, then answers from its handler table. */
class FakeTerminal {
  readonly handlers = new Map<string, (params: Record<string, unknown>) => unknown>()
  readonly sent: { id: number; method: string; params: Record<string, unknown> }[] = []
  private buf = ''

  constructor(private readonly sock: Socket) {
    sock.on('data', chunk => {
      this.buf += chunk.toString('utf8')
      let nl: number
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const text = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (text !== '') this.onLine(JSON.parse(text) as Frame)
      }
    })
  }

  static dial(port: number): Promise<FakeTerminal> {
    return new Promise((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => resolve(new FakeTerminal(sock)))
      sock.on('error', reject)
    })
  }

  hello(terminalId: string): void {
    this.write({ jsonrpc: '2.0', method: 'bridge.hello', params: { role: 'SERVICE', version: '0.2.0', terminal_id: terminalId } })
  }

  push(method: string, params: Record<string, unknown>, seq: number): void {
    this.write({ jsonrpc: '2.0', method, seq, params })
  }

  calls(method: string): Record<string, unknown>[] {
    return this.sent.filter(entry => entry.method === method).map(entry => entry.params)
  }

  close(): void {
    this.sock.destroy()
  }

  private onLine(frame: Frame): void {
    if (frame.method === undefined || frame.id === undefined) return
    this.sent.push({ id: Number(frame.id), method: frame.method, params: frame.params ?? {} })
    const handler = this.handlers.get(frame.method)
    if (handler === undefined) return
    queueMicrotask(() => {
      this.write({ jsonrpc: '2.0', id: frame.id, result: handler(frame.params ?? {}) ?? {} })
    })
  }

  private write(frame: object): void {
    if (!this.sock.destroyed) this.sock.write(JSON.stringify(frame) + '\n')
  }
}

let link: Mt5SdkLink
let terminal: FakeTerminal
let connected: boolean[]
let tables: (readonly GatewayTerminal[])[]
let events: GatewayEvent[]

beforeEach(() => {
  link = new Mt5SdkLink({ port: 0 })
  connected = []
  tables = []
  events = []
  link.onConnection(up => { connected.push(up) })
  link.onTerminals(list => { tables.push(list) })
  link.onEvent(event => { events.push(event) })
})

afterEach(async () => {
  link.close()
  terminal?.close()
})

/** A terminal the SDK adopts: it waits for the face, then answers the probe and the account read. */
async function arrive(): Promise<void> {
  await vi.waitFor(() => expect(link.port).toBeGreaterThan(0))
  terminal = await FakeTerminal.dial(link.port)
  terminal.handlers.set('terminal.get', () => ({ data_path: 'H:\\Terminal\\ACFC', connected: true, trade_allowed: true, dlls_allowed: true, build: 6320 }))
  terminal.handlers.set('account.get', () => ({ login: 1, server: 'MetaQuotes-Demo', currency: 'USD', leverage: 100, balance: 10_000, equity: 10_005, margin: 0, margin_free: 10_005, margin_level: 0, profit: 5, trade_allowed: true, hedging: true }))
  terminal.hello('T-REAL')
  await vi.waitFor(() => expect(link.snapshot().length).toBe(1))
}

describe('Mt5SdkLink', () => {
  it('serves the face, adopts a dialing terminal, and reports it in the table', async () => {
    link.open()
    await vi.waitFor(() => expect(connected).toEqual([true]))
    expect(link.port).toBeGreaterThan(0)
    await arrive()
    expect(link.snapshot()).toMatchObject([{ terminal_id: 'T-REAL', role: 'SERVICE' }])
    expect(tables.at(-1)!.length).toBe(1)
  })

  it('routes a call by terminal_id and strips it before the terminal sees it', async () => {
    link.open()
    await arrive()
    terminal.handlers.set('market.quote', () => ({ symbol: 'EURUSD', bid: 1.08123, ask: 1.08135, time_msc: 1 }))
    const answer = await link.call('market.quote', { symbol: 'EURUSD', terminal_id: 'T-REAL' })
    expect(answer).toMatchObject({ bid: 1.08123 })
    expect(terminal.calls('market.quote')[0]).toEqual({ symbol: 'EURUSD' })
  })

  it('fails a call with the runtime error codes when no terminal is in the table', async () => {
    link.open()
    await arrive()
    await expect(link.call('market.quote', { symbol: 'EURUSD', terminal_id: 'T-GONE' })).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('fans a terminal event out with its seq, and empties the table when it leaves', async () => {
    link.open()
    await arrive()
    terminal.push('event.market.tick', { symbol: 'EURUSD', bid: 1.1, ask: 1.1001 }, 7)
    await vi.waitFor(() => expect(events.length).toBe(1))
    expect(events[0]).toMatchObject({ method: 'event.market.tick', terminalId: 'T-REAL', seq: 7 })
    terminal.close()
    await vi.waitFor(() => expect(link.snapshot().length).toBe(0))
  })

  it('retries a start that fails, and takes the face once it succeeds', async () => {
    // Windows lets two listeners share a port silently (libuv sets SO_REUSEADDR on both), so a
    // failing start is scripted rather than squatted by another server.
    vi.useFakeTimers()
    const fake = { port: 19_850, onAccounts: () => {}, onRawEvent: () => {}, stop: () => {} } as unknown as Mt5Bridge
    const start = vi.spyOn(Mt5Bridge, 'start')
      .mockRejectedValueOnce(new Error('listen EADDRINUSE'))
      .mockResolvedValueOnce(fake)
    try {
      const busy = new Mt5SdkLink({ port: 19_850, log: () => {} })
      const ups: boolean[] = []
      busy.onConnection(up => { ups.push(up) })
      busy.open()
      await vi.advanceTimersByTimeAsync(0)
      expect(ups).toEqual([]) // The face could not be served; the link waits out its pause
      await vi.advanceTimersByTimeAsync(2_000)
      expect(ups).toEqual([true])
      busy.close()
      expect(busy.snapshot().length).toBe(0)
    } finally {
      start.mockRestore()
      vi.useRealTimers()
    }
  })
})
