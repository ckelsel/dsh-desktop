/**
 * Bottom trading panel, after the TradingView web account manager: the account summary, then
 * positions, pending orders, order history, deals and the account details in tabs. Row actions
 * (close, modify, cancel) go to the trading provider; selecting a row shows its symbol on the chart.
 * Open, the full account summary sits below the tabs; collapsed, only the tab bar remains, with the
 * equity and floating profit when there is room. The connection badge stays in the tab bar either way.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Check, ChevronDown, ChevronUp, Pencil, X } from 'lucide-react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketDataProvider, MarketSymbol } from './data/market-data.ts'
import { pipsBetween, type AccountInfo, type Brackets, type TradeResult, type TradingConnection, type TradingProvider, type TradingSnapshot } from './data/trading.ts'
import { ConnectionStatus } from './ConnectionStatus.tsx'
import { formatLots, formatMoney, formatNumber, formatPips, formatPrice, formatSigned, formatTime, parseDecimal, trend } from './format.ts'
import { blockText, orderKind, resultNotice, sideLabel } from './labels.ts'
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
}

const TABS: readonly BottomTab[] = ['positions', 'orders', 'history', 'deals', 'account']

/** Column of a table: header label, alignment and cell renderer. */
interface Column<Row> {
  key: string
  label: string
  numeric?: boolean
  cell(row: Row): ReactNode
}

