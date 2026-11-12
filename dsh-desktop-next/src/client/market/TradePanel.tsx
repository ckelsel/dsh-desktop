/**
 * Bottom trading panel, after the TradingView web account manager: the account summary, then
 * positions, pending orders, order history, deals and the account details in tabs. Row actions
 * (close all or part of a position, modify, cancel) go to the trading provider, and the positions
 * tab closes a symbol's positions or all of them through a confirming dialog; until the trading
 * risk disclaimer is agreed to, each of them opens it instead. Selecting a row shows its symbol on the chart.
 * The history and deal tabs show the chosen period, and the deals tab totals its trades below them.
 * Open, the full account summary sits below the tabs; collapsed, only the tab bar remains, with the
 * equity and floating profit when there is room. The connection badge stays in the tab bar either way.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Check, ChevronDown, ChevronUp, Pencil, X } from 'lucide-react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketDataProvider, MarketSymbol } from './data/market-data.ts'
import {
  bracketError, closeLotsValid, HISTORY_PERIODS, historyRange, localDate, pendingPriceValid, pipsBetween,
  type AccountInfo, type Brackets, type Deal, type HistorySelection, type HistoryState, type PendingOrder, type Position, type TradeResult,
  type TradingConnection, type TradingProvider, type TradingSnapshot,
} from './data/trading.ts'
import { ClosePositionsDialog } from './ClosePositionsDialog.tsx'
import { ConnectionStatus } from './ConnectionStatus.tsx'
import { formatLots, formatMoney, formatNumber, formatPips, formatPrice, formatSigned, formatTime, parseDecimal, trend } from './format.ts'
import { blockText, entryLabel, operationLabel, orderKind, pendingSideText, reasonLabel, resultNotice, sideLabel, type TradeAction } from './labels.ts'
import type { MarketActions, MarketPageProps, MarketT, Notify, UseAccount } from './page-types.ts'
import type { BottomTab } from './store.ts'

export interface TradePanelProps {
  t: MarketT
  market: MarketDataProvider
  trading: TradingProvider
  useAccount: UseAccount
  useStore: MarketPageProps['useStore']
  actions: MarketActions
  notify: Notify
  /** Show the trading risk disclaimer for the user to agree to. */
  onDisclaimer(): void
}

const TABS: readonly BottomTab[] = ['positions', 'orders', 'history', 'deals', 'account']

/** Column of a table: header label, alignment and cell renderer. */
interface Column<Row> {
  key: string
  label: string
  numeric?: boolean
  cell(row: Row): ReactNode
}

function Table<Row>({ columns, rows, rowKey, rowKind, empty, onSelect, label, footer }: {
  columns: readonly Column<Row>[]
  rows: readonly Row[]
  rowKey(row: NoInfer<Row>): string
  /** A row's `data-kind`, for rows styled apart. */
  rowKind?(row: NoInfer<Row>): string | undefined
  empty: string
  label: string
  onSelect?(row: NoInfer<Row>): void
  /** A last row spanning every column. */
  footer?: ReactNode
}) {
  if (rows.length === 0) return <div className="dshMkEmpty" data-table="">{empty}</div>
  return <table className="dshMkTable" aria-label={label}>
    <thead><tr>{columns.map(column => <th key={column.key} scope="col" data-numeric={column.numeric || undefined}>{column.label}</th>)}</tr></thead>
    <tbody>
      {rows.map(row => <tr key={rowKey(row)} data-kind={rowKind?.(row)} onClick={onSelect === undefined ? undefined : () => { onSelect(row) }}>
        {columns.map(column => <td key={column.key} data-numeric={column.numeric || undefined}>{column.cell(row)}</td>)}
      </tr>)}
    </tbody>
    {footer !== undefined && <tfoot><tr><td colSpan={columns.length}>{footer}</td></tr></tfoot>}
  </table>
}

/** Price text of a symbol, or the raw number when the symbol is unknown. */
function price(symbolOf: (ticker: string) => MarketSymbol | undefined, ticker: string, value: number | null): string {
  if (value === null) return '—'
  const symbol = symbolOf(ticker)
  return symbol === undefined ? String(value) : formatPrice(symbol, value)
}

