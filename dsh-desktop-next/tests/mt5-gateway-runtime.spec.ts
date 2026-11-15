/**
 * The MT5 gateway runtime: the hello snapshot probed before a terminal is trusted, the sync of
 * the chosen terminal, quote and bar subscriptions as bridge charts, trade events as
 * invalidation, sequence gaps as resync, and the terminal's departure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Mt5GatewayRuntime } from '../src/mt5/gateway-runtime.ts'
import type { GatewayTransport, GatewayTransportEvents, GatewayTransportFactory } from '../src/mt5/gateway-link.ts'
import { MT5_DISCLAIMER_VERSION, type Mt5DataEvent, type Mt5Status } from '../src/mt5/contract.ts'

const TERMINAL = 'term-real'
const TESTER = 'term-tester'

/** The gateway's SDK face, scripted: it answers requests from its handler table and pushes. */
class FakeGateway {
  private events: GatewayTransportEvents | undefined
  private sockets: GatewayTransport[] = []
  readonly sent: { id: number; method: string; params: Record<string, unknown> }[] = []
  readonly handlers = new Map<string, (params: Record<string, unknown>) => unknown>()

  readonly transport: GatewayTransportFactory = (_url, events) => {
    this.events = events
    const socket: GatewayTransport = {
      send: text => { this.receive(text) },
      close: () => { this.events?.onClose() },
    }
    this.sockets.push(socket)
    return socket
  }

  /** The socket opens and the gateway states its terminals. */
  hello(terminals: { terminal_id: string; role?: string }[] = [{ terminal_id: TERMINAL, role: 'SERVICE' }]): void {
    this.events?.onOpen()
    this.push({ jsonrpc: '2.0', method: 'bridge.hello', params: { role: 'GATEWAY', terminals } })
  }

  terminal(type: 'connected' | 'disconnected', terminalId: string): void {
    this.push({ jsonrpc: '2.0', method: 'event.terminal', params: { type, terminal_id: terminalId } })
  }

  /** An event fanned out, as the gateway sends it: the terminal's id injected, its seq on top. */
  event(method: string, params: Record<string, unknown>, seq?: number, terminalId: string = TERMINAL): void {
    this.push({ jsonrpc: '2.0', method, seq, params: { ...params, terminal_id: terminalId } })
  }

  /** A raw frame, for the cases the helpers shape too much. */
  push(frame: object): void {
    this.events?.onText(JSON.stringify(frame))
  }

  private receive(text: string): void {
    const message = JSON.parse(text) as { id: number; method: string; params?: Record<string, unknown> }
    this.sent.push({ id: message.id, method: message.method, params: message.params ?? {} })
    const handler = this.handlers.get(message.method)
    if (handler === undefined) return
    void Promise.resolve().then(() => {
      try {
        const result = handler(message.params ?? {})
        this.push({ jsonrpc: '2.0', id: message.id, result: result ?? {} })
      } catch (error) {
        this.push({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: String(error) } })
      }
    })
  }

  /** The requests of one method, newest last. */
  calls(method: string): Record<string, unknown>[] {
    return this.sent.filter(entry => entry.method === method).map(entry => entry.params)
  }

  /** Drop the socket, as a gateway restart does. */
  drop(): void {
    this.sockets.splice(0).forEach(() => this.events?.onClose())
  }
}

let gateway: FakeGateway
let runtime: Mt5GatewayRuntime
let statuses: Mt5Status[]
let data: Mt5DataEvent[]
let logs: { event: string; level: string }[]

