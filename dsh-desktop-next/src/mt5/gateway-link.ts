/**
 * The SDK side of the MT5Bridge gateway: a WebSocket client of `ws://127.0.0.1:18860`, where the
 * terminal-side DLLs of one or more MT5 terminals arrive through the gateway's terminal face. The
 * gateway pushes `bridge.hello` with the terminals it knows the moment the socket opens, and
 * `event.terminal` as they come and go, so the link keeps a live table. Requests ride JSON-RPC
 * with `params.terminal_id` naming the route; the gateway answers or times out on its own, and
 * this side adds a slower backstop. Events arrive with the terminal's `seq`, so a gap can be
 * detected and the terminal asked to resync.
 *
 * The socket is the gateway's to lose: whenever it drops, every pending request fails at once and
 * the link reconnects with a growing pause, for the gateway may itself be restarting. What counts
 * as a fresh start is the `bridge.hello` that follows, whose snapshot replaces the terminal table
 * whole — terminals it lists may no longer exist, so a caller must probe before trusting one.
 */
import { Mt5RequestError } from './bridge-server.ts'

/** Where the MT5Bridge gateway serves its SDK face, unless the preferences say otherwise. */
export const MT5_GATEWAY_URL = 'ws://127.0.0.1:18860'

/** Diagnostic log; never throws. */
export type Mt5GatewayLog = (event: string, fields?: Record<string, string | number | boolean | null>, level?: 'debug' | 'info' | 'warn' | 'error') => void

/** A terminal the gateway knows: what its hello and `event.terminal` say about it. */
export interface GatewayTerminal {
  readonly terminal_id: string
  readonly role: string
  /** MARKET components keyed by id; the hello snapshot carries them, later events do not. */
  readonly components: ReadonlyMap<string, { symbol: string | null }>
}

/** An event the gateway fanned out, with the routing the gateway added. */
export interface GatewayEvent {
  readonly method: string
  readonly params: Record<string, unknown>
  /** The terminal that emitted it, injected by the gateway. */
  readonly terminalId: string | null
  /** The terminal session's event counter; a gap means missed events. */
  readonly seq: number | null
}

export interface GatewayCallOptions {
  timeoutMs?: number
}

/** The wire the link speaks, so tests can drive it without a socket. */
export interface GatewayTransport {
  send(text: string): void
  close(): void
}

export interface GatewayTransportEvents {
  onOpen(): void
  onText(text: string): void
  onClose(): void
}

export type GatewayTransportFactory = (url: string, events: GatewayTransportEvents) => GatewayTransport

/** The browser-grade WebSocket of Node 22, which the main process runs on. */
const nodeWebSocket: GatewayTransportFactory = (url, events) => {
  const socket = new WebSocket(url)
  let closed = false
  socket.onopen = () => { events.onOpen() }
  socket.onmessage = (message) => { events.onText(String(message.data)) }
  // A failed open reports error and then close; reconnecting on close alone cannot double-fire.
  socket.onerror = () => {}
  socket.onclose = () => { if (!closed) { closed = true; events.onClose() } }
  return {
    send: text => { socket.send(text) },
    close: () => { closed = true; socket.close() },
  }
}

/** Requests wait for the gateway's own 30 s timeout first, then this backstop. */
const CALL_TIMEOUT_MS = 35_000
const RECONNECT_MIN_MS = 1_000
const RECONNECT_MAX_MS = 15_000

interface Pending {
  resolve(result: Record<string, unknown>): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

export interface Mt5GatewayLinkOptions {
  url: string
  transport?: GatewayTransportFactory
  /** Diagnostic log; never throws. */
  log?: (event: string, fields?: Record<string, string | number | boolean | null>, level?: 'debug' | 'info' | 'warn' | 'error') => void
  now?: () => number
}

export class Mt5GatewayLink {
  private readonly transportFactory: GatewayTransportFactory
  private readonly log: Mt5GatewayLog
  private readonly now: () => number
  private readonly pending = new Map<number, Pending>()
  private readonly terminalListeners = new Set<(terminals: readonly GatewayTerminal[]) => void>()
  private readonly eventListeners = new Set<(event: GatewayEvent) => void>()
  private readonly connectionListeners = new Set<(up: boolean) => void>()
  private readonly terminals = new Map<string, GatewayTerminal>()
  private nextId = 0
  private transport: GatewayTransport | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private attempts = 0
  private up = false
  private stopped = false

  constructor(private readonly options: Mt5GatewayLinkOptions) {
    this.transportFactory = options.transport ?? nodeWebSocket
    this.log = options.log ?? (() => {})
    this.now = options.now ?? Date.now
  }

  /** Start connecting, and keep reconnecting while this link is open. */
  open(): void {
    if (this.stopped || this.transport !== undefined) return
    this.connect()
  }

  /** Stop for good; pending requests fail, and nothing reconnects. */
  close(): void {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.transport?.close()
    this.settled()
  }

  /** Whether `bridge.hello` has arrived for the current socket. */
  get connected(): boolean {
    return this.up
  }

  /** The SDK face port of the configured URL, for the status the page shows. */
  get port(): number {
    return Number(new URL(this.options.url).port)
  }

  /** The terminals of the last hello, adjusted by later `event.terminal`. */
  snapshot(): readonly GatewayTerminal[] {
    return [...this.terminals.values()]
  }

  /** @returns the unsubscribe function. */
  onTerminals(listener: (terminals: readonly GatewayTerminal[]) => void): () => void {
    this.terminalListeners.add(listener)
    return () => { this.terminalListeners.delete(listener) }
  }

