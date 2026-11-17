/**
 * The MT5 bridge as the gateway mode sees it: instead of listening for an EA to dial in, the
 * Desktop is an SDK client of the local MT5Bridge gateway, where every terminal's DLL has already
 * dialed in. The runtime keeps the shape of `Mt5BridgeRuntime`, so the IPC layer and the page need
 * no changes: a status with one terminal in use, a catalogue, trading state, quote and bar
 * subscriptions, and history.
 *
 * The gateway's terminal table is not truth: `bridge.hello` may list an agent that died without
 * the gateway noticing, and a tester agent of a strategy-tester run appears beside the real
 * terminal. A candidate is therefore probed (`terminal.get`) before it is used, the real terminal
 * (`data_path` contains `\Terminal\`) wins over a tester agent, and a probe failure just moves on
 * to the next candidate — the same liveness contract the bridge's test scripts follow.
 *
 * Events invalidate, pulls decide: a pushed trade event marks the trading state dirty and the
 * state is re-read from the terminal, never patched from the event payload. A sequence gap or
 * `event.resync_required` triggers the bridge's `system.resync`, whose full re-push lands as
 * ordinary events. When the terminal in use leaves the gateway's table, the account, trading
 * state and subscriptions are cleared — MT5 stays the authority — while the catalogue outlives
 * the disconnect, so the page keeps its symbols while the quotes pause.
 */
import type { DesktopPreferences } from '../desktop-contract.ts'
import { randomUUID } from 'node:crypto'
import { Mt5RequestError } from './bridge-server.ts'
import {
  MT5_DISCLAIMER_VERSION, MT5_TIMEFRAMES,
  type Mt5Account, type Mt5Bar, type Mt5BarData, type Mt5Catalog, type Mt5DataEvent, type Mt5Deal, type Mt5HistoryBars, type Mt5HistoryBarsOptions,
  type Mt5HistoryBarsRequest, type Mt5HistoryOrder, type Mt5Order, type Mt5PendingType, type Mt5Position, type Mt5Status, type Mt5Subscription,
  type Mt5Symbol, type Mt5SymbolInfo, type Mt5TerminalStatus, type Mt5Tick, type Mt5TradeHistory, type Mt5TradeInput,
  type Mt5TradeOutcome, type Mt5Trading,
} from './contract.ts'
import { MT5_GATEWAY_URL, Mt5GatewayLink, type GatewayEvent, type GatewayTerminal, type GatewayTransportFactory } from './gateway-link.ts'
import { blockReasons, bridgePhase } from './terminal-state.ts'

/**
 * The wire the runtime rides: the gateway's SDK face (`Mt5GatewayLink`), or the mt5bridge SDK
 * serving the terminal face in process (`Mt5SdkLink`). Both keep the same shape, so this layer
 * and everything above it cannot tell them apart.
 */
export interface Mt5LinkPort {
  /** The face's port, for the status the page shows. */
  readonly port: number
  open(): void
  close(): void
  snapshot(): readonly GatewayTerminal[]
  onTerminals(listener: (terminals: readonly GatewayTerminal[]) => void): () => void
  onEvent(listener: (event: GatewayEvent) => void): () => void
  onConnection(listener: (up: boolean) => void): () => void
  call(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<Record<string, unknown>>
}

export type Mt5LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type Mt5GatewayLog = (event: string, fields?: Record<string, string | number | boolean | null>, level?: Mt5LogLevel) => void

export type Mt5GatewayPreferences = Pick<DesktopPreferences, 'mt5Enabled' | 'mt5DisclaimerVersion' | 'mt5DisclaimerAcceptedAt'>

export interface Mt5GatewayRuntimeOptions {
  /** The gateway's SDK face; `MT5_GATEWAY_URL` by default. */
  url?: string
  /** The transport to ride, for tests; the platform WebSocket by default. */
  transport?: GatewayTransportFactory
  /**
   * The link to ride instead of the gateway socket — the in-process SDK, whose terminal face the
   * terminal's DLL dials directly. Given, `url` and `transport` do not apply.
   */
  link?: Mt5LinkPort
  /**
   * Which terminal to work with: the real one (default), or a strategy-tester agent — a 1:1
   * replay of which stands in for the market on a closed weekend.
   */
  terminal?: 'real' | 'tester'
  log: Mt5GatewayLog
  now?: () => number
}

/** A symbol as `symbol.get` reports it: the catalogue entry plus the trading rules. */
interface SymbolDetail extends Mt5Symbol {
  volumeLimit: number
  stopsLevel: number
  freezeLevel: number
  execution: string
  orderModes: readonly string[]
  marginBuy: number | null
  marginSell: number | null
}

const PROBE_TIMEOUT_MS = 3_000
/** How long a failed recovery waits before it tries the terminal table again. */
const RETRY_MS = 5_000
/** The pause that folds a burst of trade events into one re-read. */
const REFOLD_MS = 500
/** Symbols hydrated at once while reading details. */
const HYDRATE_PARALLEL = 8
/** Resync asks the bridge to re-push; one per window is plenty. */
const RESYNC_DEBOUNCE_MS = 2_000
/** The snapshot and the `connected` event of one arrival land together; recovery runs once. */
const RECOVERY_DEBOUNCE_MS = 250
/** Subscription changes within this window reach the terminal as one flush. */
const SUBSCRIBE_DEBOUNCE_MS = 50

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
const delay = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const asString = (value: unknown): string => typeof value === 'string' ? value : ''
const asNumber = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback
/** Tickets and order ids travel as decimal strings (ulong range); integers accepted, as in protocol.ts's id(). */
const asTicketId = (value: unknown): string =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value)
    : typeof value === 'string' && /^\d{1,20}$/u.test(value) ? value
      : '0'
