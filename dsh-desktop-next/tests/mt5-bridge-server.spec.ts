/** The MT5 bridge TCP server against scripted EAs on real loopback sockets, with short timings. */
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Mt5BridgeServer, Mt5RequestError, normalizeAddress, tokensMatch, type Mt5ServerConfig, type Mt5ServerEvent } from '../src/mt5/bridge-server.ts'
import { ACCOUNT, FakeEa, TOKEN } from './mt5-fixtures.ts'

const TIMINGS = { handshakeMs: 200, heartbeatMs: 60, idleMs: 400, requestMs: 250 }
const CONFIG: Mt5ServerConfig = { host: '127.0.0.1', port: 0, allowedAddresses: [], token: TOKEN }

/** A non-loopback IPv4 address of this machine, so a connection can come from outside the loopback. */
const lanAddress = Object.values(networkInterfaces()).flat().find(entry => entry !== undefined && entry.family === 'IPv4' && !entry.internal)?.address

const servers: Mt5BridgeServer[] = []
const eas: FakeEa[] = []
afterEach(async () => {
  for (const ea of eas.splice(0)) ea.close()
  await Promise.all(servers.splice(0).map(server => server.stop()))
})

async function listen(config: Partial<Mt5ServerConfig> = {}): Promise<{ server: Mt5BridgeServer; events: Mt5ServerEvent[]; port: number }> {
  const server = new Mt5BridgeServer({ desktopVersion: 'DSH NEXT test', timings: TIMINGS })
  servers.push(server)
  const events: Mt5ServerEvent[] = []
  server.subscribe(event => { events.push(event) })
  await server.start({ ...CONFIG, ...config })
  const bound = server.address()
  if (bound === null) throw new Error('the server did not listen')
  return { server, events, port: bound.port }
}

async function ea(port: number, host?: string): Promise<FakeEa> {
  const client = await FakeEa.connect(port, host)
  eas.push(client)
  return client
}

/** An EA that has completed its hello. */
async function session(port: number, overrides: Record<string, unknown> = {}): Promise<FakeEa> {
  const client = await ea(port)
  const response = await client.response(client.hello(overrides))
  expect(response).toMatchObject({ ok: true })
  return client
}

const kinds = (events: Mt5ServerEvent[], kind: Mt5ServerEvent['kind']) => events.filter(event => event.kind === kind)