const lotsOf = (symbolOf: (ticker: string) => MarketSymbol | undefined, ticker: string, lots: number): string => {
  const symbol = symbolOf(ticker)
  return symbol === undefined ? String(lots) : formatLots(symbol, lots)
}

function Money({ value }: { value: number }) {
  return <span data-trend={trend(value)}>{formatSigned(value, 2)}</span>
}

/** Totals of the trades among `deals`; balance operations are not trading results. */
export function dealTotals(deals: readonly Deal[]): { profit: number; commission: number; swap: number; fee: number; net: number } {
  let profit = 0
  let commission = 0
  let swap = 0
  let fee = 0
  for (const deal of deals) {
    if (deal.kind !== 'trade') continue
    profit += deal.profit
    commission += deal.commission
    swap += deal.swap
    fee += deal.fee
  }
  return { profit, commission, swap, fee, net: profit + commission + swap + fee }
}

function DealTotals({ t, deals }: { t: MarketT; deals: readonly Deal[] }) {
  const totals = dealTotals(deals)
  const item = (label: string, value: number, key: string) => <span key={key} className="dshMkSummaryItem"><span className="dshMkMuted">{label}</span><span className="dshMkNum"><Money value={value} /></span></span>
  return <div className="dshMkAccountSummary" data-compact="">
    <span>{t('summary.title')}</span>
    {item(t('summary.profit'), totals.profit, 'profit')}
    {item(t('summary.commission'), totals.commission, 'commission')}
    {item(t('summary.swap'), totals.swap, 'swap')}
    {totals.fee !== 0 && item(t('summary.fee'), totals.fee, 'fee')}
    {item(t('summary.net'), totals.net, 'net')}
  </div>
}

/** The period of the history and deal tabs, and how its reading went. */
function HistoryBar({ t, selection, state, onSelect, onRetry }: {
  t: MarketT
  selection: HistorySelection
  state: HistoryState
  onSelect(selection: HistorySelection): void
  onRetry(): void
}) {
  const choose = (period: HistorySelection['period']): void => {
    if (period !== 'custom' || (selection.from !== '' && selection.to !== '')) { onSelect({ ...selection, period }); return }
    // A first custom period starts as the current one.
    const now = Date.now()
    const range = historyRange(selection, now)
    onSelect({ period, from: localDate(range.from), to: localDate(Math.min(now, range.to - 1)) })
  }
  return <div className="dshMkHistoryBar">
    <div className="dshMkTabs" role="radiogroup" aria-label={t('history.period')}>
      {HISTORY_PERIODS.map(period => <button key={period} type="button" role="radio" className="dshMkTab" aria-checked={selection.period === period}
        onClick={() => { choose(period) }}>{t(`history.${period}`)}</button>)}
    </div>
    {selection.period === 'custom' && <span className="dshMkDateRange">
      <input type="date" className="dshMkDateInput" aria-label={t('history.from')} value={selection.from} max={selection.to || undefined}
        onChange={(event) => { onSelect({ ...selection, from: event.target.value }) }} />
      <span>–</span>
      <input type="date" className="dshMkDateInput" aria-label={t('history.to')} value={selection.to} min={selection.from || undefined}
        onChange={(event) => { onSelect({ ...selection, to: event.target.value }) }} />
    </span>}
    {state.status === 'loading' && <span className="dshMkHistoryStatus" role="status">{t('history.loading')}</span>}
    {state.status === 'error' && <span className="dshMkHistoryStatus" role="alert" data-tone="error">
      {t('history.error', { message: state.error ?? '' })}
      <button type="button" className="dshMkTextButton" onClick={onRetry}>{t('history.retry')}</button>
    </span>}
    {state.truncated && <span className="dshMkHistoryStatus" data-tone="warning">{t('history.truncated')}</span>}
  </div>
}

