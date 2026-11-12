/**
 * TLS server the DshBridge EA connects to; the EA is the client because MQL5 sockets cannot
 * listen. The host decides who can reach it: `127.0.0.1` an EA on this computer only, `0.0.0.0`
 * one on any computer. Either way a connection must finish TLS and authenticate both ways within
 * the handshake timeout (protocol 2, `mt5/PROTOCOL.md`), so only an EA that holds the token gets
 * a session: `system.hello` carries the EA's nonce and gets the Desktop's nonce and proof,
 * then `system.auth` carries the EA's proof and identity. Neither proof reveals the token, and both
 * bind the certificate fingerprint the EA saw, so a man in the middle convinces neither side.
 *
 * One authenticated session exists at a time: another account's EA is refused as busy, and a new
 * connection of the same account replaces a session the old EA left behind. After the handshake
 * both sides ping every heartbeat interval, and a session silent for the idle timeout is closed,
 * unless a request that keeps it alive is waiting: MT5 runs a trade synchronously, and the EA
 * cannot ping meanwhile. Responses and events carry the sequence number of their frame, so a
 * caller can tell which of two arrived later.
 */
import { randomUUID } from 'node:crypto'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { createServer as createTlsServer, type Server as TlsServer, type TLSSocket } from 'node:tls'
import { mt5Nonce, mt5Proof, mt5ProofMatches, mt5SignedPayload } from './bridge-auth.ts'
import type { Mt5TlsIdentity } from './bridge-tls.ts'
import type { Mt5RejectReason } from './contract.ts'
import { encodeLine, Mt5LineDecoder } from './framing.ts'
import {
  errorFrame, eventFrame, MT5_PROTOCOL_VERSION, okFrame, parseAuth, parseFrame, parseGreeting, requestFrame,
  type Mt5Auth, type Mt5Frame, type Mt5Greeting, type Mt5Hello, type Mt5Payload,
} from './protocol.ts'

export interface Mt5ServerConfig {
  host: string
  port: number
  token: string
  tls: Pick<Mt5TlsIdentity, 'cert' | 'key' | 'fingerprint'>
}

export interface Mt5ServerTimings {
  handshakeMs: number
  heartbeatMs: number
  idleMs: number
  requestMs: number
}

export const MT5_SERVER_TIMINGS: Readonly<Mt5ServerTimings> = Object.freeze({ handshakeMs: 5_000, heartbeatMs: 5_000, idleMs: 15_000, requestMs: 10_000 })

/** The authenticated EA. */
export interface Mt5Session {
  readonly id: number
  readonly address: string
  readonly port: number
  readonly hello: Mt5Hello
  /** Unix ms. */
  readonly connectedAt: number
}

export type Mt5ServerEvent =
  | { kind: 'listening'; host: string; port: number }
  | { kind: 'stopped' }
  | { kind: 'listen-error'; message: string }
  /** The number of connections waiting to authenticate changed. */
  | { kind: 'pending'; count: number }
  | { kind: 'rejected'; address: string; reason: Mt5RejectReason; detail: string }
  | { kind: 'session-open'; session: Mt5Session }
  | { kind: 'session-closed'; session: Mt5Session; reason: string }
  /** `seq` orders this event among the session's events and responses. */
  | { kind: 'event'; session: Mt5Session; type: string; payload: Mt5Payload; seq: number }
  /** An authenticated session sent a frame that breaks the protocol; it was dropped. */
  | { kind: 'protocol-error'; session: Mt5Session; detail: string }

/** A request the EA failed, or that never got an answer. */
export class Mt5RequestError extends Error {
  readonly code: string
  readonly retcode: number | undefined
  constructor(code: string, message: string, retcode?: number) {
    super(message)
    this.name = 'Mt5RequestError'
    this.code = code
    this.retcode = retcode
  }
}

export interface Mt5RequestOptions {
  /** Request id; trade requests pass their journal id so a resend is recognized. */
  id?: string
  timeoutMs?: number
  /** Sign the payload with the session key, as the EA requires of trade requests. */
  signed?: boolean
  /** While this request waits, silence does not close the session; the request's own timeout still applies. */
  keepAlive?: boolean
}

/** A response payload, and the sequence number of its frame. */
export interface Mt5Answer {
  payload: Mt5Payload
  /** Frames arrive in the order the EA sent them: a higher number is newer. */
  seq: number
}

const MAX_PENDING_CONNECTIONS = 4
/** Output a peer may leave unread before the session is dropped. */
const MAX_WRITE_BUFFER = 16 * 1024 * 1024
const KEEPALIVE_MS = 10_000
/** How long a refused connection gets to read its error before it is destroyed. */
const LINGER_MS = 1_000

