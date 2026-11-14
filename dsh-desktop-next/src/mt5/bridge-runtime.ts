/**
 * The Desktop's MT5 bridge: the TLS server configured from the preferences, the terminal state it
 * syncs from the EA, the trading gate over that state, and trade requests. Every authenticated session is synced
 * before it counts as ready: the account (`system.resync`, `system.status`, `account.snapshot`),
 * then, from an EA that serves them, the symbol catalogue, positions, orders, and the page's
 * subscriptions. Events the EA pushes keep the state current afterwards. Every value remembers the
 * frame it came in, so a sync answer never replaces a newer pushed value.
 *
 * MT5 stays the authority: a disconnected EA clears the account, positions and orders instead of
 * leaving stale figures on screen, and a session that fails to sync is dropped so the EA
 * reconnects and syncs again. Only the catalogue outlives a disconnect, so the page keeps its
 * charts while the quotes pause. The Desktop keeps no record of trades either: a request is sent
 * once, and MT5's positions, orders and history tell what it did.
 */
import { randomUUID } from 'node:crypto'
import type { DesktopPreferences } from '../desktop-contract.ts'
import { mt5SecretPath, readMt5Token, writeMt5Token } from './bridge-secret.ts'
import { Mt5BridgeServer, Mt5RequestError, type Mt5ServerConfig, type Mt5ServerEvent, type Mt5ServerTimings, type Mt5Session } from './bridge-server.ts'
import { loadMt5TlsIdentity, mt5TlsPath, type Mt5TlsIdentity } from './bridge-tls.ts'
import {
  MT5_DISCLAIMER_VERSION, type Mt5Account, type Mt5Bar, type Mt5BlockReason, type Mt5Catalog, type Mt5HistoryBars, type Mt5HistoryBarsOptions,
  type Mt5HistoryBarsRequest, type Mt5Order, type Mt5Position, type Mt5Status, type Mt5Subscription, type Mt5Symbol, type Mt5SymbolInfo,
  type Mt5TerminalStatus, type Mt5Tick, type Mt5TradeEvent, type Mt5TradeHistory, type Mt5TradeInput, type Mt5TradeOutcome, type Mt5Trading,
  type Mt5DataEvent,
} from './contract.ts'
import {
  parseAccount, parseBars, parseHistoryAnswer, parseOrders, parsePositions, parseSubscribeAnswer, parseSymbolInfo,
  parseSymbolsPage, parseTerminalStatus, parseTicks, parseTradeEvent, parseTradeHistory, parseTradeOutcome, tradeBody,
  type Mt5Parsed, type Mt5Payload,
} from './protocol.ts'
import { blockReasons, bridgePhase } from './terminal-state.ts'

export type Mt5Preferences = Pick<DesktopPreferences,
  'mt5Enabled' | 'mt5Exposure' | 'mt5Port' | 'mt5DisclaimerVersion' | 'mt5DisclaimerAcceptedAt'>

export type Mt5LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type Mt5BridgeLog = (event: string, fields?: Record<string, string | number | boolean | null>, level?: Mt5LogLevel) => void

/** How history requests repeat while the terminal builds or downloads a series. */
export interface Mt5HistoryTimings {
  /** Pause between two requests answered `pending`. */
  retryMs: number
}

export interface Mt5BridgeRuntimeOptions {
  /** Desktop data directory; the token and certificate files live here. */
  home: string
  desktopVersion: string
  /** LAN IPv4 addresses of this machine, shown so the user can enter one in the EA. */
  lanAddresses(): readonly string[]
  log: Mt5BridgeLog
  timings?: Partial<Mt5ServerTimings>
  history?: Partial<Mt5HistoryTimings>
  /** The longest a trade request waits for its answer; `TRADE_TIMEOUT_MS` by default. */
  tradeTimeoutMs?: number
  now?: () => number
}

/** Market and trading data, for the IPC layer to forward to the page. */
export type { Mt5DataEvent } from './contract.ts'

