// 账户 = 一次登录 = 一个平台的数据世界。行情与交易都挂在账户下，
// 不同账户（不同平台/回放）的数据天然隔离。
import type { BridgeCore } from './core.js'
import { Market } from './market.js'
import { Trading, parseOrder, parsePosition, type RawOrder, type RawPosition } from './trading.js'
import type { AccountInfo, AccountKind, StateSnapshot, Unsubscribe } from './types.js'

export interface RawAccount {
  login?: string | number
  server?: string
  currency?: string
  leverage?: number
  balance?: number
  equity?: number
  margin?: number
  margin_free?: number
  margin_level?: number
  profit?: number
  trade_allowed?: boolean
  hedging?: boolean
}

/** 桥侧 account.get / event.account.changed 的字段 → SDK 形状（缺省字段不覆盖旧值）。 */
export function mapAccount(raw: RawAccount | undefined, base?: AccountInfo): AccountInfo {
  const info: AccountInfo = base ?? {
    login: '', server: '', currency: '', leverage: 0,
    balance: 0, equity: 0, margin: 0, marginFree: 0, marginLevel: 0, profit: 0,
    hedging: false, tradeAllowed: false,
  }
  if (raw === undefined) return info
  if (raw.login !== undefined) info.login = String(raw.login)
  if (raw.server !== undefined) info.server = raw.server
  if (raw.currency !== undefined) info.currency = raw.currency
  if (raw.leverage !== undefined) info.leverage = raw.leverage
  if (raw.balance !== undefined) info.balance = raw.balance
  if (raw.equity !== undefined) info.equity = raw.equity
  if (raw.margin !== undefined) info.margin = raw.margin
  if (raw.margin_free !== undefined) info.marginFree = raw.margin_free
  if (raw.margin_level !== undefined) info.marginLevel = raw.margin_level
  if (raw.profit !== undefined) info.profit = raw.profit
  if (raw.trade_allowed !== undefined) info.tradeAllowed = raw.trade_allowed
  if (raw.hedging !== undefined) info.hedging = raw.hedging
  return info
}

type AccountEvent = { account: AccountInfo }

export class Account {
  /** 最后一次已知的账户信息（连接建立时拉取，事件推送时更新）。 */
  info: AccountInfo | undefined
  readonly market: Market
  readonly trading: Trading
  private readonly changeListeners = new Set<(info: AccountInfo) => void>()

  constructor(
    private readonly core: BridgeCore,
    /** 即终端 id：一台 MT5 终端同一时刻登录一个账户。 */
    readonly id: string,
    readonly kind: AccountKind,
  ) {
    this.market = new Market(core, id)
    this.trading = new Trading(core, id)
  }

  /** 主动拉取最新账户信息（同时刷新 info 缓存）。 */
  async getInfo(): Promise<AccountInfo> {
    this.info = mapAccount(await this.core.call('account.get', {}, this.id) as RawAccount)
    return this.info
  }

  /** 一次往返的全量状态（账户 + 持仓 + 挂单），启动铺屏 / 断档恢复用。 */
  async getState(): Promise<StateSnapshot> {
    const raw = await this.core.call('state.snapshot', {}, this.id) as {
      account?: RawAccount; positions?: RawPosition[]; orders?: RawOrder[]
    }
    this.info = mapAccount(raw.account, this.info)
    return {
      account: this.info,
      positions: (raw.positions ?? []).map(parsePosition),
      orders: (raw.orders ?? []).map(parseOrder),
    }
  }

  /** 余额/净值等变动推送。 */
  onChange(cb: (info: AccountInfo) => void): Unsubscribe {
    this.changeListeners.add(cb)
    return () => { this.changeListeners.delete(cb) }
  }

  /** @internal bridge 装配：事件到达时合并并通知。 */
  mergeAccountEvent(params: { account?: RawAccount }): void {
    this.info = mapAccount(params.account, this.info)
    for (const cb of this.changeListeners) cb(this.info)
    this.trading.emitEvent({ type: 'account', account: this.info })
  }

  /** @internal bridge 装配：resync_required 后刷新（全量快照优先，持仓挂单同刷）。 */
  async refresh(): Promise<void> {
    await this.getState().catch(() => this.getInfo().catch(() => {}))
  }
}

export type { AccountEvent }
