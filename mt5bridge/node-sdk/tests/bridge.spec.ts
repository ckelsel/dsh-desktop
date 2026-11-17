// SDK 全链路测试：用假终端（真 TCP 连接，说 DLL 的行协议）驱动 Mt5Bridge——
// hello 认证、探活建账、订阅引用计数、事件路由、断档 resync、超时与离场。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, type Socket } from 'node:net'
import { Mt5Bridge } from '../src/index.ts'

interface Request { id: string; method: string; params: Record<string, unknown> }

/** 假 MT5 终端：连上 SDK 的门，hello 认证，按 handler 表应答 RPC，可主动推事件。 */
class FakeTerminal {
  readonly received: Request[] = []
  readonly handlers = new Map<string, (params: Record<string, unknown>) => unknown>()
  private readonly sock: Socket
  private buf = ''

  private constructor(sock: Socket) {
    this.sock = sock
    sock.on('data', chunk => {
      this.buf += chunk.toString('utf8')
      let nl: number
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const text = this.buf.slice(0, nl).trim()
        this.buf = this.buf.slice(nl + 1)
        if (text !== '') this.onLine(JSON.parse(text) as Request)
      }
    })
  }

  static connect(port: number): Promise<FakeTerminal> {
    return new Promise((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => resolve(new FakeTerminal(sock)))
      sock.on('error', reject)
    })
  }

  hello(options: { terminal_id: string; role?: string; token?: string }): void {
    this.write({ jsonrpc: '2.0', method: 'bridge.hello', params: { role: 'SERVICE', version: '0.2.0', ...options } })
  }

  /** 推一条事件行（seq 顶层，与 DLL 一致）。 */
  push(method: string, params: Record<string, unknown>, seq?: number): void {
    this.write({ jsonrpc: '2.0', method, ...(seq !== undefined ? { seq } : {}), params })
  }

  close(): void {
    this.sock.destroy()
  }

  calls(method: string): Record<string, unknown>[] {
    return this.received.filter(request => request.method === method).map(request => request.params)
  }

  private onLine(msg: Request): void {
    if (msg.method === undefined || msg.id === undefined) return
    this.received.push(msg)
    const handler = this.handlers.get(msg.method)
    if (handler === undefined) return
    queueMicrotask(() => {
      try {
        this.write({ jsonrpc: '2.0', id: msg.id, result: handler(msg.params ?? {}) ?? {} })
      } catch (error) {
        this.write({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: String(error) } })
      }
    })
  }

  private write(frame: object): void {
    if (!this.sock.destroyed) this.sock.write(JSON.stringify(frame) + '\n')
  }
}

/** 真实终端的 terminal.get/account.get 应答。 */
function scriptLive(terminal: FakeTerminal, dataPath: string, login: number): void {
  terminal.handlers.set('terminal.get', () => ({ data_path: dataPath, connected: true, trade_allowed: true, dlls_allowed: true, build: 6320, name: '', company: '' }))
  terminal.handlers.set('account.get', () => ({ login, server: 'MetaQuotes-Demo', currency: 'USD', leverage: 100, balance: 10000, equity: 10005, margin: 22, margin_free: 9983, margin_level: 45477, profit: 5, trade_allowed: true, hedging: true }))
}

const waitFor = async <T>(read: () => T, ok: (value: T) => boolean, ms: number): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (ok(value)) return value
    if (Date.now() > end) return value
    await new Promise(resolve => { setTimeout(resolve, 50) })
  }
}

let bridge: Mt5Bridge

beforeEach(async () => {
  bridge = await Mt5Bridge.start({ port: 0 })
})

afterEach(async () => {
  await bridge.stop()
})