const asPositive = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null

/** The chart key of a subscription stream, as the bridge's subscription table knows it. */
const streamKey = (symbol: string, timeframe: string): string => `${symbol}\n${timeframe}`

/** `map` over `items` with at most `limit` promises in flight, keeping failures as null. */
async function mapLimited<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      try { results[index] = await task(items[index]!) } catch { results[index] = null }
    }
  })
  await Promise.all(workers)
  return results
}

export class Mt5GatewayRuntime {
  private readonly link: Mt5LinkPort
  private readonly now: () => number
  private readonly log: Mt5GatewayLog
  private readonly terminalKind: 'real' | 'tester'
  private readonly listeners = new Set<(status: Mt5Status) => void>()
  private readonly dataListeners = new Set<(event: Mt5DataEvent) => void>()
  /** One trade at a time, as the bridge's journal keys one request to one outcome. */
  private tradeInFlight = false

  private enabled = false
  private disclaimer: Mt5Status['disclaimer'] = null
  private gatewayUp = false

  /** The terminal in use, and the state synced from it. */
  private terminalId: string | null = null
  private ready = false
  private terminal: Mt5TerminalStatus | null = null
  private account: Mt5Account | null = null
  private positions: readonly Mt5Position[] | null = null
  private orders: readonly Mt5Order[] | null = null
  private syncedAt: number | null = null
  /** Orders the steps of one recovery; a later recovery supersedes an earlier one. */
  private generation = 0
  private recoveryTimer: NodeJS.Timeout | undefined
  private refoldTimer: NodeJS.Timeout | undefined
  private resyncAt = 0
  private lastSeq: number | null = null

  /** Catalogue: the symbols whose details are read, seeded from the terminal's Market Watch. */
  private catalogValue: Mt5Catalog | null = null
  private readonly details = new Map<string, SymbolDetail>()
  private serverName = ''
  private watch: readonly string[] = []
  private hydrating = new Set<string>()

  /** The page's subscriptions, and the chart subscriptions the terminal actually holds. */
  private subscription: Mt5Subscription = { quotes: [], bars: [] }
  private readonly active = new Map<string, { symbol: string; period: string }>()
  private sentSubscription: string | null = null
  private sentWatch: string | null = null
  private flushTimer: NodeJS.Timeout | undefined
  /** One flush runs at a time; changes that arrive meanwhile run again after it. */
  private flushing = false
  private reflush = false
  private snapshot: Mt5Status
  private published = ''

