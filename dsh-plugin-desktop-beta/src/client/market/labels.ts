/** Localized names shared by the market page panels and the chart datafeed. */
import { ASSET_CLASSES, type MarketSymbol } from './data/market-data.ts'
import type { Mt5RejectReason } from '../../mt5/contract.ts'
import type { Deal, DealEntry, HistoryOrderType, PendingType, Side, TradeBlock, TradeResult } from './data/trading.ts'
import type { DatafeedLabels } from './tradingview/datafeed.ts'
import { zh } from './locales.ts'
import type { MarketT, Notice } from './page-types.ts'

type MarketKey = keyof typeof zh
const known = (key: string): key is MarketKey => Object.hasOwn(zh, key)

/** Name of a currency or metal code, or the code itself when unnamed. */
export function currencyName(t: MarketT, code: string): string {
  const key = `currency.${code}`
  return known(key) ? t(key) : code
}

/**
 * A symbol's description: `Euro / U.S. Dollar` style names for currency pairs and metals whose
 * codes have names, the source's own description for everything else.
 */
export function describeSymbol(t: MarketT, symbol: Pick<MarketSymbol, 'assetClass' | 'baseCurrency' | 'currency' | 'description'>): string {
  const named = (symbol.assetClass === 'forex' || symbol.assetClass === 'metal') && symbol.baseCurrency !== symbol.currency
    && known(`currency.${symbol.baseCurrency}`) && known(`currency.${symbol.currency}`)
  return named ? `${currencyName(t, symbol.baseCurrency)} / ${currencyName(t, symbol.currency)}` : symbol.description
}

/** A watchlist group's name: an asset class by its label, a broker folder as it is. */
export function groupLabel(t: MarketT, group: string): string {
  const key = `group.${group}`
  return known(key) ? t(key) : group
}

export function datafeedLabels(t: MarketT): DatafeedLabels {
  return {
    describe: symbol => describeSymbol(t, symbol),
    allTypes: t('search.all'),
    types: Object.fromEntries(ASSET_CLASSES.map(assetClass => [assetClass, t(`group.${assetClass}`)])) as DatafeedLabels['types'],
  }
}

export const sideLabel = (t: MarketT, side: Side): string => t(side === 'buy' ? 'side.buy' : 'side.sell')

const KINDS = { limit: 'Limit', stop: 'Stop', stopLimit: 'StopLimit' } as const

/** `Buy Limit`, `Sell Stop Limit`, `Close By`, or just the side for a market order. */
export function orderKind(t: MarketT, side: Side | null, type: HistoryOrderType): string {
  if (type === 'closeBy' || side === null) return t('kind.closeBy')
  return type === 'market' ? sideLabel(t, side) : t(`kind.${side}${KINDS[type]}`)
}

/** How a deal changed its position. */
export const entryLabel = (t: MarketT, entry: DealEntry): string => t(`entry.${entry}`)

/** A balance operation: a deposit or withdrawal by its sign, the others by their MT5 type. */
export function operationLabel(t: MarketT, deal: Pick<Deal, 'operation' | 'profit'>): string {
  if (deal.operation === 'balance') return t(deal.profit < 0 ? 'operation.withdrawal' : 'operation.deposit')
  const key = `operation.${deal.operation ?? ''}`
  return known(key) ? t(key) : deal.operation ?? ''
}

/** What made a deal, such as the desktop terminal, a phone or a stop loss. */
export function reasonLabel(t: MarketT, reason: string): string {
  const key = `reason.${reason}`
  return known(key) ? t(key) : reason
}

/** Why a pending price is refused: a limit order waits beyond the market, a stop order before it. */
export function pendingSideText(t: MarketT, side: Side, type: PendingType): string {
  if (type === 'limit') return t(side === 'buy' ? 'ticket.errorBuyLimit' : 'ticket.errorSellLimit')
  return t(side === 'buy' ? 'ticket.errorBuyStop' : 'ticket.errorSellStop')
}

/** Why trades are refused, as a sentence fragment. */
export const blockText = (t: MarketT, reason: TradeBlock): string => t(`block.${reason}`)

/** Why the MT5 bridge turned a connection away. */
export const rejectText = (t: MarketT, reason: Mt5RejectReason): string => t(`reject.${reason}`)

/**
 * Why a request was refused: the EA's or the Desktop's reason when it has a name here, else MT5's
 * return code by name, else MT5's own comment, with the return code to look up.
 */
export function refusalText(t: MarketT, result: Pick<TradeResult, 'code' | 'retcode' | 'message'>): string {
  const code = `code.${result.code ?? ''}`
  if (known(code)) return t(code)
  const retcode = `retcode.${String(result.retcode ?? '')}`
  const reason = known(retcode) ? t(retcode) : result.message
  if (result.retcode === null) return reason || (result.code ?? '')
  return reason === '' ? String(result.retcode) : t('result.reasonCode', { reason, retcode: String(result.retcode) })
}

/** What a request did: `order` places one, `close` closes a position, `modify` changes stops or an order's price, `cancel` deletes an order. */
export type TradeAction = 'order' | 'close' | 'modify' | 'cancel'

/** TRADE_RETCODE_DONE_PARTIAL: a market order filled only part of its lots. */
const PARTIAL = 10010

/**
 * The notice a trade request's outcome shows.
 * @param format - formats the price and lots of a fill; without it they show as MT5 sent them.
 */
export function resultNotice(t: MarketT, result: TradeResult, action: TradeAction = 'order',
  format?: { price(value: number): string; lots(value: number): string }): { text: string; tone: Notice['tone'] } {
  const ticket = result.orderTicket ?? ''
  switch (result.status) {
    case 'done': {
      if (action === 'close') return { text: t('result.closed'), tone: 'success' }
      if (action === 'modify') return { text: t('result.modified'), tone: 'success' }
      if (action === 'cancel') return { text: t('result.cancelled'), tone: 'success' }
      if (result.price === null || result.volume === null) return { text: t('result.done', { ticket }), tone: 'success' }
      const fill = { ticket, price: format?.price(result.price) ?? String(result.price), lots: format?.lots(result.volume) ?? String(result.volume) }
      return result.retcode === PARTIAL ? { text: t('result.partial', fill), tone: 'warning' } : { text: t('result.filled', fill), tone: 'success' }
    }
    case 'placed': return { text: t('result.placed', { ticket }), tone: 'success' }
    case 'rejected': return { text: t('result.rejected', { message: refusalText(t, result) }), tone: 'error' }
    case 'unconfirmed': return { text: t('result.unconfirmed'), tone: 'warning' }
    case 'offline': return { text: t('result.offline'), tone: 'warning' }
    case 'blocked': return { text: t('result.blocked', { reason: blockText(t, result.blocked ?? 'syncing') }), tone: 'warning' }
  }
}

/** `17:00` from the `1700` of a session string. */
const clock = (hhmm: string): string => `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`

/**
 * Weekly hours and, when there is one, the daily break of a symbol's session (New York time); none
 * for a symbol whose hours the source does not report.
 */
export function sessionLines(t: MarketT, symbol: Pick<MarketSymbol, 'session'>): string[] {
  if (symbol.session === '24x7') return []
  const match = /^(\d{4})-(\d{4})/.exec(symbol.session)
  if (match === null) return [symbol.session]
  const open = clock(match[1]!)
  const close = clock(match[2]!)
  const hours = t('details.sessionValue', { open, close })
  return open === close ? [hours] : [hours, t('details.sessionBreak', { open, close })]
}