describe('accounts', () => {
  it('adopts a real terminal as the main account and reaches ready', async () => {
    expect(bridge.getStatus()).toBe('listening')
    const terminal = await FakeTerminal.connect(bridge.port)
    scriptLive(terminal, 'H:\\Terminal\\ACFC', 115496317)
    terminal.hello({ terminal_id: 'T-REAL' })
    const accounts = await waitFor(() => bridge.getAccounts(), list => list.length === 1, 3000)
    expect(accounts.length).toBe(1)
    expect(accounts[0]).toMatchObject({ id: 'T-REAL', kind: 'real' })
    expect(accounts[0]!.info).toMatchObject({ login: '115496317', server: 'MetaQuotes-Demo', hedging: true })
    expect(bridge.main?.id).toBe('T-REAL')
    expect(bridge.getStatus()).toBe('ready')
  })

  it('prefers the real account over a tester agent joining later', async () => {
    const real = await FakeTerminal.connect(bridge.port)
    scriptLive(real, 'H:\\Terminal\\ACFC', 1)
    real.hello({ terminal_id: 'T-REAL' })
    const tester = await FakeTerminal.connect(bridge.port)
    scriptLive(tester, 'H:\\Tester\\ACFC\\Agent-3000', 2)
    tester.hello({ terminal_id: 'T-TESTER' })
    await waitFor(() => bridge.getAccounts(), list => list.length === 2, 3000)
    expect(bridge.main?.kind).toBe('real')
    const testerAccount = bridge.getAccounts().find(account => account.id === 'T-TESTER')
    expect(testerAccount?.kind).toBe('tester')
    tester.close()
  })

  it('drops the account when the terminal leaves and reports lost', async () => {
    const terminal = await FakeTerminal.connect(bridge.port)
    scriptLive(terminal, 'H:\\Terminal\\ACFC', 1)
    terminal.hello({ terminal_id: 'T-REAL' })
    await waitFor(() => bridge.getAccounts(), list => list.length === 1, 3000)
    terminal.close()
    await waitFor(() => bridge.getAccounts(), list => list.length === 0, 3000)
    expect(bridge.getStatus()).toBe('lost')
  })

  it('rejects a terminal whose token does not match', async () => {
    const secure = await Mt5Bridge.start({ port: 0, token: 'secret' })
    try {
      const terminal = await FakeTerminal.connect(secure.port)
      scriptLive(terminal, 'H:\\Terminal\\ACFC', 1)
      terminal.hello({ terminal_id: 'T-REAL', token: 'wrong' })
      await new Promise(resolve => { setTimeout(resolve, 400) })
      expect(secure.getAccounts().length).toBe(0)
      expect(secure.getStatus()).toBe('listening')
    } finally {
      await secure.stop()
    }
  })
})

