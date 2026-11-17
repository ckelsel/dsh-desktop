// SDK 的公共数据形状。服务用类、数据用纯对象：所有结构都可直接 JSON 序列化，
// 能跨进程（IPC）与跨网络（web 前后端）传递。字段与 contracts/registry.yaml 一一对应。

/** MT5 周期名（与桥的 period 参数同名直传）。 */
export type Period =
  | 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M10' | 'M12' | 'M15' | 'M20' | 'M30'
  | 'H1' | 'H2' | 'H3' | 'H4' | 'H6' | 'H8' | 'H12'
  | 'D1' | 'W1' | 'MN1'

/** 终端/账户类别：真实终端，或策略测试器回放 agent（周末假想市场）。 */
export type AccountKind = 'real' | 'tester'

export interface AccountInfo {
  /** 登录号 */
  login: string
  /** 平台（交易服务器）名——数据世界归属的单位 */
  server: string
  /** 账户类型；桥侧 account.get 暂不区分（待补 ACCOUNT_TRADE_MODE），无数据时缺省 */
  mode?: 'demo' | 'contest' | 'real'
  currency: string
  leverage: number
  balance: number
  equity: number
  margin: number
  marginFree: number
  marginLevel: number
  profit: number
  /** 对冲账户可同时持多空；净持仓账户同品种自动抵消 */
  hedging: boolean
  tradeAllowed: boolean
}

export interface Tick {
  symbol: string
  bid: number
  ask: number
  last: number
  /** 毫秒时间戳 */
  time: number
  volume: number
  volumeReal: number
}

export interface Bar {
  symbol: string
  period: Period
  /** 毫秒时间戳 */
  time: number
  open: number
  high: number
  low: number
  close: number
  /** tick 数（MT5 的 tick_volume） */
  volume: number
  /** bar_closed 事件为 true；当前未收K线为 false */
  closed: boolean
}

export interface SymbolInfo {
  symbol: string
  description: string
  digits: number
  point: number
  tickSize: number
  spread: number
  contractSize: number
  currencyBase: string
  currencyProfit: string
  currencyMargin: string
  volumeMin: number
  volumeMax: number
  volumeStep: number
  volumeLimit: number
  stopsLevel: number
  freezeLevel: number
  /** 允许的订单动作：market/limit/stop/stop_limit/sl/tp/close_by */
  orderModes: string[]
  /** 当前报价下 1 手所需保证金；无报价时为 null */
  marginBuy: number | null
  marginSell: number | null
}

export interface Position {
  ticket: string
  symbol: string
  side: 'buy' | 'sell'
  volume: number
  open: number
  current: number
  sl: number
  tp: number
  profit: number
  swap: number
  /** 毫秒时间戳 */
  time: number
  comment: string
}

export interface PendingOrder {
  ticket: string
  symbol: string
  action: string
  state: string
  volume: number
  price: number
  sl: number
  tp: number
  /** 毫秒时间戳 */
  time: number
  comment: string
}

export interface Deal {
  ticket: string
  order: string
  symbol: string
  side: 'buy' | 'sell'
  direction: 'in' | 'out'
  volume: number
  price: number
  profit: number
  commission: number
  swap: number
  /** 毫秒时间戳 */
  time: number
  comment: string
}

/** 下单/撤单/平仓/改单的受理回执。终态不在这里——经 onTradeEvent 的持仓/成交事件到达。 */
export interface TradeReceipt {
  requestId: string
  retcode: number
  status: 'accepted' | 'rejected'
}

export type OrderAction =
  | 'buy' | 'sell'
  | 'buy_limit' | 'sell_limit' | 'buy_stop' | 'sell_stop'

/** 交易域推送（持仓/挂单/成交/账户任何变化）。 */
export type TradeEvent =
  | { type: 'account'; account: AccountInfo }
  | { type: 'positions'; kind: 'added' | 'removed' | 'modified'; positions: Position[] }
  | { type: 'orders'; kind: 'added' | 'removed' | 'modified'; orders: PendingOrder[] }
  | { type: 'deals'; deals: Deal[] }

/** SDK 生命周期状态：listening=门已开等 MT5；ready=至少一个账户在线；
 *  lost=曾有账户、现已全部离线；stopped=已停止。 */
export type BridgeStatus = 'listening' | 'ready' | 'lost' | 'stopped'

/** 盘口档位方向（MQL5 ENUM_BOOK_TYPE 数字 → 语义名）。 */
export type BookLevel = 'sell' | 'buy' | 'sell_market' | 'buy_market'

/** 盘口深度的一档。 */
export interface BookEntry {
  symbol: string
  level: BookLevel
  price: number
  volume: number
  volumeReal: number
}

export type Weekday = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat'

/** 交易时段表；from/to 为当天内的秒偏移。quote 会话桥侧暂未实现。 */
export interface SymbolSessions {
  trade: Partial<Record<Weekday, { from: number; to: number }[]>>
}

/** 终端侧权威订阅表条目。 */
export interface SubscriptionInfo {
  subscriptionId: string
  symbol: string
  period: Period
  refs: number
  chart: string
}

/** 下单前检查（trade.preview）：能不能成、要押多少保证金，不动真格。 */
export interface TradePreview {
  ok: boolean
  retcode: number
  comment: string
  margin: number
  marginFree: number
  balance: number
  equity: number
}

/** 下单终态查询（trade.status）。state：journal 侧 pending|filled|rejected|unknown，
 * 按 order 直查时为 MT5 的 ORDER_STATE_* 名。 */
export interface TradeStatus {
  found: boolean
  requestId?: string
  order?: string
  deal?: string
  state?: string
  timeDoneMs?: number
}

/** 一次往返的全量状态（state.snapshot）：账户 + 持仓 + 挂单。 */
export interface StateSnapshot {
  account: AccountInfo
  positions: Position[]
  orders: PendingOrder[]
}

/** 桥侧运行状态（system.status）。 */
export interface SystemStatus {
  bridgeVersion: string
  role: string
  terminalId: string
  uptimeMs: number
  /** DLL 状态码（0 = 正常） */
  dllStatus: number
  tradeAllowed: boolean
}

/** 能力协商（system.capabilities）：终端侧支持的方法与事件清单。 */
export interface Capabilities {
  version: string
  serviceMethods: string[]
  marketMethods: string[]
  events: string[]
}

export type Unsubscribe = () => void