function Summary({ t, account, compact }: { t: MarketT; account: AccountInfo | null; compact: boolean }) {
  if (account === null) return <span className="dshMkMuted dshMkAccountSummary" data-compact={compact || undefined}>{t('account.none')}</span>
  const item = (label: string, value: ReactNode, key: string) => <span key={key} className="dshMkSummaryItem"><span className="dshMkMuted">{label}</span><span className="dshMkNum">{value}</span></span>
  const level = account.marginLevel === null ? '—' : `${formatNumber(account.marginLevel, 2)}%`
  return <div className="dshMkAccountSummary" data-compact={compact || undefined}>
    {!compact && item(t('account.balance'), formatMoney(account.balance), 'balance')}
    {item(t('account.equity'), formatMoney(account.equity), 'equity')}
    {item(t('account.profit'), <Money value={account.profit} />, 'profit')}
    {!compact && item(t('account.margin'), formatMoney(account.margin), 'margin')}
    {!compact && item(t('account.freeMargin'), formatMoney(account.freeMargin), 'free')}
    {!compact && item(t('account.marginLevel'), level, 'level')}
  </div>
}

interface Editing { ticket: string; price: string | null; takeProfit: string; stopLoss: string }
/** A position being closed, with the lots the trader typed. */
interface Closing { ticket: string; lots: string }

