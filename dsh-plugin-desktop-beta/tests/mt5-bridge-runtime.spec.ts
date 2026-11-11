/** The MT5 bridge runtime: preferences, the sync of each session, pushed updates, and the token. */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Mt5BridgeRuntime, type Mt5Preferences } from '../src/mt5/bridge-runtime.ts'
import { mt5SecretPath } from '../src/mt5/bridge-secret.ts'
import type { Mt5Status } from '../src/mt5/contract.ts'
import { ACCOUNT, FakeEa, TERMINAL } from './mt5-fixtures.ts'

const TIMINGS = { handshakeMs: 300, heartbeatMs: 60, idleMs: 600, requestMs: 300 }
/** Port 0 takes an ephemeral port; the preferences parser itself requires 1 through 65535. */
const PREFERENCES: Mt5Preferences = { mt5Enabled: true, mt5Exposure: 'loopback', mt5Port: 0, mt5AllowedAddresses: '' }

let home: string
let runtime: Mt5BridgeRuntime
let statuses: Mt5Status[]
let logs: { event: string; fields: Record<string, unknown> | undefined; level: string | undefined }[]
const eas: FakeEa[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-mt5-runtime-'))
  statuses = []
  logs = []
  runtime = new Mt5BridgeRuntime({
    home, desktopVersion: 'DSH Desktop Beta test', lanAddresses: () => ['10.0.0.9'], timings: TIMINGS,
    log: (event, fields, level) => { logs.push({ event, fields, level }) },
  })
  runtime.subscribe(status => { statuses.push(status) })
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