/** Requests the renderer may send through the bridge; the rest stay main-process only. */
const RENDERER_REQUESTS: ReadonlySet<string> = new Set(['system.status', 'account.snapshot'])
const SYMBOLS_PAGE = 500
/** A catalogue larger than this is cut short; no broker comes close. */
const MAX_CATALOG = 50_000
/** Subscription changes within this window reach the EA as one. */
const SUBSCRIBE_DEBOUNCE_MS = 50
/** A query of thousands of deals takes the EA a while to serialize. */
const HISTORY_QUERY_TIMEOUT_MS = 30_000
const HISTORY_TIMINGS: Readonly<Mt5HistoryTimings> = Object.freeze({ retryMs: 400 })
/** The longest a trade request waits for its answer; then the session is dropped and the outcome is unknown. */
const TRADE_TIMEOUT_MS = 30_000

/** Values whose frames are ordered, so a sync answer never replaces a newer event. */
type Ordered = 'status' | 'account' | 'positions' | 'orders'

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

/** An outcome the Desktop reports itself, without a trade result from MT5. */
const localOutcome = (status: 'rejected' | 'unknown' | 'blocked', id: string | null, code: string, message: string,
  blocked: Mt5BlockReason | null = null): Mt5TradeOutcome =>
  ({ status, id, blocked, retcode: 0, code, message, order: null, deal: null, price: null, volume: null, duplicate: false })

export class Mt5BridgeRuntime {
  private readonly server: Mt5BridgeServer
  private readonly listeners = new Set<(status: Mt5Status) => void>()
  private readonly dataListeners = new Set<(event: Mt5DataEvent) => void>()
  private readonly now: () => number
  private readonly history: Mt5HistoryTimings
  private readonly tradeTimeoutMs: number
  private config: Mt5ServerConfig | undefined
  private enabled = false
  private listen: Mt5Status['listen'] = null
  private listenError: string | null = null
  private pending = 0
  private session: Mt5Session | null = null
  private ready = false
  private terminal: Mt5TerminalStatus | null = null
  private account: Mt5Account | null = null
  private positions: readonly Mt5Position[] | null = null
  private orders: readonly Mt5Order[] | null = null
  private catalogValue: Mt5Catalog | null = null
  private catalogText = 'null'
  /** The frame each ordered value came in; cleared with every new session. */
  private readonly frames = new Map<Ordered, number>()
  private syncedAt: number | null = null
  private lastRejection: Mt5Status['lastRejection'] = null
  /** Bumped by every sync, so a slower earlier sync cannot overwrite a later one. */
  private generation = 0
  private subscription: Mt5Subscription = { quotes: [], bars: [] }
  /** The subscription the EA of this session has, as JSON; null before the first one. */
  private sentSubscription: string | null = null
  private subscribeTimer: NodeJS.Timeout | undefined
  private tokenValue: string | undefined
  private identity: Promise<Mt5TlsIdentity> | undefined
  private fingerprint: string | null = null
  private disclaimer: Mt5Status['disclaimer'] = null
  /** A trade request is waiting for its answer; the next waits for it to finish. */
  private tradeInFlight = false
  private snapshot: Mt5Status
  private published = ''