/** The handlers of a terminal that answers everything a sync asks for. */
function scriptTerminal(overrides: { terminal?: Partial<Record<string, unknown>>; account?: Partial<Record<string, unknown>> } = {}): void {
  gateway.handlers.set('terminal.get', () => ({ name: 'MetaTrader 5', build: 5120, data_path: 'H:\\Terminal\\ACFC...', connected: true, trade_allowed: true, dlls_allowed: true, ...overrides.terminal }))
  gateway.handlers.set('account.get', () => ({ login: 115496317, server: 'MetaQuotes-Demo', currency: 'USD', leverage: 100, balance: 10000, equity: 10012.5, margin: 220.4, margin_free: 9792.1, margin_level: 4541.9, profit: 12.5, trade_allowed: true, algo_allowed: true, hedging: true, ...overrides.account }))
  gateway.handlers.set('position.list', () => ({ positions: [{ ticket: 123456, symbol: 'EURUSD', type: 'buy', volume: 0.02, price_open: 1.08123, price_current: 1.08245, sl: 0, tp: 0, profit: 2.44, swap: 0, time_msc: 1763000000000, magic: 0, comment: '' }] }))
  gateway.handlers.set('order.list', () => ({ orders: [] }))
  gateway.handlers.set('symbol.list', () => ({ symbols: ['EURUSD', 'XAUUSD'], count: 2 }))
  gateway.handlers.set('symbol.get', params => ({ symbol: params.symbol, description: 'Euro vs US Dollar', path: 'Forex\\Majors', digits: 5, point: 0.00001, tick_size: 0.00001, spread: 12, trade_mode: 4, execution_mode: 'instant', currency_base: 'EUR', currency_profit: 'USD', currency_margin: 'USD', volume_min: 0.01, volume_max: 500, volume_step: 0.01, volume_limit: 0, stops_level: 0, freeze_level: 0, contract_size: 100000, calc_mode: 'forex', sector: 'currency', visible: true, order_modes: ['market', 'limit', 'stop', 'sl', 'tp'], margin_buy: 231.2, margin_sell: 231.4, filling_mode: 1, swap_long: -0.7, swap_short: 0.1 }))
  gateway.handlers.set('market.subscribe', () => ({ subscription_id: 'x', status: 'provisioning', chart_created: true, refs: 1 }))
  gateway.handlers.set('market.unsubscribe', () => ({ closed: true, remaining_refs: 0 }))
  gateway.handlers.set('market.quote', params => ({ symbol: params.symbol, bid: 1.08123, ask: 1.08135, last: 0, time_msc: 1763000000000, flags: 6, volume: 0, volume_real: 0 }))
  gateway.handlers.set('system.resync', () => ({ state: 'full' }))
}

/** A runtime on a scripted gateway, configured on and past its first hello. */
async function start(overrides?: Parameters<typeof scriptTerminal>[0]): Promise<void> {
  scriptTerminal(overrides)
  await runtime.configure({ mt5Enabled: true, mt5DisclaimerVersion: MT5_DISCLAIMER_VERSION, mt5DisclaimerAcceptedAt: 1 }, { safeMode: false })
  gateway.hello()
  await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
}

beforeEach(() => {
  vi.useFakeTimers()
  gateway = new FakeGateway()
  statuses = []
  data = []
  logs = []
  runtime = new Mt5GatewayRuntime({
    transport: gateway.transport,
    log: (event, _fields, level = 'info') => { logs.push({ event, level }) },
  })
  runtime.subscribe(status => { statuses.push(status) })
  runtime.subscribeData(event => { data.push(event) })
})
afterEach(async () => {
  await runtime.stop()
  vi.useRealTimers()
})

