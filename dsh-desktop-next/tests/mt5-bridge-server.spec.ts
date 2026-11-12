/** The MT5 bridge TLS server against scripted EAs on real loopback sockets, with short timings. */
import { networkInterfaces } from 'node:os'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mt5Proof } from '../src/mt5/bridge-auth.ts'
import { Mt5BridgeServer, Mt5RequestError, normalizeAddress, type Mt5ServerConfig, type Mt5ServerEvent } from '../src/mt5/bridge-server.ts'
import { ACCOUNT, FakeEa, HELLO, testTls, TOKEN, type LoginOptions } from './mt5-fixtures.ts'

const TIMINGS = { handshakeMs: 200, heartbeatMs: 60, idleMs: 400, requestMs: 250 }
let CONFIG: Mt5ServerConfig
beforeAll(async () => {
  CONFIG = { host: '127.0.0.1', port: 0, token: TOKEN, tls: await testTls() }
})

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

/** An EA that has completed the handshake. */
async function session(port: number, options: LoginOptions = {}): Promise<FakeEa> {
  const client = await ea(port)
  const response = await client.response(await client.login(options))
  expect(response).toMatchObject({ ok: true })
  return client
}

const kinds = (events: Mt5ServerEvent[], kind: Mt5ServerEvent['kind']) => events.filter(event => event.kind === kind)

describe('handshake', () => {
  it('opens a session over TLS once both sides prove the token, and answers with the heartbeat contract', async () => {
    const { server, events, port } = await listen()
    expect(events[0]).toEqual({ kind: 'listening', host: '127.0.0.1', port })
    const client = await ea(port)
    expect(client.fingerprint).toBe((await testTls()).fingerprint)
    const response = await client.response(await client.login())
    expect(client.desktopVerified).toBe(true)
    expect(response).toMatchObject({ v: 2, ok: true, payload: { protocol: 2, desktop: 'DSH NEXT test', heartbeat_ms: 60, idle_ms: 400 } })
    // Before the EA has proved the token, the Desktop tells it nothing but its nonce and proof.
    const greeting = client.frames.find(frame => frame.type === 'response' && frame.id !== response.id)
    expect(Object.keys(greeting?.payload ?? {}).sort()).toEqual(['nonce', 'proof', 'protocol'])
    await vi.waitFor(() => expect(server.session).not.toBeNull())
    expect(server.session).toMatchObject({ address: '127.0.0.1', hello: { login: '50123456', server: 'Example-Demo', eaVersion: '1.2.0', terminalBuild: 5120, instance: HELLO.instance } })
    expect(kinds(events, 'session-open')).toHaveLength(1)
  })

  it.each([
    ['a wrong token', (client: FakeEa) => client.login({ token: 'wrong' }), 'auth_failed', 'token'],
    ['a proof bound to another certificate, as through a man in the middle', (client: FakeEa) => client.login({ fingerprint: 'ab'.repeat(20) }), 'auth_failed', 'token'],
    ['another protocol version', (client: FakeEa) => Promise.resolve(client.hello({ protocol: 3 })), 'unsupported_protocol', 'protocol'],
    ['an invalid hello', (client: FakeEa) => Promise.resolve(client.hello({ nonce: 'abc' })), 'bad_request', 'invalid'],
    ['an invalid system.auth', (client: FakeEa) => client.login({ auth: { login: 'abc' } }), 'bad_request', 'invalid'],
  ] as const)('refuses %s with an error, then closes', async (_name, send, code, reason) => {
    const { server, events, port } = await listen()
    const client = await ea(port)
    const response = await client.response(await send(client))
    expect(response).toMatchObject({ ok: false, error: { code } })
    await client.ended()
    expect(kinds(events, 'rejected')).toEqual([expect.objectContaining({ address: '127.0.0.1', reason })])
    expect(server.session).toBeNull()
  })

  it('gives an EA with another token a Desktop proof that fails, and counts its hang-up as a token mismatch', async () => {
    const { server, events, port } = await listen({ token: 'another-token-0123456789abcdef' })
    const client = await ea(port)
    const greeting = await client.response(client.hello())
    expect(greeting).toMatchObject({ ok: true })
    const { nonce, proof } = greeting.payload as { nonce: string; proof: string }
    expect(proof).not.toBe(mt5Proof(TOKEN, 'desktop', client.nonce, nonce, client.fingerprint).toString('hex'))
    // The real EA checks the proof first and hangs up without sending its own.
    client.close()
    await vi.waitFor(() => expect(kinds(events, 'rejected')).toEqual([expect.objectContaining({ address: '127.0.0.1', reason: 'token' })]))
    expect(server.session).toBeNull()
  })

  it('refuses an EA that speaks plain TCP, as EAs older than 1.2.0 do', async () => {
    const { server, events, port } = await listen()
    const old = await FakeEa.connectPlain(port)
    eas.push(old)
    old.write({ v: 1, id: 'hello-1', type: 'system.hello', payload: { token: TOKEN, protocol: 1 } })
    await old.ended()
    await vi.waitFor(() => expect(kinds(events, 'rejected')).toEqual([expect.objectContaining({ address: '127.0.0.1', reason: 'tls' })]))
    expect(old.frames.filter(frame => frame.type === 'response')).toEqual([])
    expect(server.session).toBeNull()
    await vi.waitFor(() => expect(server.pendingCount).toBe(0))
  })

  it('closes a connection whose first frame is not a hello, or not a frame at all', async () => {
    const { events, port } = await listen()
    const ping = await ea(port)
    ping.event('system.ping')
    await ping.ended()
    const early = await ea(port)
    early.request('system.auth', { proof: '00'.repeat(32), ...HELLO })
    await early.ended()
    const garbage = await ea(port)
    garbage.writeRaw('hello\n')
    await garbage.ended()
    expect(kinds(events, 'rejected').map(event => event.kind === 'rejected' && event.reason)).toEqual(['invalid', 'invalid', 'invalid'])
  })

  it('counts a connection that never starts TLS as a TLS failure when the handshake times out', async () => {
    const { events, port } = await listen()
    const silent = await FakeEa.connectPlain(port)
    eas.push(silent)
    await silent.ended(1_000)
    expect(kinds(events, 'rejected')).toEqual([expect.objectContaining({ reason: 'tls' })])
  })

  it('closes a connection that sends no hello in time', async () => {
    const { events, port } = await listen()
    const client = await ea(port)
    await vi.waitFor(() => expect(kinds(events, 'pending')).toContainEqual({ kind: 'pending', count: 1 }))
    await client.ended(1_000)
    expect(kinds(events, 'rejected')).toEqual([expect.objectContaining({ reason: 'handshake-timeout' })])
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ kind: 'pending', count: 0 }))
  })

  it('turns away connections beyond the ones waiting to authenticate, before TLS', async () => {
    const { events, port } = await listen()
    for (let index = 0; index < 4; index++) await ea(port)
    await vi.waitFor(() => expect(kinds(events, 'pending')).toContainEqual({ kind: 'pending', count: 4 }))
    await expect(ea(port)).rejects.toThrow()
    expect(kinds(events, 'rejected')).toEqual([expect.objectContaining({ reason: 'busy' })])
  })

  it.runIf(lanAddress !== undefined)('on every interface admits an EA on another computer once it proves the token', async () => {
    const { server, events, port } = await listen({ host: '0.0.0.0' })
    const stranger = await ea(port, lanAddress)
    expect(await stranger.response(await stranger.login({ token: 'wrong' }))).toMatchObject({ ok: false, error: { code: 'auth_failed' } })
    await stranger.ended()
    expect(kinds(events, 'rejected')).toEqual([expect.objectContaining({ address: lanAddress, reason: 'token' })])
    const client = await ea(port, lanAddress)
    expect(await client.response(await client.login())).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(server.session).toMatchObject({ address: lanAddress }))
  })

  it.runIf(lanAddress !== undefined)('on loopback cannot be reached from another interface', async () => {
    const { port } = await listen()
    await expect(ea(port, lanAddress)).rejects.toThrow()
  })

  it('normalizes mapped IPv4 and IPv6 loopback addresses', () => {
    expect(normalizeAddress('::ffff:10.0.0.13')).toBe('10.0.0.13')
    expect(normalizeAddress('::1')).toBe('127.0.0.1')
    expect(normalizeAddress('10.0.0.13')).toBe('10.0.0.13')
  })
})

