/** The MT5 bridge runtime: preferences, the sync of each session, pushed updates, market data, and the token. */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Mt5BridgeRuntime, type Mt5DataEvent, type Mt5Preferences } from '../src/mt5/bridge-runtime.ts'
import { mt5SecretPath } from '../src/mt5/bridge-secret.ts'
import { mt5TlsPath } from '../src/mt5/bridge-tls.ts'
import { atomicJson } from '../src/private-files.ts'
import { MT5_DISCLAIMER_VERSION, type Mt5HistoryBarsRequest, type Mt5Status, type Mt5TradeInput } from '../src/mt5/contract.ts'
import { encodeLine } from '../src/mt5/framing.ts'
import {
  ACCOUNT, BAR, DEAL, DEPOSIT, EURUSD, FakeEa, HISTORY_ORDER, ORDER, POSITION, SYMBOL_INFO, TERMINAL, testTls, TICK,
} from './mt5-fixtures.ts'

const TIMINGS = { handshakeMs: 300, heartbeatMs: 60, idleMs: 600, requestMs: 300 }
/** Port 0 takes an ephemeral port; the preferences parser itself requires 1 through 65535. */
const PREFERENCES: Mt5Preferences = {
  mt5Enabled: true, mt5Exposure: 'loopback', mt5Port: 0, mt5DisclaimerVersion: MT5_DISCLAIMER_VERSION, mt5DisclaimerAcceptedAt: 1,
}

let home: string
let runtime: Mt5BridgeRuntime
let statuses: Mt5Status[]
let logs: { event: string; fields: Record<string, unknown> | undefined; level: string | undefined }[]
let data: Mt5DataEvent[]
const eas: FakeEa[] = []

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'dsh-mt5-runtime-'))
  // One certificate for every test: making an RSA key per test would slow the suite down.
  const { cert, key } = await testTls()
  atomicJson(mt5TlsPath(home), { cert, key })
  statuses = []
  logs = []
  data = []
  runtime = new Mt5BridgeRuntime({
    home, desktopVersion: 'DSH NEXT test', lanAddresses: () => ['10.0.0.9'], timings: TIMINGS, history: { retryMs: 20 }, tradeTimeoutMs: 900,
    log: (event, fields, level) => { logs.push({ event, fields, level }) },
  })
  runtime.subscribe(status => { statuses.push(status) })
  runtime.subscribeData(event => { data.push(event) })
})
afterEach(async () => {
  for (const ea of eas.splice(0)) ea.close()
  await runtime.stop()
  rmSync(home, { recursive: true, force: true })
})

async function start(preferences: Partial<Mt5Preferences> = {}): Promise<number> {
  await runtime.configure({ ...PREFERENCES, ...preferences }, { safeMode: false })
  const port = runtime.status().listen?.port
  if (port === undefined) throw new Error('the bridge did not listen')
  return port
}

/** An EA that logs in with the runtime's own token, unless `token` says otherwise; the other overrides go into its system.auth. */
async function connect(port: number, overrides: Record<string, unknown> = {}): Promise<FakeEa> {
  const ea = await FakeEa.connect(port)
  eas.push(ea)
  const { token, ...auth } = overrides
  void ea.login({ token: typeof token === 'string' ? token : runtime.token(), auth }).catch(() => {})
  return ea
}

