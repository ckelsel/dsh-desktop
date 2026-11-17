// mt5bridge SDK 入口。
//
//   const bridge = await Mt5Bridge.start()      // 开门等 MT5 拨入（默认 18850）
//   const account = bridge.main                 // 默认账户（真实终端优先）
//   await account.market.subscribe('EURUSD')    // 行情
//   await account.trading.buy({ symbol: 'EURUSD', volume: 0.01 })   // 交易
export { Mt5Bridge } from './bridge.js'
export type { Mt5BridgeOptions, TerminalSummary, RawTerminalEvent } from './bridge.js'
export { Account } from './account.js'
export { Market } from './market.js'
export type { BarsQuery, TicksQuery } from './market.js'
export { Trading } from './trading.js'
export type { TradeOptions, PendingOrderOptions, PreviewOptions, HistoryQuery } from './trading.js'
export { Mt5Error } from './errors.js'
export type {
  AccountInfo, AccountKind, Bar, BookEntry, BookLevel, BridgeStatus, Capabilities, Deal,
  OrderAction, PendingOrder, Period, Position, StateSnapshot, SubscriptionInfo, SymbolInfo,
  SymbolSessions, SystemStatus, Tick, TradeEvent, TradePreview, TradeReceipt, TradeStatus,
  Unsubscribe, Weekday,
} from './types.js'