describe('market', () => {
  it('serves the order book snapshot and follows book events', async () => {
    const terminal = await FakeTerminal.connect(bridge.port)
    scriptLive(terminal, 'H:\\Terminal\\ACFC', 1)
    terminal.handlers.set('market.book', () => ({ symbol: 'EURUSD', entries: [
      { type: 0, price: 1.0812, volume: 8, volume_real: 8 },
      { type: 1, price: 1.0814, volume: 6, volume_real: 6 },
    ] }))
    terminal.hello({ terminal_id: 'T-REAL' })
    const account = (await waitFor(() => bridge.getAccounts(), list => list.length === 1, 3000))[0]!

    const snapshot = await account.market.getOrderBook('EURUSD')
    expect(snapshot.map(e => [e.level, e.price])).toEqual([['sell', 1.0812], ['buy', 1.0814]])
    expect(snapshot[0]!.symbol).toBe('EURUSD')

    const levels: string[] = []
    account.market.onBook(entries => { levels.push(entries[0]!.level) })
    terminal.push('event.market.book', { symbol: 'EURUSD', entries: [{ type: 3, price: 1.0814, volume: 1, volume_real: 1 }] }, 11)
    await waitFor(() => levels, list => list.length === 1, 2000)
    expect(levels).toEqual(['buy_market'])
    terminal.close()
  })

  it('previews a trade, modifies a pending order, and reconciles by request id', async () => {
    const terminal = await FakeTerminal.connect(bridge.port)
    scriptLive(terminal, 'H:\\Terminal\\ACFC', 1)
    terminal.handlers.set('trade.preview', () => ({ ok: true, retcode: 0, comment: 'ok', margin: 23.4, margin_free: 9976.6, balance: 10000, equity: 10005 }))
    terminal.handlers.set('order.modify', () => ({ status: 'accepted', request_id: 9, retcode: 10009 }))
    terminal.handlers.set('trade.status', () => ({ found: true, request_id: 3, state: 'filled', order: '3001', deal: '3002' }))
    terminal.hello({ terminal_id: 'T-REAL' })
    const account = (await waitFor(() => bridge.getAccounts(), list => list.length === 1, 3000))[0]!

    const preview = await account.trading.preview({ action: 'buy', symbol: 'EURUSD', volume: 0.01 })
    expect(preview).toMatchObject({ ok: true, margin: 23.4 })
    expect(terminal.calls('trade.preview')[0]).toMatchObject({ action: 'buy', symbol: 'EURUSD', volume: 0.01 })

    const receipt = await account.trading.modifyOrder({ ticket: '123', price: 1.09 })
    expect(receipt).toMatchObject({ requestId: '9', status: 'accepted' })

    const status = await account.trading.getStatus({ requestId: '3' })
    expect(status).toMatchObject({ found: true, state: 'filled', order: '3001', deal: '3002' })
    terminal.close()
  })

  it('subscribes once for repeated listeners, seeds a quote, and follows tick events', async () => {
    const terminal = await FakeTerminal.connect(bridge.port)
    scriptLive(terminal, 'H:\\Terminal\\ACFC', 1)
    terminal.handlers.set('market.subscribe', () => ({ subscription_id: 'x', status: 'ready', chart_created: true }))
    terminal.handlers.set('market.unsubscribe', () => ({ closed: true, remaining_refs: 0 }))
    terminal.handlers.set('market.quote', () => ({ bid: 1.08123, ask: 1.08135, last: 0, time_msc: 1763000000000, volume: 0, volume_real: 0 }))
    terminal.hello({ terminal_id: 'T-REAL' })
    const account = (await waitFor(() => bridge.getAccounts(), list => list.length === 1, 3000))[0]!

    const ticks: number[] = []
    account.market.onTick(tick => { ticks.push(tick.bid) })
    await account.market.subscribe('EURUSD')
    await account.market.subscribe('EURUSD')
    expect(terminal.calls('market.subscribe').length).toBe(1)
    // 订阅成功即播种一帧现价
    await waitFor(() => ticks, list => list.length >= 1, 2000)
    // 之后按事件推流
    terminal.push('event.market.tick', { symbol: 'EURUSD', bid: 1.083, ask: 1.0831, time_msc: 1763000100000 }, 5)
    await waitFor(() => ticks, list => list.length >= 2, 2000)
    expect(ticks).toEqual([1.08123, 1.083])

    await account.market.unsubscribe('EURUSD')
    await account.market.unsubscribe('EURUSD')
    expect(terminal.calls('market.unsubscribe').length).toBe(1)
    terminal.close()
  })

  it('serves bars oldest first and closes bar events with closed=true', async () => {
    const terminal = await FakeTerminal.connect(bridge.port)
    scriptLive(terminal, 'H:\\Terminal\\ACFC', 1)
    terminal.handlers.set('market.bars', () => ({ bars: [
      { time_msc: 1763000060000, open: 1.0805, high: 1.081, low: 1.08, close: 1.0808, tick_volume: 10 },
      { time_msc: 1763000000000, open: 1.08, high: 1.0805, low: 1.079, close: 1.0805, tick_volume: 12 },
    ] }))
    terminal.hello({ terminal_id: 'T-REAL' })
    const account = (await waitFor(() => bridge.getAccounts(), list => list.length === 1, 3000))[0]!

    const bars = await account.market.getBars({ symbol: 'EURUSD', period: 'M1', count: 2 })
    expect(bars.map(bar => bar.time)).toEqual([1763000000000, 1763000060000])
    expect(terminal.calls('market.bars')[0]).toMatchObject({ symbol: 'EURUSD', period: 'M1', count: 2 })

    const closed: boolean[] = []
    account.market.onBar(bar => { closed.push(bar.closed) })
    terminal.push('event.market.bar', { symbol: 'EURUSD', period: 'M5', time_msc: 1, open: 1, high: 1, low: 1, close: 1, tick_volume: 1 }, 7)
    terminal.push('event.market.bar_closed', { symbol: 'EURUSD', period: 'M5', time_msc: 1, open: 1, high: 1, low: 1, close: 1, tick_volume: 1 }, 8)
    await waitFor(() => closed, list => list.length === 2, 2000)
    expect(closed).toEqual([false, true])
    terminal.close()
  })
})

