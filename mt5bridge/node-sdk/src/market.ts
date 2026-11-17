// 行情：订阅推送（内部引用计数，同品种多处订阅只对桥开一份）+ 按需查询。
import type { BridgeCore } from './core.js'
import type { Bar, BookEntry, BookLevel, Period, SymbolInfo, SymbolSessions, SubscriptionInfo, Tick, Unsubscribe, Weekday } from './types.js'

export interface RawTick {
  symbol?: string
  bid?: number
  ask?: number
  last?: number
  time_msc?: number
  volume?: number
  volume_real?: number
}

export interface RawBar {
  symbol?: string
  period?: string
  time_msc?: number
  open?: number
  high?: number
  low?: number
  close?: number
  tick_volume?: number
}

export function parseTick(raw: RawTick, fallbackSymbol: string): Tick | null {
  const symbol = raw.symbol ?? fallbackSymbol
  if (symbol === '') return null
  return {
    symbol,
    bid: raw.bid ?? 0,
    ask: raw.ask ?? 0,
    last: raw.last ?? 0,
    time: raw.time_msc ?? 0,
    volume: raw.volume ?? 0,
    volumeReal: raw.volume_real ?? 0,
  }
}

/** symbol/period 缺省时用 fallback（bars 应答元素不带，事件行自带）。 */
export function parseBar(raw: RawBar, closed: boolean, fallbackSymbol: string, fallbackPeriod: Bar['period'] = 'M1'): Bar | null {
  const symbol = raw.symbol ?? fallbackSymbol
  if (symbol === '') return null
  return {
    symbol,
    period: (raw.period ?? fallbackPeriod) as Bar['period'],
    time: raw.time_msc ?? 0,
    open: raw.open ?? 0,
    high: raw.high ?? 0,
    low: raw.low ?? 0,
    close: raw.close ?? 0,
    volume: raw.tick_volume ?? 0,
    closed,
  }
}

export interface RawBookEntry {
  type?: number
  price?: number
  volume?: number
  volume_real?: number
}

const BOOK_LEVELS: readonly BookLevel[] = ['sell', 'buy', 'sell_market', 'buy_market']

/** 盘口应答/事件 → SDK 形状（type 为 MQL5 ENUM_BOOK_TYPE 数字）。 */
export function parseBook(raw: { symbol?: string; entries?: RawBookEntry[] }, fallbackSymbol: string): BookEntry[] {
  const symbol = raw.symbol ?? fallbackSymbol
  return (raw.entries ?? []).map(entry => ({
    symbol,
    level: BOOK_LEVELS[entry.type ?? 0] ?? 'buy',
    price: entry.price ?? 0,
    volume: entry.volume ?? 0,
    volumeReal: entry.volume_real ?? 0,
  }))
}

export interface BarsQuery {
  symbol: string
  period?: Period
  /** 最近 N 根 */
  count?: number
  /** 时间区间（与 toMs 同用） */
  fromMs?: number
  toMs?: number
}

export interface TicksQuery {
  symbol: string
  fromMs: number
  toMs: number
}

export interface RawSymbol {
  symbol?: string
  description?: string
  digits?: number
  point?: number
  tick_size?: number
  spread?: number
  contract_size?: number
  currency_base?: string
  currency_profit?: string
  currency_margin?: string
  volume_min?: number
  volume_max?: number
  volume_step?: number
  volume_limit?: number
  stops_level?: number
  freeze_level?: number
  order_modes?: string[]
  margin_buy?: number | null
  margin_sell?: number | null
}

export class Market {
  private readonly tickListeners = new Set<(tick: Tick) => void>()
  private readonly barListeners = new Set<(bar: Bar) => void>()
  private readonly bookListeners = new Set<(entries: BookEntry[]) => void>()

  constructor(
    private readonly core: BridgeCore,
    private readonly terminalId: string,
  ) {}

  /** 订阅行情推送（tick 与当前K线）。period 只影响 bar 推送，tick 与周期无关。 */
  async subscribe(symbol: string, period: Period = 'M1'): Promise<void> {
    await this.core.addSubscription(this.terminalId, symbol, period)
  }

  async unsubscribe(symbol: string, period: Period = 'M1'): Promise<void> {
    await this.core.removeSubscription(this.terminalId, symbol, period)
  }

  onTick(cb: (tick: Tick) => void): Unsubscribe {
    this.tickListeners.add(cb)
    return () => { this.tickListeners.delete(cb) }
  }

  onBar(cb: (bar: Bar) => void): Unsubscribe {
    this.barListeners.add(cb)
    return () => { this.barListeners.delete(cb) }
  }

  /** 盘口推送（OnBookEvent，订阅品种生效）。 */
  onBook(cb: (entries: BookEntry[]) => void): Unsubscribe {
    this.bookListeners.add(cb)
    return () => { this.bookListeners.delete(cb) }
  }

  /** 当前报价快照。 */
  async getQuote(symbol: string): Promise<Tick> {
    const raw = await this.core.call('market.quote', { symbol }, this.terminalId) as RawTick
    const tick = parseTick(raw, symbol)
    if (tick === null) throw new Error('market.quote: no symbol in reply')
    return tick
  }