describe('terminal choice', () => {
  it('syncs a real terminal from the hello snapshot and goes ready', async () => {
    await start()
    const ready = runtime.status()
    expect(ready).toMatchObject({ phase: 'ready', account: { login: '115496317', server: 'MetaQuotes-Demo', tradeMode: 'demo' }, blocked: [] })
    expect(ready.terminal).toMatchObject({ connected: true, build: 5120 })
    expect(runtime.trading()).toMatchObject({ positions: [{ ticket: '123456', side: 'buy', volume: 0.02 }] })
    expect(runtime.catalog()).toMatchObject({ server: 'MetaQuotes-Demo', watch: ['EURUSD', 'XAUUSD'] })
    expect(runtime.catalog()!.symbols.map(symbol => symbol.name)).toEqual(['EURUSD', 'XAUUSD'])
    expect(gateway.calls('terminal.get').every(params => params.terminal_id === TERMINAL)).toBe(true)
  })

  it('skips a snapshot entry that does not answer, and takes the next one', async () => {
    scriptTerminal()
    gateway.handlers.set('terminal.get', params => {
      if (params.terminal_id === 'term-dead') throw new Error('stale snapshot entry')
      return { data_path: 'H:\\Terminal\\ACFC...', connected: true, trade_allowed: true, dlls_allowed: true, build: 5120, name: '', company: '' }
    })
    await runtime.configure({ mt5Enabled: true, mt5DisclaimerVersion: MT5_DISCLAIMER_VERSION, mt5DisclaimerAcceptedAt: 1 }, { safeMode: false })
    gateway.hello([{ terminal_id: 'term-dead' }, { terminal_id: TERMINAL }])
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    // The probes, before the chosen terminal's own sync reads it once more.
    expect(gateway.calls('terminal.get').map(params => params.terminal_id).slice(0, 2)).toEqual(['term-dead', TERMINAL])
  })

  it('prefers the real terminal over a strategy-tester agent listed first', async () => {
    scriptTerminal()
    gateway.handlers.set('terminal.get', params => ({ data_path: params.terminal_id === TESTER ? 'H:\\Tester\\ACFC...\\Agent-3000' : 'H:\\Terminal\\ACFC...', connected: true, trade_allowed: true, dlls_allowed: true, build: 5120, name: '', company: '' }))
    await runtime.configure({ mt5Enabled: true, mt5DisclaimerVersion: MT5_DISCLAIMER_VERSION, mt5DisclaimerAcceptedAt: 1 }, { safeMode: false })
    gateway.hello([{ terminal_id: TESTER }, { terminal_id: TERMINAL }])
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    const routed = gateway.sent.filter(entry => entry.method === 'account.get')
    expect(routed.every(entry => entry.params.terminal_id === TERMINAL)).toBe(true)
    expect(gateway.calls('terminal.get').map(params => params.terminal_id).slice(0, 2)).toEqual([TESTER, TERMINAL])
  })

  it('prefers the replay agent when asked for a tester, with the real terminal listed first', async () => {
    runtime = new Mt5GatewayRuntime({
      terminal: 'tester',
      transport: gateway.transport,
      log: (event, _fields, level = 'info') => { logs.push({ event, level }) },
    })
    runtime.subscribe(status => { statuses.push(status) })
    runtime.subscribeData(event => { data.push(event) })
    scriptTerminal()
    gateway.handlers.set('terminal.get', params => ({ data_path: params.terminal_id === TESTER ? 'H:\\Tester\\ACFC...\\Agent-3000' : 'H:\\Terminal\\ACFC...', connected: true, trade_allowed: true, dlls_allowed: true, build: 5120, name: '', company: '' }))
    await runtime.configure({ mt5Enabled: true, mt5DisclaimerVersion: MT5_DISCLAIMER_VERSION, mt5DisclaimerAcceptedAt: 1 }, { safeMode: false })
    gateway.hello([{ terminal_id: TERMINAL }, { terminal_id: TESTER }])
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    const routed = gateway.sent.filter(entry => entry.method === 'account.get')
    expect(routed.every(entry => entry.params.terminal_id === TESTER)).toBe(true)
  })

  it('returns to listening when the terminal in use leaves the gateway, and recovers on its return', async () => {
    await start()
    gateway.terminal('disconnected', TERMINAL)
    await vi.waitFor(() => expect(runtime.status().phase).toBe('listening'))
    expect(runtime.status().blocked).toContain('ea-disconnected')
    expect(runtime.trading()).toBeNull()
    expect(data.some(event => event.kind === 'trading' && event.trading === null)).toBe(true)
    gateway.terminal('connected', TERMINAL)
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
  })
})