  constructor(options: Mt5GatewayRuntimeOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log
    this.terminalKind = options.terminal === 'tester' ? 'tester' : 'real'
    this.link = options.link ?? new Mt5GatewayLink({ url: options.url ?? MT5_GATEWAY_URL, transport: options.transport, log: options.log, now: this.now })
    this.link.onConnection(up => { this.onConnection(up) })
    this.link.onTerminals(terminals => { this.onTerminals(terminals) })
    this.link.onEvent(event => { this.onEvent(event) })
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

  /** @returns the unsubscribe function. */
  subscribeData(listener: (event: Mt5DataEvent) => void): () => void {
    this.dataListeners.add(listener)
    return () => { this.dataListeners.delete(listener) }
  }

  catalog(): Mt5Catalog | null {
    return this.catalogValue
  }

  trading(): Mt5Trading | null {
    return this.positions === null || this.orders === null ? null : { positions: this.positions, orders: this.orders }
  }

  token(): string {
    return '(managed by the MT5Bridge gateway)'
  }

  async regenerateToken(): Promise<string> {
    throw new Mt5RequestError('not_available', 'Gateway mode: the token belongs to the gateway and the terminal DLL')
  }

  /** Apply the preferences: only the enable switch matters, as the gateway address is fixed. */
  async configure(preferences: Mt5GatewayPreferences, options: { safeMode: boolean }): Promise<void> {
    this.disclaimer = preferences.mt5DisclaimerVersion === MT5_DISCLAIMER_VERSION
      ? { version: preferences.mt5DisclaimerVersion, acceptedAt: preferences.mt5DisclaimerAcceptedAt }
      : null
    const enabled = preferences.mt5Enabled && !options.safeMode
    if (enabled === this.enabled) return
    this.enabled = enabled
    if (enabled) this.link.open()
    else await this.stop()
    this.publish()
  }

  /** Read the terminal state again from the terminal in use. */
  async resync(): Promise<void> {
    if (this.terminalId === null) throw new Mt5RequestError('not_connected', 'No terminal is in use')
    await this.sync(this.terminalId)
  }

  /** Renderer requests stay read-only; `account.snapshot` keeps its legacy name. */
  async request(type: string): Promise<Record<string, unknown>> {
    if (type === 'account.snapshot') return this.call('state.snapshot')
    if (type === 'system.status') return this.call('system.status')
    throw new Mt5RequestError('not_available', `MT5 request ${type} is not available in gateway mode`)
  }

  /** How long a history request waits for the terminal to build or download the series. */
  private static readonly HISTORY_WAIT_MS = 12_000
  private static readonly HISTORY_RETRY_MS = 400

  /**
   * Bars that open before `request.to`, oldest first. The terminal may still be building or
   * downloading the series (`CopyRates` answers 4401), so the request repeats until the series
   * answers or the wait runs out; the legacy `partial` waiting game does not apply beyond that.
   */
  async historyBars(request: Mt5HistoryBarsRequest, _options: Mt5HistoryBarsOptions = {}): Promise<Mt5HistoryBars> {
    const deadline = this.now() + Mt5GatewayRuntime.HISTORY_WAIT_MS
    let answer: Record<string, unknown>
    for (;;) {
      try {
        answer = await this.call('market.bars', { symbol: request.symbol, period: request.timeframe, count: request.count, to_ms: request.to })
        break
      } catch (error) {
        if (!(error instanceof Mt5RequestError) || !/4401/u.test(error.message) || this.now() > deadline) throw error
        await delay(Mt5GatewayRuntime.HISTORY_RETRY_MS)
      }
    }
    const bars: Mt5BarData[] = []
    for (const raw of Array.isArray(answer.bars) ? answer.bars : []) {
      if (!isRecord(raw)) continue
      bars.push({
        time: asNumber(raw.time_msc, 0),
        open: asNumber(raw.open, 0), high: asNumber(raw.high, 0), low: asNumber(raw.low, 0), close: asNumber(raw.close, 0),
        volume: asNumber(raw.tick_volume, 0),
      })
    }
    bars.sort((left, right) => left.time - right.time)
    return { bars, noData: bars.length === 0 }
  }

  /** Orders and deals of a time range, newest first. */
  async historyTrades(range: { from: number; to: number }): Promise<Mt5TradeHistory> {
    const window = { from_ms: range.from, to_ms: range.to }
    const [orders, deals] = await Promise.all([
      this.call('history.orders', window),
      this.call('history.deals', window),
    ])
    return { orders: parseHistoryOrders(orders), deals: parseHistoryDeals(deals), truncated: false }
  }

  /** How long a trade request waits for its acceptance before the outcome is `unknown`. */
  private static readonly TRADE_WAIT_MS = 20_000

  /**
   * Send a trade request once. The bridge takes it asynchronously (`trade.execute` answers
   * acceptance, not the fill), so `placed` means MT5 took it and the outcome arrives as the trade
   * events that follow; a timeout is `unknown`, never a cancellation, and the bridge's journal
   * keys it by the idempotency key for reconciliation.
   */
  async trade(input: Mt5TradeInput): Promise<Mt5TradeOutcome> {
    const blocked = this.build().blocked[0]
    if (blocked !== undefined) return localOutcome('blocked', null, 'blocked', `Trading is blocked: ${blocked}`, blocked)
    if (this.terminalId === null) return localOutcome('blocked', null, 'not_connected', 'No terminal is in use', 'ea-disconnected')
    const account = this.account
    if (account === null || account.login !== input.account.login || account.server !== input.account.server) {
      return localOutcome('rejected', null, 'account_mismatch', 'The trade names another account than the one in use')
    }
    if (this.tradeInFlight) return localOutcome('rejected', null, 'busy', 'Another trade request is still waiting for the terminal')
    this.tradeInFlight = true
    const id = `dsh-${randomUUID()}`
    this.log('mt5.trade-sent', { id, type: input.type, symbol: input.symbol })
    let outcome: Mt5TradeOutcome
    try {
      const [method, body] = tradeBody(input)
      const answer = await this.call(method, { ...body, idempotency_key: id }, Mt5GatewayRuntime.TRADE_WAIT_MS)
      const retcode = asNumber(answer.retcode, 0)
      const requestId = answer.request_id === undefined ? null : String(answer.request_id)
      outcome = answer.status === 'accepted'
        ? localOutcome(input.type === 'order.place' && input.orderType === 'market' ? 'placed' : 'done', requestId, 'sent', '', null, retcode)
        : localOutcome('rejected', requestId, 'sent', `MT5 refused the request (retcode ${String(retcode)})`, null, retcode)
    } catch (error) {
      const code = error instanceof Mt5RequestError ? error.code : 'failed'
      if (code === 'timeout') outcome = localOutcome('unknown', id, code, `The terminal did not answer within ${String(Mt5GatewayRuntime.TRADE_WAIT_MS / 1000)} s`)
      else if (code === 'not_connected') outcome = localOutcome('unknown', id, code, 'The terminal connection dropped before it answered')
      else outcome = localOutcome('rejected', id, code, errorText(error))
    } finally {
      this.tradeInFlight = false
    }
    this.log('mt5.trade-result', { id, status: outcome.status, retcode: outcome.retcode, code: outcome.code }, outcome.status === 'unknown' ? 'warn' : 'info')
    return outcome
  }

  /** A symbol's trade rules, read from the terminal at every call. */
  async symbolInfo(symbol: string): Promise<Mt5SymbolInfo> {
    const detail = await this.symbolDetail(symbol)
    return {
      symbol: detail.name,
      digits: detail.digits, point: detail.point, tickSize: detail.tickSize, contractSize: detail.contractSize,
      volumeMin: detail.volumeMin, volumeMax: detail.volumeMax, volumeStep: detail.volumeStep,
      volumeLimit: detail.volumeLimit, stopsLevel: detail.stopsLevel, freezeLevel: detail.freezeLevel,
      tradeMode: detail.tradeMode, execution: detail.execution, orderModes: detail.orderModes,
      marginBuy: detail.marginBuy, marginSell: detail.marginSell,
      sessionOpen: false,
    }
  }

  /** Replace the page's quote and bar subscriptions; the terminal in use gets their charts. */
  setSubscription(subscription: Mt5Subscription): void {
    this.subscription = subscription
    clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flushSubscription()
    }, SUBSCRIBE_DEBOUNCE_MS)
    this.flushTimer.unref?.()
  }

  async stop(): Promise<void> {
    this.enabled = false
    clearTimeout(this.recoveryTimer)
    this.recoveryTimer = undefined
    clearTimeout(this.refoldTimer)
    this.refoldTimer = undefined
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    this.link.close()
    this.gatewayUp = false
    this.abandon('the bridge stopped')
    this.publish()
  }

  // ── Connection and terminal choice ────────────────────────────────────────

  private onConnection(up: boolean): void {
    this.gatewayUp = up
    if (!up) {
      this.abandon('the gateway connection dropped')
      this.scheduleRecovery(RETRY_MS)
    }
    this.publish()
  }

  /**
   * The terminal table changed: the hello snapshot, or a terminal that came or went. The terminal
   * in use leaving the table ends its session; otherwise a new terminal is worth a recovery.
   */
  private onTerminals(terminals: readonly { terminal_id: string }[]): void {
    if (this.terminalId !== null && !terminals.some(terminal => terminal.terminal_id === this.terminalId)) {
      this.abandon('the terminal left the gateway')
      this.scheduleRecovery()
      return
    }
    this.scheduleRecovery(RECOVERY_DEBOUNCE_MS)
  }

  private scheduleRecovery(pause = 0): void {
    if (!this.enabled) return
    clearTimeout(this.recoveryTimer)
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined
      void this.recover()
    }, pause)
    this.recoveryTimer.unref?.()
  }

  /** Probe the gateway's terminals and sync the best one; failures retry later. */
  private async recover(): Promise<void> {
    if (!this.enabled || this.terminalId !== null) return
    const candidates = this.link.snapshot().map(terminal => terminal.terminal_id)
    if (candidates.length === 0) return
    const generation = ++this.generation
    const probed: { terminalId: string; dataPath: string }[] = []
    for (const terminalId of candidates) {
      const probe = await this.probe(terminalId)
      if (probe !== null) probed.push(probe)
      if (generation !== this.generation) return
    }
    if (probed.length === 0) {
      // The whole snapshot is stale; the gateway will tell when a live terminal arrives.
      this.log('mt5.gateway-terminals-dead', { candidates: candidates.length }, 'warn')
      this.scheduleRecovery(RETRY_MS)
      return
    }
    // The kind asked for wins; a tester preference takes a replay agent, the default the real
    // terminal. Between equals, the first probed.
    const wanted = this.terminalKind === 'tester'
    const chosen = probed.find(probe => probe.dataPath.includes('\\Tester\\') === wanted) ?? probed[0]!
    if (chosen.dataPath.includes('\\Tester\\') !== wanted) {
      this.log('mt5.gateway-terminal-kind-missed', { wanted: this.terminalKind, terminal_id: chosen.terminalId }, 'warn')
    }
    this.terminalId = chosen.terminalId
    this.lastSeq = null
    this.publish()
    await this.sync(chosen.terminalId)
  }

  /** Whether a listed terminal answers; its data path says real terminal or tester agent. */
  private async probe(terminalId: string): Promise<{ terminalId: string; dataPath: string } | null> {
    try {
      const answer = await this.link.call('terminal.get', { terminal_id: terminalId }, { timeoutMs: PROBE_TIMEOUT_MS })
      return { terminalId, dataPath: asString(answer.data_path) }
    } catch {
      return null
    }
  }

  private requireTerminal(): string {
    const terminalId = this.terminalId
    if (terminalId === null) throw new Mt5RequestError('not_connected', 'No terminal is in use')
    return terminalId
  }

  private async call(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<Record<string, unknown>> {
    const terminalId = this.requireTerminal()
    return this.link.call(method, { ...params, terminal_id: terminalId }, timeoutMs !== undefined ? { timeoutMs } : undefined)
  }

  /** Forget the terminal in use and everything synced from it; the catalogue stays. */
  private abandon(reason: string): void {
    if (this.terminalId === null) return
    const hadTrading = this.trading() !== null
    this.generation++
    this.terminalId = null
    this.ready = false
    this.terminal = null
    this.account = null
    this.positions = null
    this.orders = null
    this.lastSeq = null
    this.sentSubscription = null
    this.sentWatch = null
    this.active.clear()
    this.log('mt5.gateway-terminal-lost', { reason })
    if (hadTrading) this.emitData({ kind: 'trading', trading: null })
    this.publish()
  }

  // ── Sync ──────────────────────────────────────────────────────────────────

  /** Read the whole terminal state, then replay the page's subscriptions and go ready. */
  private async sync(terminalId: string): Promise<void> {
    const generation = ++this.generation
    const current = (): boolean => generation === this.generation && this.terminalId === terminalId
    this.ready = false
    this.publish()
    try {
      const terminal = parseTerminalStatus(await this.call('terminal.get'))
      if (!current()) return
      this.terminal = terminal
      const account = parseAccount(await this.call('account.get'))
      if (!current()) return
      this.account = account
      // Another server's symbols must not stand in for this one's.
      if (this.serverName !== '' && this.serverName !== account.server) this.details.clear()
      this.serverName = account.server
      this.positions = parsePositions(await this.call('position.list'))
      if (!current()) return
      this.orders = parseOrders(await this.call('order.list'))
      if (!current()) return
      this.tradingChanged()
      await this.readCatalog()
      if (!current()) return
      // A fresh terminal session holds no charts; ready first, so the flush replays whole.
      this.sentSubscription = null
      this.sentWatch = null
      this.active.clear()
      this.ready = true
      await this.flushSubscription()
      if (!current()) return
      this.syncedAt = this.now()
      this.log('mt5.gateway-synced', { terminal_id: terminalId, login: account.login, symbols: this.catalogValue?.symbols.length ?? null })
    } catch (error) {
      if (!current()) return
      this.log('mt5.gateway-sync-failed', { detail: errorText(error) }, 'warn')
      // The terminal is gone or stalled; let recovery find one that answers.
      this.abandon(`sync failed: ${errorText(error)}`)
      this.scheduleRecovery(RETRY_MS)
      return
    }
    this.publish()
  }

  /**
   * The catalogue starts from the terminal's Market Watch: its symbols are read in full. The rest
   * of the trade server's names wait until a subscription needs them, for a server lists thousands.
   */
  private async readCatalog(): Promise<void> {
    const answer = await this.call('symbol.list', { view_only: 'true' })
    const watch = (Array.isArray(answer.symbols) ? answer.symbols : []).filter(name => typeof name === 'string') as string[]
    await mapLimited(watch, HYDRATE_PARALLEL, async name => this.symbolDetail(name).catch(() => null))
    this.watch = watch
    this.publishCatalog()
  }

  /** One symbol's details, cached; the first read of a symbol goes to the terminal. */
  private async symbolDetail(symbol: string): Promise<SymbolDetail> {
    const cached = this.details.get(symbol)
    if (cached !== undefined) return cached
    const detail = parseSymbol(await this.call('symbol.get', { symbol }))
    this.details.set(symbol, detail)
    this.publishCatalog()
    return detail
  }

  /** The catalogue is the details read so far, the Market Watch's symbols in their order first. */
  private publishCatalog(): void {
    if (this.serverName === '') return
    const watch = this.watch.filter(name => this.details.has(name))
    const symbols = watch.map(name => this.details.get(name)!)
    for (const [name, detail] of this.details) {
      if (!watch.includes(name)) symbols.push(detail)
    }
    this.catalogValue = { server: this.serverName, watch, symbols }
    this.emitData({ kind: 'catalog', catalog: this.catalogValue })
  }

  private tradingChanged(): void {
    const trading = this.trading()
    if (trading !== null) this.emitData({ kind: 'trading', trading })
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  /** The chart keys the page's bar subscriptions need: quotes ride the service's watch list, not charts. */
  private wanted(): Map<string, { symbol: string; period: string }> {
    const streams = new Map<string, { symbol: string; period: string }>()
    for (const stream of this.subscription.bars) {
      const key = streamKey(stream.symbol, stream.timeframe)
      streams.set(key, { symbol: stream.symbol, period: stream.timeframe })
    }
    return streams
  }

  /**
   * Bring the terminal's charts to what the page wants: subscribe what is new, unsubscribe what
   * is gone, and read the details of symbols the catalogue has not seen before the charts open.
   */
  private async flushSubscription(): Promise<void> {
    if (this.flushing) {
      this.reflush = true
      return
    }
    this.flushing = true
    try {
      await this.flushNow()
    } finally {
      this.flushing = false
      if (this.reflush) {
        this.reflush = false
        void this.flushSubscription()
      }
    }
  }

  private async flushNow(): Promise<void> {
    const wanted = this.wanted()
    const symbols = [...new Set([...this.subscription.bars.map(stream => stream.symbol), ...this.subscription.quotes])]
    // While no terminal is in use the details can still be read; charts wait for a synced one,
    // for a mid-sync flush would double-subscribe against the sync's own replay.
    if (this.terminalId === null || !this.ready) {
      await this.hydrate(symbols)
      return
    }
    const text = JSON.stringify(this.subscription)
    if (text === this.sentSubscription) return
    this.sentSubscription = text
    // The quote watch list is the service's to poll (no chart per symbol): one call replaces the
    // whole set, and the first pass after it seeds every symbol at once.
    const watch = JSON.stringify(this.subscription.quotes)
    if (watch !== this.sentWatch) {
      this.sentWatch = watch
      this.link.call('market.watch', { symbols: this.subscription.quotes, terminal_id: this.terminalId }).catch((error: unknown) => {
        if (this.sentWatch === watch) this.sentWatch = null
        this.log('mt5.gateway-watch-failed', { detail: errorText(error) }, 'warn')
      })
    }
    await this.hydrate(symbols)
    const removals: Promise<unknown>[] = []
    for (const [key, stream] of [...this.active.entries()]) {
      if (!wanted.has(key)) {
        this.active.delete(key)
        removals.push(this.link.call('market.unsubscribe', { symbol: stream.symbol, period: stream.period, terminal_id: this.terminalId }).catch(() => {}))
      }
    }
    for (const [key, stream] of wanted) {
      if (this.active.has(key)) continue
      this.active.set(key, stream)
      try {
        await this.link.call('market.subscribe', { symbol: stream.symbol, period: stream.period, terminal_id: this.terminalId })
      } catch (error) {
        this.active.delete(key)
        this.log('mt5.gateway-subscribe-failed', { symbol: stream.symbol, period: stream.period, detail: errorText(error) }, 'warn')
        continue
      }
      // One quote seeds the page before the terminal's next tick reaches it.
      void this.link.call('market.quote', { symbol: stream.symbol, terminal_id: this.terminalId }).then(quote => {
        const tick = parseTick(quote, stream.symbol)
        if (tick !== null) this.emitData({ kind: 'ticks', ticks: [tick] })
      }).catch(() => {})
    }
    await Promise.all(removals)
  }

  /** Read the details of symbols the catalogue lacks, so charts know their digits. */
  private async hydrate(symbols: readonly string[]): Promise<void> {
    const missing = symbols.filter(symbol => !this.details.has(symbol) && !this.hydrating.has(symbol))
    if (missing.length === 0) return
    for (const symbol of missing) this.hydrating.add(symbol)
    await mapLimited(missing, HYDRATE_PARALLEL, async symbol => {
      try { await this.symbolDetail(symbol) } catch (error) {
        this.log('mt5.gateway-symbol-failed', { symbol, detail: errorText(error) }, 'warn')
      } finally { this.hydrating.delete(symbol) }
    })
  }

  // ── Events ────────────────────────────────────────────────────────────────

  private onEvent(event: { method: string; params: Record<string, unknown>; terminalId: string | null; seq: number | null }): void {
    if (event.terminalId !== this.terminalId) return
    // A sequence that went backwards or jumped means events were lost; ask the bridge to re-push.
    if (event.seq !== null) {
      if (this.lastSeq !== null && (event.seq < this.lastSeq || event.seq > this.lastSeq + 1)) {
        this.log('mt5.gateway-seq-gap', { last: this.lastSeq, now: event.seq, method: event.method }, 'warn')
        this.resyncTerminal()
      }
      this.lastSeq = event.seq
    }
    switch (event.method) {
      case 'event.market.tick': {
        const tick = parseTick(event.params, '')
        if (tick !== null && tick.symbol !== '') this.emitData({ kind: 'ticks', ticks: [tick] })
        return
      }
      case 'event.market.bar':
      case 'event.market.bar_closed': {
        const bar = parseBar(event.params)
        if (bar !== null) this.emitData({ kind: 'bars', bars: [bar] })
        return
      }
      case 'event.resync_required':
        this.resyncTerminal()
        return
      // Trade events invalidate; the state is re-read from the terminal.
      case 'event.account.changed':
      case 'event.position.changed':
      case 'event.order.changed':
      case 'event.deal.added':
        this.refold()
        return
      default:
        return
    }
  }

  /** The bridge re-pushes its watchers' whole state; this lands as the events above. */
  private resyncTerminal(): void {
    if (this.terminalId === null || this.now() - this.resyncAt < RESYNC_DEBOUNCE_MS) return
    this.resyncAt = this.now()
    this.link.call('system.resync', { terminal_id: this.terminalId }).catch(() => {})
  }

  /** Fold a burst of trade events into one re-read of positions and orders. */
  private refold(): void {
    if (this.refoldTimer !== undefined) return
    this.refoldTimer = setTimeout(() => {
      this.refoldTimer = undefined
      void this.refoldNow()
    }, REFOLD_MS)
    this.refoldTimer.unref?.()
  }

  private async refoldNow(): Promise<void> {
    if (this.terminalId === null) return
    const generation = this.generation
    try {
      // The gate (blocked) lives on terminal/account facts the events themselves don't carry.
      // The bridge's service may start before the broker login lands, so the first sync can
      // read "disconnected" that later events never correct — re-read both here, and a
      // terminal that connects afterwards unblocks without a manual resync.
      const terminal = parseTerminalStatus(await this.call('terminal.get'))
      if (generation !== this.generation) return
      this.terminal = terminal
      const account = parseAccount(await this.call('account.get'))
      if (generation !== this.generation) return
      this.account = account
      this.positions = parsePositions(await this.call('position.list'))
      if (generation !== this.generation) return
      this.orders = parseOrders(await this.call('order.list'))
      if (generation !== this.generation) return
      this.tradingChanged()
      this.publish()
    } catch (error) {
      this.log('mt5.gateway-refold-failed', { detail: errorText(error) }, 'warn')
    }
  }

  private emitData(event: Mt5DataEvent): void {
    for (const listener of [...this.dataListeners]) listener(event)
  }

  // ── Status ────────────────────────────────────────────────────────────────

  private build(): Mt5Status {
    const phase = bridgePhase({
      enabled: this.enabled,
      error: null,
      listening: this.gatewayUp,
      session: this.terminalId === null ? 'none' : this.ready ? 'ready' : 'syncing',
    })
    return {
      phase,
      listen: this.enabled ? { host: '127.0.0.1', port: this.link.port, addresses: ['127.0.0.1'] } : null,
      error: null,
      peer: this.terminalId === null ? null : { address: '127.0.0.1', port: 18860, eaVersion: 'gateway', connectedAt: this.syncedAt ?? 0 },
      terminal: this.terminalId === null ? null : this.terminal,
      account: this.terminalId === null ? null : this.account,
      blocked: blockReasons({ phase, terminal: this.terminal, account: this.account, disclaimerAccepted: this.disclaimer !== null }),
      syncedAt: this.syncedAt,
      lastRejection: null,
      tls: null,
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

// ── Wire to domain mappings ─────────────────────────────────────────────────

const TRADE_MODES: Readonly<Record<number, Mt5SymbolInfo['tradeMode']>> = { 0: 'disabled', 1: 'long_only', 2: 'short_only', 3: 'close_only', 4: 'full' }

/** A trade request the runtime answered without the terminal. */
function localOutcome(status: Mt5TradeOutcome['status'], id: string | null, code: string, message: string, blocked: Mt5Status['blocked'][number] | null = null, retcode = 0): Mt5TradeOutcome {
  return { status, id, blocked, retcode, code, message, order: null, deal: null, price: null, volume: null, duplicate: false }
}

/** A trade request as the bridge takes it: the method it rides and its parameters. */
function tradeBody(input: Mt5TradeInput): [string, Record<string, unknown>] {
  const stops = (sl: number | null, tp: number | null): Record<string, unknown> => ({
    ...(sl === null ? {} : { sl }), ...(tp === null ? {} : { tp }),
  })
  switch (input.type) {
    case 'order.place':
      return ['trade.execute', {
        action: input.orderType === 'market' ? input.side : `${input.side}_${input.orderType}`,
        symbol: input.symbol, volume: input.volume,
        ...(input.price === null ? {} : { price: input.price }),
        ...stops(input.sl, input.tp),
      }]
    case 'position.close':
      return ['position.close', { ticket: input.ticket, volume: input.volume }]
    case 'position.modify':
      return ['position.modify', { ticket: input.ticket, ...stops(input.sl, input.tp) }]
    case 'order.modify':
      return ['order.modify', { ticket: input.ticket, price: input.price, ...stops(input.sl, input.tp) }]
    case 'order.cancel':
      return ['order.cancel', { ticket: input.ticket }]
  }
}

/** `history.orders` answer, newest first. */
function parseHistoryOrders(answer: Record<string, unknown>): Mt5HistoryOrder[] {
  const orders: Mt5HistoryOrder[] = []
  for (const raw of Array.isArray(answer.orders) ? answer.orders : []) {
    if (!isRecord(raw)) continue
    orders.push({
      ticket: asTicketId(raw.ticket),
      symbol: asString(raw.symbol),
      type: asString(raw.type) as Mt5HistoryOrder['type'],
      state: asString(raw.state),
      volumeInitial: asNumber(raw.volume_initial, 0),
      volumeCurrent: asNumber(raw.volume_current, 0),
      price: asPositive(raw.price_open),
      stopLimit: null,
      sl: asPositive(raw.sl),
      tp: asPositive(raw.tp),
      timeSetup: asNumber(raw.time_setup_msc, 0),
      timeDone: asNumber(raw.time_done_msc, 0),
      position: null,
      positionBy: null,
      reason: '',
      comment: asString(raw.comment),
      magic: asNumber(raw.magic, 0),
    })
  }
  return orders.sort((left, right) => right.timeSetup - left.timeSetup)
}

/** `history.deals` answer, newest first. */
function parseHistoryDeals(answer: Record<string, unknown>): Mt5Deal[] {
  const deals: Mt5Deal[] = []
  for (const raw of Array.isArray(answer.deals) ? answer.deals : []) {
    if (!isRecord(raw)) continue
    deals.push({
      ticket: asTicketId(raw.ticket),
      order: raw.order === undefined ? null : asTicketId(raw.order),
      position: null,
      symbol: asString(raw.symbol),
      type: asString(raw.type),
      entry: asString(raw.direction) === 'out' ? 'out' : 'in',
      volume: asNumber(raw.volume, 0),
      price: asNumber(raw.price, 0),
      commission: asNumber(raw.commission, 0),
      swap: asNumber(raw.swap, 0),
      fee: 0,
      profit: asNumber(raw.profit, 0),
      time: asNumber(raw.time_msc, 0),
      reason: '',
      comment: asString(raw.comment),
      magic: asNumber(raw.magic, 0),
    })
  }
  return deals.sort((left, right) => right.time - left.time)
}

/** `terminal.get` answer. */
function parseTerminalStatus(answer: Record<string, unknown>): Mt5TerminalStatus {
  return {
    connected: answer.connected === true,
    tradeAllowed: answer.trade_allowed === true,
    // The bridge reports the terminal's DLL permission; the closest it has to the EA's own switch.
    eaTradeAllowed: answer.dlls_allowed !== false,
    build: asNumber(answer.build, 0),
    name: asString(answer.name),
    company: asString(answer.company),
    pingMs: null,
    serverUtcOffset: 0,
  }
}

/** `account.get` answer. */
function parseAccount(answer: Record<string, unknown>): Mt5Account {
  const server = asString(answer.server)
  const tradeMode = /demo/i.test(server) ? 'demo' : /contest/i.test(server) ? 'contest' : 'real'
  return {
    login: String(asNumber(answer.login, 0)),
    name: '',
    server,
    company: '',
    currency: asString(answer.currency) || 'USD',
    currencyDigits: 2,
    leverage: asNumber(answer.leverage, 0),
    tradeMode,
    marginMode: answer.hedging === true ? 'hedging' : 'netting',
    tradeAllowed: answer.trade_allowed === true,
    tradeExpert: answer.algo_allowed !== false,
    limitOrders: 0,
    balance: asNumber(answer.balance, 0),
    credit: 0,
    profit: asNumber(answer.profit, 0),
    equity: asNumber(answer.equity, 0),
    margin: asNumber(answer.margin, 0),
    marginFree: asNumber(answer.margin_free, 0),
    marginLevel: asPositive(answer.margin_level),
    marginCall: 0,
    stopOut: 0,
    marginSoMode: 'percent',
  }
}

/** `symbol.get` answer. */
function parseSymbol(answer: Record<string, unknown>): SymbolDetail {
  const name = asString(answer.symbol)
  const point = asNumber(answer.point, 0.00001)
  return {
    name,
    description: asString(answer.description) || name,
    path: asString(answer.path),
    currencyBase: asString(answer.currency_base),
    currencyProfit: asString(answer.currency_profit),
    currencyMargin: asString(answer.currency_margin),
    digits: asNumber(answer.digits, 5),
    point,
    tickSize: asNumber(answer.tick_size, point),
    contractSize: asNumber(answer.contract_size, 100_000),
    volumeMin: asNumber(answer.volume_min, 0.01),
    volumeMax: asNumber(answer.volume_max, 0),
    volumeStep: asNumber(answer.volume_step, 0.01),
    volumeLimit: asNumber(answer.volume_limit, 0),
    stopsLevel: asNumber(answer.stops_level, 0),
    freezeLevel: asNumber(answer.freeze_level, 0),
    tradeMode: TRADE_MODES[asNumber(answer.trade_mode, 4)] ?? 'full',
    calcMode: asString(answer.calc_mode),
    sector: asString(answer.sector),
    selected: answer.visible !== false,
    execution: asString(answer.execution_mode) || 'request',
    orderModes: (Array.isArray(answer.order_modes) ? answer.order_modes : []).filter(mode => typeof mode === 'string') as string[],
    marginBuy: asPositive(answer.margin_buy),
    marginSell: asPositive(answer.margin_sell),
  }
}

/** `position.list` answer. */
function parsePositions(answer: Record<string, unknown>): Mt5Position[] {
  const positions: Mt5Position[] = []
  for (const raw of Array.isArray(answer.positions) ? answer.positions : []) {
    if (!isRecord(raw)) continue
    positions.push({
      ticket: asTicketId(raw.ticket),
      symbol: asString(raw.symbol),
      side: asString(raw.type) === 'sell' ? 'sell' : 'buy',
      volume: asNumber(raw.volume, 0),
      priceOpen: asNumber(raw.price_open, 0),
      sl: asPositive(raw.sl),
      tp: asPositive(raw.tp),
      priceCurrent: asNumber(raw.price_current, 0),
      profit: asNumber(raw.profit, 0),
      swap: asNumber(raw.swap, 0),
      time: asNumber(raw.time_msc, 0),
      comment: asString(raw.comment),
      magic: asNumber(raw.magic, 0),
    })
  }
  return positions
}

/** `order.list` answer. */
function parseOrders(answer: Record<string, unknown>): Mt5Order[] {
  const orders: Mt5Order[] = []
  for (const raw of Array.isArray(answer.orders) ? answer.orders : []) {
    if (!isRecord(raw)) continue
    orders.push({
      ticket: asTicketId(raw.ticket),
      symbol: asString(raw.symbol),
      type: asString(raw.type) as Mt5PendingType,
      state: asString(raw.state),
      volume: asNumber(raw.volume_current, 0),
      volumeInitial: asNumber(raw.volume_initial, 0),
      price: asNumber(raw.price_open, 0),
      stopLimit: null,
      sl: asPositive(raw.sl),
      tp: asPositive(raw.tp),
      priceCurrent: asNumber(raw.price_current, 0),
      time: asNumber(raw.time_setup_msc, 0),
      timeType: 'gtc',
      expiration: null,
      comment: asString(raw.comment),
      magic: asNumber(raw.magic, 0),
    })
  }
  return orders
}

/** A tick event or `market.quote` answer; `fallback` names a quote answer's symbol. */
function parseTick(params: Record<string, unknown>, fallback: string): Mt5Tick | null {
  const bid = asNumber(params.bid, 0)
  const ask = asNumber(params.ask, 0)
  if (bid <= 0 && ask <= 0) return null
  return {
    symbol: asString(params.symbol) || fallback,
    time: asNumber(params.time_msc, 0),
    bid,
    ask,
    dayOpen: asPositive(params.day_open),
    dayHigh: asPositive(params.day_high),
    dayLow: asPositive(params.day_low),
    prevClose: asPositive(params.prev_close),
    dayVolume: asPositive(params.volume),
    sessionOpen: false,
  }
}

/** A bar event answer, dropped when its timeframe is not one the page charts. */
function parseBar(params: Record<string, unknown>): Mt5Bar | null {
  const timeframe = asString(params.period)
  if (!(MT5_TIMEFRAMES as readonly string[]).includes(timeframe)) return null
  return {
    symbol: asString(params.symbol),
    timeframe: timeframe as Mt5Bar['timeframe'],
    time: asNumber(params.time_msc, 0),
    open: asNumber(params.open, 0),
    high: asNumber(params.high, 0),
    low: asNumber(params.low, 0),
    close: asNumber(params.close, 0),
    volume: asNumber(params.tick_volume, 0),
  }
}