describe('trading', () => {
  it('routes a buy order and follows the deal event', async () => {
    const terminal = await FakeTerminal.connect(bridge.port)
    scriptLive(terminal, 'H:\\Terminal\\ACFC', 1)
    terminal.handlers.set('trade.execute', () => ({ status: 'accepted', request_id: 3, retcode: 10009 }))
    terminal.hello({ terminal_id: 'T-REAL' })
    const account = (await waitFor(() => bridge.getAccounts(), list => list.length === 1, 3000))[0]!

    const events: string[] = []
    account.trading.onEvent(event => { events.push(event.type) })
    const receipt = await account.trading.buy({ symbol: 'EURUSD', volume: 0.01, idempotencyKey: 'probe-1' })
    expect(receipt).toMatchObject({ requestId: '3', retcode: 10009, status: 'accepted' })
    expect(terminal.calls('trade.execute')[0]).toMatchObject({ action: 'buy', symbol: 'EURUSD', volume: 0.01, idempotency_key: 'probe-1' })

    terminal.push('event.deal.added', { deals: [{ ticket: 3, order: 3, symbol: 'EURUSD', type: 0, direction: 'in', volume: 0.01, price: 1.12381, profit: 0, commission: 0, swap: 0, time_msc: 1793765535000, comment: '' }] }, 9)
    await waitFor(() => events, list => list.includes('deals'), 2000)
    terminal.close()
  })

  it('returns the full state in one round trip', async () => {
    const terminal = await FakeTerminal.connect(bridge.port)
    scriptLive(terminal, 'H:\\Terminal\\ACFC', 1)
    terminal.handlers.set('state.snapshot', () => ({
      account: { login: 1, balance: 10100, equity: 10115 },
      positions: [{ ticket: 77, symbol: 'EURUSD', type: 'buy', volume: 0.01, price_open: 1.08, price_current: 1.095, profit: 1.5 }],
      orders: [{ ticket: 88, symbol: 'EURUSD', type: 'buy_limit', state: 'ORDER_STATE_PLACED', volume_current: 0.02, price_open: 1.07 }],
    }))
    terminal.hello({ terminal_id: 'T-REAL' })
    const account = (await waitFor(() => bridge.getAccounts(), list => list.length === 1, 3000))[0]!

    const state = await account.getState()
    expect(state.account.equity).toBe(10115)
    expect(state.positions).toMatchObject([{ ticket: '77', symbol: 'EURUSD', side: 'buy' }])
    expect(state.orders).toMatchObject([{ ticket: '88', action: 'buy_limit' }])
    expect(account.info?.equity).toBe(10115)
    terminal.close()
  })

  it('refreshes account info on change events', async () => {
    const terminal = await FakeTerminal.connect(bridge.port)
    scriptLive(terminal, 'H:\\Terminal\\ACFC', 1)
    terminal.hello({ terminal_id: 'T-REAL' })
    const account = (await waitFor(() => bridge.getAccounts(), list => list.length === 1, 3000))[0]!

    const seen: number[] = []
    account.onChange(info => { seen.push(info.equity) })
    terminal.push('event.account.changed', { account: { balance: 10000, equity: 10012.5, profit: 12.5 }, changed_fields: ['equity'] }, 3)
    await waitFor(() => seen, list => list.length >= 1, 2000)
    expect(account.info?.equity).toBe(10012.5)
    expect(account.info?.login).toBe('1') // 部分事件不重传全量，旧值保留
    terminal.close()
  })
})