/** The trading panel (see module doc). */
export function TradePanel({ t, market, trading, useAccount, useStore, actions, notify, onDisclaimer }: TradePanelProps) {
  const open = useStore(state => state.bottomOpen)
  const tab = useStore(state => state.bottomTab)
  const upColor = useStore(state => state.upColor)
  const historyPeriod = useStore(state => state.historyPeriod)
  const snapshot = useAccount(state => state)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [closing, setClosing] = useState<Closing | null>(null)
  const [closeMany, setCloseMany] = useState<{ symbol: string | null; positions: readonly Position[] } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const symbolOf = (ticker: string): MarketSymbol | undefined => market.symbol(ticker)
  const { account, positions, orders, history, deals, connection, historyState } = snapshot
  const counts: Partial<Record<BottomTab, number>> = { positions: positions.length, orders: orders.length }
  useEffect(() => { trading.setHistoryPeriod(historyPeriod) }, [trading, historyPeriod])

  // Agreeing does not carry out the action that asked for it: the trader repeats it.
  const needsDisclaimer = connection.blocked[0] === 'disclaimer'
  const agreed = (): boolean => {
    if (needsDisclaimer) onDisclaimer()
    return !needsDisclaimer
  }
  const run = (key: string, action: TradeAction, ticker: string, request: () => Promise<TradeResult>): void => {
    if (busy !== null || !agreed()) return
    setBusy(key)
    request().then((result) => {
      const symbol = symbolOf(ticker)
      const notice = resultNotice(t, result, action, symbol === undefined ? undefined
        : { price: value => formatPrice(symbol, value), lots: value => formatLots(symbol, value) })
      notify(notice.text, notice.tone)
      if (result.status === 'done' || result.status === 'placed') {
        setEditing(null)
        setClosing(null)
      }
    }, (reason: unknown) => {
      notify(t('result.rejected', { message: String(reason) }), 'error')
    }).finally(() => { setBusy(null) })
  }
  const parseBracket = (text: string): number | null => text.trim() === '' ? null : parseDecimal(text)
  const brackets = (edit: Editing): Brackets => ({ takeProfit: parseBracket(edit.takeProfit), stopLoss: parseBracket(edit.stopLoss) })
  /**
   * Why an edit cannot be saved, checked when it is saved since the market moves: a price that is
   * no number, an order price on the wrong side of the market, or a stop on the wrong side of the
   * price the position closes at or the order opens at. MT5 checks the distances.
   */
  const editError = (row: Position | PendingOrder, edit: Editing): string | null => {
    const { takeProfit, stopLoss } = brackets(edit)
    if ([takeProfit, stopLoss].some(value => value !== null && !(value > 0))) return t('ticket.errorPrice')
    let reference = row.currentPrice
    if (edit.price !== null && 'type' in row) {
      reference = parseDecimal(edit.price)
      if (!(reference > 0)) return t('ticket.errorPrice')
      // An order's current price is the touch it waits on, the only one its side needs.
      if (!pendingPriceValid(row.side, row.type, reference, { bid: row.currentPrice, ask: row.currentPrice })) return pendingSideText(t, row.side, row.type)
    }
    const wrong = bracketError(row.side, reference, { takeProfit, stopLoss })
    return wrong === null ? null : t(wrong === 'takeProfit' ? 'ticket.errorTakeProfit' : 'ticket.errorStopLoss')
  }
  /** Send an edit, or show why it cannot go. */
  const save = (row: Position | PendingOrder, request: (edit: Editing) => Promise<TradeResult>): void => {
    if (editing === null) return
    const problem = editError(row, editing)
    if (problem !== null) { notify(problem, 'error'); return }
    run(row.ticket, 'modify', row.ticker, () => request(editing))
  }
  const bracketText = (ticker: string, value: number | null): string => {
    const symbol = symbolOf(ticker)
    return value === null || symbol === undefined ? '' : value.toFixed(symbol.decimals)
  }
  const editCell = (ticket: string, field: 'takeProfit' | 'stopLoss' | 'price', fallback: string, label: string) => {
    if (editing?.ticket !== ticket) return fallback
    const value = editing[field] ?? ''
    return <input
      className="dshMkCellInput"
      value={value}
      inputMode="decimal"
      aria-label={label}
      onClick={(event) => { event.stopPropagation() }}
      onChange={(event) => { setEditing({ ...editing, [field]: event.target.value }) }}
    />
  }
  const editActions = (ticket: string, save: () => void, start: () => void, extra?: ReactNode) => editing?.ticket === ticket
    ? <span className="dshMkRowActions">
      <button type="button" className="dshMkIconButton" aria-label={t('action.save')} title={t('action.save')} disabled={busy !== null}
        onClick={(event) => { event.stopPropagation(); save() }}><Check size={14} /></button>
      <button type="button" className="dshMkIconButton" aria-label={t('action.discard')} title={t('action.discard')}
        onClick={(event) => { event.stopPropagation(); setEditing(null) }}><X size={14} /></button>
    </span>
    : <span className="dshMkRowActions">
      <button type="button" className="dshMkIconButton" aria-label={t('action.modify')} title={t('action.modify')}
        onClick={(event) => { event.stopPropagation(); start() }}><Pencil size={13} /></button>
      {extra}
    </span>

  /** The row's close editor: the lots to close, all of them at first, with confirm and discard. */
  const closeEditor = (row: Position, edit: Closing) => {
    const symbol = symbolOf(row.ticker)
    const lots = parseDecimal(edit.lots)
    const whole = Math.abs(lots - row.lots) < 1e-9
    const valid = symbol === undefined ? whole : closeLotsValid(symbol, row.lots, lots)
    const rule = symbol === undefined ? undefined
      : t('close.errorLots', { min: formatLots(symbol, symbol.minLots), max: formatLots(symbol, row.lots), step: formatLots(symbol, symbol.lotStep) })
    return <span className="dshMkRowActions">
      <input className="dshMkCellInput" value={edit.lots} inputMode="decimal" autoComplete="off" spellCheck={false} aria-label={t('close.lots')}
        aria-invalid={valid ? undefined : true} title={valid ? t('close.lots') : rule}
        onClick={(event) => { event.stopPropagation() }}
        onChange={(event) => { setClosing({ ticket: row.ticket, lots: event.target.value }) }} />
      <button type="button" className="dshMkIconButton" aria-label={t('close.confirm')} title={t('close.confirm')} disabled={!valid || busy !== null}
        onClick={(event) => {
          event.stopPropagation()
          run(row.ticket, 'close', row.ticker, () => trading.closePosition(row.ticket, whole ? undefined : lots))
        }}><Check size={14} /></button>
      <button type="button" className="dshMkIconButton" aria-label={t('action.discard')} title={t('action.discard')}
        onClick={(event) => { event.stopPropagation(); setClosing(null) }}><X size={14} /></button>
    </span>
  }
  const lotsInput = (row: Position): string => {
    const symbol = symbolOf(row.ticker)
    return symbol === undefined ? String(row.lots) : formatLots(symbol, row.lots).replace(/,/g, '')
  }
  /** Close a symbol's positions, or all of them, once the trader confirms the list. */
  const closePositions = (symbol: string | null): void => {
    if (!agreed()) return
    const list = positions.filter(position => symbol === null || position.ticker === symbol)
    if (list.length > 0) setCloseMany({ symbol, positions: list })
  }
  const heldSymbols = [...new Set(positions.map(position => position.ticker))]

  // Balance operations have no symbol, and the demo account may hold one the page does not list.
  const select = (row: { ticker: string }): void => { if (market.symbol(row.ticker) !== undefined) actions.setSymbol(row.ticker) }
  const orderPrice = (row: { ticker: string; price: number | null; stopLimit: number | null }): string => {
    if (row.price === null) return t('type.market')
    const text = price(symbolOf, row.ticker, row.price)
    return row.stopLimit === null ? text : `${text} (${t('order.limitAt', { price: price(symbolOf, row.ticker, row.stopLimit) })})`
  }

  const positionColumns: Column<TradingSnapshot['positions'][number]>[] = [
    { key: 'symbol', label: t('col.symbol'), cell: row => <strong>{row.ticker}</strong> },
    { key: 'ticket', label: t('col.ticket'), cell: row => row.ticket },
    { key: 'time', label: t('col.openTime'), cell: row => formatTime(row.openTime) },
    { key: 'side', label: t('col.side'), cell: row => <span data-side={row.side}>{sideLabel(t, row.side)}</span> },
    { key: 'lots', label: t('col.lots'), numeric: true, cell: row => lotsOf(symbolOf, row.ticker, row.lots) },
    { key: 'open', label: t('col.openPrice'), numeric: true, cell: row => price(symbolOf, row.ticker, row.openPrice) },
    { key: 'sl', label: t('col.stopLoss'), numeric: true, cell: row => editCell(row.ticket, 'stopLoss', price(symbolOf, row.ticker, row.stopLoss), t('col.stopLoss')) },
    { key: 'tp', label: t('col.takeProfit'), numeric: true, cell: row => editCell(row.ticket, 'takeProfit', price(symbolOf, row.ticker, row.takeProfit), t('col.takeProfit')) },
    { key: 'current', label: t('col.currentPrice'), numeric: true, cell: row => price(symbolOf, row.ticker, row.currentPrice) },
    { key: 'swap', label: t('col.swap'), numeric: true, cell: row => formatMoney(row.swap) },
    { key: 'pips', label: t('col.pips'), numeric: true, cell: (row) => {
      const symbol = symbolOf(row.ticker)
      const pips = symbol === undefined ? 0 : pipsBetween(symbol, row.side, row.openPrice, row.currentPrice)
      return <span data-trend={trend(pips)}>{formatPips(pips)}</span>
    } },
    { key: 'profit', label: t('col.profit'), numeric: true, cell: row => <Money value={row.profit} /> },
    { key: 'actions', label: t('col.actions'), cell: row => closing?.ticket === row.ticket ? closeEditor(row, closing) : editActions(
      row.ticket,
      () => { save(row, edit => trading.modifyPosition(row.ticket, brackets(edit))) },
      () => {
        if (!agreed()) return
        setClosing(null)
        setEditing({ ticket: row.ticket, price: null, takeProfit: bracketText(row.ticker, row.takeProfit), stopLoss: bracketText(row.ticker, row.stopLoss) })
      },
      <button type="button" className="dshMkTextButton" disabled={busy !== null}
        onClick={(event) => {
          event.stopPropagation()
          if (!agreed()) return
          setEditing(null)
          setClosing({ ticket: row.ticket, lots: lotsInput(row) })
        }}>{t('action.close')}</button>,
    ) },
  ]

  const orderColumns: Column<TradingSnapshot['orders'][number]>[] = [
    { key: 'symbol', label: t('col.symbol'), cell: row => <strong>{row.ticker}</strong> },
    { key: 'ticket', label: t('col.ticket'), cell: row => row.ticket },
    { key: 'time', label: t('col.placedTime'), cell: row => formatTime(row.placedAt) },
    { key: 'type', label: t('col.type'), cell: row => <span data-side={row.side}>{orderKind(t, row.side, row.type)}</span> },
    { key: 'lots', label: t('col.lots'), numeric: true, cell: row => lotsOf(symbolOf, row.ticker, row.lots) },
    { key: 'price', label: t('col.price'), numeric: true, cell: row => editCell(row.ticket, 'price', orderPrice(row), t('col.price')) },
    { key: 'sl', label: t('col.stopLoss'), numeric: true, cell: row => editCell(row.ticket, 'stopLoss', price(symbolOf, row.ticker, row.stopLoss), t('col.stopLoss')) },
    { key: 'tp', label: t('col.takeProfit'), numeric: true, cell: row => editCell(row.ticket, 'takeProfit', price(symbolOf, row.ticker, row.takeProfit), t('col.takeProfit')) },
    { key: 'current', label: t('col.currentPrice'), numeric: true, cell: row => price(symbolOf, row.ticker, row.currentPrice) },
    { key: 'actions', label: t('col.actions'), cell: row => editActions(
      row.ticket,
      () => { save(row, edit => trading.modifyOrder(row.ticket, { price: parseDecimal(edit.price ?? ''), ...brackets(edit) })) },
      () => {
        if (!agreed()) return
        setClosing(null)
        setEditing({
          ticket: row.ticket, price: bracketText(row.ticker, row.price),
          takeProfit: bracketText(row.ticker, row.takeProfit), stopLoss: bracketText(row.ticker, row.stopLoss),
        })
      },
      <button type="button" className="dshMkTextButton" disabled={busy !== null}
        onClick={(event) => { event.stopPropagation(); run(row.ticket, 'cancel', row.ticker, () => trading.cancelOrder(row.ticket)) }}>{t('action.cancel')}</button>,
    ) },
  ]

  const historyColumns: Column<TradingSnapshot['history'][number]>[] = [
    { key: 'symbol', label: t('col.symbol'), cell: row => <strong>{row.ticker}</strong> },
    { key: 'ticket', label: t('col.ticket'), cell: row => row.ticket },
    { key: 'placed', label: t('col.placedTime'), cell: row => formatTime(row.placedAt) },
    { key: 'type', label: t('col.type'), cell: row => <span data-side={row.side ?? undefined}>{orderKind(t, row.side, row.type)}</span> },
    { key: 'lots', label: t('col.lots'), numeric: true, cell: row => lotsOf(symbolOf, row.ticker, row.lots) },
    { key: 'price', label: t('col.price'), numeric: true, cell: row => orderPrice(row) },
    { key: 'fill', label: t('col.fillPrice'), numeric: true, cell: row => price(symbolOf, row.ticker, row.fillPrice) },
    { key: 'state', label: t('col.state'), cell: row => <span className="dshMkState" data-state={row.state}>{t(`state.${row.state}`)}</span> },
    { key: 'done', label: t('col.doneTime'), cell: row => formatTime(row.doneAt) },
  ]

  // A balance operation fills the symbol column with what it is, and leaves the trade columns empty.
  const trade = (row: Deal, cell: (deal: Deal) => ReactNode): ReactNode => row.kind === 'trade' ? cell(row) : '—'
  const dealColumns: Column<Deal>[] = [
    { key: 'time', label: t('col.time'), cell: row => formatTime(row.time) },
    { key: 'deal', label: t('col.deal'), cell: row => row.ticket },
    { key: 'order', label: t('col.order'), cell: row => row.orderTicket ?? '—' },
    { key: 'symbol', label: t('col.symbol'), cell: row => row.kind === 'trade' ? <strong>{row.ticker}</strong> : operationLabel(t, row) },
    { key: 'side', label: t('col.side'), cell: row => row.side === null ? '—' : <span data-side={row.side}>{sideLabel(t, row.side)}</span> },
    { key: 'entry', label: t('col.entry'), cell: row => row.entry === null ? '—' : entryLabel(t, row.entry) },
    { key: 'lots', label: t('col.lots'), numeric: true, cell: row => trade(row, deal => lotsOf(symbolOf, deal.ticker, deal.lots)) },
    { key: 'price', label: t('col.price'), numeric: true, cell: row => trade(row, deal => price(symbolOf, deal.ticker, deal.price)) },
    { key: 'commission', label: t('col.commission'), numeric: true, cell: row => formatMoney(row.commission) },
    { key: 'swap', label: t('col.swap'), numeric: true, cell: row => formatMoney(row.swap) },
    { key: 'fee', label: t('col.fee'), numeric: true, cell: row => formatMoney(row.fee) },
    { key: 'profit', label: t('col.profit'), numeric: true, cell: row => <Money value={row.profit} /> },
    { key: 'reason', label: t('col.reason'), cell: row => reasonLabel(t, row.reason) },
  ]
  const historyBar = <HistoryBar t={t} selection={historyPeriod} state={historyState} onSelect={actions.setHistoryPeriod} onRetry={() => { trading.refreshHistory() }} />
  const historyEmpty = (key: 'empty.history' | 'empty.deals'): string => historyState.status === 'loading' ? t('history.loading') : t(key)

  const body = (): ReactNode => {
    switch (tab) {
      case 'positions': return <div className="dshMkHistoryBody">
        {positions.length > 0 && <div className="dshMkHistoryBar">
          <select className="dshMkSelect" aria-label={t('close.bySymbol')} value="" disabled={busy !== null}
            onChange={(event) => { if (event.target.value !== '') closePositions(event.target.value) }}>
            <option value="">{t('close.bySymbol')}</option>
            {heldSymbols.map(ticker => <option key={ticker} value={ticker}>{ticker}</option>)}
          </select>
          <button type="button" className="dshMkTextButton" disabled={busy !== null} onClick={() => { closePositions(null) }}>{t('close.all')}</button>
        </div>}
        <Table label={t('panel.positions')} columns={positionColumns} rows={positions} rowKey={row => row.ticket} empty={t('empty.positions')} onSelect={select} />
      </div>
      case 'orders': return <Table label={t('panel.orders')} columns={orderColumns} rows={orders} rowKey={row => row.ticket} empty={t('empty.orders')} onSelect={select} />
      case 'history': return <div className="dshMkHistoryBody">
        {historyBar}
        <Table label={t('panel.history')} columns={historyColumns} rows={history} rowKey={row => row.ticket} empty={historyEmpty('empty.history')} onSelect={select} />
      </div>
      case 'deals': return <div className="dshMkHistoryBody">
        {historyBar}
        <Table label={t('panel.deals')} columns={dealColumns} rows={deals} rowKey={row => row.ticket} rowKind={row => row.kind === 'balance' ? 'balance' : undefined}
          empty={historyEmpty('empty.deals')} onSelect={select} footer={<DealTotals t={t} deals={deals} />} />
      </div>
      case 'account': return <AccountTab t={t} account={account} connection={connection} upColor={upColor} onUpColor={actions.setUpColor} />
    }
  }

  return <section className="dshMkTrade" data-open={open || undefined} aria-label={t('widget.tradePanel')}>
    <div className="dshMkTradeBar">
      <div className="dshMkTradeTabs" role="tablist" aria-label={t('widget.tradePanel')}>
        {TABS.map(value => <button key={value} type="button" role="tab" className="dshMkTradeTab" aria-selected={open && tab === value}
          onClick={() => { if (open && tab === value) actions.toggleBottom(); else actions.setBottomTab(value) }}>
          {t(`panel.${value}`)}
          {counts[value] !== undefined && <span className="dshMkCount">{counts[value]}</span>}
        </button>)}
      </div>
      <span className="dshMkTradeSpacer" />
      {!open && <Summary t={t} account={account} compact />}
      <ConnectionStatus t={t} connection={connection} trading={trading} notify={notify} />
      <Tooltip label={t(open ? 'panel.collapse' : 'panel.expand')} side="top" delayMs={400}>
        <button type="button" className="dshMkIconButton" aria-label={t(open ? 'panel.collapse' : 'panel.expand')} aria-expanded={open} onClick={() => { actions.toggleBottom() }}>
          {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
      </Tooltip>
    </div>
    {open && <Summary t={t} account={account} compact={false} />}
    {open && <div className="dshMkTradeBody" role="tabpanel">{body()}</div>}
    {closeMany !== null && <ClosePositionsDialog t={t} symbol={closeMany.symbol} positions={closeMany.positions} trading={trading}
      symbolOf={symbolOf} upColor={upColor} onClose={() => { setCloseMany(null) }} />}
  </section>
}

/** A margin call or stop out level in the unit the broker sets it in. */
const stopLevel = (value: number, mode: 'percent' | 'money', currency: string): string =>
  mode === 'percent' ? `${formatNumber(value, 2)}%` : `${formatMoney(value)} ${currency}`

function AccountTab({ t, account, connection, upColor, onUpColor }: {
  t: MarketT
  account: AccountInfo | null
  connection: TradingConnection
  upColor: 'green' | 'red'
  onUpColor(color: 'green' | 'red'): void
}) {
  const row = (label: string, value: ReactNode) => <div><dt>{label}</dt><dd>{value}</dd></div>
  // The demo account stands in without an MT5 account, so the MT5 extras only show for a real link.
  const mt5 = connection.source === 'mt5' ? connection.mt5?.account ?? null : null
  const firstBlock = connection.blocked[0]
  return <div className="dshMkAccountTab">
    <section>
      <h3>{t('account.details')}</h3>
      {account === null ? <div className="dshMkEmpty">{t('account.none')}</div> : <dl className="dshMkStats" data-wide="">
        {row(t('account.login'), account.login)}
        {row(t('account.name'), connection.source === 'mock' ? t('account.mockName') : account.name)}
        {row(t('account.company'), account.company)}
        {row(t('account.server'), account.server)}
        {row(t('account.currency'), account.currency)}
        {row(t('account.leverage'), `1:${account.leverage}`)}
        {row(t('account.accounting'), t(account.accounting === 'hedging' ? 'account.hedging' : 'account.netting'))}
        {row(t('col.type'), t(`account.${account.mode}`))}
        {connection.source === 'mt5' && row(t('account.trading'), firstBlock === undefined ? t('account.tradingOk') : blockText(t, firstBlock))}
        {row(t('account.balance'), formatMoney(account.balance))}
        {row(t('account.credit'), formatMoney(account.credit))}
        {row(t('account.equity'), formatMoney(account.equity))}
        {row(t('account.margin'), formatMoney(account.margin))}
        {row(t('account.freeMargin'), formatMoney(account.freeMargin))}
        {row(t('account.marginLevel'), account.marginLevel === null ? '—' : `${formatNumber(account.marginLevel, 2)}%`)}
        {mt5 !== null && row(t('account.marginCall'), stopLevel(mt5.marginCall, mt5.marginSoMode, mt5.currency))}
        {mt5 !== null && row(t('account.stopOut'), stopLevel(mt5.stopOut, mt5.marginSoMode, mt5.currency))}
      </dl>}
    </section>
    <section>
      <h3>{t('account.display')}</h3>
      <div className="dshMkSetting">
        <span>{t('account.colors')}</span>
        <div className="dshMkTabs" role="radiogroup" aria-label={t('account.colors')}>
          <button type="button" role="radio" aria-checked={upColor === 'green'} className="dshMkTab" onClick={() => { onUpColor('green') }}>
            <span className="dshMkSwatch" data-color="green" />{t('account.greenUp')}
          </button>
          <button type="button" role="radio" aria-checked={upColor === 'red'} className="dshMkTab" onClick={() => { onUpColor('red') }}>
            <span className="dshMkSwatch" data-color="red" />{t('account.redUp')}
          </button>
        </div>
      </div>
    </section>
  </div>
}