describe('configuration', () => {
  it('stays off when disabled or in Safe Mode, blocking trades for that reason', async () => {
    await runtime.configure({ ...PREFERENCES, mt5Enabled: false }, { safeMode: false })
    expect(runtime.status()).toMatchObject({ phase: 'disabled', listen: null, blocked: ['bridge-disabled'] })
    await runtime.configure(PREFERENCES, { safeMode: true })
    expect(runtime.status()).toMatchObject({ phase: 'disabled', blocked: ['bridge-disabled'] })
  })

  it('listens on loopback, or on every interface with the LAN addresses an EA can dial', async () => {
    await start()
    expect(runtime.status()).toMatchObject({ phase: 'listening', listen: { host: '127.0.0.1', addresses: ['127.0.0.1'] }, blocked: ['ea-disconnected'] })
    await start({ mt5Exposure: 'lan' })
    expect(runtime.status()).toMatchObject({ phase: 'listening', listen: { host: '0.0.0.0', addresses: ['10.0.0.9'] } })
  })

  it('reports a port it cannot take as an error that blocks trading', async () => {
    const port = await start()
    const other = new Mt5BridgeRuntime({ home, desktopVersion: 'test', lanAddresses: () => [], log: () => {}, timings: TIMINGS })
    try {
      await other.configure({ ...PREFERENCES, mt5Port: port }, { safeMode: false })
      expect(other.status()).toMatchObject({ phase: 'error', listen: null, blocked: ['bridge-error'] })
      expect(other.status().error).toMatch(/EADDRINUSE/u)
    } finally { await other.stop() }
  })

  it('creates an owner-only token file once and reuses it', async () => {
    const token = runtime.token()
    expect(token).toMatch(/^[\w-]{43}$/u)
    const path = mt5SecretPath(home)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ token })
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    const again = new Mt5BridgeRuntime({ home, desktopVersion: 'test', lanAddresses: () => [], log: () => {} })
    expect(again.token()).toBe(token)
  })
})

describe('sessions', () => {
  it('syncs a new session before it is ready, then follows the updates the EA pushes', async () => {
    const port = await start()
    const ea = await connect(port)
    await vi.waitFor(() => expect(runtime.status().phase).toBe('syncing'))
    expect(runtime.status().blocked).toEqual(['syncing'])
    await ea.sync()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    // Accepting the hello moves straight on to syncing, never back to listening for a moment.
    const phases = statuses.map(status => status.phase).filter((phase, index, all) => phase !== all[index - 1])
    expect(phases).toEqual(['listening', 'handshaking', 'syncing', 'ready'])
    const ready = runtime.status()
    expect(ready).toMatchObject({
      peer: { address: '127.0.0.1', eaVersion: '1.2.0' },
      terminal: { connected: true, build: 5120, serverUtcOffset: 7200 },
      account: { login: '50123456', tradeMode: 'demo', equity: 10_012.5, marginFree: 9_792.1 },
      blocked: [],
    })
    expect(ready.syncedAt).toEqual(expect.any(Number))
    ea.event('account.snapshot', { ...ACCOUNT, equity: 9_990, profit: -10 })
    ea.event('system.status', { ...TERMINAL, terminal_connected: false })
    await vi.waitFor(() => expect(runtime.status()).toMatchObject({ account: { equity: 9_990 }, terminal: { connected: false }, blocked: ['broker-disconnected'] }))
    // An invalid update is logged and ignored, never applied partially.
    ea.event('account.snapshot', { ...ACCOUNT, equity: 'lots' })
    await vi.waitFor(() => expect(logs.map(log => log.event)).toContain('mt5.event-invalid'))
    expect(runtime.status().account?.equity).toBe(9_990)
  })

  it('clears the account when the EA disconnects, instead of keeping stale figures', async () => {
    const port = await start()
    const ea = await connect(port)
    await ea.sync()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    ea.close()
    await vi.waitFor(() => expect(runtime.status()).toMatchObject({ phase: 'listening', peer: null, terminal: null, account: null, blocked: ['ea-disconnected'] }))
  })

  it('ends the session as soon as the bridge is turned off, not when the socket finishes closing', async () => {
    const port = await start()
    const ea = await connect(port)
    await ea.sync()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    await runtime.configure({ ...PREFERENCES, mt5Enabled: false }, { safeMode: false })
    expect(runtime.status()).toMatchObject({ phase: 'disabled', peer: null, terminal: null, account: null })
    expect(statuses.at(-1)).toMatchObject({ phase: 'disabled', peer: null, account: null })
  })

  it('drops a session whose state cannot be read, so the EA reconnects and syncs again', async () => {
    const port = await start()
    const ea = await connect(port)
    await ea.serve('system.resync', {})
    await ea.serve('system.status', TERMINAL)
    const account = await ea.serve('account.snapshot')
    ea.fail(account.id!, 'not_ready', 'still loading')
    await ea.ended()
    await vi.waitFor(() => expect(runtime.status()).toMatchObject({ phase: 'listening', account: null }))
    expect(logs).toContainEqual(expect.objectContaining({ event: 'mt5.sync-failed', level: 'warn' }))
    const again = await connect(port)
    await again.sync()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
  })

  it('resyncs on request and keeps the figures on screen meanwhile', async () => {
    const port = await start()
    const ea = await connect(port)
    await ea.sync()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    const resync = runtime.resync()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('syncing'))
    expect(runtime.status().account?.login).toBe('50123456')
    await ea.sync({ ...ACCOUNT, balance: 10_100 })
    await resync
    expect(runtime.status()).toMatchObject({ phase: 'ready', account: { balance: 10_100 } })
  })

  it('refuses a resync without an EA, and renderer requests beyond the read-only ones', async () => {
    await start()
    await expect(runtime.resync()).rejects.toMatchObject({ code: 'not_connected' })
    await expect(runtime.request('order.place', {})).rejects.toThrow('not available to the renderer')
    await expect(runtime.request('account.snapshot')).rejects.toMatchObject({ code: 'not_connected' })
  })

  it('records why a connection was refused, for the settings page', async () => {
    const port = await start()
    const ea = await connect(port, { token: 'wrong' })
    await ea.ended()
    await vi.waitFor(() => expect(runtime.status().lastRejection).toMatchObject({ address: '127.0.0.1', reason: 'token' }))
    // An EA older than 1.2.0 speaks plain TCP.
    const old = await FakeEa.connectPlain(port)
    eas.push(old)
    old.write({ v: 1, id: 'hello-1', type: 'system.hello', payload: { protocol: 1 } })
    await old.ended()
    await vi.waitFor(() => expect(runtime.status().lastRejection).toMatchObject({ address: '127.0.0.1', reason: 'tls' }))
  })

  it('reports the fingerprint of its certificate, which the EA reads from the connection', async () => {
    const port = await start()
    const { fingerprint } = await testTls()
    expect(runtime.status().tls).toEqual({ fingerprint })
    const ea = await connect(port)
    expect(ea.fingerprint).toBe(fingerprint)
    expect(logs.map(log => log.event)).not.toContain('mt5.certificate-created')
  })

  it('disconnects the EA when the token is regenerated', async () => {
    const port = await start()
    const ea = await connect(port)
    await ea.sync()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    const previous = runtime.token()
    const token = await runtime.regenerateToken()
    expect(token).not.toBe(previous)
    expect(JSON.parse(readFileSync(mt5SecretPath(home), 'utf8'))).toEqual({ token })
    await ea.ended()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('listening'))
    const stale = await connect(port, { token: previous })
    await stale.ended()
    expect(runtime.status().lastRejection?.reason).toBe('token')
  })

  it('publishes a status only when it changed', async () => {
    await start()
    const count = statuses.length
    await start()
    expect(statuses).toHaveLength(count)
    expect(statuses.at(-1)).toBe(runtime.status())
  })
})

