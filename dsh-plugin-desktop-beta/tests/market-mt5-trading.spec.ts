/** The market page's MT5 account: the bridge status as a trading snapshot, the gate, and the demo fallback. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectionBadge, utcOffsetText } from '../src/client/market/connection.ts'
import { createMockMarketData } from '../src/client/market/data/mock-market-data.ts'
import { createMockTrading } from '../src/client/market/data/mock-trading.ts'
import { createMt5Trading, mt5Connection } from '../src/client/market/data/mt5-trading.ts'
import type { TradeRequest } from '../src/client/market/data/trading.ts'
import type { Mt5RendererBridge, Mt5Status } from '../src/mt5/contract.ts'
import { parseAccount, parseTerminalStatus } from '../src/mt5/protocol.ts'
import { ACCOUNT, TERMINAL } from './mt5-fixtures.ts'

const READY: Mt5Status = {
  phase: 'ready', listen: { host: '0.0.0.0', port: 19500, addresses: ['10.0.0.9'] }, error: null,
  peer: { address: '10.0.0.13', port: 50123, eaVersion: '1.0.0', connectedAt: 1 },
  terminal: parseTerminalStatus(TERMINAL), account: parseAccount(ACCOUNT), blocked: [], syncedAt: 2, lastRejection: null,
}
const LISTENING: Mt5Status = { ...READY, phase: 'listening', peer: null, terminal: null, account: null, blocked: ['ea-disconnected'], syncedAt: null }
const DISABLED: Mt5Status = { ...LISTENING, phase: 'disabled', listen: null, blocked: ['bridge-disabled'] }
const ORDER: TradeRequest = { ticker: 'EURUSD', side: 'buy', type: 'market', lots: 0.1, price: null, takeProfit: null, stopLoss: null, deviation: 10, comment: '' }

/** A bridge whose status the test pushes. */
function bridge(initial: Mt5Status | null) {
  const listeners = new Set<(status: Mt5Status) => void>()
  let answer: (status: Mt5Status) => void = () => {}
  const fake: Mt5RendererBridge & { push(status: Mt5Status): void; answer(status: Mt5Status): void; listeners: number } = {
    status: vi.fn(() => initial === null ? new Promise<Mt5Status>((resolve) => { answer = resolve }) : Promise.resolve(initial)),
    onStatus: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    resync: vi.fn(async () => {}),
    request: vi.fn(async () => ({})),
    token: vi.fn(async () => 'token'),
    regenerateToken: vi.fn(async () => 'token'),
    push: (status) => { for (const listener of [...listeners]) listener(status) },
    answer: (status) => { answer(status) },
    get listeners() { return listeners.size },
  }
  return fake
}

const disposers: (() => void)[] = []
afterEach(() => { for (const dispose of disposers.splice(0)) dispose() })

function provider(initial: Mt5Status | null) {
  const market = createMockMarketData({ interval: 0 })
  const demo = createMockTrading({ market, latency: 0 })
  const fake = bridge(initial)
  const trading = createMt5Trading({ bridge: fake, demo })
  disposers.push(() => { trading.dispose(); market.dispose() })
  return { trading, fake, demo }
}