describe('sessions', () => {
  it('refuses another account as busy while one is connected', async () => {
    const { server, events, port } = await listen()
    const first = await session(port)
    const second = await ea(port)
    const response = await second.response(await second.login({ auth: { login: '50999999' } }))
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
    client.writeRaw('{"v":2}\n')
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

  it('signs a request with the session key when asked, and sends the others as they are', async () => {
    const { server, port } = await listen()
    const client = await session(port)
    const placed = server.request('order.place', { symbol: 'EURUSD', volume: 0.01 }, { id: 'trade-1', signed: true })
    const frame = await client.serve('order.place')
    expect(frame.id).toBe('trade-1')
    expect(Object.keys(frame.payload ?? {}).sort()).toEqual(['body', 'mac'])
    expect(client.signed(frame)).toEqual({ body: { symbol: 'EURUSD', volume: 0.01 }, valid: true })
    client.respond(frame.id!, { status: 'done' })
    await expect(placed).resolves.toEqual({ status: 'done' })
    const status = server.request('system.status', { detail: true })
    const plain = await client.serve('system.status', { ok: 1 })
    expect(plain.payload).toEqual({ detail: true })
    await expect(status).resolves.toEqual({ ok: 1 })
    // A new session has a new key: what the old one signed does not verify any more.
    const next = await session(port)
    expect(next.sessionKey).not.toEqual(client.sessionKey)
    expect(next.signed(frame).valid).toBe(false)
  })

  it('keeps a session silent while a keep-alive request waits, and closes it once that ends', async () => {
    const { server, events, port } = await listen()
    const client = await session(port)
    const trade = server.request('order.place', {}, { signed: true, keepAlive: true, timeoutMs: 900 })
    await client.serve('order.place')
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(client.closed).toBe(false)
    await expect(trade).rejects.toMatchObject({ code: 'timeout' })
    await client.ended(1_000)
    expect(kinds(events, 'session-closed')).toEqual([expect.objectContaining({ reason: 'heartbeat timeout' })])
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
    expect(await retry.response(await retry.login())).toMatchObject({ ok: false, error: { code: 'auth_failed' } })
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