describe('stage 2', () => {
  const STAGE2 = { ea_version: '1.2.0' }

  /** An EA through a full sync. */
  async function ready(port: number, overrides: Record<string, unknown> = {}): Promise<FakeEa> {
    const ea = await connect(port, { ...STAGE2, ...overrides })
    await ea.syncStage2()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    return ea
  }

  it('reads the catalogue page by page, then positions, orders and the subscriptions, before it is ready', async () => {
    const port = await start()
    const many = Array.from({ length: 1001 }, (_, index) => ({ ...EURUSD, name: `SYM${String(index).padStart(4, '0')}` }))
    const ea = await connect(port, STAGE2)
    await ea.syncAccount()
    const pages = await ea.serveCatalog([EURUSD, ...many], ['SYM0003', 'EURUSD', 'GONE'])
    expect(pages.map(page => page.payload)).toEqual([{ offset: 0, limit: 500 }, { offset: 500, limit: 500 }, { offset: 1000, limit: 500 }])
    await ea.serve('positions.snapshot', { positions: [POSITION] })
    expect(runtime.status().phase).toBe('syncing')
    await ea.serve('orders.snapshot', { orders: [ORDER] })
    const subscribe = await ea.serve('market.subscribe', { unknown: [] })
    expect(subscribe.payload).toEqual({ quotes: [], bars: [] })
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    expect(runtime.status()).toMatchObject({ peer: { eaVersion: '1.2.0' }, blocked: [] })
    const catalog = runtime.catalog()
    expect(catalog?.server).toBe('Example-Demo')
    expect(catalog?.symbols).toHaveLength(1002)
    // The Market Watch order, without names the catalogue lacks.
    expect(catalog?.watch).toEqual(['SYM0003', 'EURUSD'])
    expect(runtime.trading()).toMatchObject({ positions: [{ ticket: '1001', side: 'buy' }], orders: [{ ticket: '2001', type: 'buy_limit' }] })
    expect(data.map(event => event.kind)).toEqual(['catalog', 'trading'])
    expect(logs).toContainEqual(expect.objectContaining({ event: 'mt5.synced', fields: expect.objectContaining({ symbols: 1002, positions: 1, orders: 1 }) }))
  })

  it('never lets a sync answer replace a value the EA pushed after it', async () => {
    const port = await start()
    const ea = await connect(port, STAGE2)
    await ea.syncAccount()
    await ea.serveCatalog()
    // The answer and a newer push arrive in one read, before the sync gets to use the answer.
    const positions = await ea.serve('positions.snapshot')
    ea.writeRaw(`${encodeLine({ v: 2, id: positions.id, type: 'response', ok: true, payload: { positions: [POSITION] } }).toString()}${
      encodeLine({ v: 2, type: 'positions.snapshot', payload: { positions: [] } }).toString()}`)
    // An older push, then the answer: the answer stands.
    const orders = await ea.serve('orders.snapshot')
    ea.event('orders.snapshot', { orders: [] })
    ea.respond(orders.id!, { orders: [ORDER] })
    await ea.serve('market.subscribe', { unknown: [] })
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    expect(runtime.trading()).toMatchObject({ positions: [], orders: [{ ticket: '2001' }] })
  })

  it('forwards quotes, bars and trade events, and follows pushed positions and orders', async () => {
    const port = await start()
    const ea = await ready(port)
    ea.event('market.tick', { ticks: [TICK, { ...TICK, bid: null }] })
    ea.event('market.bar', { bars: [BAR] })
    ea.event('trade.event', { type: 'deal_add', deal: '4002', order: '3002', position: '1001', symbol: 'EURUSD' })
    ea.event('positions.snapshot', { positions: [] })
    ea.event('orders.snapshot', { orders: [ORDER, { ...ORDER, ticket: '2002', type: 'sell_stop' }] })
    await vi.waitFor(() => expect(runtime.trading()?.orders).toHaveLength(2))
    expect(runtime.trading()?.positions).toEqual([])
    expect(data).toContainEqual({ kind: 'ticks', ticks: [expect.objectContaining({ symbol: 'EURUSD', bid: 1.07251, sessionOpen: true })] })
    expect(data).toContainEqual({ kind: 'bars', bars: [expect.objectContaining({ timeframe: 'M5', close: 1.07251 })] })
    expect(data).toContainEqual({ kind: 'trade-event', event: { type: 'deal_add', deal: '4002', order: '3002', position: '1001', symbol: 'EURUSD' } })
    expect(logs).toContainEqual(expect.objectContaining({ event: 'mt5.items-skipped', fields: expect.objectContaining({ message: 'market.tick', count: 1 }) }))
  })

  it('keeps the catalogue across a disconnect, but not positions and orders, nor for another server', async () => {
    const port = await start()
    const ea = await ready(port)
    ea.close()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('listening'))
    expect(runtime.catalog()?.symbols).toHaveLength(3)
    expect(runtime.trading()).toBeNull()
    expect(data.at(-1)).toEqual({ kind: 'trading', trading: null })
    const other = await connect(port, { ...STAGE2, server: 'Other-Demo' })
    await vi.waitFor(() => expect(runtime.catalog()).toBeNull())
    await other.syncStage2({}, { ...ACCOUNT, server: 'Other-Demo' })
    await vi.waitFor(() => expect(runtime.catalog()?.server).toBe('Other-Demo'))
    await runtime.configure({ ...PREFERENCES, mt5Enabled: false }, { safeMode: false })
    expect(runtime.catalog()).toBeNull()
  })

  it('sends the page subscriptions as one set while ready, and again to the next session', async () => {
    const port = await start()
    runtime.setSubscription({ quotes: ['EURUSD'], bars: [] })
    const ea = await connect(port, STAGE2)
    const first = await ea.syncStage2()
    expect(first.payload).toEqual({ quotes: ['EURUSD'], bars: [] })
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    runtime.setSubscription({ quotes: ['EURUSD', 'XAUUSD'], bars: [] })
    runtime.setSubscription({ quotes: ['XAUUSD'], bars: [{ symbol: 'XAUUSD', timeframe: 'M5' }] })
    const merged = await ea.serve('market.subscribe', { unknown: ['XAUUSD'] })
    expect(merged.payload).toEqual({ quotes: ['XAUUSD'], bars: [{ symbol: 'XAUUSD', timeframe: 'M5' }] })
    // The same set again sends nothing.
    runtime.setSubscription({ quotes: ['XAUUSD'], bars: [{ symbol: 'XAUUSD', timeframe: 'M5' }] })
    await new Promise(resolve => setTimeout(resolve, 120))
    expect(ea.frames.filter(frame => frame.type === 'market.subscribe')).toHaveLength(2)
    ea.close()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('listening'))
    const again = await connect(port, STAGE2)
    const resent = await again.syncStage2()
    expect(resent.payload).toEqual({ quotes: ['XAUUSD'], bars: [{ symbol: 'XAUUSD', timeframe: 'M5' }] })
  })

  it('asks again for as long as the terminal builds or downloads a series, until the EA disconnects', async () => {
    const port = await start()
    const ea = await ready(port)
    const request: Mt5HistoryBarsRequest = { symbol: 'EURUSD', timeframe: 'M5', to: 1_762_000_200_000, count: 2 }
    const bars = runtime.historyBars(request)
    await ea.serve('market.history', { pending: true })
    await ea.serve('market.history', { pending: true })
    const last = await ea.serve('market.history', { bars: [[1_762_000_000_000, 1, 2, 0.5, 1.5, 10]], no_data: false })
    expect(last.payload).toEqual(request)
    await expect(bars).resolves.toEqual({ bars: [{ time: 1_762_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }], noData: false })
    let settled = false
    const slow = runtime.historyBars(request).then(() => null, (error: unknown) => error).finally(() => { settled = true })
    // A slow network: far more retries than any fixed wait would allow.
    for (let asked = 0; asked < 30; asked++) await ea.serve('market.history', { pending: true })
    expect(settled).toBe(false)
    ea.close()
    await expect(slow).resolves.toMatchObject({ code: 'disconnected' })
  })

  it('answers a partial request with the bars there are once the series is built, and says whether more are coming', async () => {
    const port = await start()
    const ea = await ready(port)
    const request: Mt5HistoryBarsRequest = { symbol: 'EURUSD', timeframe: 'M5', to: 1_762_000_200_000, count: 2 }
    const bar = { time: 1_762_000_000_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }
    const partial = runtime.historyBars(request, { partial: true })
    // The terminal is still building the series.
    const asked = await ea.serve('market.history', { pending: true })
    expect(asked.payload).toEqual({ ...request, partial: true })
    await ea.serve('market.history', { bars: [[bar.time, 1, 2, 0.5, 1.5, 10]], no_data: false, complete: false })
    await expect(partial).resolves.toEqual({ bars: [bar], noData: false, partial: true })
    const whole = runtime.historyBars(request, { partial: true })
    await ea.serve('market.history', { bars: [[bar.time, 1, 2, 0.5, 1.5, 10]], no_data: false, complete: true })
    await expect(whole).resolves.toEqual({ bars: [bar], noData: false, partial: false })
  })

  it('reads trade history and reloads the EA, and refuses both without one', async () => {
    await expect(runtime.historyTrades({ from: 0, to: 1 })).rejects.toMatchObject({ code: 'not_connected' })
    const port = await start()
    const ea = await ready(port)
    const history = runtime.historyTrades({ from: 1_761_900_000_000, to: 1_762_000_000_000 })
    const query = await ea.serve('history.query', { orders: [HISTORY_ORDER], deals: [DEAL, DEPOSIT], truncated: false })
    expect(query.payload).toEqual({ from: 1_761_900_000_000, to: 1_762_000_000_000 })
    await expect(history).resolves.toMatchObject({ orders: [{ ticket: '3001' }], deals: [{ ticket: '4001' }, { ticket: '4000', type: 'balance' }], truncated: false })
    const reload = runtime.reload()
    await ea.serve('system.reload', {})
    await expect(reload).resolves.toBeUndefined()
  })
})