describe('market data', () => {
  it("subscribes the page's quotes as charts, seeds one quote, and follows tick events", async () => {
    await start()
    runtime.setSubscription({ quotes: ['EURUSD'], bars: [] })
    await vi.waitFor(() => expect(gateway.calls('market.subscribe').length).toBe(1))
    expect(gateway.calls('market.subscribe')[0]).toMatchObject({ symbol: 'EURUSD', period: 'M1', terminal_id: TERMINAL })
    // The seed quote arrives as a tick, before any tick event.
    await vi.waitFor(() => expect(data.some(event => event.kind === 'ticks' && event.ticks.some(tick => tick.symbol === 'EURUSD' && tick.bid === 1.08123))).toBe(true))
    gateway.event('event.market.tick', { symbol: 'EURUSD', bid: 1.083, ask: 1.0831, time_msc: 1763000100000, volume: 7 }, 5)
    await vi.waitFor(() => expect(data.some(event => event.kind === 'ticks' && event.ticks.some(tick => tick.bid === 1.083))).toBe(true))
  })

  it('subscribes and unsubscribes bar streams by their chart key', async () => {
    await start()
    runtime.setSubscription({ quotes: [], bars: [{ symbol: 'EURUSD', timeframe: 'M5' }] })
    await vi.waitFor(() => expect(gateway.calls('market.subscribe').length).toBe(1))
    expect(gateway.calls('market.subscribe')[0]).toMatchObject({ symbol: 'EURUSD', period: 'M5' })
    runtime.setSubscription({ quotes: [], bars: [] })
    await vi.waitFor(() => expect(gateway.calls('market.unsubscribe').length).toBe(1))
    expect(gateway.calls('market.unsubscribe')[0]).toMatchObject({ symbol: 'EURUSD', period: 'M5' })
  })

  it("follows bar events of the page's timeframes and drops the others", async () => {
    await start()
    gateway.event('event.market.bar', { symbol: 'EURUSD', period: 'M5', time_msc: 1763000000000, open: 1.08, high: 1.081, low: 1.079, close: 1.0805, tick_volume: 42 }, 8)
    gateway.event('event.market.bar', { symbol: 'EURUSD', period: 'MN1', time_msc: 1763000000000, open: 1.08, high: 1.081, low: 1.079, close: 1.0805, tick_volume: 42 }, 9)
    await vi.waitFor(() => expect(data.filter(event => event.kind === 'bars').length).toBe(1))
    expect(data.find(event => event.kind === 'bars')).toMatchObject({ bars: [{ symbol: 'EURUSD', timeframe: 'M5', volume: 42 }] })
  })

  it('serves history bars from the terminal, oldest first', async () => {
    await start()
    gateway.handlers.set('market.bars', () => ({ bars: [
      { time_msc: 1763000060000, open: 1.0805, high: 1.081, low: 1.08, close: 1.0808, tick_volume: 10 },
      { time_msc: 1763000000000, open: 1.08, high: 1.0805, low: 1.079, close: 1.0805, tick_volume: 12 },
    ] }))
    const answer = await runtime.historyBars({ symbol: 'EURUSD', timeframe: 'M1', to: 1763000100000, count: 2 })
    expect(answer.bars.map(bar => bar.time)).toEqual([1763000000000, 1763000060000])
    expect(gateway.calls('market.bars')[0]).toMatchObject({ symbol: 'EURUSD', period: 'M1', to_ms: 1763000100000 })
  })
})

