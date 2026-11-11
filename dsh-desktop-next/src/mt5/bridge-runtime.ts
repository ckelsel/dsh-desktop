/**
 * The Desktop's MT5 bridge: the TCP server configured from the preferences, the account state it
 * syncs from the EA, and the trading gate over that state. Every authenticated session is synced
 * before it counts as ready (`system.resync`, `system.status`, `account.snapshot`); events the EA
 * pushes keep the state current afterwards. MT5 stays the authority: a disconnected EA clears the
 * account instead of leaving stale figures on screen, and a session that fails to sync is dropped
 * so the EA reconnects and syncs again.
 */
import type { DesktopPreferences } from '../desktop-contract.ts'
import { parseAddressList } from './addresses.ts'
import { mt5SecretPath, readMt5Token, writeMt5Token } from './bridge-secret.ts'
import { Mt5BridgeServer, Mt5RequestError, type Mt5ServerConfig, type Mt5ServerEvent, type Mt5ServerTimings, type Mt5Session } from './bridge-server.ts'
import type { Mt5Account, Mt5Status, Mt5TerminalStatus } from './contract.ts'
import { parseAccount, parseTerminalStatus, type Mt5Payload } from './protocol.ts'
import { blockReasons, bridgePhase } from './terminal-state.ts'

export type Mt5Preferences = Pick<DesktopPreferences, 'mt5Enabled' | 'mt5Exposure' | 'mt5Port' | 'mt5AllowedAddresses'>

export type Mt5LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type Mt5BridgeLog = (event: string, fields?: Record<string, string | number | boolean | null>, level?: Mt5LogLevel) => void

export interface Mt5BridgeRuntimeOptions {
  /** Desktop data directory; the token file lives here. */
  home: string
  desktopVersion: string
  /** LAN IPv4 addresses of this machine, shown so the user can enter one in the EA. */
  lanAddresses(): readonly string[]
  log: Mt5BridgeLog
  timings?: Partial<Mt5ServerTimings>
  now?: () => number
}

/** Requests the renderer may send through the bridge; the rest stay main-process only. */
const RENDERER_REQUESTS: ReadonlySet<string> = new Set(['system.status', 'account.snapshot'])

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)

export class Mt5BridgeRuntime {
  private readonly server: Mt5BridgeServer
  private readonly listeners = new Set<(status: Mt5Status) => void>()
  private readonly now: () => number
  private config: Mt5ServerConfig | undefined
  private enabled = false
  private listen: Mt5Status['listen'] = null
  private listenError: string | null = null
  private pending = 0
  private session: Mt5Session | null = null
  private ready = false
  private terminal: Mt5TerminalStatus | null = null
  private account: Mt5Account | null = null
  private syncedAt: number | null = null
  private lastRejection: Mt5Status['lastRejection'] = null
  /** Bumped by every sync, so a slower earlier sync cannot overwrite a later one. */
  private generation = 0
  private tokenValue: string | undefined
  private snapshot: Mt5Status
  private published = ''

  constructor(private readonly options: Mt5BridgeRuntimeOptions) {
    this.now = options.now ?? Date.now
    this.server = new Mt5BridgeServer({ desktopVersion: options.desktopVersion, timings: options.timings, now: this.now })
    this.server.subscribe(event => { this.onServerEvent(event) })
    this.snapshot = this.build()
  }

  status(): Mt5Status {
    return this.snapshot
  }

