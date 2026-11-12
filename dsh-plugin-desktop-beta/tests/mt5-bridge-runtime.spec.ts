/** The MT5 bridge runtime: preferences, the sync of each session, pushed updates, market data, and the token. */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Mt5BridgeRuntime, type Mt5DataEvent, type Mt5Preferences } from '../src/mt5/bridge-runtime.ts'
import { mt5SecretPath } from '../src/mt5/bridge-secret.ts'
import type { Mt5HistoryBarsRequest, Mt5Status } from '../src/mt5/contract.ts'
import { encodeLine } from '../src/mt5/framing.ts'
import {
  ACCOUNT, BAR, DEAL, DEPOSIT, EURUSD, FakeEa, HISTORY_ORDER, ORDER, POSITION, TERMINAL, TICK,
} from './mt5-fixtures.ts'

const TIMINGS = { handshakeMs: 300, heartbeatMs: 60, idleMs: 600, requestMs: 300 }
/** Port 0 takes an ephemeral port; the preferences parser itself requires 1 through 65535. */
const PREFERENCES: Mt5Preferences = { mt5Enabled: true, mt5Exposure: 'loopback', mt5Port: 0, mt5AllowedAddresses: '' }

let home: string
let runtime: Mt5BridgeRuntime
let statuses: Mt5Status[]
let logs: { event: string; fields: Record<string, unknown> | undefined; level: string | undefined }[]
let data: Mt5DataEvent[]
const eas: FakeEa[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-mt5-runtime-'))
  statuses = []
  logs = []
  data = []
  runtime = new Mt5BridgeRuntime({
    home, desktopVersion: 'DSH Desktop Beta test', lanAddresses: () => ['10.0.0.9'], timings: TIMINGS, history: { retryMs: 20 },
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

/** An EA connected with the runtime's own token. */
async function connect(port: number, overrides: Record<string, unknown> = {}): Promise<FakeEa> {
  const ea = await FakeEa.connect(port)
  eas.push(ea)
  ea.hello({ token: runtime.token(), ...overrides })
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
      peer: { address: '127.0.0.1', eaVersion: '1.0.0' },
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
  const STAGE2 = { ea_version: '1.1.0' }

  /** A 1.1.0 EA through a full sync. */
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
    await ea.sync()
    const pages = await ea.serveCatalog([EURUSD, ...many], ['SYM0003', 'EURUSD', 'GONE'])
    expect(pages.map(page => page.payload)).toEqual([{ offset: 0, limit: 500 }, { offset: 500, limit: 500 }, { offset: 1000, limit: 500 }])
    await ea.serve('positions.snapshot', { positions: [POSITION] })
    expect(runtime.status().phase).toBe('syncing')
    await ea.serve('orders.snapshot', { orders: [ORDER] })
    const subscribe = await ea.serve('market.subscribe', { unknown: [] })
    expect(subscribe.payload).toEqual({ quotes: [], bars: [] })
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    expect(runtime.status()).toMatchObject({ eaOutdated: false, peer: { eaVersion: '1.1.0' }, blocked: [] })
    const catalog = runtime.catalog()
    expect(catalog?.server).toBe('Example-Demo')
    expect(catalog?.symbols).toHaveLength(1002)
    // The Market Watch order, without names the catalogue lacks.
    expect(catalog?.watch).toEqual(['SYM0003', 'EURUSD'])
    expect(runtime.trading()).toMatchObject({ positions: [{ ticket: '1001', side: 'buy' }], orders: [{ ticket: '2001', type: 'buy_limit' }] })
    expect(data.map(event => event.kind)).toEqual(['catalog', 'trading'])
    expect(logs).toContainEqual(expect.objectContaining({ event: 'mt5.synced', fields: expect.objectContaining({ symbols: 1002, positions: 1, orders: 1 }) }))
  })

  it('serves only the account to an EA older than 1.1.0, and says it is out of date', async () => {
    const port = await start()
    const ea = await connect(port)
    await ea.sync()
    await vi.waitFor(() => expect(runtime.status().phase).toBe('ready'))
    expect(runtime.status()).toMatchObject({ eaOutdated: true, account: { login: '50123456' } })
    expect(runtime.catalog()).toBeNull()
    expect(runtime.trading()).toBeNull()
    expect(ea.frames.map(frame => frame.type)).not.toContain('symbols.list')
    await expect(runtime.historyBars({ symbol: 'EURUSD', timeframe: 'M5', to: 1, count: 1 })).rejects.toMatchObject({ code: 'ea_outdated' })
    expect(logs).toContainEqual(expect.objectContaining({ event: 'mt5.ea-outdated', level: 'warn' }))
  })

  it('never lets a sync answer replace a value the EA pushed after it', async () => {
    const port = await start()
    const ea = await connect(port, STAGE2)
    await ea.sync()
    await ea.serveCatalog()
    // The answer and a newer push arrive in one read, before the sync gets to use the answer.
    const positions = await ea.serve('positions.snapshot')
    ea.writeRaw(`${encodeLine({ v: 1, id: positions.id, type: 'response', ok: true, payload: { positions: [POSITION] } }).toString()}${
      encodeLine({ v: 1, type: 'positions.snapshot', payload: { positions: [] } }).toString()}`)
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