  constructor(private readonly options: Mt5BridgeRuntimeOptions) {
    this.now = options.now ?? Date.now
    this.history = { ...HISTORY_TIMINGS, ...options.history }
    this.tradeTimeoutMs = options.tradeTimeoutMs ?? TRADE_TIMEOUT_MS
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

  /** Follow the catalogue, positions and orders, quotes, bars, and trade events. */
  subscribeData(listener: (event: Mt5DataEvent) => void): () => void {
    this.dataListeners.add(listener)
    return () => { this.dataListeners.delete(listener) }
  }

  /** The catalogue of the trade server last synced; it outlives a disconnect. */
  catalog(): Mt5Catalog | null {
    return this.catalogValue
  }

  /** Positions and pending orders, once both are known for the session in use. */
  trading(): Mt5Trading | null {
    return this.positions === null || this.orders === null ? null : { positions: this.positions, orders: this.orders }
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
    this.disclaimer = preferences.mt5DisclaimerVersion === MT5_DISCLAIMER_VERSION
      ? { version: preferences.mt5DisclaimerVersion, acceptedAt: preferences.mt5DisclaimerAcceptedAt }
      : null
    this.enabled = preferences.mt5Enabled && !options.safeMode
    if (!this.enabled) {
      this.config = undefined
      this.listenError = null
      await this.server.stop()
      this.setCatalog(null)
      this.publish()
      return
    }
    let tls: Mt5TlsIdentity
    try { tls = await this.tlsIdentity() } catch (error) {
      this.config = undefined
      this.listenError = `The bridge certificate is unavailable: ${errorText(error)}`
      await this.server.stop()
      this.publish()
      return
    }
    const config: Mt5ServerConfig = {
      host: preferences.mt5Exposure === 'lan' ? '0.0.0.0' : '127.0.0.1',
      port: preferences.mt5Port,
      token: this.token(),
      tls,
    }
    const moved = this.config === undefined || this.config.host !== config.host || this.config.port !== config.port
    this.config = config
    if (moved) this.listenError = null
    await this.server.start(config)
    this.publish()
  }

  /** The certificate, read or made once; a failure is retried at the next configure. */
  private tlsIdentity(): Promise<Mt5TlsIdentity> {
    this.identity ??= loadMt5TlsIdentity(mt5TlsPath(this.options.home), this.now()).then(({ identity, created }) => {
      if (created !== undefined) this.options.log('mt5.certificate-created', { reason: created })
      this.fingerprint = identity.fingerprint
      return identity
    }, (error: unknown) => {
      this.identity = undefined
      this.options.log('mt5.certificate-failed', { detail: errorText(error) }, 'error')
      throw error
    })
    return this.identity
  }

  /** Read the terminal state again; trading stays blocked until it is back in sync. */
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

  /** Replace the page's quote and bar subscriptions; the EA gets them while a session is ready. */
  setSubscription(subscription: Mt5Subscription): void {
    this.subscription = subscription
    if (this.subscribeTimer !== undefined) return
    this.subscribeTimer = setTimeout(() => {
      this.subscribeTimer = undefined
      void this.flushSubscription()
    }, SUBSCRIBE_DEBOUNCE_MS)
  }

  /**
   * Bars that open before `request.to`, oldest first: `request.count` of them, or all there are.
   * While the terminal is still building the series or downloading older history, the EA answers
   * pending and the request is repeated, however long the terminal's network takes. A partial
   * request waits only for the series, and gets the bars the terminal has meanwhile.
   * @throws Mt5RequestError when no EA that serves bars is connected, or it disconnects meanwhile.
   */
  async historyBars(request: Mt5HistoryBarsRequest, options: Mt5HistoryBarsOptions = {}): Promise<Mt5HistoryBars> {
    const session = this.marketSession()
    const disconnected = (): boolean => this.session?.id !== session.id
    const partial = options.partial === true
    for (;;) {
      const answer = parseHistoryAnswer(await this.server.request('market.history', partial ? { ...request, partial } : { ...request }))
      if (disconnected()) throw new Mt5RequestError('disconnected', 'The EA disconnected')
      if (!answer.pending) {
        if (answer.skipped > 0) this.options.log('mt5.history-rows-skipped', { symbol: request.symbol, timeframe: request.timeframe, count: answer.skipped }, 'warn')
        return partial ? { bars: answer.bars, noData: answer.noData, partial: !answer.complete } : { bars: answer.bars, noData: answer.noData }
      }
      await delay(this.history.retryMs)
      if (disconnected()) throw new Mt5RequestError('disconnected', 'The EA disconnected')
    }
  }

  /**
   * Orders and deals with times in [from, to), newest first.
   * @throws Mt5RequestError when no EA that serves history is connected.
   */
  async historyTrades(range: { from: number; to: number }): Promise<Mt5TradeHistory> {
    this.marketSession()
    const answer = parseTradeHistory(await this.server.request('history.query', range, { timeoutMs: HISTORY_QUERY_TIMEOUT_MS }))
    this.logSkipped('history.query orders', answer.orders)
    this.logSkipped('history.query deals', answer.deals)
    return { orders: answer.orders.items, deals: answer.deals.items, truncated: answer.truncated }
  }

  /**
   * Send a trade request through the open trading gate, one request at a time. It is sent once and
   * never again, whatever becomes of it. Without an answer in time the session is
   * dropped: the EA, held up until OrderSend returns, reconnects after it, and the sync reads from
   * MT5 what the request did before the gate opens again.
   */
  async trade(input: Mt5TradeInput): Promise<Mt5TradeOutcome> {
    const blocked = this.build().blocked[0]
    const session = this.session
    if (blocked !== undefined || session === null) {
      const reason = blocked ?? 'ea-disconnected'
      return localOutcome('blocked', null, 'blocked', `Trading is blocked: ${reason}`, reason)
    }
    if (this.tradeInFlight) return localOutcome('rejected', null, 'busy', 'Another trade request is still waiting for MT5')
    this.tradeInFlight = true
    const id = randomUUID()
    const { log } = this.options
    log('mt5.trade-sent', { id, type: input.type, symbol: input.symbol })
    let outcome: Mt5TradeOutcome
    try {
      const answer = await this.server.request(input.type, tradeBody(input), { id, signed: true, timeoutMs: this.tradeTimeoutMs, keepAlive: true })
      try { outcome = parseTradeOutcome(id, answer) } catch (error) {
        outcome = localOutcome('unknown', id, 'bad_answer', `The EA's answer is unreadable: ${errorText(error)}`)
      }
    } catch (error) {
      outcome = this.tradeFailure(id, session, error)
    } finally {
      this.tradeInFlight = false
    }
    log('mt5.trade-result', { id, status: outcome.status, retcode: outcome.retcode, code: outcome.code, duplicate: outcome.duplicate },
      outcome.status === 'unknown' ? 'warn' : 'info')
    return outcome
  }

  /** The outcome of a trade request the EA did not answer with a trade result. */
  private tradeFailure(id: string, session: Mt5Session, error: unknown): Mt5TradeOutcome {
    const code = error instanceof Mt5RequestError ? error.code : 'failed'
    switch (code) {
      case 'timeout':
        if (this.session?.id === session.id) this.server.disconnect('a trade request got no answer in time')
        return localOutcome('unknown', id, code, `MT5 did not answer within ${String(this.tradeTimeoutMs / 1000)} s`)
      case 'disconnected':
        return localOutcome('unknown', id, code, 'The EA disconnected before it answered')
      case 'not_connected':
        // The session ended before the request was written: nothing was sent, as with the gate.
        return localOutcome('blocked', null, code, 'No EA is connected', 'ea-disconnected')
      default:
        // The EA refused the frame without trading: bad_request, bad_signature, or unknown_type from an older EA.
        return localOutcome('rejected', id, code, errorText(error))
    }
  }

  /** A symbol's trade rules, read from MT5 at every call. */
  async symbolInfo(symbol: string): Promise<Mt5SymbolInfo> {
    this.marketSession()
    return parseSymbolInfo(await this.server.request('symbol.info', { symbol }))
  }

  /** Make the EA load itself again from disk, for example after it was recompiled. Main process only. */
  async reload(): Promise<void> {
    this.marketSession()
    await this.server.request('system.reload')
  }

  async stop(): Promise<void> {
    this.enabled = false
    this.config = undefined
    clearTimeout(this.subscribeTimer)
    this.subscribeTimer = undefined
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
        this.clearSession()
        // Another server's symbols must not stand in for this one's.
        if (this.catalogValue !== null && this.catalogValue.server !== event.session.hello.server) this.setCatalog(null)
        log('mt5.session-open', { address: event.session.address, login: event.session.hello.login, server: event.session.hello.server,
          ea: event.session.hello.eaVersion, terminal: event.session.hello.terminalBuild })
        void this.sync(event.session)
        break
      case 'session-closed':
        // Only the session on record clears the state; a replaced session closes before its successor opens.
        if (this.session?.id === event.session.id) {
          this.session = null
          this.clearSession()
        }
        log('mt5.session-closed', { address: event.session.address, reason: event.reason })
        break
      case 'event':
        if (this.session?.id === event.session.id) this.apply(event.type, event.payload, event.seq)
        break
      case 'protocol-error':
        log('mt5.protocol-error', { detail: event.detail }, 'warn')
        break
    }
    this.publish()
  }

