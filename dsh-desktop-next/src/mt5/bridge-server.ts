/**
 * TCP server the DshBridge EA connects to; the EA is the client because MQL5 sockets cannot
 * listen. A connection must come from an allowed address and authenticate with `system.hello`
 * carrying the bridge token within the handshake timeout. One authenticated session exists at a
 * time: another account's EA is refused as busy, and a new connection of the same account
 * replaces a session the old EA left behind. After the handshake both sides ping every heartbeat
 * interval, and a session silent for the idle timeout is closed.
 */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type AddressInfo, type Server, type Socket } from 'node:net'
import type { Mt5RejectReason } from './contract.ts'
import { encodeLine, Mt5LineDecoder } from './framing.ts'
import {
  errorFrame, eventFrame, MT5_PROTOCOL_VERSION, okFrame, parseFrame, parseHello, requestFrame,
  type Mt5Frame, type Mt5Hello, type Mt5Payload,
} from './protocol.ts'

export interface Mt5ServerConfig {
  host: string
  port: number
  /** IPv4 addresses allowed to connect besides loopback; empty allows any address. */
  allowedAddresses: readonly string[]
  token: string
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
  /** The number of connections waiting for their hello changed. */
  | { kind: 'pending'; count: number }
  | { kind: 'rejected'; address: string; reason: Mt5RejectReason; detail: string }
  | { kind: 'session-open'; session: Mt5Session }
  | { kind: 'session-closed'; session: Mt5Session; reason: string }
  | { kind: 'event'; session: Mt5Session; type: string; payload: Mt5Payload }
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
}

const MAX_PENDING_CONNECTIONS = 4
/** Output a peer may leave unread before the session is dropped. */
const MAX_WRITE_BUFFER = 16 * 1024 * 1024
const KEEPALIVE_MS = 10_000
/** How long a refused connection gets to read its error before it is destroyed. */
const LINGER_MS = 1_000

interface Pending {
  resolve(payload: Mt5Payload): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

class Connection {
  readonly decoder = new Mt5LineDecoder()
  readonly pending = new Map<string, Pending>()
  session: Mt5Session | undefined
  handshakeTimer: NodeJS.Timeout | undefined
  heartbeatTimer: NodeJS.Timeout | undefined
  idleTimer: NodeJS.Timeout | undefined
  closeReason: string | undefined
  closed = false
  constructor(readonly socket: Socket, readonly address: string, readonly port: number) {}
}

/** `::ffff:10.0.0.13` and `::1` as the IPv4 forms the allowlist uses. */
export function normalizeAddress(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(address)
  if (mapped !== null) return mapped[1]!
  return address === '::1' ? '127.0.0.1' : address
}

const isLoopback = (address: string): boolean => address.startsWith('127.')
const digest = (text: string): Buffer => createHash('sha256').update(text, 'utf8').digest()

/** Constant-time token comparison; an empty expected token matches nothing. */
export function tokensMatch(received: string, expected: string): boolean {
  return expected.length > 0 && timingSafeEqual(digest(received), digest(expected))
}

export class Mt5BridgeServer {
  private readonly timings: Mt5ServerTimings
  private readonly now: () => number
  private readonly listeners = new Set<(event: Mt5ServerEvent) => void>()
  private readonly connections = new Set<Connection>()
  private server: Server | undefined
  private bound: { host: string; port: number } | undefined
  private config: Mt5ServerConfig | undefined
  private active: Connection | undefined
  private sessions = 0
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

  /** Connections waiting for their hello. */
  get pendingCount(): number {
    let count = 0
    for (const connection of this.connections) if (connection.session === undefined) count++
    return count
  }

