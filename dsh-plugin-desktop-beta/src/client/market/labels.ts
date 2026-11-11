/** Localized names shared by the market page panels and the chart datafeed. */
import { ASSET_CLASSES, type MarketSymbol } from './data/market-data.ts'
import type { Mt5RejectReason } from '../../mt5/contract.ts'
import type { OrderType, Side, TradeBlock, TradeResult } from './data/trading.ts'
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

/** `Euro / U.S. Dollar` style description of a symbol. */
export function describeSymbol(t: MarketT, symbol: Pick<MarketSymbol, 'baseCurrency' | 'currency'>): string {
  return `${currencyName(t, symbol.baseCurrency)} / ${currencyName(t, symbol.currency)}`
}

export function datafeedLabels(t: MarketT): DatafeedLabels {
  return {
    describe: symbol => describeSymbol(t, symbol),
    allTypes: t('search.all'),
    types: Object.fromEntries(ASSET_CLASSES.map(assetClass => [assetClass, t(`group.${assetClass}`)])) as DatafeedLabels['types'],
  }
}

export const sideLabel = (t: MarketT, side: Side): string => t(side === 'buy' ? 'side.buy' : 'side.sell')

/** `Buy Limit`, `Sell Stop`, or just the side for a market order. */
export function orderKind(t: MarketT, side: Side, type: OrderType): string {
  if (type === 'market') return sideLabel(t, side)
  const key = `kind.${side}${type === 'limit' ? 'Limit' : 'Stop'}`
  return known(key) ? t(key) : `${sideLabel(t, side)} ${t(`type.${type}`)}`
}

/** Why trades are refused, as a sentence fragment. */
export const blockText = (t: MarketT, reason: TradeBlock): string => t(`block.${reason}`)

/** Why the MT5 bridge turned a connection away. */
export const rejectText = (t: MarketT, reason: Mt5RejectReason): string => t(`reject.${reason}`)

/** The notice a trade request's outcome shows. */
export function resultNotice(t: MarketT, result: TradeResult): { text: string; tone: Notice['tone'] } {
  switch (result.status) {
    case 'done': return { text: t('result.done', { ticket: result.orderTicket ?? '' }), tone: 'success' }
    case 'placed': return { text: t('result.placed', { ticket: result.orderTicket ?? '' }), tone: 'success' }
    case 'rejected': return { text: t('result.rejected', { message: result.message || String(result.retcode ?? '') }), tone: 'error' }
    case 'offline': return { text: t('result.offline'), tone: 'warning' }
    case 'blocked': return { text: t('result.blocked', { reason: blockText(t, result.blocked ?? 'unsupported') }), tone: 'warning' }
  }
}

/** `17:00` from the `1700` of a session string. */
const clock = (hhmm: string): string => `${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}`

/** Weekly hours and, when there is one, the daily break of a symbol's session (New York time). */
export function sessionLines(t: MarketT, symbol: Pick<MarketSymbol, 'session'>): string[] {
  const match = /^(\d{4})-(\d{4})/.exec(symbol.session)
  if (match === null) return [symbol.session]
  const open = clock(match[1]!)
  const close = clock(match[2]!)
  const hours = t('details.sessionValue', { open, close })
  return open === close ? [hours] : [hours, t('details.sessionBreak', { open, close })]
}