interface Pending {
  resolve(answer: Mt5Answer): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  keepAlive: boolean
}

type Stage = 'tls' | 'hello' | 'auth' | 'ready'

class Connection {
  readonly decoder = new Mt5LineDecoder()
  readonly pending = new Map<string, Pending>()
  /** The TLS socket once TLS is up; the TCP socket before. */
  socket: Socket
  stage: Stage = 'tls'
  eaNonce = ''
  desktopNonce = ''
  /** Key of the session's signed requests. */
  sessionKey: Buffer | undefined
  session: Mt5Session | undefined
  handshakeTimer: NodeJS.Timeout | undefined
  heartbeatTimer: NodeJS.Timeout | undefined
  idleTimer: NodeJS.Timeout | undefined
  closeReason: string | undefined
  closed = false
  constructor(readonly tcp: Socket, readonly address: string, readonly port: number) {
    this.socket = tcp
  }
}

/** `::ffff:10.0.0.13` and `::1` in the IPv4 form that Settings and the log show. */
export function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address)
  if (mapped !== null) return mapped[1]!
  return address === '::1' ? '127.0.0.1' : address
}

const peerKey = (address: string, port: number | undefined): string => `${address}|${String(port ?? 0)}`

export class Mt5BridgeServer {
  private readonly timings: Mt5ServerTimings
  private readonly now: () => number
  private readonly listeners = new Set<(event: Mt5ServerEvent) => void>()
  private readonly connections = new Set<Connection>()
  /** Connections in their TLS handshake, by remote address and port. */
  private readonly securing = new Map<string, Connection>()
  private server: Server | undefined
  private tls: TlsServer | undefined
  private bound: { host: string; port: number } | undefined
  private config: Mt5ServerConfig | undefined
  private active: Connection | undefined
  private sessions = 0
  /** Sequence number of the last frame an authenticated session sent. */
  private frames = 0
  /** Start and stop calls apply one at a time, in order. */
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: { desktopVersion: string; timings?: Partial<Mt5ServerTimings>; now?: () => number }) {
    this.timings = { ...MT5_SERVER_TIMINGS, ...options.timings }
    this.now = options.now ?? Date.now
  }

  subscribe(listener: (event: Mt5ServerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** The bound address, while listening. */
  address(): { host: string; port: number } | null {
    return this.bound ?? null
  }

  /** The authenticated session, if any. */
  get session(): Mt5Session | null {
    return this.active?.session ?? null
  }

  /** Connections still authenticating, TLS included. */
  get pendingCount(): number {
    let count = 0
    for (const connection of this.connections) if (connection.session === undefined) count++
    return count
  }

  /**
   * Listen with `config`. The same host and port keep the socket, and a new token or
   * certificate drops every connection.
   */
  start(config: Mt5ServerConfig): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.config
      this.config = config
      if (this.server !== undefined && previous !== undefined && previous.host === config.host && previous.port === config.port) {
        const renewed = previous.tls.fingerprint !== config.tls.fingerprint
        if (renewed) this.tls?.setSecureContext(this.secureOptions(config))
        for (const connection of [...this.connections]) {
          if (previous.token !== config.token) this.close(connection, 'the bridge token changed')
          else if (renewed) this.close(connection, 'the bridge certificate changed')
        }
        return
      }
      await this.closeServer()
      await this.listen(config)
    })
  }

  /** Close every connection and stop listening. */
  stop(): Promise<void> {
    return this.enqueue(async () => {
      this.config = undefined
      await this.closeServer()
    })
  }

  /** Close the authenticated session; the EA reconnects on its own. */
  disconnect(reason: string): void {
    if (this.active !== undefined) this.close(this.active, reason)
  }

  /**
   * Send a request to the authenticated EA.
   * @returns the response payload.
   * @throws Mt5RequestError when no EA is connected, the EA fails the request, it times out, or the session ends first.
   */
  request(type: string, payload: Mt5Payload = {}, options: Mt5RequestOptions = {}): Promise<Mt5Payload> {
    return this.exchange(type, payload, options).then(answer => answer.payload)
  }

  /**
   * Like `request`, with the sequence number of the response frame.
   * @throws Mt5RequestError when no EA is connected, the EA fails the request, it times out, or the session ends first.
   */
  exchange(type: string, payload: Mt5Payload = {}, options: Mt5RequestOptions = {}): Promise<Mt5Answer> {
    const connection = this.active
    if (connection === undefined || connection.closed || connection.sessionKey === undefined) return Promise.reject(new Mt5RequestError('not_connected', 'No EA is connected'))
    const id = options.id ?? randomUUID()
    if (connection.pending.has(id)) return Promise.reject(new Mt5RequestError('duplicate_id', `Request ${id} is already in flight`))
    const wire = options.signed === true ? mt5SignedPayload(connection.sessionKey, id, type, payload) : payload
    return new Promise<Mt5Answer>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id)
        reject(new Mt5RequestError('timeout', `${type} got no answer`))
      }, options.timeoutMs ?? this.timings.requestMs)
      connection.pending.set(id, { resolve, reject, timer, keepAlive: options.keepAlive === true })
      if (!this.send(connection, requestFrame(id, type, wire))) {
        clearTimeout(timer)
        connection.pending.delete(id)
        reject(new Mt5RequestError('not_connected', 'The EA connection closed'))
      }
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.queue.then(operation)
    this.queue = next.catch(() => {})
    return next
  }

  private emit(event: Mt5ServerEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  private secureOptions(config: Mt5ServerConfig): { cert: string; key: string; minVersion: 'TLSv1.2' } {
    return { cert: config.tls.cert, key: config.tls.key, minVersion: 'TLSv1.2' }
  }

  private listen(config: Mt5ServerConfig): Promise<void> {
    return new Promise((resolve) => {
      // TCP accepts and screens the connection; TLS takes over the ones admitted. Our own
      // handshake timer, started at accept, fires before the TLS layer's.
      const tls = createTlsServer({ ...this.secureOptions(config), handshakeTimeout: this.timings.handshakeMs + LINGER_MS })
      tls.on('secureConnection', (socket: TLSSocket) => { this.secured(socket) })
      tls.on('tlsClientError', (error: Error & { code?: string }, socket: TLSSocket) => { this.insecure(error, socket) })
      const server = createServer(socket => { this.accept(socket) })
      const failed = (error: Error): void => {
        server.removeListener('listening', listening)
        this.emit({ kind: 'listen-error', message: error.message })
        resolve()
      }
      const listening = (): void => {
        server.removeListener('error', failed)
        // Accept errors after listening concern single sockets, which report on their own.
        server.on('error', () => {})
        this.server = server
        this.tls = tls
        this.bound = { host: config.host, port: (server.address() as AddressInfo).port }
        this.emit({ kind: 'listening', ...this.bound })
        resolve()
      }
      server.once('error', failed)
      server.once('listening', listening)
      server.listen({ host: config.host, port: config.port, exclusive: true })
    })
  }

  private async closeServer(): Promise<void> {
    const server = this.server
    for (const connection of [...this.connections]) this.close(connection, 'the bridge stopped')
    if (server === undefined) return
    this.server = undefined
    this.tls = undefined
    this.bound = undefined
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    this.emit({ kind: 'stopped' })
  }

  private reject(address: string, reason: Mt5RejectReason, detail: string): void {
    this.emit({ kind: 'rejected', address, reason, detail })
  }

  private accept(socket: Socket): void {
    const address = normalizeAddress(socket.remoteAddress ?? '')
    if (this.config === undefined || this.tls === undefined) { socket.destroy(); return }
    if (this.pendingCount >= MAX_PENDING_CONNECTIONS) {
      this.reject(address, 'busy', 'too many connections are waiting to authenticate')
      socket.destroy()
      return
    }
    socket.setNoDelay(true)
    socket.setKeepAlive(true, KEEPALIVE_MS)
    const connection = new Connection(socket, address, socket.remotePort ?? 0)
    this.connections.add(connection)
    this.securing.set(peerKey(address, connection.port), connection)
    connection.handshakeTimer = setTimeout(() => {
      if (connection.stage === 'tls') this.reject(address, 'tls', 'the TLS handshake did not finish in time')
      else this.reject(address, 'handshake-timeout', 'the EA did not authenticate in time')
      this.close(connection, 'handshake timeout')
    }, this.timings.handshakeMs)
    // 'close' always follows and settles the connection.
    socket.on('error', () => {})
    socket.on('close', () => { this.settle(connection) })
    this.emit({ kind: 'pending', count: this.pendingCount })
    this.tls.emit('connection', socket)
  }

  /** TLS is up: the protocol handshake starts. */
  private secured(socket: TLSSocket): void {
    const key = peerKey(normalizeAddress(socket.remoteAddress ?? ''), socket.remotePort)
    const connection = this.securing.get(key)
    this.securing.delete(key)
    if (connection === undefined || connection.closed || connection.closeReason !== undefined) { socket.destroy(); return }
    connection.socket = socket
    connection.stage = 'hello'
    socket.on('data', (chunk: Buffer) => { this.receive(connection, chunk) })
    socket.on('error', () => {})
    socket.on('close', () => { this.settle(connection) })
  }

  /** TLS failed, typically because an EA older than 1.2.0 speaks plain TCP. */
  private insecure(error: Error & { code?: string }, socket: TLSSocket): void {
    const connection = this.securing.get(peerKey(normalizeAddress(socket.remoteAddress ?? ''), socket.remotePort))
    socket.destroy()
    if (connection === undefined || connection.closed || connection.closeReason !== undefined) return
    this.reject(connection.address, 'tls', `TLS handshake failed: ${error.code ?? error.message}`)
    this.close(connection, 'TLS handshake failed')
  }

  private receive(connection: Connection, chunk: Buffer): void {
    let lines: string[]
    try { lines = connection.decoder.push(chunk) } catch (error) {
      this.violation(connection, error)
      return
    }
    for (const line of lines) {
      if (connection.closed || connection.closeReason !== undefined) return
      let frame: Mt5Frame
      try { frame = parseFrame(line) } catch (error) {
        if (connection.session === undefined) { this.violation(connection, error); return }
        this.emit({ kind: 'protocol-error', session: connection.session, detail: errorText(error) })
        continue
      }
      connection.idleTimer?.refresh()
      if (connection.session === undefined) this.handshake(connection, frame)
      else this.dispatch(connection, connection.session, frame)
    }
  }

  /** A frame too long, or an invalid frame before authentication, ends the connection. */
  private violation(connection: Connection, error: unknown): void {
    if (connection.session === undefined) this.reject(connection.address, 'invalid', errorText(error))
    else this.emit({ kind: 'protocol-error', session: connection.session, detail: errorText(error) })
    this.close(connection, `protocol violation: ${errorText(error)}`)
  }

  /** Answer with an error, then close once the answer is flushed. */
  private refuse(connection: Connection, id: string, code: string, message: string, reason: Mt5RejectReason): void {
    this.reject(connection.address, reason, message)
    this.send(connection, errorFrame(id, { code, message }))
    connection.closeReason ??= message
    connection.socket.end()
    setTimeout(() => { connection.socket.destroy() }, LINGER_MS).unref()
  }

  private handshake(connection: Connection, frame: Mt5Frame): void {
    const config = this.config
    const expected = connection.stage === 'hello' ? 'system.hello' : 'system.auth'
    if (config === undefined || frame.kind !== 'request' || frame.type !== expected) {
      this.reject(connection.address, 'invalid', `expected ${expected}, got ${frame.kind === 'response' ? 'a response' : frame.type}`)
      this.close(connection, `the EA did not send ${expected}`)
      return
    }
    if (connection.stage === 'hello') {
      let greeting: Mt5Greeting
      try { greeting = parseGreeting(frame.payload) } catch (error) {
        this.refuse(connection, frame.id, 'bad_request', errorText(error), 'invalid')
        return
      }
      if (greeting.protocol !== MT5_PROTOCOL_VERSION) {
        this.refuse(connection, frame.id, 'unsupported_protocol', `The Desktop speaks protocol ${String(MT5_PROTOCOL_VERSION)}, the EA ${String(greeting.protocol)}`, 'protocol')
        return
      }
      connection.eaNonce = greeting.nonce
      connection.desktopNonce = mt5Nonce()
      connection.stage = 'auth'
      const proof = mt5Proof(config.token, 'desktop', connection.eaNonce, connection.desktopNonce, config.tls.fingerprint)
      this.send(connection, okFrame(frame.id, { protocol: MT5_PROTOCOL_VERSION, nonce: connection.desktopNonce, proof: proof.toString('hex') }))
      return
    }
    let auth: Mt5Auth
    try { auth = parseAuth(frame.payload) } catch (error) {
      this.refuse(connection, frame.id, 'bad_request', errorText(error), 'invalid')
      return
    }
    const expectedProof = mt5Proof(config.token, 'ea', connection.eaNonce, connection.desktopNonce, config.tls.fingerprint)
    if (config.token === '' || !mt5ProofMatches(auth.proof, expectedProof)) {
      this.refuse(connection, frame.id, 'auth_failed', 'The EA did not prove the Desktop bridge token', 'token')
      return
    }
    const hello = auth.hello
    const current = this.active
    if (current !== undefined && current !== connection && current.session !== undefined) {
      const sameAccount = current.session.hello.login === hello.login && current.session.hello.server === hello.server
      if (!sameAccount) {
        this.refuse(connection, frame.id, 'busy', `Account ${current.session.hello.login} on ${current.session.hello.server} is already connected`, 'busy')
        return
      }
      // The old EA is gone (restarted, or its connection is half open); the new one takes over.
      this.close(current, 'replaced by a new connection of the same account')
    }
    clearTimeout(connection.handshakeTimer)
    connection.handshakeTimer = undefined
    connection.stage = 'ready'
    connection.sessionKey = mt5Proof(config.token, 'session', connection.eaNonce, connection.desktopNonce, config.tls.fingerprint)
    const session: Mt5Session = { id: ++this.sessions, address: connection.address, port: connection.port, hello, connectedAt: this.now() }
    connection.session = session
    this.active = connection
    this.send(connection, okFrame(frame.id, {
      protocol: MT5_PROTOCOL_VERSION, desktop: this.options.desktopVersion,
      heartbeat_ms: this.timings.heartbeatMs, idle_ms: this.timings.idleMs,
    }))
    connection.heartbeatTimer = setInterval(() => { this.send(connection, eventFrame('system.ping', { time: this.now() })) }, this.timings.heartbeatMs)
    connection.idleTimer = setTimeout(() => { this.idle(connection) }, this.timings.idleMs)
    // The session first: a listener between the two events must not see neither connection.
    this.emit({ kind: 'session-open', session })
    this.emit({ kind: 'pending', count: this.pendingCount })
  }

  /** The session was silent for the idle timeout: close it, unless a trade is still executing. */
  private idle(connection: Connection): void {
    for (const pending of connection.pending.values()) {
      if (!pending.keepAlive) continue
      connection.idleTimer?.refresh()
      return
    }
    this.close(connection, 'heartbeat timeout')
  }

  private dispatch(connection: Connection, session: Mt5Session, frame: Mt5Frame): void {
    const seq = ++this.frames
    switch (frame.kind) {
      case 'response': {
        const pending = connection.pending.get(frame.id)
        if (pending === undefined) return
        connection.pending.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.ok) pending.resolve({ payload: frame.payload, seq })
        else pending.reject(new Mt5RequestError(frame.error.code, frame.error.message, frame.error.retcode))
        return
      }
      case 'event':
        if (frame.type !== 'system.ping') this.emit({ kind: 'event', session, type: frame.type, payload: frame.payload, seq })
        return
      case 'request':
        // The EA asks the Desktop nothing after its handshake.
        this.send(connection, errorFrame(frame.id, { code: 'unknown_type', message: `The Desktop does not serve ${frame.type}` }))
    }
  }

  private send(connection: Connection, frame: object): boolean {
    if (connection.closed || connection.stage === 'tls' || connection.socket.destroyed || !connection.socket.writable) return false
    if (connection.socket.writableLength > MAX_WRITE_BUFFER) {
      this.close(connection, 'the EA stopped reading')
      return false
    }
    connection.socket.write(encodeLine(frame))
    return true
  }

  /** Close a connection. Its session ends at once, not when the socket's close event follows. */
  private close(connection: Connection, reason: string): void {
    connection.closeReason ??= reason
    connection.socket.destroy()
    connection.tcp.destroy()
    this.settle(connection)
  }

  /** The socket closed: clear its timers, fail its requests and report the end of its session. */
  private settle(connection: Connection): void {
    if (connection.closed) return
    connection.closed = true
    clearTimeout(connection.handshakeTimer)
    clearInterval(connection.heartbeatTimer)
    clearTimeout(connection.idleTimer)
    this.connections.delete(connection)
    this.securing.delete(peerKey(connection.address, connection.port))
    // A peer that hangs up during the handshake reports nothing else. After the Desktop's proof, the
    // EA hangs up when that proof fails for it: its token differs, or it saw another certificate.
    if (connection.closeReason === undefined) {
      if (connection.stage === 'tls') this.reject(connection.address, 'tls', 'the connection closed during the TLS handshake')
      else if (connection.stage === 'auth') this.reject(connection.address, 'token', "the EA hung up after the Desktop's proof: the tokens differ, or the EA saw another certificate")
    }
    const reason = connection.closeReason ?? 'the EA closed the connection'
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Mt5RequestError('disconnected', `The EA disconnected: ${reason}`))
    }
    connection.pending.clear()
    if (this.active === connection) this.active = undefined
    if (connection.session === undefined) this.emit({ kind: 'pending', count: this.pendingCount })
    else this.emit({ kind: 'session-closed', session: connection.session, reason })
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