  /**
   * Listen with `config`. The same host and port keep the socket: a new allowlist drops
   * connections it no longer admits, and a new token drops every connection.
   */
  start(config: Mt5ServerConfig): Promise<void> {
    return this.enqueue(async () => {
      const previous = this.config
      this.config = config
      if (this.server !== undefined && previous !== undefined && previous.host === config.host && previous.port === config.port) {
        for (const connection of [...this.connections]) {
          if (previous.token !== config.token) this.close(connection, 'the bridge token changed')
          else if (!this.allowed(connection.address)) this.close(connection, 'the address is no longer allowed')
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
    const connection = this.active
    if (connection === undefined || connection.closed) return Promise.reject(new Mt5RequestError('not_connected', 'No EA is connected'))
    const id = options.id ?? randomUUID()
    if (connection.pending.has(id)) return Promise.reject(new Mt5RequestError('duplicate_id', `Request ${id} is already in flight`))
    return new Promise<Mt5Payload>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id)
        reject(new Mt5RequestError('timeout', `${type} got no answer`))
      }, options.timeoutMs ?? this.timings.requestMs)
      connection.pending.set(id, { resolve, reject, timer })
      if (!this.send(connection, requestFrame(id, type, payload))) {
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

  private listen(config: Mt5ServerConfig): Promise<void> {
    return new Promise((resolve) => {
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
    this.bound = undefined
    await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    this.emit({ kind: 'stopped' })
  }

  private allowed(address: string): boolean {
    const allowlist = this.config?.allowedAddresses ?? []
    return isLoopback(address) || allowlist.length === 0 || allowlist.includes(address)
  }

  private reject(address: string, reason: Mt5RejectReason, detail: string): void {
    this.emit({ kind: 'rejected', address, reason, detail })
  }

  private accept(socket: Socket): void {
    const address = normalizeAddress(socket.remoteAddress ?? '')
    if (this.config === undefined) { socket.destroy(); return }
    if (!this.allowed(address)) {
      this.reject(address, 'address', 'not in the allowed address list')
      socket.destroy()
      return
    }
    if (this.pendingCount >= MAX_PENDING_CONNECTIONS) {
      this.reject(address, 'busy', 'too many connections are waiting to authenticate')
      socket.destroy()
      return
    }
    socket.setNoDelay(true)
    socket.setKeepAlive(true, KEEPALIVE_MS)
    const connection = new Connection(socket, address, socket.remotePort ?? 0)
    this.connections.add(connection)
    connection.handshakeTimer = setTimeout(() => {
      this.reject(address, 'handshake-timeout', 'no system.hello arrived in time')
      this.close(connection, 'handshake timeout')
    }, this.timings.handshakeMs)
    socket.on('data', (chunk: Buffer) => { this.receive(connection, chunk) })
    // 'close' always follows and settles the connection.
    socket.on('error', () => {})
    socket.on('close', () => { this.settle(connection) })
    this.emit({ kind: 'pending', count: this.pendingCount })
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
    if (frame.kind !== 'request' || frame.type !== 'system.hello') {
      this.reject(connection.address, 'invalid', `expected system.hello, got ${frame.kind === 'response' ? 'a response' : frame.type}`)
      this.close(connection, 'the first frame was not system.hello')
      return
    }
    let hello: Mt5Hello
    try { hello = parseHello(frame.payload) } catch (error) {
      this.refuse(connection, frame.id, 'bad_request', errorText(error), 'invalid')
      return
    }
    if (hello.protocol !== MT5_PROTOCOL_VERSION) {
      this.refuse(connection, frame.id, 'unsupported_protocol', `The Desktop speaks protocol ${String(MT5_PROTOCOL_VERSION)}, the EA ${String(hello.protocol)}`, 'protocol')
      return
    }
    if (!tokensMatch(hello.token, this.config?.token ?? '')) {
      this.refuse(connection, frame.id, 'auth_failed', 'The token does not match the Desktop bridge token', 'token')
      return
    }
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
    const session: Mt5Session = { id: ++this.sessions, address: connection.address, port: connection.port, hello, connectedAt: this.now() }
    connection.session = session
    this.active = connection
    this.send(connection, okFrame(frame.id, {
      protocol: MT5_PROTOCOL_VERSION, desktop: this.options.desktopVersion,
      heartbeat_ms: this.timings.heartbeatMs, idle_ms: this.timings.idleMs,
    }))
    connection.heartbeatTimer = setInterval(() => { this.send(connection, eventFrame('system.ping', { time: this.now() })) }, this.timings.heartbeatMs)
    connection.idleTimer = setTimeout(() => { this.close(connection, 'heartbeat timeout') }, this.timings.idleMs)
    // The session first: a listener between the two events must not see neither connection.
    this.emit({ kind: 'session-open', session })
    this.emit({ kind: 'pending', count: this.pendingCount })
  }

  private dispatch(connection: Connection, session: Mt5Session, frame: Mt5Frame): void {
    switch (frame.kind) {
      case 'response': {
        const pending = connection.pending.get(frame.id)
        if (pending === undefined) return
        connection.pending.delete(frame.id)
        clearTimeout(pending.timer)
        if (frame.ok) pending.resolve(frame.payload)
        else pending.reject(new Mt5RequestError(frame.error.code, frame.error.message, frame.error.retcode))
        return
      }
      case 'event':
        if (frame.type !== 'system.ping') this.emit({ kind: 'event', session, type: frame.type, payload: frame.payload })
        return
      case 'request':
        // The EA asks the Desktop nothing in protocol v1 beyond its hello.
        this.send(connection, errorFrame(frame.id, { code: 'unknown_type', message: `The Desktop does not serve ${frame.type}` }))
    }
  }

  private send(connection: Connection, frame: object): boolean {
    if (connection.closed || connection.socket.destroyed || !connection.socket.writable) return false
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
