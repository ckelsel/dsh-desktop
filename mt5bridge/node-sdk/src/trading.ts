// 交易：动作方法一律"受理即返回"（trade.execute 为 deferred 语义），
// 终态经 onEvent 的持仓/成交事件到达；查账方法即时返回。
import type { BridgeCore } from './core.js'
import type { Deal, OrderAction, PendingOrder, Position, TradeEvent, TradePreview, TradeReceipt, TradeStatus, Unsubscribe } from './types.js'

export interface TradeOptions {
  symbol: string
  volume: number
  sl?: number
  tp?: number
  /** 市价滑点容忍（点） */
  deviation?: number
  comment?: string
  /** 幂等键；缺省自动生成（桥侧暂无去重，键值用于对账关联） */
  idempotencyKey?: string
}

export interface PendingOrderOptions extends TradeOptions {
  action: Exclude<OrderAction, 'buy' | 'sell'>
  price: number
}

export interface HistoryQuery {
  fromMs: number
  toMs: number
}

export interface RawPosition {
  ticket?: string | number
  symbol?: string
  type?: string
  volume?: number
  price_open?: number
  price_current?: number
  sl?: number
  tp?: number
  profit?: number
  swap?: number
  time_msc?: number
  comment?: string
}

export interface RawOrder {
  ticket?: string | number
  symbol?: string
  type?: string
  state?: string
  volume_current?: number
  volume_initial?: number
  price_open?: number
  sl?: number
  tp?: number
  time_setup_msc?: number
  comment?: string
}

export interface RawDeal {
  ticket?: string | number
  order?: string | number
  symbol?: string
  /** 桥侧两种形态都出现过：事件里 type:0（数字），RPC 里 'buy'（字符串） */
  type?: string | number
  direction?: string
  volume?: number
  price?: number
  profit?: number
  commission?: number
  swap?: number
  time_msc?: number
  comment?: string
}

export const parsePosition = (raw: RawPosition): Position => ({
  ticket: String(raw.ticket ?? ''),
  symbol: raw.symbol ?? '',
  side: raw.type === 'sell' ? 'sell' : 'buy',
  volume: raw.volume ?? 0,
  open: raw.price_open ?? 0,
  current: raw.price_current ?? 0,
  sl: raw.sl ?? 0,
  tp: raw.tp ?? 0,
  profit: raw.profit ?? 0,
  swap: raw.swap ?? 0,
  time: raw.time_msc ?? 0,
  comment: raw.comment ?? '',
})

export const parseOrder = (raw: RawOrder): PendingOrder => ({
  ticket: String(raw.ticket ?? ''),
  symbol: raw.symbol ?? '',
  action: raw.type ?? '',
  state: raw.state ?? '',
  volume: raw.volume_current ?? raw.volume_initial ?? 0,
  price: raw.price_open ?? 0,
  sl: raw.sl ?? 0,
  tp: raw.tp ?? 0,
  time: raw.time_setup_msc ?? 0,
  comment: raw.comment ?? '',
})

const parseDeal = (raw: RawDeal): Deal => ({
  ticket: String(raw.ticket ?? ''),
  order: String(raw.order ?? ''),
  symbol: raw.symbol ?? '',
  side: raw.type === 1 || raw.type === 'sell' ? 'sell' : 'buy',
  direction: raw.direction === 'out' ? 'out' : 'in',
  volume: raw.volume ?? 0,
  price: raw.price ?? 0,
  profit: raw.profit ?? 0,
  commission: raw.commission ?? 0,
  swap: raw.swap ?? 0,
  time: raw.time_msc ?? 0,
  comment: raw.comment ?? '',
})

export interface PreviewOptions {
  action: OrderAction
  symbol: string
  volume: number
  /** 挂单动作必填 */
  price?: number
  sl?: number
  tp?: number
  deviation?: number
}

const defaultKey = (): string => `sdk-${Date.now()}-${Math.floor(Math.random() * 1e6)}`

export class Trading {
  private readonly listeners = new Set<(event: TradeEvent) => void>()

  constructor(
    private readonly core: BridgeCore,
    private readonly terminalId: string,
  ) {}

  async buy(options: TradeOptions): Promise<TradeReceipt> {
    return this.execute({ ...options, action: 'buy' })
  }

  async sell(options: TradeOptions): Promise<TradeReceipt> {
    return this.execute({ ...options, action: 'sell' })
  }

  /** 挂单（limit/stop 四种；price 必填）。 */
  async placeOrder(options: PendingOrderOptions): Promise<TradeReceipt> {
    return this.execute(options)
  }

  async cancelOrder(ticket: string): Promise<TradeReceipt> {
    return this.receipt(await this.core.call('order.cancel', { ticket }, this.terminalId))
  }

  /** 不传 volume = 全平。 */
  async closePosition(options: { ticket: string; volume?: number }): Promise<TradeReceipt> {
    return this.receipt(await this.core.call('position.close', options, this.terminalId))
  }

  async modifyPosition(options: { ticket: string; sl?: number; tp?: number }): Promise<TradeReceipt> {
    return this.receipt(await this.core.call('position.modify', options, this.terminalId))
  }