describe('createMt5Trading', () => {
  it('waits for the first status without showing an account', async () => {
    const { trading, fake } = provider(null)
    expect(trading.getSnapshot()).toMatchObject({ connection: { source: 'mt5', status: 'connecting', blocked: ['syncing'], mt5: null }, account: null, positions: [] })
    fake.answer(READY)
    await vi.waitFor(() => expect(trading.getSnapshot().connection.status).toBe('connected'))
  })

  it('shows the synced MT5 account and refuses trades while sending is not implemented', async () => {
    const { trading } = provider(READY)
    await vi.waitFor(() => expect(trading.getSnapshot().account).not.toBeNull())
    const snapshot = trading.getSnapshot()
    expect(snapshot.account).toEqual({
      login: '50123456', name: 'Demo User', server: 'Example-Demo', company: 'Example Ltd', currency: 'USD', leverage: 500, mode: 'demo',
      accounting: 'hedging', balance: 10_000, credit: 0, equity: 10_012.5, profit: 12.5, margin: 220.4, freeMargin: 9_792.1, marginLevel: 4_542.88,
    })
    expect(snapshot.connection).toMatchObject({ source: 'mt5', status: 'connected', blocked: ['unsupported'], mt5: READY })
    expect(trading.getSnapshot()).toBe(snapshot)
    await expect(trading.sendOrder(ORDER)).resolves.toEqual({ status: 'blocked', blocked: 'unsupported', retcode: null, message: '', orderTicket: null, price: null })
    await expect(trading.closePosition('1')).resolves.toMatchObject({ status: 'blocked' })
    await expect(trading.cancelOrder('1')).resolves.toMatchObject({ status: 'blocked' })
  })

  it('reports the bridge reasons first and follows status pushes', async () => {
    const { trading, fake } = provider(READY)
    const listener = vi.fn()
    trading.subscribe(listener)
    await vi.waitFor(() => expect(trading.getSnapshot().account).not.toBeNull())
    fake.push({ ...READY, blocked: ['broker-disconnected', 'real-account-locked'] })
    expect(listener).toHaveBeenCalled()
    expect(trading.getSnapshot().connection.blocked).toEqual(['broker-disconnected', 'real-account-locked'])
    await expect(trading.modifyPosition('1', { takeProfit: null, stopLoss: null })).resolves.toMatchObject({ status: 'blocked', blocked: 'broker-disconnected' })
    fake.push(LISTENING)
    expect(trading.getSnapshot()).toMatchObject({ connection: { status: 'disconnected', blocked: ['ea-disconnected'] }, account: null })
  })

  it('shows the demo account while the bridge is turned off, following its quotes only while subscribed', async () => {
    const { trading, fake, demo } = provider(DISABLED)
    await vi.waitFor(() => expect(trading.getSnapshot().connection.source).toBe('mock'))
    expect(trading.getSnapshot().connection.mt5).toEqual(DISABLED)
    expect(trading.getSnapshot().account?.login).toBe(demo.getSnapshot().account?.login)
    expect(trading.getSnapshot().positions.length).toBeGreaterThan(0)
    await expect(trading.sendOrder(ORDER)).resolves.toMatchObject({ status: 'offline' })
    const subscribe = vi.spyOn(demo, 'subscribe')
    const stop = trading.subscribe(() => {})
    expect(subscribe).toHaveBeenCalledOnce()
    fake.push(READY)
    expect(trading.getSnapshot().connection.source).toBe('mt5')
    fake.push(DISABLED)
    expect(subscribe).toHaveBeenCalledTimes(2)
    stop()
  })

  it('resyncs through the bridge and stops following it on dispose', async () => {
    const { trading, fake } = provider(READY)
    await trading.resync()
    expect(fake.resync).toHaveBeenCalledOnce()
    expect(fake.listeners).toBe(1)
    trading.dispose()
    expect(fake.listeners).toBe(0)
  })
})

describe('connection labels', () => {
  it('names each bridge state', () => {
    expect(connectionBadge({ source: 'mock', status: 'connected', blocked: [], mt5: null })).toEqual({ key: 'account.mock', tone: 'mock' })
    expect(connectionBadge(mt5Connection(null))).toEqual({ key: 'conn.waiting', tone: 'busy' })
    expect(connectionBadge(mt5Connection({ ...LISTENING, phase: 'error', error: 'EADDRINUSE' }))).toEqual({ key: 'conn.error', tone: 'error' })
    expect(connectionBadge(mt5Connection(LISTENING))).toEqual({ key: 'conn.listening', tone: 'idle' })
    expect(connectionBadge(mt5Connection({ ...LISTENING, phase: 'handshaking' }))).toEqual({ key: 'conn.handshaking', tone: 'busy' })
    expect(connectionBadge(mt5Connection({ ...READY, phase: 'syncing' }))).toEqual({ key: 'conn.syncing', tone: 'busy' })
    expect(connectionBadge(mt5Connection(READY))).toEqual({ key: 'conn.ready', tone: 'ok' })
    expect(connectionBadge(mt5Connection({ ...READY, terminal: { ...READY.terminal!, connected: false } }))).toEqual({ key: 'conn.brokerLost', tone: 'warning' })
  })

  it('writes server time zones as UTC offsets', () => {
    expect(utcOffsetText(0)).toBe('UTC+0')
    expect(utcOffsetText(7_200)).toBe('UTC+2')
    expect(utcOffsetText(19_800)).toBe('UTC+5:30')
    expect(utcOffsetText(-14_400)).toBe('UTC−4')
  })
})