  /** Forget the state of the session that ended or is about to be replaced. */
  private clearSession(): void {
    this.ready = false
    this.terminal = null
    this.account = null
    this.frames.clear()
    this.sentSubscription = null
    const hadTrading = this.trading() !== null
    this.positions = null
    this.orders = null
    if (hadTrading) this.emitData({ kind: 'trading', trading: null })
  }

  /** Take a value unless one from a later frame is in use already. */
  private newer(kind: Ordered, seq: number): boolean {
    if (seq < (this.frames.get(kind) ?? 0)) return false
    this.frames.set(kind, seq)
    return true
  }

  private setTerminal(terminal: Mt5TerminalStatus, seq: number): void {
    if (this.newer('status', seq)) this.terminal = terminal
  }

  private setAccount(account: Mt5Account, seq: number): void {
    if (this.newer('account', seq)) this.account = account
  }

  private setPositions(positions: Mt5Parsed<Mt5Position>, seq: number): void {
    this.logSkipped('positions.snapshot', positions)
    if (!this.newer('positions', seq)) return
    this.positions = positions.items
    this.tradingChanged()
  }

  private setOrders(orders: Mt5Parsed<Mt5Order>, seq: number): void {
    this.logSkipped('orders.snapshot', orders)
    if (!this.newer('orders', seq)) return
    this.orders = orders.items
    this.tradingChanged()
  }

