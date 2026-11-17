// Mt5Bridge：SDK 入口。在业务进程内开终端面的门（MT5 的 DLL 主动拨入），
// 把每台在线终端包装成 Account（一次登录 = 一个账户/平台的数据世界）。
// 账户中心路由：Market/Trading 的每个调用都锁定在其账户的终端上，互不串扰。
import { TerminalFace, type TerminalSession } from './face.js'
import { Account, type RawAccount } from './account.js'
import { parseBar, parseBook, parseTick, type RawBar, type RawBookEntry, type RawTick } from './market.js'
import { Trading, type RawDeal, type RawOrder, type RawPosition } from './trading.js'
import { Mt5Error } from './errors.js'
import type { BridgeCore } from './core.js'
import type { AccountKind, BridgeStatus, Capabilities, SystemStatus, Tick, Unsubscribe } from './types.js'

export interface Mt5BridgeOptions {
  /** 终端面监听端口，默认 18850；传 0 = 随机端口（测试用） */
  port?: number
  /** 监听地址，默认 0.0.0.0 */
  host?: string
  /** hello 令牌；非空时终端必须带匹配 token（与网关一致） */
  token?: string
  /** 单个 RPC 的默认超时，默认 30s（与桥/DLL 的 30s 契约对齐） */
  requestTtlMs?: number
  /** 终端上线后的探活超时，默认 3s（hello 快照可能残留已死终端） */
  probeTimeoutMs?: number
  /** seq 断档触发 system.resync 的去抖窗口，默认 2s */
  resyncDebounceMs?: number
  /** 诊断日志回调 */
  log?: (event: string, fields?: Record<string, unknown>) => void
}

export interface TerminalSummary {
  id: string
  role: string
  version: string
  /** 有 Account 的终端给出类别；未通过探活的原始会话为 undefined */
  kind?: AccountKind
}

/** 原始终端事件（event.* 行，seq 顶层注入）：诊断与外接运行时（dsh 网关运行时）用。 */
export interface RawTerminalEvent {
  terminalId: string
  method: string
  seq?: number
  params: Record<string, unknown>
}

export class Mt5Bridge implements BridgeCore {
  /** 启动并在终端面开始监听后返回（不等 MT5 接入）。 */
  static async start(options: Mt5BridgeOptions = {}): Promise<Mt5Bridge> {
    const bridge = new Mt5Bridge(options)
    await bridge.face.listen(bridge.portNumber, options.host ?? '0.0.0.0')
    bridge.portNumber = bridge.face.port
    bridge.log('bridge.listening', { port: bridge.portNumber, token: bridge.token === '' ? 'off' : 'on' })
    return bridge
  }

  private readonly face: TerminalFace
  private readonly accounts = new Map<string, Account>()
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  private readonly subscriptions = new Map<string, Map<string, { symbol: string; period: string; refs: number }>>()
  private readonly lastSeq = new Map<string, number>()
  private readonly resyncTimers = new Map<string, NodeJS.Timeout>()
  private readonly accountListeners = new Set<(accounts: Account[]) => void>()
  private readonly statusListeners = new Set<(status: BridgeStatus) => void>()
  private readonly rawEventListeners = new Set<(event: RawTerminalEvent) => void>()
  private nextRequestId = 0
  private statusValue: BridgeStatus = 'listening'
  private readonly token: string
  private portNumber: number

  private constructor(private readonly options: Mt5BridgeOptions) {
    this.token = options.token ?? ''
    this.portNumber = options.port ?? 18850
    this.face = new TerminalFace(this.token, (event, fields) => this.log(event, fields))
    this.face.on('session', session => { void this.adopt(session) })
    this.face.on('gone', (session, reason) => this.retire(session, reason))
    this.face.on('response', msg => this.onResponse(msg))
    this.face.on('event', (session, msg) => this.onTerminalEvent(session, msg))
  }

  /** 实际监听端口。 */
  get port(): number {
    return this.portNumber
  }

  getStatus(): BridgeStatus {
    return this.statusValue
  }

  /** 在线且通过探活的账户。 */
  getAccounts(): Account[] {
    return [...this.accounts.values()]
  }

  /** 默认账户：真实终端优先于回放 agent。 */
  get main(): Account | undefined {
    const accounts = this.getAccounts()
    return accounts.find(account => account.kind === 'real') ?? accounts[0]
  }

  /** 原始终端会话（含未通过探活的），调试用。 */
  getTerminals(): TerminalSummary[] {
    return this.face.all().map(session => {
      const account = session.terminalId !== null ? this.accounts.get(session.terminalId) : undefined
      return { id: session.terminalId ?? '', role: session.role, version: session.version, kind: account?.kind }
    })
  }

  /** 账户列表变化（上线/离线）。 */
  onAccounts(cb: (accounts: Account[]) => void): Unsubscribe {
    this.accountListeners.add(cb)
    return () => { this.accountListeners.delete(cb) }
  }