function Table<Row>({ columns, rows, rowKey, empty, onSelect, label }: {
  columns: readonly Column<Row>[]
  rows: readonly Row[]
  rowKey(row: NoInfer<Row>): string
  empty: string
  label: string
  onSelect?(row: NoInfer<Row>): void
}) {
  if (rows.length === 0) return <div className="dshMkEmpty" data-table="">{empty}</div>
  return <table className="dshMkTable" aria-label={label}>
    <thead><tr>{columns.map(column => <th key={column.key} scope="col" data-numeric={column.numeric || undefined}>{column.label}</th>)}</tr></thead>
    <tbody>
      {rows.map(row => <tr key={rowKey(row)} onClick={onSelect === undefined ? undefined : () => { onSelect(row) }}>
        {columns.map(column => <td key={column.key} data-numeric={column.numeric || undefined}>{column.cell(row)}</td>)}
      </tr>)}
    </tbody>
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

/** The trading panel (see module doc). */
export function TradePanel({ t, market, trading, useAccount, useStore, actions, notify }: TradePanelProps) {
  const open = useStore(state => state.bottomOpen)
  const tab = useStore(state => state.bottomTab)
  const upColor = useStore(state => state.upColor)
  const snapshot = useAccount(state => state)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const symbolOf = (ticker: string): MarketSymbol | undefined => market.symbol(ticker)
  const { account, positions, orders, history, deals, connection } = snapshot
  const counts: Partial<Record<BottomTab, number>> = { positions: positions.length, orders: orders.length }

  const run = (key: string, request: () => Promise<TradeResult>): void => {
    if (busy !== null) return
    setBusy(key)
    request().then((result) => {
      const notice = resultNotice(t, result)
      notify(notice.text, notice.tone)
      if (result.status === 'done' || result.status === 'placed') setEditing(null)
    }, (reason: unknown) => {
      notify(t('result.rejected', { message: String(reason) }), 'error')
    }).finally(() => { setBusy(null) })
  }
  const parseBracket = (text: string): number | null => text.trim() === '' ? null : parseDecimal(text)
  const brackets = (edit: Editing): Brackets => ({ takeProfit: parseBracket(edit.takeProfit), stopLoss: parseBracket(edit.stopLoss) })
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

  const select = (row: { ticker: string }): void => { actions.setSymbol(row.ticker) }

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
    { key: 'actions', label: t('col.actions'), cell: row => editActions(
      row.ticket,
      () => { if (editing !== null) run(row.ticket, () => trading.modifyPosition(row.ticket, brackets(editing))) },
      () => { setEditing({ ticket: row.ticket, price: null, takeProfit: bracketText(row.ticker, row.takeProfit), stopLoss: bracketText(row.ticker, row.stopLoss) }) },
      <button type="button" className="dshMkTextButton" disabled={busy !== null}
        onClick={(event) => { event.stopPropagation(); run(row.ticket, () => trading.closePosition(row.ticket)) }}>{t('action.close')}</button>,
    ) },
  ]

  const orderColumns: Column<TradingSnapshot['orders'][number]>[] = [
    { key: 'symbol', label: t('col.symbol'), cell: row => <strong>{row.ticker}</strong> },
    { key: 'ticket', label: t('col.ticket'), cell: row => row.ticket },
    { key: 'time', label: t('col.placedTime'), cell: row => formatTime(row.placedAt) },
    { key: 'type', label: t('col.type'), cell: row => <span data-side={row.side}>{orderKind(t, row.side, row.type)}</span> },
    { key: 'lots', label: t('col.lots'), numeric: true, cell: row => lotsOf(symbolOf, row.ticker, row.lots) },
    { key: 'price', label: t('col.price'), numeric: true, cell: row => editCell(row.ticket, 'price', price(symbolOf, row.ticker, row.price), t('col.price')) },
    { key: 'sl', label: t('col.stopLoss'), numeric: true, cell: row => editCell(row.ticket, 'stopLoss', price(symbolOf, row.ticker, row.stopLoss), t('col.stopLoss')) },
    { key: 'tp', label: t('col.takeProfit'), numeric: true, cell: row => editCell(row.ticket, 'takeProfit', price(symbolOf, row.ticker, row.takeProfit), t('col.takeProfit')) },
    { key: 'current', label: t('col.currentPrice'), numeric: true, cell: row => price(symbolOf, row.ticker, row.currentPrice) },
    { key: 'actions', label: t('col.actions'), cell: row => editActions(
      row.ticket,
      () => {
        if (editing === null) return
        run(row.ticket, () => trading.modifyOrder(row.ticket, { price: parseDecimal(editing.price ?? ''), ...brackets(editing) }))
      },
      () => {
        setEditing({
          ticket: row.ticket, price: bracketText(row.ticker, row.price),
          takeProfit: bracketText(row.ticker, row.takeProfit), stopLoss: bracketText(row.ticker, row.stopLoss),
        })
      },
      <button type="button" className="dshMkTextButton" disabled={busy !== null}
        onClick={(event) => { event.stopPropagation(); run(row.ticket, () => trading.cancelOrder(row.ticket)) }}>{t('action.cancel')}</button>,
    ) },
  ]

  const historyColumns: Column<TradingSnapshot['history'][number]>[] = [
    { key: 'symbol', label: t('col.symbol'), cell: row => <strong>{row.ticker}</strong> },
    { key: 'ticket', label: t('col.ticket'), cell: row => row.ticket },
    { key: 'placed', label: t('col.placedTime'), cell: row => formatTime(row.placedAt) },
    { key: 'type', label: t('col.type'), cell: row => <span data-side={row.side}>{orderKind(t, row.side, row.type)}</span> },
    { key: 'lots', label: t('col.lots'), numeric: true, cell: row => lotsOf(symbolOf, row.ticker, row.lots) },
    { key: 'price', label: t('col.price'), numeric: true, cell: row => row.price === null ? t('type.market') : price(symbolOf, row.ticker, row.price) },
    { key: 'fill', label: t('col.fillPrice'), numeric: true, cell: row => price(symbolOf, row.ticker, row.fillPrice) },
    { key: 'state', label: t('col.state'), cell: row => <span className="dshMkState" data-state={row.state}>{t(`state.${row.state}`)}</span> },
    { key: 'done', label: t('col.doneTime'), cell: row => formatTime(row.doneAt) },
  ]

  const dealColumns: Column<TradingSnapshot['deals'][number]>[] = [
    { key: 'time', label: t('col.time'), cell: row => formatTime(row.time) },
    { key: 'deal', label: t('col.deal'), cell: row => row.ticket },
    { key: 'order', label: t('col.order'), cell: row => row.orderTicket },
    { key: 'symbol', label: t('col.symbol'), cell: row => <strong>{row.ticker}</strong> },
    { key: 'side', label: t('col.side'), cell: row => <span data-side={row.side}>{sideLabel(t, row.side)}</span> },
    { key: 'entry', label: t('col.entry'), cell: row => t(`entry.${row.entry}`) },
    { key: 'lots', label: t('col.lots'), numeric: true, cell: row => lotsOf(symbolOf, row.ticker, row.lots) },
    { key: 'price', label: t('col.price'), numeric: true, cell: row => price(symbolOf, row.ticker, row.price) },
    { key: 'commission', label: t('col.commission'), numeric: true, cell: row => formatMoney(row.commission) },
    { key: 'swap', label: t('col.swap'), numeric: true, cell: row => formatMoney(row.swap) },
    { key: 'profit', label: t('col.profit'), numeric: true, cell: row => <Money value={row.profit} /> },
  ]

  const body = (): ReactNode => {
    switch (tab) {
      case 'positions': return <Table label={t('panel.positions')} columns={positionColumns} rows={positions} rowKey={row => row.ticket} empty={t('empty.positions')} onSelect={select} />
      case 'orders': return <Table label={t('panel.orders')} columns={orderColumns} rows={orders} rowKey={row => row.ticket} empty={t('empty.orders')} onSelect={select} />
      case 'history': return <Table label={t('panel.history')} columns={historyColumns} rows={history} rowKey={row => row.ticket} empty={t('empty.history')} onSelect={select} />
      case 'deals': return <Table label={t('panel.deals')} columns={dealColumns} rows={deals} rowKey={row => row.ticket} empty={t('empty.deals')} onSelect={select} />
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
        {row(t('account.name'), account.name)}
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