  private tradingChanged(): void {
    const trading = this.trading()
    if (trading !== null) this.emitData({ kind: 'trading', trading })
  }

  private setCatalog(catalog: Mt5Catalog | null): void {
    const text = JSON.stringify(catalog)
    if (text === this.catalogText) return
    this.catalogText = text
    this.catalogValue = catalog
    this.emitData({ kind: 'catalog', catalog })
  }

  private emitData(event: Mt5DataEvent): void {
    for (const listener of [...this.dataListeners]) listener(event)
  }

  private logSkipped(message: string, parsed: Mt5Parsed<unknown>): void {
    if (parsed.skipped > 0) this.options.log('mt5.items-skipped', { message, count: parsed.skipped, detail: parsed.firstError }, 'warn')
  }

  /** An update the EA pushed. */
  private apply(type: string, payload: Mt5Payload, seq: number): void {
    try {
      switch (type) {
        case 'system.status': this.setTerminal(parseTerminalStatus(payload), seq); break
        case 'account.snapshot': this.setAccount(parseAccount(payload), seq); break
        case 'positions.snapshot': this.setPositions(parsePositions(payload), seq); break
        case 'orders.snapshot': this.setOrders(parseOrders(payload), seq); break
        case 'market.tick': {
          const ticks = parseTicks(payload)
          this.logSkipped(type, ticks)
          if (ticks.items.length > 0) this.emitData({ kind: 'ticks', ticks: ticks.items })
          break
        }
        case 'market.bar': {
          const bars = parseBars(payload)
          this.logSkipped(type, bars)
          if (bars.items.length > 0) this.emitData({ kind: 'bars', bars: bars.items })
          break
        }
        case 'trade.event': this.emitData({ kind: 'trade-event', event: parseTradeEvent(payload) }); break
        default: this.options.log('mt5.event-ignored', { type }, 'debug')
      }
    } catch (error) {
      this.options.log('mt5.event-invalid', { type, detail: errorText(error) }, 'warn')
    }
  }

  /** The session; every EA that passes the protocol 2 handshake serves market data. */
  private marketSession(): Mt5Session {
    const session = this.session
    if (session === null) throw new Mt5RequestError('not_connected', 'No EA is connected')
    return session
  }