  onStatus(cb: (status: BridgeStatus) => void): Unsubscribe {
    this.statusListeners.add(cb)
    return () => { this.statusListeners.delete(cb) }
  }

  /** 原始终端事件流（在 SDK 内部路由之前的完整 event.* 面，含 seq）。 */
  onRawEvent(cb: (event: RawTerminalEvent) => void): Unsubscribe {
    this.rawEventListeners.add(cb)
    return () => { this.rawEventListeners.delete(cb) }
  }

  /** 桥侧运行状态（版本/角色/在线时长/DLL 状态码），诊断用。 */
  async getSystemStatus(terminalId?: string): Promise<SystemStatus> {
    const raw = await this.call('system.status', {}, terminalId) as {
      bridge_version?: string; role?: string; terminal_id?: string
      uptime_ms?: number; dll_status?: number; trade_allowed?: boolean
    }
    return {
      bridgeVersion: raw.bridge_version ?? '',
      role: raw.role ?? '',
      terminalId: raw.terminal_id ?? '',
      uptimeMs: raw.uptime_ms ?? 0,
      dllStatus: raw.dll_status ?? 0,
      tradeAllowed: raw.trade_allowed ?? false,
    }
  }

  /** 能力协商：终端侧支持的方法与事件清单（版本升级探测用）。 */
  async getCapabilities(terminalId?: string): Promise<Capabilities> {
    const raw = await this.call('system.capabilities', {}, terminalId) as {
      version?: string; service_methods?: string[]; market_methods?: string[]; events?: string[]
    }
    return {
      version: raw.version ?? '',
      serviceMethods: raw.service_methods ?? [],
      marketMethods: raw.market_methods ?? [],
      events: raw.events ?? [],
    }
  }