describe('handshake', () => {
  it('opens a session for the right token and answers the hello with the heartbeat contract', async () => {
    const { server, events, port } = await listen()
    expect(events[0]).toEqual({ kind: 'listening', host: '127.0.0.1', port })
    const client = await ea(port)
    const response = await client.response(client.hello())
    expect(response).toMatchObject({ v: 1, ok: true, payload: { protocol: 1, desktop: 'DSH NEXT test', heartbeat_ms: 60, idle_ms: 400 } })
    await vi.waitFor(() => expect(server.session).not.toBeNull())
    expect(server.session).toMatchObject({ address: '127.0.0.1', hello: { login: '50123456', server: 'Example-Demo', eaVersion: '1.0.0', terminalBuild: 5120 } })
    expect(kinds(events, 'session-open')).toHaveLength(1)
  })

  it.each([
    ['a wrong token', { token: 'wrong' }, 'auth_failed', 'token'],
    ['another protocol version', { protocol: 2 }, 'unsupported_protocol', 'protocol'],
    ['an invalid hello', { login: 'abc' }, 'bad_request', 'invalid'],
  ] as const)('refuses %s with an error, then closes', async (_name, overrides, code, reason) => {
    const { server, events, port } = await listen()
    const client = await ea(port)
    const response = await client.response(client.hello(overrides))
    expect(response).toMatchObject({ ok: false, error: { code } })
    await client.ended()
    expect(kinds(events, 'rejected')).toEqual([expect.objectContaining({ address: '127.0.0.1', reason })])
    expect(server.session).toBeNull()
  })

  it('closes a connection whose first frame is not a hello, or not a frame at all', async () => {
    const { events, port } = await listen()
    const ping = await ea(port)
    ping.event('system.ping')
    await ping.ended()
    const garbage = await ea(port)
    garbage.writeRaw('hello\n')
    await garbage.ended()
    expect(kinds(events, 'rejected').map(event => event.kind === 'rejected' && event.reason)).toEqual(['invalid', 'invalid'])
  })

  it('closes a connection that sends no hello in time', async () => {
    const { events, port } = await listen()
    const client = await ea(port)
    await vi.waitFor(() => expect(kinds(events, 'pending')).toContainEqual({ kind: 'pending', count: 1 }))
    await client.ended(1_000)
    expect(kinds(events, 'rejected')).toEqual([expect.objectContaining({ reason: 'handshake-timeout' })])
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ kind: 'pending', count: 0 }))
  })

  it('turns away connections beyond the ones waiting to authenticate', async () => {
    const { events, port } = await listen()
    for (let index = 0; index < 4; index++) await ea(port)
    await vi.waitFor(() => expect(kinds(events, 'pending')).toContainEqual({ kind: 'pending', count: 4 }))
    const extra = await ea(port)
    await extra.ended()
    expect(kinds(events, 'rejected')).toEqual([expect.objectContaining({ reason: 'busy' })])
  })

  it.runIf(lanAddress !== undefined)('admits only allowed addresses besides loopback', async () => {
    const { events, port } = await listen({ host: '0.0.0.0', allowedAddresses: ['192.0.2.1'] })
    const outsider = await ea(port, lanAddress)
    await outsider.ended()
    expect(kinds(events, 'rejected')).toEqual([expect.objectContaining({ address: lanAddress, reason: 'address' })])
    await session(port)
  })

  it('normalizes mapped IPv4 and IPv6 loopback addresses and compares tokens exactly', () => {
    expect(normalizeAddress('::ffff:10.0.0.13')).toBe('10.0.0.13')
    expect(normalizeAddress('::1')).toBe('127.0.0.1')
    expect(normalizeAddress('10.0.0.13')).toBe('10.0.0.13')
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true)
    expect(tokensMatch(`${TOKEN} `, TOKEN)).toBe(false)
    expect(tokensMatch('', '')).toBe(false)
  })
})

describe('sessions', () => {
  it('refuses another account as busy while one is connected', async () => {
    const { server, events, port } = await listen()
    const first = await session(port)
    const second = await ea(port)
    const response = await second.response(second.hello({ login: '50999999' }))
    expect(response).toMatchObject({ ok: false, error: { code: 'busy' } })
    await second.ended()
    expect(first.closed).toBe(false)
    expect(server.session?.hello.login).toBe('50123456')
    expect(kinds(events, 'rejected')).toEqual([expect.objectContaining({ reason: 'busy' })])
  })

  it('lets a reconnecting EA of the same account replace the session it left behind', async () => {
    const { server, events, port } = await listen()
    const first = await session(port)
    const firstId = server.session?.id
    await session(port)
    await first.ended()
    await vi.waitFor(() => expect(kinds(events, 'session-closed')).toHaveLength(1))
    expect(kinds(events, 'session-closed')[0]).toMatchObject({ session: { id: firstId }, reason: 'replaced by a new connection of the same account' })
    expect(server.session?.id).not.toBe(firstId)
  })

  it('pings the EA and keeps a session that answers alive past the idle timeout', async () => {
    const { server, port } = await listen()
    const client = await session(port)
    await client.next(frame => frame.type === 'system.ping')
    const keepAlive = setInterval(() => { client.event('system.ping') }, 50)
    try {
      await new Promise(resolve => setTimeout(resolve, 600))
      expect(client.closed).toBe(false)
      expect(server.session).not.toBeNull()
    } finally { clearInterval(keepAlive) }
  })

  it('closes a session that stays silent for the idle timeout', async () => {
    const { server, events, port } = await listen()
    const client = await session(port)
    await client.ended(1_500)
    await vi.waitFor(() => expect(kinds(events, 'session-closed')).toEqual([expect.objectContaining({ reason: 'heartbeat timeout' })]))
    expect(server.session).toBeNull()
  })

  it('reports EA events except pings, and answers EA requests it does not serve', async () => {
    const { events, port } = await listen()
    const client = await session(port)
    client.event('system.ping')
    client.event('account.snapshot', ACCOUNT)
    await vi.waitFor(() => expect(kinds(events, 'event')).toHaveLength(1))
    expect(kinds(events, 'event')[0]).toMatchObject({ type: 'account.snapshot', payload: { login: '50123456' } })
    const response = await client.response(client.request('market.subscribe'))
    expect(response).toMatchObject({ ok: false, error: { code: 'unknown_type' } })
  })

  it('reports a malformed frame from a session without dropping it', async () => {
    const { events, port } = await listen()
    const client = await session(port)
    client.writeRaw('{"v":1}\n')
    await vi.waitFor(() => expect(kinds(events, 'protocol-error')).toHaveLength(1))
    expect(client.closed).toBe(false)
  })
})