  /** Every event the gateway fans out. */
  onEvent(listener: (event: GatewayEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  /** Each transition of the socket, `false` on every drop. */
  onConnection(listener: (up: boolean) => void): () => void {
    this.connectionListeners.add(listener)
    return () => { this.connectionListeners.delete(listener) }
  }

  /**
   * A request through the gateway to a terminal.
   * @throws Mt5RequestError when the socket is down, the terminal fails it, or no answer comes.
   */
  call(method: string, params: Record<string, unknown> = {}, options: GatewayCallOptions = {}): Promise<Record<string, unknown>> {
    if (this.transport === undefined || !this.up) return Promise.reject(new Mt5RequestError('not_connected', 'The gateway is not connected'))
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Mt5RequestError('timeout', `${method} got no answer`))
      }, options.timeoutMs ?? CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.transport?.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    })
  }

  private connect(): void {
    let transport: GatewayTransport
    try {
      transport = this.transportFactory(this.options.url, {
        onOpen: () => {},
        onText: text => { this.receive(text) },
        onClose: () => { this.dropped() },
      })
    } catch (error) {
      this.log('mt5.gateway-connect-failed', { detail: error instanceof Error ? error.message : String(error) }, 'warn')
      this.scheduleReconnect()
      return
    }
    this.transport = transport
  }

  /** `bridge.hello` turns the socket on; anything else before it waits. */
  private receive(text: string): void {
    let message: { id?: unknown; method?: unknown; params?: unknown; seq?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }
    try { message = JSON.parse(text) } catch { return }
    if (typeof message.method === 'string') {
      const params = (typeof message.params === 'object' && message.params !== null ? message.params : {}) as Record<string, unknown>
      if (message.method === 'bridge.hello') this.hello(params)
      else if (message.method === 'event.terminal') this.terminalEvent(params)
      else this.fanOut(message.method, params, message.seq)
      return
    }
    if (message.id === undefined || typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (pending === undefined) return
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error !== undefined) pending.reject(new Mt5RequestError(String(message.error.code ?? 'gateway_error'), String(message.error.message ?? 'The gateway failed the request')))
    else pending.resolve((typeof message.result === 'object' && message.result !== null ? message.result : {}) as Record<string, unknown>)
  }

  /** The snapshot of the gateway's terminal table; it replaces whatever was known. */
  private hello(params: Record<string, unknown>): void {
    this.terminals.clear()
    const listed = Array.isArray(params.terminals) ? params.terminals : []
    for (const entry of listed) {
      if (typeof entry !== 'object' || entry === null) continue
      const { terminal_id, role } = entry as Record<string, unknown>
      if (typeof terminal_id !== 'string' || terminal_id === '') continue
      const components = new Map<string, { symbol: string | null }>()
      const raw = (entry as Record<string, unknown>).components
      if (Array.isArray(raw)) {
        for (const component of raw) {
          if (typeof component !== 'object' || component === null) continue
          const { component_id, symbol } = component as Record<string, unknown>
          if (typeof component_id !== 'string') continue
          components.set(component_id, { symbol: typeof symbol === 'string' ? symbol : null })
        }
      }
      this.terminals.set(terminal_id, { terminal_id, role: typeof role === 'string' ? role : '', components })
    }
    const wasUp = this.up
    this.up = true
    this.attempts = 0
    if (!wasUp) {
      this.log('mt5.gateway-up', { terminals: this.terminals.size })
      for (const listener of [...this.connectionListeners]) listener(true)
    }
    this.terminalsChanged()
  }

  private terminalEvent(params: Record<string, unknown>): void {
    const { type, terminal_id, role } = params
    if (typeof terminal_id !== 'string') return
    if (type === 'connected') {
      if (!this.terminals.has(terminal_id)) {
        this.terminals.set(terminal_id, { terminal_id, role: typeof role === 'string' ? role : '', components: new Map() })
        this.terminalsChanged()
      }
      return
    }
    if (type === 'disconnected' && this.terminals.delete(terminal_id)) this.terminalsChanged()
  }

  private fanOut(method: string, params: Record<string, unknown>, seq: unknown): void {
    const terminalId = typeof params.terminal_id === 'string' ? params.terminal_id : null
    const event: GatewayEvent = {
      method,
      params,
      terminalId,
      seq: typeof seq === 'number' ? seq : null,
    }
    for (const listener of [...this.eventListeners]) listener(event)
  }

  private terminalsChanged(): void {
    const terminals = this.snapshot()
    for (const listener of [...this.terminalListeners]) listener(terminals)
  }

  /** The socket died: fail what waits, forget the terminals, and try again later. */
  private dropped(): void {
    if (this.transport === undefined) return
    this.transport = undefined
    this.settled()
    if (this.up) {
      this.up = false
      this.log('mt5.gateway-down', { pending: this.pending.size })
      for (const listener of [...this.connectionListeners]) listener(false)
    }
    if (this.terminals.size > 0) {
      this.terminals.clear()
      this.terminalsChanged()
    }
    this.scheduleReconnect()
  }

  /** Fail every pending request, as the socket that would answer it is gone. */
  private settled(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Mt5RequestError('disconnected', 'The gateway connection closed'))
    }
    this.pending.clear()
    this.up = false
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return
    const pause = Math.min(RECONNECT_MIN_MS * 2 ** this.attempts, RECONNECT_MAX_MS)
    this.attempts++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, pause)
    this.reconnectTimer.unref?.()
  }
}