  /** 历史K线，旧在前。count 单独=最近 N 根；fromMs+toMs=区间；toMs+count=to 之前 N 根。 */
  async getBars(query: BarsQuery): Promise<Bar[]> {
    const params: Record<string, unknown> = { symbol: query.symbol, period: query.period ?? 'M1' }
    if (query.count !== undefined) params.count = query.count
    if (query.fromMs !== undefined) params.from_ms = query.fromMs
    if (query.toMs !== undefined) params.to_ms = query.toMs
    const raw = await this.core.call('market.bars', params, this.terminalId) as { bars?: RawBar[] }
    return (raw.bars ?? [])
      .map(bar => parseBar(bar, true, query.symbol, query.period ?? 'M1'))
      .filter((bar): bar is Bar => bar !== null)
      .sort((a, b) => a.time - b.time)
  }

  /** 历史 tick 批量（服务端单次窗口 ≤ 2h，大区间分段拉）。 */
  async getTicks(query: TicksQuery): Promise<Tick[]> {
    const raw = await this.core.call('market.ticks', {
      symbol: query.symbol, from_ms: query.fromMs, to_ms: query.toMs,
    }, this.terminalId) as { ticks?: RawTick[] }
    return (raw.ticks ?? [])
      .map(tick => parseTick(tick, query.symbol))
      .filter((tick): tick is Tick => tick !== null)
  }

  /** 盘口深度快照（仅已订阅品种可用，终端侧 ~1s 轮询，略滞后于事件推送）。 */
  async getOrderBook(symbol: string): Promise<BookEntry[]> {
    const raw = await this.core.call('market.book', { symbol }, this.terminalId) as { symbol?: string; entries?: RawBookEntry[] }
    return parseBook(raw, symbol)
  }

  /** 交易时段表（周几 → 当天内秒偏移段；未返回的周几无时段）。 */
  async getSessions(symbol: string): Promise<SymbolSessions> {
    const raw = await this.core.call('symbol.sessions', { symbol }, this.terminalId) as {
      trade?: Record<string, Array<{ from?: number; to?: number }>>
    }
    const trade: SymbolSessions['trade'] = {}
    for (const [day, list] of Object.entries(raw.trade ?? {})) {
      trade[day as Weekday] = (list ?? []).map(s => ({ from: s.from ?? 0, to: s.to ?? 0 }))
    }
    return { trade }
  }

  /** 终端侧权威订阅表（对账/诊断；SDK 本地计数之外的真相）。 */
  async getSubscriptions(): Promise<SubscriptionInfo[]> {
    const raw = await this.core.call('market.subscriptions', {}, this.terminalId) as {
      subscriptions?: Array<{ subscription_id?: string; symbol?: string; period?: string; refs?: number; chart?: string | number }>
    }
    return (raw.subscriptions ?? []).map(s => ({
      subscriptionId: s.subscription_id ?? '',
      symbol: s.symbol ?? '',
      period: (s.period ?? 'M1') as Period,
      refs: s.refs ?? 0,
      chart: String(s.chart ?? ''),
    }))
  }

  /** 可交易品种列表（全市场）。 */
  async getSymbols(): Promise<string[]> {
    const raw = await this.core.call('symbol.list', {}, this.terminalId) as { symbols?: string[] }
    return raw.symbols ?? []
  }

  /** 品种交易规则（点差/手数/允许的订单类型/保证金等）。 */
  async getSymbolInfo(symbol: string): Promise<SymbolInfo> {
    const raw = await this.core.call('symbol.get', { symbol }, this.terminalId) as RawSymbol
    return {
      symbol: raw.symbol ?? symbol,
      description: raw.description ?? '',
      digits: raw.digits ?? 0,
      point: raw.point ?? 0,
      tickSize: raw.tick_size ?? 0,
      spread: raw.spread ?? 0,
      contractSize: raw.contract_size ?? 0,
      currencyBase: raw.currency_base ?? '',
      currencyProfit: raw.currency_profit ?? '',
      currencyMargin: raw.currency_margin ?? '',
      volumeMin: raw.volume_min ?? 0,
      volumeMax: raw.volume_max ?? 0,
      volumeStep: raw.volume_step ?? 0,
      volumeLimit: raw.volume_limit ?? 0,
      stopsLevel: raw.stops_level ?? 0,
      freezeLevel: raw.freeze_level ?? 0,
      orderModes: raw.order_modes ?? [],
      marginBuy: raw.margin_buy ?? null,
      marginSell: raw.margin_sell ?? null,
    }
  }

  /** @internal bridge 装配：tick/bar 事件与订阅种子报价。 */
  emitTick(tick: Tick): void {
    for (const cb of this.tickListeners) cb(tick)
  }

  emitBar(bar: Bar): void {
    for (const cb of this.barListeners) cb(bar)
  }

  /** @internal bridge 装配：盘口事件。 */
  emitBook(entries: BookEntry[]): void {
    for (const cb of this.bookListeners) cb(entries)
  }
}