  /** @returns the unsubscribe function. */
  subscribe(listener: (status: Mt5Status) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  token(): string {
    return this.tokenValue ??= readMt5Token(mt5SecretPath(this.options.home))
  }

  /** Replace the token; the EA is disconnected until it is given the new one. */
  async regenerateToken(): Promise<string> {
    this.tokenValue = writeMt5Token(mt5SecretPath(this.options.home))
    this.options.log('mt5.token-regenerated')
    if (this.config !== undefined) {
      this.config = { ...this.config, token: this.tokenValue }
      await this.server.start(this.config)
    }
    return this.tokenValue
  }

  /** Apply the preferences: start, move or stop the TCP server. Safe Mode keeps the bridge off. */
  async configure(preferences: Mt5Preferences, options: { safeMode: boolean }): Promise<void> {
    this.enabled = preferences.mt5Enabled && !options.safeMode
    if (!this.enabled) {
      this.config = undefined
      this.listenError = null
      await this.server.stop()
      this.publish()
      return
    }
    const config: Mt5ServerConfig = {
      host: preferences.mt5Exposure === 'lan' ? '0.0.0.0' : '127.0.0.1',
      port: preferences.mt5Port,
      allowedAddresses: parseAddressList(preferences.mt5AllowedAddresses).addresses,
      token: this.token(),
    }
    const moved = this.config === undefined || this.config.host !== config.host || this.config.port !== config.port
    this.config = config
    if (moved) this.listenError = null
    await this.server.start(config)
    this.publish()
  }

  /** Read the account state again; trading stays blocked until it is back in sync. */
  async resync(): Promise<void> {
    const session = this.session
    if (session === null) throw new Mt5RequestError('not_connected', 'No EA is connected')
    await this.sync(session)
  }

  /** A renderer request; only the read requests in `RENDERER_REQUESTS` pass. */
  request(type: string, payload: Mt5Payload = {}): Promise<Mt5Payload> {
    if (!RENDERER_REQUESTS.has(type)) return Promise.reject(new Error(`MT5 request ${type} is not available to the renderer`))
    return this.server.request(type, payload)
  }

  async stop(): Promise<void> {
    this.enabled = false
    this.config = undefined
    await this.server.stop()
    this.publish()
  }

  private onServerEvent(event: Mt5ServerEvent): void {
    const { log } = this.options
    switch (event.kind) {
      case 'listening':
        this.listenError = null
        this.listen = { host: event.host, port: event.port, addresses: event.host === '127.0.0.1' ? ['127.0.0.1'] : [...this.options.lanAddresses()] }
        log('mt5.listening', { host: event.host, port: event.port })
        break
      case 'stopped':
        this.listen = null
        log('mt5.stopped')
        break
      case 'listen-error':
        this.listen = null
        this.listenError = event.message
        log('mt5.listen-failed', { message: event.message }, 'warn')
        break
      case 'pending':
        this.pending = event.count
        break
      case 'rejected':
        this.lastRejection = { address: event.address, reason: event.reason, at: this.now() }
        log('mt5.rejected', { address: event.address, reason: event.reason, detail: event.detail }, 'warn')
        break
      case 'session-open':
        this.session = event.session
        this.ready = false
        this.terminal = null
        this.account = null
        log('mt5.session-open', { address: event.session.address, login: event.session.hello.login, server: event.session.hello.server,
          ea: event.session.hello.eaVersion, terminal: event.session.hello.terminalBuild })
        void this.sync(event.session)
        break
      case 'session-closed':
        // Only the session on record clears the state; a replaced session closes before its successor opens.
        if (this.session?.id === event.session.id) {
          this.session = null
          this.ready = false
          this.terminal = null
          this.account = null
        }
        log('mt5.session-closed', { address: event.session.address, reason: event.reason })
        break
      case 'event':
        if (this.session?.id === event.session.id) this.apply(event.type, event.payload)
        break
      case 'protocol-error':
        log('mt5.protocol-error', { detail: event.detail }, 'warn')
        break
    }
    this.publish()
  }

  /** An update the EA pushed. */
  private apply(type: string, payload: Mt5Payload): void {
    try {
      if (type === 'system.status') this.terminal = parseTerminalStatus(payload)
      else if (type === 'account.snapshot') this.account = parseAccount(payload)
      else this.options.log('mt5.event-ignored', { type }, 'debug')
    } catch (error) {
      this.options.log('mt5.event-invalid', { type, detail: errorText(error) }, 'warn')
    }
  }

  private async sync(session: Mt5Session): Promise<void> {
    const generation = ++this.generation
    const current = (): boolean => generation === this.generation && this.session?.id === session.id
    this.ready = false
    this.publish()
    try {
      // The EA forgets what it last pushed, so every later change reaches this sync's state.
      await this.server.request('system.resync')
      const terminal = parseTerminalStatus(await this.server.request('system.status'))
      const account = parseAccount(await this.server.request('account.snapshot'))
      if (!current()) return
      this.terminal = terminal
      this.account = account
      this.ready = true
      this.syncedAt = this.now()
      this.options.log('mt5.synced', { login: account.login, mode: account.tradeMode, brokerConnected: terminal.connected })
    } catch (error) {
      if (!current()) return
      this.options.log('mt5.sync-failed', { detail: errorText(error) }, 'warn')
      // An account state that cannot be read cannot be trusted; the EA reconnects and the next session syncs.
      this.server.disconnect(`sync failed: ${errorText(error)}`)
    } finally {
      this.publish()
    }
  }

  private build(): Mt5Status {
    const session = this.session
    const phase = bridgePhase({
      enabled: this.enabled,
      error: this.listenError,
      listening: this.listen !== null,
      session: session === null ? this.pending > 0 ? 'handshaking' : 'none' : this.ready ? 'ready' : 'syncing',
    })
    const terminal = session === null ? null : this.terminal
    const account = session === null ? null : this.account
    return {
      phase,
      listen: this.listen,
      error: this.listenError,
      peer: session === null ? null : { address: session.address, port: session.port, eaVersion: session.hello.eaVersion, connectedAt: session.connectedAt },
      terminal,
      account,
      // Real-money trading stays off until the Desktop offers a setting for it.
      blocked: blockReasons({ phase, terminal, account, allowRealTrading: false }),
      syncedAt: this.syncedAt,
      lastRejection: this.lastRejection,
    }
  }

  private publish(): void {
    const next = this.build()
    const text = JSON.stringify(next)
    if (text === this.published) return
    this.published = text
    this.snapshot = next
    for (const listener of [...this.listeners]) listener(next)
  }
}