  /** 下单前检查：能不能过、要押多少保证金（OrderCheck，不动真格）。 */
  async preview(options: PreviewOptions): Promise<TradePreview> {
    const params: Record<string, unknown> = {
      action: options.action, symbol: options.symbol, volume: options.volume,
    }
    if (options.price !== undefined) params.price = options.price
    if (options.sl !== undefined) params.sl = options.sl
    if (options.tp !== undefined) params.tp = options.tp
    if (options.deviation !== undefined) params.deviation = options.deviation
    const raw = await this.core.call('trade.preview', params, this.terminalId) as {
      ok?: boolean; retcode?: number; comment?: string
      margin?: number; margin_free?: number; balance?: number; equity?: number
    }
    return {
      ok: raw.ok ?? false,
      retcode: raw.retcode ?? 0,
      comment: raw.comment ?? '',
      margin: raw.margin ?? 0,
      marginFree: raw.margin_free ?? 0,
      balance: raw.balance ?? 0,
      equity: raw.equity ?? 0,
    }
  }

  /** 改挂单（价格/止损/止盈）。 */
  async modifyOrder(options: { ticket: string; price?: number; sl?: number; tp?: number }): Promise<TradeReceipt> {
    return this.receipt(await this.core.call('order.modify', options, this.terminalId))
  }

  /** 下单终态对账：requestId 查内存 journal，或 order 票号直查历史。 */
  async getStatus(query: { requestId?: string; order?: string }): Promise<TradeStatus> {
    const params: Record<string, unknown> = {}
    if (query.requestId !== undefined) params.request_id = Number(query.requestId)
    if (query.order !== undefined) params.order = Number(query.order)
    const raw = await this.core.call('trade.status', params, this.terminalId) as {
      found?: boolean; request_id?: number; order?: string | number; deal?: string | number
      state?: string; time_done_msc?: number
    }
    if (raw.found !== true) return { found: false }
    const status: TradeStatus = { found: true }
    if (raw.request_id !== undefined) status.requestId = String(raw.request_id)
    if (raw.order !== undefined) status.order = String(raw.order)
    if (raw.deal !== undefined) status.deal = String(raw.deal)
    if (raw.state !== undefined) status.state = raw.state
    if (raw.time_done_msc !== undefined && raw.time_done_msc > 0) status.timeDoneMs = raw.time_done_msc
    return status
  }

  async getPositions(): Promise<Position[]> {
    const raw = await this.core.call('position.list', {}, this.terminalId) as { positions?: RawPosition[] }
    return (raw.positions ?? []).map(parsePosition)
  }

  async getOrders(): Promise<PendingOrder[]> {
    const raw = await this.core.call('order.list', {}, this.terminalId) as { orders?: RawOrder[] }
    return (raw.orders ?? []).map(parseOrder)
  }

  /** 历史成交与订单（对账权威账本）。 */
  async getHistory(query: HistoryQuery): Promise<{ deals: Deal[]; orders: PendingOrder[] }> {
    const params = { from_ms: query.fromMs, to_ms: query.toMs }
    const [deals, orders] = await Promise.all([
      this.core.call('history.deals', params, this.terminalId) as Promise<{ deals?: RawDeal[] }>,
      this.core.call('history.orders', params, this.terminalId) as Promise<{ orders?: RawOrder[] }>,
    ])
    return {
      deals: (deals.deals ?? []).map(parseDeal),
      orders: (orders.orders ?? []).map(parseOrder),
    }
  }

  /** 交易域推送：持仓/挂单/成交/账户任何变化。 */
  onEvent(cb: (event: TradeEvent) => void): Unsubscribe {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** @internal bridge 装配。 */
  emitEvent(event: TradeEvent): void {
    for (const cb of this.listeners) cb(event)
  }

  private async execute(options: TradeOptions & { action: OrderAction; price?: number }): Promise<TradeReceipt> {
    const params: Record<string, unknown> = {
      action: options.action,
      symbol: options.symbol,
      volume: options.volume,
      idempotency_key: options.idempotencyKey ?? defaultKey(),
    }
    if (options.price !== undefined) params.price = options.price
    if (options.sl !== undefined) params.sl = options.sl
    if (options.tp !== undefined) params.tp = options.tp
    if (options.deviation !== undefined) params.deviation = options.deviation
    if (options.comment !== undefined) params.comment = options.comment
    return this.receipt(await this.core.call('trade.execute', params, this.terminalId))
  }

  private receipt(raw: unknown): TradeReceipt {
    const r = raw as { status?: string; request_id?: string | number; retcode?: number }
    return {
      requestId: String(r.request_id ?? ''),
      retcode: r.retcode ?? 0,
      status: r.status === 'rejected' ? 'rejected' : 'accepted',
    }
  }

  /** @internal bridge 装配：事件 → SDK 形状。 */
  static parsePositionsEvent(params: { kind?: string; entries?: RawPosition[]; positions?: RawPosition[] }): TradeEvent | null {
    const list = params.entries ?? params.positions ?? []
    if (list.length === 0) return null
    const kind = params.kind === 'removed' ? 'removed' : params.kind === 'modified' ? 'modified' : 'added'
    return { type: 'positions', kind, positions: list.map(parsePosition) }
  }

  static parseOrdersEvent(params: { kind?: string; entries?: RawOrder[]; orders?: RawOrder[] }): TradeEvent | null {
    const list = params.entries ?? params.orders ?? []
    if (list.length === 0) return null
    const kind = params.kind === 'removed' ? 'removed' : params.kind === 'modified' ? 'modified' : 'added'
    return { type: 'orders', kind, orders: list.map(parseOrder) }
  }

  static parseDealsEvent(params: { deals?: RawDeal[] }): TradeEvent | null {
    const list = params.deals ?? []
    if (list.length === 0) return null
    return { type: 'deals', deals: list.map(parseDeal) }
  }
}