describe('trades', () => {
  const ACCOUNT_KEY = { login: '50123456', server: 'Example-Demo' }
  const BUY: Mt5TradeInput = { type: 'order.place', account: ACCOUNT_KEY, symbol: 'EURUSD', side: 'buy', orderType: 'market', volume: 0.01, price: null, sl: 1.07, tp: null }
  const DONE = { status: 'done', retcode: 10009, code: 'sent', message: 'Request executed', order: '3002', deal: '4002', price: 1.07255, volume: 0.01, duplicate: false }
  const sent = (ea: FakeEa): number => ea.frames.filter(frame => frame.type === 'order.place').length

  async function ready(port: number): Promise<FakeEa> {
    const ea = await connect(port)
    await ea.sync()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    return ea
  }

  it('sends each request once, signed and under a new id, and returns what MT5 did', async () => {
    const ea = await ready(await start())
    expect(runtime.status().disclaimer).toEqual({ version: MT5_DISCLAIMER_VERSION, acceptedAt: 1 })
    const outcome = runtime.trade(BUY)
    const request = await ea.serve('order.place')
    expect(request.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
    expect(ea.signed(request)).toEqual({
      valid: true, body: { account: ACCOUNT_KEY, symbol: 'EURUSD', side: 'buy', type: 'market', volume: 0.01, price: null, sl: 1.07, tp: null },
    })
    ea.respond(request.id!, DONE)
    await expect(outcome).resolves.toEqual({ ...DONE, id: request.id, blocked: null })
    const again = runtime.trade(BUY)
    const second = await ea.serve('order.place')
    expect(second.id).not.toBe(request.id)
    ea.respond(second.id!, { ...DONE, status: 'rejected', retcode: 10018, code: 'sent', message: 'Market is closed', order: null, deal: null, price: null, volume: null })
    await expect(again).resolves.toMatchObject({ status: 'rejected', retcode: 10018, order: null })
    expect(sent(ea)).toBe(2)
  })

  it.each([
    [{ type: 'position.close', account: ACCOUNT_KEY, symbol: 'EURUSD', ticket: '1001', volume: 0.01 }, { ticket: '1001', volume: 0.01 }],
    [{ type: 'position.modify', account: ACCOUNT_KEY, symbol: 'EURUSD', ticket: '1001', sl: null, tp: 1.08 }, { ticket: '1001', sl: null, tp: 1.08 }],
    [{ type: 'order.modify', account: ACCOUNT_KEY, symbol: 'EURUSD', ticket: '2001', price: 1.06, sl: 1.05, tp: null }, { ticket: '2001', price: 1.06, sl: 1.05, tp: null }],
    [{ type: 'order.cancel', account: ACCOUNT_KEY, symbol: 'EURUSD', ticket: '2001' }, { ticket: '2001' }],
  ] as const)('sends %o with the body the EA reads', async (input, fields) => {
    const ea = await ready(await start())
    const outcome = runtime.trade(input)
    const request = await ea.serve(input.type)
    expect(ea.signed(request)).toEqual({ valid: true, body: { account: ACCOUNT_KEY, symbol: 'EURUSD', ...fields } })
    ea.respond(request.id!, DONE)
    await expect(outcome).resolves.toMatchObject({ status: 'done' })
  })

  it('sends nothing while the gate is closed, and needs the current disclaimer agreed to', async () => {
    await expect(runtime.trade(BUY)).resolves.toMatchObject({ status: 'blocked', id: null, blocked: 'bridge-disabled' })
    const port = await start({ mt5DisclaimerVersion: 0, mt5DisclaimerAcceptedAt: 0 })
    await expect(runtime.trade(BUY)).resolves.toMatchObject({ status: 'blocked', blocked: 'ea-disconnected' })
    const ea = await ready(port)
    expect(runtime.status()).toMatchObject({ disclaimer: null, blocked: ['disclaimer'] })
    await expect(runtime.trade(BUY)).resolves.toMatchObject({ status: 'blocked', blocked: 'disclaimer' })
    // A disclaimer this build does not know is not the one the user agreed to.
    await start({ mt5DisclaimerVersion: MT5_DISCLAIMER_VERSION + 1, mt5DisclaimerAcceptedAt: 5 })
    expect(runtime.status()).toMatchObject({ disclaimer: null, blocked: ['disclaimer'] })
    await start({ mt5DisclaimerAcceptedAt: 7 })
    expect(runtime.status()).toMatchObject({ disclaimer: { version: MT5_DISCLAIMER_VERSION, acceptedAt: 7 }, blocked: [] })
    expect(sent(ea)).toBe(0)
  })

  it('takes one request at a time', async () => {
    const ea = await ready(await start())
    const first = runtime.trade(BUY)
    const request = await ea.serve('order.place')
    await expect(runtime.trade(BUY)).resolves.toMatchObject({ status: 'rejected', id: null, code: 'busy' })
    ea.respond(request.id!, DONE)
    await expect(first).resolves.toMatchObject({ status: 'done' })
    const next = runtime.trade(BUY)
    ea.respond((await ea.serve('order.place')).id!, DONE)
    await expect(next).resolves.toMatchObject({ status: 'done' })
    expect(sent(ea)).toBe(2)
  })

  it('keeps a silent EA connected while it trades, then drops it unanswered and never sends the request again', async () => {
    const port = await start()
    const ea = await ready(port)
    const started = Date.now()
    const outcome = runtime.trade(BUY)
    const request = await ea.serve('order.place')
    // Silence past the idle timeout does not end the session while the trade waits.
    await expect(outcome).resolves.toMatchObject({ status: 'unknown', id: request.id, code: 'timeout' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(850)
    await ea.ended()
    expect(runtime.status().blocked).toEqual(['ea-disconnected'])
    const again = await ready(port)
    expect(sent(ea) + sent(again)).toBe(1)
    expect(logs).toContainEqual(expect.objectContaining({ event: 'mt5.trade-result', fields: expect.objectContaining({ id: request.id, status: 'unknown', code: 'timeout' }), level: 'warn' }))
  })

  it('reports an outcome the EA did not give as unknown, and a request it refused as rejected', async () => {
    const ea = await ready(await start())
    const dropped = runtime.trade(BUY)
    const request = await ea.serve('order.place')
    ea.close()
    await expect(dropped).resolves.toMatchObject({ status: 'unknown', id: request.id, code: 'disconnected' })
    const other = await ready(runtime.status().listen!.port)
    const refused = runtime.trade(BUY)
    const forged = await other.serve('order.place')
    other.fail(forged.id!, 'bad_signature', 'The request signature does not hold')
    await expect(refused).resolves.toMatchObject({ status: 'rejected', id: forged.id, code: 'bad_signature' })
    const garbled = runtime.trade(BUY)
    other.respond((await other.serve('order.place')).id!, { status: 'maybe' })
    await expect(garbled).resolves.toMatchObject({ status: 'unknown', code: 'bad_answer' })
  })

  it('reads a symbol\'s trade rules', async () => {
    await expect(runtime.symbolInfo('EURUSD')).rejects.toMatchObject({ code: 'not_connected' })
    const ea = await ready(await start())
    const info = runtime.symbolInfo('EURUSD')
    const request = await ea.serve('symbol.info', SYMBOL_INFO)
    expect(request.payload).toEqual({ symbol: 'EURUSD' })
    await expect(info).resolves.toMatchObject({ symbol: 'EURUSD', volumeStep: 0.01, stopsLevel: 0, orderModes: ['market', 'limit', 'stop', 'sl', 'tp'], marginBuy: 214.5 })
  })
})