  async stop(): Promise<void> {
    this.setStatus('stopped')
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Mt5Error(-32003, 'REQUEST_TIMEOUT: bridge stopped'))
    }
    this.pending.clear()
    for (const [, timer] of this.resyncTimers) clearTimeout(timer)
    this.resyncTimers.clear()
    this.face.stop()
  }

  // ── BridgeCore（Account/Market/Trading 的通路）──────────────────

  async call(method: string, params: Record<string, unknown>, terminalId?: string, timeoutMs?: number): Promise<unknown> {
    const session = this.route(terminalId)
    const id = `s${++this.nextRequestId}`
    const ttl = timeoutMs ?? this.options.requestTtlMs ?? 30_000
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Mt5Error(-32003, `REQUEST_TIMEOUT: ${method} timed out`))
      }, ttl)
      this.pending.set(id, { resolve, reject, timer })
      session.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  async addSubscription(terminalId: string, symbol: string, period: string): Promise<void> {
    const key = `${symbol}|${period}`
    let perTerminal = this.subscriptions.get(terminalId)
    if (perTerminal === undefined) {
      perTerminal = new Map()
      this.subscriptions.set(terminalId, perTerminal)
    }
    const existing = perTerminal.get(key)
    if (existing !== undefined) {
      existing.refs++
      return
    }
    perTerminal.set(key, { symbol, period, refs: 1 })
    try {
      await this.call('market.subscribe', { symbol, period }, terminalId)
    } catch (error) {
      perTerminal.delete(key)
      throw error
    }
    // 种子报价：订阅成功立即给一帧现价，界面不用等下一跳。
    const account = this.accounts.get(terminalId)
    if (account !== undefined) {
      try {
        const raw = await this.call('market.quote', { symbol }, terminalId) as RawTick
        const tick = parseTick(raw, symbol)
        if (tick !== null) account.market.emitTick(tick)
      } catch { /* 种子失败不影响订阅 */ }
    }
  }

  async removeSubscription(terminalId: string, symbol: string, period: string): Promise<void> {
    const perTerminal = this.subscriptions.get(terminalId)
    if (perTerminal === undefined) return
    const key = `${symbol}|${period}`
    const entry = perTerminal.get(key)
    if (entry === undefined) return
    entry.refs--
    if (entry.refs > 0) return
    perTerminal.delete(key)
    await this.call('market.unsubscribe', { symbol, period }, terminalId).catch(() => {})
  }

  // ── 内部：会话装配 ────────────────────────────────────────────

  private route(terminalId?: string): TerminalSession {
    if (terminalId !== undefined) {
      const session = this.face.get(terminalId)
      if (session === undefined) throw new Mt5Error(-32010, `TERMINAL_NOT_FOUND: ${terminalId} is not connected`)
      return session
    }
    const main = this.main
    if (main !== undefined) {
      const session = this.face.get(main.id)
      if (session !== undefined) return session
    }
    const any = this.face.all()[0]
    if (any === undefined) throw new Mt5Error(-32001, 'SERVICE_NOT_READY: no terminal connected')
    return any
  }

  /** 探活（hello 快照可能残留已死终端）→ 建账户 → 首次拉取账户信息。 */
  private async adopt(session: TerminalSession): Promise<void> {
    const id = session.terminalId
    if (id === null) return
    try {
      const probe = await this.call('terminal.get', {}, id, this.options.probeTimeoutMs ?? 3_000) as { data_path?: string }
      const kind: AccountKind = String(probe.data_path ?? '').includes('\\Tester\\') ? 'tester' : 'real'
      const account = new Account(this, id, kind)
      await account.getInfo()
      this.accounts.set(id, account)
      this.lastSeq.delete(id)
      this.emitAccounts()
      this.setStatus('ready')
      this.log('bridge.account-ready', { id, kind, login: account.info?.login })
    } catch (error) {
      this.log('bridge.probe-failed', { id, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  private retire(session: TerminalSession, reason: string): void {
    const id = session.terminalId
    if (id === null) return
    const had = this.accounts.delete(id)
    this.subscriptions.delete(id)
    this.lastSeq.delete(id)
    const timer = this.resyncTimers.get(id)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.resyncTimers.delete(id)
    }
    if (had) {
      this.emitAccounts()
      if (this.statusValue === 'ready' && this.accounts.size === 0) this.setStatus('lost')
    }
    this.log('bridge.account-gone', { id, reason })
  }

  private onResponse(msg: { id?: string | number; result?: unknown; error?: { code: number; message: string } }): void {
    const id = typeof msg.id === 'string' ? msg.id : msg.id !== undefined ? String(msg.id) : undefined
    if (id === undefined) return
    const entry = this.pending.get(id)
    if (entry === undefined) return // 迟到回包丢弃
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (msg.error !== undefined) entry.reject(new Mt5Error(msg.error.code, msg.error.message))
    else entry.resolve(msg.result)
  }

  private onTerminalEvent(session: TerminalSession, msg: { method: string; seq?: number; params: Record<string, unknown> }): void {
    const id = session.terminalId
    if (id === null) return
    for (const cb of this.rawEventListeners) cb({ terminalId: id, method: msg.method, seq: msg.seq, params: msg.params })
    // seq 断档（回退/跳号）= 事件丢失，去抖后请终端重推快照
    if (typeof msg.seq === 'number') {
      const last = this.lastSeq.get(id)
      if (last !== undefined && (msg.seq < last || msg.seq > last + 1)) this.scheduleResync(id)
      this.lastSeq.set(id, msg.seq)
    }
    const account = this.accounts.get(id)
    if (account === undefined) return
    switch (msg.method) {
      case 'event.market.tick': {
        const tick = parseTick(msg.params as RawTick, '')
        if (tick !== null && tick.symbol !== '') account.market.emitTick(tick)
        return
      }
      case 'event.market.bar':
      case 'event.market.bar_closed': {
        const bar = parseBar(msg.params as unknown as RawBar, msg.method === 'event.market.bar_closed', '')
        if (bar !== null) account.market.emitBar(bar)
        return
      }
      case 'event.market.book': {
        const entries = parseBook(msg.params as { symbol?: string; entries?: RawBookEntry[] }, '')
        if (entries.length > 0 && entries[0]!.symbol !== '') account.market.emitBook(entries)
        return
      }
      case 'event.account.changed':
        account.mergeAccountEvent(msg.params as { account?: RawAccount })
        return
      case 'event.position.changed': {
        const event = Trading.parsePositionsEvent(msg.params as { kind?: string; entries?: RawPosition[]; positions?: RawPosition[] })
        if (event !== null) account.trading.emitEvent(event)
        return
      }
      case 'event.order.changed': {
        const event = Trading.parseOrdersEvent(msg.params as { kind?: string; entries?: RawOrder[]; orders?: RawOrder[] })
        if (event !== null) account.trading.emitEvent(event)
        return
      }
      case 'event.deal.added': {
        const event = Trading.parseDealsEvent(msg.params as { deals?: RawDeal[] })
        if (event !== null) account.trading.emitEvent(event)
        return
      }
      case 'event.resync_required':
        void account.refresh()
        return
      default:
        return
    }
  }

  private scheduleResync(terminalId: string): void {
    if (this.resyncTimers.has(terminalId)) return
    const timer = setTimeout(() => {
      this.resyncTimers.delete(terminalId)
      this.log('bridge.seq-gap-resync', { terminalId })
      void this.call('system.resync', {}, terminalId).catch(() => {})
    }, this.options.resyncDebounceMs ?? 2_000)
    timer.unref()
    this.resyncTimers.set(terminalId, timer)
  }

  private emitAccounts(): void {
    const snapshot = this.getAccounts()
    for (const cb of this.accountListeners) cb(snapshot)
  }

  private setStatus(status: BridgeStatus): void {
    if (this.statusValue === 'stopped') return
    this.statusValue = status
    for (const cb of this.statusListeners) cb(status)
  }

  private log(event: string, fields?: Record<string, unknown>): void {
    this.options.log?.(event, fields)
  }
}