  private async sync(session: Mt5Session): Promise<void> {
    const generation = ++this.generation
    const current = (): boolean => generation === this.generation && this.session?.id === session.id
    const { log } = this.options
    this.ready = false
    this.publish()
    try {
      // The EA forgets what it last pushed, so every later change reaches this sync's state.
      await this.server.request('system.resync')
      const status = await this.server.exchange('system.status')
      const terminal = parseTerminalStatus(status.payload)
      if (!current()) return
      this.setTerminal(terminal, status.seq)
      const answer = await this.server.exchange('account.snapshot')
      const account = parseAccount(answer.payload)
      if (!current()) return
      this.setAccount(account, answer.seq)
      const catalog = await this.readCatalog(session)
      if (!current()) return
      this.setCatalog(catalog)
      const positions = await this.server.exchange('positions.snapshot')
      const parsedPositions = parsePositions(positions.payload)
      if (!current()) return
      this.setPositions(parsedPositions, positions.seq)
      const orders = await this.server.exchange('orders.snapshot')
      const parsedOrders = parseOrders(orders.payload)
      if (!current()) return
      this.setOrders(parsedOrders, orders.seq)
      // The EA keeps its subscriptions across a resync, but a new session starts without any.
      this.sentSubscription = null
      await this.sendSubscription()
      if (!current()) return
      this.ready = true
      this.syncedAt = this.now()
      log('mt5.synced', { login: account.login, mode: account.tradeMode, brokerConnected: terminal.connected,
        symbols: this.catalogValue?.symbols.length ?? null, positions: this.positions?.length ?? null, orders: this.orders?.length ?? null })
    } catch (error) {
      if (!current()) return
      log('mt5.sync-failed', { detail: errorText(error) }, 'warn')
      // A terminal state that cannot be read cannot be trusted; the EA reconnects and the next session syncs.
      this.server.disconnect(`sync failed: ${errorText(error)}`)
    } finally {
      this.publish()
    }
    // Subscriptions that changed while the sync ran.
    if (current() && this.ready) void this.flushSubscription()
  }

  /** The whole catalogue, page by page; the Market Watch order comes with the first page. */
  private async readCatalog(session: Mt5Session): Promise<Mt5Catalog> {
    const symbols = new Map<string, Mt5Symbol>()
    let watch: string[] = []
    let skipped = 0
    let firstError: string | null = null
    let total = 1
    for (let offset = 0; offset < total && offset < MAX_CATALOG; offset += SYMBOLS_PAGE) {
      const page = parseSymbolsPage(await this.server.request('symbols.list', { offset, limit: SYMBOLS_PAGE }))
      total = page.total
      if (offset === 0) watch = page.watch ?? []
      for (const symbol of page.symbols.items) if (!symbols.has(symbol.name)) symbols.set(symbol.name, symbol)
      skipped += page.symbols.skipped
      firstError ??= page.symbols.firstError
    }
    this.logSkipped('symbols.list', { items: [], skipped, firstError })
    return { server: session.hello.server, symbols: [...symbols.values()], watch: [...new Set(watch)].filter(name => symbols.has(name)) }
  }

  private async flushSubscription(): Promise<void> {
    const session = this.session
    if (session === null || !this.ready) return
    try {
      await this.sendSubscription()
    } catch (error) {
      if (this.session?.id === session.id) this.options.log('mt5.subscribe-failed', { detail: errorText(error) }, 'warn')
    }
  }

  /** Send the page's subscriptions, unless the EA has them already. */
  private async sendSubscription(): Promise<void> {
    const subscription = this.subscription
    const text = JSON.stringify(subscription)
    if (text === this.sentSubscription) return
    this.sentSubscription = text
    try {
      const unknown = parseSubscribeAnswer(await this.server.request('market.subscribe', { quotes: subscription.quotes, bars: subscription.bars }))
      if (unknown.length > 0) this.options.log('mt5.subscribe-unknown', { count: unknown.length, symbols: unknown.slice(0, 20).join(', ') }, 'debug')
    } catch (error) {
      if (this.sentSubscription === text) this.sentSubscription = null
      throw error
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
      blocked: blockReasons({ phase, terminal, account, disclaimerAccepted: this.disclaimer !== null }),
      syncedAt: this.syncedAt,
      lastRejection: this.lastRejection,
      tls: this.fingerprint === null ? null : { fingerprint: this.fingerprint },
      disclaimer: this.disclaimer,
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