describe('invalidation', () => {
  it('re-reads the trading state once after a burst of trade events', async () => {
    await start()
    const before = gateway.calls('position.list').length
    gateway.event('event.position.changed', { kind: 'modified', positions: [] }, 10)
    gateway.event('event.deal.added', { deals: [] }, 11)
    await vi.advanceTimersByTimeAsync(600)
    expect(gateway.calls('position.list').length).toBe(before + 1)
    expect(runtime.trading()?.positions[0]).toMatchObject({ ticket: '123456' })
  })

  it('asks the bridge to resync on a sequence gap, once per window', async () => {
    await start()
    gateway.event('event.market.tick', { symbol: 'EURUSD', bid: 1.083, ask: 1.0831 }, 20)
    gateway.event('event.market.tick', { symbol: 'EURUSD', bid: 1.084, ask: 1.0841 }, 25)
    gateway.event('event.market.tick', { symbol: 'EURUSD', bid: 1.085, ask: 1.0851 }, 26)
    await vi.advanceTimersByTimeAsync(100)
    expect(gateway.calls('system.resync').length).toBe(1)
    await vi.advanceTimersByTimeAsync(2500)
    expect(gateway.calls('system.resync').length).toBe(1)
  })

  it('ignores events of another terminal', async () => {
    await start()
    gateway.push({ jsonrpc: '2.0', method: 'event.market.tick', seq: 30, params: { symbol: 'EURUSD', bid: 9.9, ask: 9.9, terminal_id: 'term-other' } })
    await vi.advanceTimersByTimeAsync(50)
    expect(data.some(event => event.kind === 'ticks' && event.ticks.some(tick => tick.bid === 9.9))).toBe(false)
  })
})