describe('requests', () => {
  it('resolves with the EA answer and rejects with its error', async () => {
    const { server, port } = await listen()
    const client = await session(port)
    const status = server.request('system.status')
    await client.serve('system.status', { ok: 1 })
    await expect(status).resolves.toEqual({ ok: 1 })
    const failed = server.request('account.snapshot')
    const frame = await client.serve('account.snapshot')
    client.fail(frame.id!, 'not_ready', 'terminal still loading')
    await expect(failed).rejects.toMatchObject({ name: 'Mt5RequestError', code: 'not_ready', message: 'terminal still loading' })
  })

  it('times out unanswered requests and fails pending ones when the session ends', async () => {
    const { server, port } = await listen()
    const client = await session(port)
    await expect(server.request('system.status', {}, { timeoutMs: 50 })).rejects.toMatchObject({ code: 'timeout' })
    const pending = server.request('system.status')
    await client.serve('system.status')
    client.close()
    await expect(pending).rejects.toMatchObject({ code: 'disconnected' })
    await expect(server.request('system.status')).rejects.toBeInstanceOf(Mt5RequestError)
  })

  it('refuses a request id already in flight', async () => {
    const { server, port } = await listen()
    await session(port)
    const first = server.request('system.status', {}, { id: 'same', timeoutMs: 100 })
    await expect(server.request('system.status', {}, { id: 'same' })).rejects.toMatchObject({ code: 'duplicate_id' })
    await expect(first).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('configuration', () => {
  it('drops every connection when the token changes and keeps listening on the same port', async () => {
    const { server, events, port } = await listen()
    const client = await session(port)
    // The same requested host and port (an ephemeral one here) keeps the listening socket.
    await server.start({ ...CONFIG, token: 'another-token' })
    await client.ended()
    expect(server.address()?.port).toBe(port)
    expect(kinds(events, 'listening')).toHaveLength(1)
    const retry = await ea(port)
    expect(await retry.response(retry.hello())).toMatchObject({ ok: false, error: { code: 'auth_failed' } })
  })

  it('reports a port it cannot take, then listens once started again', async () => {
    const { port } = await listen()
    const second = new Mt5BridgeServer({ desktopVersion: 'test', timings: TIMINGS })
    servers.push(second)
    const events: Mt5ServerEvent[] = []
    second.subscribe(event => { events.push(event) })
    await second.start({ ...CONFIG, port })
    expect(events).toEqual([expect.objectContaining({ kind: 'listen-error' })])
    expect(second.address()).toBeNull()
    await second.start({ ...CONFIG, port: 0 })
    expect(second.address()).not.toBeNull()
  })

  it('closes sessions and stops listening on stop', async () => {
    const { server, events, port } = await listen()
    const client = await session(port)
    await server.stop()
    await client.ended()
    expect(server.address()).toBeNull()
    expect(events.map(event => event.kind)).toContain('stopped')
    await expect(FakeEa.connect(port)).rejects.toThrow()
  })
})