describe('link discipline', () => {
  it('exposes the raw event stream with seq before internal routing', async () => {
    const terminal = await FakeTerminal.connect(bridge.port)
    scriptLive(terminal, 'H:\\Terminal\\ACFC', 1)
    terminal.hello({ terminal_id: 'T-REAL' })
    await waitFor(() => bridge.getAccounts(), list => list.length === 1, 3000)

    const raw: Array<{ method: string; seq?: number; terminalId: string }> = []
    const stopRaw = bridge.onRawEvent(event => { raw.push(event) })
    terminal.push('event.market.tick', { symbol: 'EURUSD', bid: 1.1 }, 4)
    await waitFor(() => raw, list => list.length === 1, 2000)
    expect(raw[0]).toMatchObject({ method: 'event.market.tick', seq: 4, terminalId: 'T-REAL' })
    stopRaw()
    terminal.push('event.market.tick', { symbol: 'EURUSD', bid: 1.2 }, 5)
    await new Promise(resolve => { setTimeout(resolve, 150) })
    expect(raw.length).toBe(1) // 退订后不再收
    terminal.close()
  })

  it('keeps a terminal that talks past the idle window, drops a silent one', async () => {
    vi.useFakeTimers()
    try {
      const quiet = await FakeTerminal.connect(bridge.port)
      scriptLive(quiet, 'H:\\Terminal\\ACFC', 1)
      quiet.hello({ terminal_id: 'T-QUIET' })
      await vi.waitFor(() => expect(bridge.getAccounts().length).toBe(1))
      const live = await FakeTerminal.connect(bridge.port)
      scriptLive(live, 'H:\\Terminal\\ACFC2', 2)
      live.hello({ terminal_id: 'T-LIVE' })
      await vi.waitFor(() => expect(bridge.getAccounts().length).toBe(2))

      await vi.advanceTimersByTimeAsync(20_000)
      live.push('event.market.tick', { symbol: 'EURUSD', bid: 1 }, 1) // 任意入站续命
      await vi.advanceTimersByTimeAsync(15_000)
      // 安静者 30s 被断；活跃者 20s 时续过命，50s 才到期
      expect(bridge.getAccounts().map(account => account.id)).toEqual(['T-LIVE'])
      expect(bridge.getStatus()).toBe('ready')
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out a request the terminal never answers', async () => {
    const quick = await Mt5Bridge.start({ port: 0, requestTtlMs: 150 })
    try {
      const terminal = await FakeTerminal.connect(quick.port)
      scriptLive(terminal, 'H:\\Terminal\\ACFC', 1)
      terminal.handlers.delete('account.get') // 探活的 account.get 悬挂
      terminal.hello({ terminal_id: 'T-REAL' })
      await new Promise(resolve => { setTimeout(resolve, 400) })
      expect(quick.getAccounts().length).toBe(0) // 探活超时，不建账户
    } finally {
      await quick.stop()
    }
  })

  it('asks a gap-broken terminal to resync, once per window', async () => {
    const jumpy = await Mt5Bridge.start({ port: 0, resyncDebounceMs: 200 })
    try {
      const terminal = await FakeTerminal.connect(jumpy.port)
      scriptLive(terminal, 'H:\\Terminal\\ACFC', 1)
      terminal.handlers.set('system.resync', () => ({ state: 'full' }))
      terminal.hello({ terminal_id: 'T-REAL' })
      const account = (await waitFor(() => jumpy.getAccounts(), list => list.length === 1, 3000))[0]!
      const ticks: number[] = []
      account.market.onTick(tick => { ticks.push(tick.bid) })

      terminal.push('event.market.tick', { symbol: 'EURUSD', bid: 1.1 }, 1)
      terminal.push('event.market.tick', { symbol: 'EURUSD', bid: 1.2 }, 5) // 断档
      terminal.push('event.market.tick', { symbol: 'EURUSD', bid: 1.3 }, 6) // 窗口内不再触发
      await waitFor(() => ticks, list => list.length === 3, 2000)
      await new Promise(resolve => { setTimeout(resolve, 500) })
      expect(terminal.calls('system.resync').length).toBe(1)
      terminal.close()
    } finally {
      await jumpy.stop()
    }
  })
})