describe('connection', () => {
  it('clears the terminal state when the gateway drops, and resyncs after the reconnect', async () => {
    await start()
    gateway.drop()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('listening'))
    expect(runtime.trading()).toBeNull()
    expect(runtime.catalog()).not.toBeNull()
    // The link reconnects after its pause; the gateway's hello rides the new socket.
    await vi.advanceTimersByTimeAsync(1_100)
    gateway.hello()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
  })

  it("replays the page's subscriptions after the terminal returns", async () => {
    await start()
    runtime.setSubscription({ quotes: ['EURUSD'], bars: [] })
    await vi.waitFor(() => expect(gateway.calls('market.subscribe').length).toBe(1))
    gateway.terminal('disconnected', TERMINAL)
    await vi.waitFor(() => expect(runtime.status().phase).toBe('listening'))
    gateway.terminal('connected', TERMINAL)
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    // The recovery's sync replays the subscription on the fresh terminal session.
    await vi.waitFor(() => expect(gateway.calls('market.subscribe').length).toBe(2))
  })

  it('stays off while disabled, and answers gateway-mode gaps honestly', async () => {
    await runtime.configure({ mt5Enabled: false, mt5DisclaimerVersion: 0, mt5DisclaimerAcceptedAt: 0 }, { safeMode: false })
    expect(runtime.status()).toMatchObject({ phase: 'disabled', blocked: ['bridge-disabled'] })
    // Trading is refused by the gate without reaching a terminal.
    const outcome = await runtime.trade({ type: 'order.cancel', account: { login: '1', server: 'x' }, symbol: 'EURUSD', ticket: '1' })
    expect(outcome).toMatchObject({ status: 'blocked', blocked: 'bridge-disabled', code: 'blocked' })
    expect(runtime.token()).toContain('gateway')
  })

  it('sends a market order as trade.execute and answers placed', async () => {
    await start()
    gateway.handlers.set('trade.execute', () => ({ status: 'accepted', request_id: 3, retcode: 10009 }))
    const outcome = await runtime.trade({
      type: 'order.place', account: { login: '115496317', server: 'MetaQuotes-Demo' },
      symbol: 'EURUSD', side: 'buy', orderType: 'market', volume: 0.01, price: null, sl: null, tp: null,
    })
    expect(outcome).toMatchObject({ status: 'placed', id: '3', retcode: 10009, code: 'sent' })
    const sent = gateway.calls('trade.execute')[0]!
    expect(sent).toMatchObject({ action: 'buy', symbol: 'EURUSD', volume: 0.01 })
    expect(sent.sl).toBeUndefined()
    expect(typeof sent.idempotency_key).toBe('string')
  })

  it('maps a pending order to its action, and reports the terminal refusal with its retcode', async () => {
    await start()
    gateway.handlers.set('trade.execute', () => ({ status: 'rejected', request_id: 4, retcode: 10015 }))
    const outcome = await runtime.trade({
      type: 'order.place', account: { login: '115496317', server: 'MetaQuotes-Demo' },
      symbol: 'XAUUSD', side: 'sell', orderType: 'limit', volume: 0.1, price: 2650.5, sl: null, tp: 2600,
    })
    expect(outcome).toMatchObject({ status: 'rejected', id: '4', retcode: 10015, code: 'sent' })
    expect(gateway.calls('trade.execute')[0]).toMatchObject({ action: 'sell_limit', price: 2650.5, tp: 2600 })
  })

  it('refuses a trade for another account without sending it', async () => {
    await start()
    const outcome = await runtime.trade({
      type: 'position.close', account: { login: '999', server: 'Elsewhere' }, symbol: 'EURUSD', ticket: '123456', volume: 0.02,
    })
    expect(outcome).toMatchObject({ status: 'rejected', code: 'account_mismatch', id: null })
    expect(gateway.calls('position.close').length).toBe(0)
  })

  it('closes a position through its own channel with the ticket', async () => {
    await start()
    gateway.handlers.set('position.close', () => ({ status: 'accepted', request_id: 5, retcode: 10009 }))
    const outcome = await runtime.trade({
      type: 'position.close', account: { login: '115496317', server: 'MetaQuotes-Demo' }, symbol: 'EURUSD', ticket: '123456', volume: 0.02,
    })
    expect(outcome).toMatchObject({ status: 'done', id: '5' })
    expect(gateway.calls('position.close')[0]).toMatchObject({ ticket: '123456', volume: 0.02 })
  })

  it('answers trade history newest first, orders and deals together', async () => {
    await start()
    gateway.handlers.set('history.orders', () => ({ orders: [
      { ticket: 2, symbol: 'EURUSD', type: 'buy_limit', state: 'ORDER_STATE_FILLED', volume_current: 0.01, volume_initial: 0.01, price_open: 1.08, time_setup_msc: 2000, time_done_msc: 2100, comment: 'dsh-1' },
      { ticket: 1, symbol: 'XAUUSD', type: 'sell', state: 'ORDER_STATE_FILLED', volume_current: 0.1, volume_initial: 0.1, price_open: 2650, time_setup_msc: 1000, time_done_msc: 1100, comment: '' },
    ] }))
    gateway.handlers.set('history.deals', () => ({ deals: [
      { ticket: 21, order: 2, symbol: 'EURUSD', type: 'buy', direction: 'in', volume: 0.01, price: 1.0812, profit: 0, commission: 0, swap: 0, time_msc: 2100, comment: 'dsh-1' },
      { ticket: 11, order: 1, symbol: 'XAUUSD', type: 'sell', direction: 'out', volume: 0.1, price: 2649.5, profit: 5, commission: -0.1, swap: 0, time_msc: 1100, comment: '' },
    ] }))
    const history = await runtime.historyTrades({ from: 0, to: 10_000 })
    expect(history.orders.map(order => order.ticket)).toEqual(['2', '1'])
    expect(history.orders[0]).toMatchObject({ state: 'ORDER_STATE_FILLED', price: 1.08, timeSetup: 2000, comment: 'dsh-1' })
    expect(history.deals.map(deal => deal.ticket)).toEqual(['21', '11'])
    expect(history.deals[1]).toMatchObject({ entry: 'out', profit: 5, time: 1100 })
    expect(history.truncated).toBe(false)
  })
})
