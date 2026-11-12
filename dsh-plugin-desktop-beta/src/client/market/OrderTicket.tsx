/**
 * Order ticket, after the TradingView web order panel: sell and buy prices with the spread, market,
 * limit and stop orders, lots with presets, take profit and stop loss with their distance and
 * expected result, the margin the order needs, and one submit button that names the order, beside
 * the account's type. The order is checked against the symbol's rules from MT5 before it goes to
 * the trading provider, which forwards it to MT5; the demo account answers `offline`. While the MT5
 * connection refuses trades, the button is off and the first reason shows below it; until the
 * trading risk disclaimer is agreed to, the button opens it instead.
 */
import { useEffect, useRef, useState } from 'react'
import { Minus, Plus } from 'lucide-react'
import { roundPrice, type MarketDataProvider, type MarketSymbol, type Quote } from './data/market-data.ts'
import {
  bracketError, conversionRate, direction, entryPrice, exitPrice, lotsValid, marginFor, pendingPriceValid, pipValue, pipsBetween, profitFor,
  roundLots, stopsDistanceError, tradeModeError, type OrderType, type Side, type TradeRules, type TradingProvider,
} from './data/trading.ts'
import { formatLots, formatMoney, formatNumber, formatPips, formatPrice, formatSigned, parseDecimal, trend } from './format.ts'
import { blockText, describeSymbol, pendingSideText, resultNotice } from './labels.ts'
import type { MarketActions, MarketPageProps, MarketT, Notify, UseAccount, UseQuotes } from './page-types.ts'

export interface OrderTicketProps {
  t: MarketT
  market: MarketDataProvider
  trading: TradingProvider
  useQuotes: UseQuotes
  useAccount: UseAccount
  useStore: MarketPageProps['useStore']
  actions: MarketActions
  notify: Notify
  /** Show the trading risk disclaimer for the user to agree to. */
  onDisclaimer(): void
}

/** The message of each way an order breaks its symbol's rules. */
const RULE_ERRORS = {
  tradeDisabled: 'ticket.errorTradeDisabled', closeOnly: 'ticket.errorCloseOnly', longOnly: 'ticket.errorLongOnly',
  shortOnly: 'ticket.errorShortOnly', orderType: 'ticket.errorOrderType',
  pendingDistance: 'ticket.errorPendingDistance', stopsDistance: 'ticket.errorStopsDistance',
} as const

const LOT_PRESETS = [0.01, 0.1, 0.5, 1]
const ORDER_TYPES: readonly OrderType[] = ['market', 'limit', 'stop']
/** Distance of a new pending price, take profit and stop loss from the reference, in pips. */
const PENDING_PIPS = 10
const TAKE_PROFIT_PIPS = 50
const STOP_LOSS_PIPS = 30

const priceText = (symbol: MarketSymbol, value: number): string => value.toFixed(symbol.decimals)
const lotsText = (symbol: Pick<MarketSymbol, 'lotStep'>, lots: number): string => formatLots(symbol, lots).replace(/,/g, '')

/** Default pending price on the valid side of the touch. */
function defaultPending(symbol: MarketSymbol, quote: Quote, side: Side, type: Exclude<OrderType, 'market'>): number {
  const away = (type === 'limit' ? -1 : 1) * direction(side)
  return roundPrice(symbol, entryPrice(quote, side) + away * PENDING_PIPS * symbol.pip)
}

/** A price field with pip steppers. */
function PriceField(props: { id: string; label: string; value: string; step: number; decimals: number; disabled?: boolean; onChange(value: string): void; t: MarketT }) {
  const { id, label, value, step, decimals, disabled, onChange, t } = props
  const nudge = (sign: 1 | -1): void => {
    const current = parseDecimal(value)
    if (!Number.isFinite(current)) return
    onChange((current + sign * step).toFixed(decimals))
  }
  return <div className="dshMkStepper" data-disabled={disabled || undefined}>
    <button type="button" className="dshMkStepButton" aria-label={t('ticket.decrease', { field: label })} disabled={disabled} onClick={() => { nudge(-1) }}><Minus size={14} /></button>
    <input id={id} value={value} inputMode="decimal" autoComplete="off" spellCheck={false} disabled={disabled} aria-label={label}
      onChange={(event) => { onChange(event.target.value) }} />
    <button type="button" className="dshMkStepButton" aria-label={t('ticket.increase', { field: label })} disabled={disabled} onClick={() => { nudge(1) }}><Plus size={14} /></button>
  </div>
}

interface Bracket { on: boolean; text: string }

/** The order ticket (see module doc). */
export function OrderTicket({ t, market, trading, useQuotes, useAccount, useStore, actions, notify, onDisclaimer }: OrderTicketProps) {
  const ticker = useStore(state => state.symbol)
  const type = useStore(state => state.orderType)
  const savedLots = useStore(state => state.lots)
  const symbol = market.symbol(ticker)
  const quote = useQuotes(map => map[ticker])
  const account = useAccount(state => state.account)
  const source = useAccount(state => state.connection.source)
  const blocked = useAccount(state => state.connection.source === 'mt5' ? state.connection.blocked[0] : undefined)
  const syncedAt = useAccount(state => state.connection.mt5?.syncedAt ?? null)
  const [rules, setRules] = useState<TradeRules | null>(null)
  const [side, setSide] = useState<Side>('buy')
  const [lots, setLots] = useState(() => symbol === undefined ? String(savedLots) : lotsText(symbol, savedLots))
  const [pending, setPending] = useState('')
  const [takeProfit, setTakeProfit] = useState<Bracket>({ on: false, text: '' })
  const [stopLoss, setStopLoss] = useState<Bracket>({ on: false, text: '' })
  const [sending, setSending] = useState(false)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  // The rules come from MT5 with every sync, so a new session reads them again.
  useEffect(() => {
    let current = true
    setRules(null)
    trading.rules(ticker).then((next) => { if (current) setRules(next) }, () => {})
    return () => { current = false }
  }, [trading, ticker, syncedAt])

  // A new symbol, side or order type starts from prices around the current quote.
  useEffect(() => {
    const info = market.symbol(ticker)
    const now = market.quote(ticker)
    if (info === undefined || now === undefined) return
    setPending(type === 'market' ? '' : priceText(info, defaultPending(info, now, side, type)))
    setTakeProfit(value => ({ ...value, text: '' }))
    setStopLoss(value => ({ ...value, text: '' }))
  }, [market, ticker, side, type])

  if (symbol === undefined) return <section className="dshMkPanel"><div className="dshMkEmpty">{t('details.noQuote')}</div></section>

  const isPending = type !== 'market'
  const lotsValue = parseDecimal(lots)
  const pendingValue = isPending ? parseDecimal(pending) : Number.NaN
  const reference = isPending ? pendingValue : quote === undefined ? Number.NaN : entryPrice(quote, side)
  const currency = account?.currency ?? 'USD'
  const rate = conversionRate(symbol.currency, currency, value => market.quote(value))
  const sign = direction(side)
  // An empty bracket field shows the default distance until the trader types a price.
  const bracketPrice = (bracket: Bracket, pips: number): number => bracket.text === ''
    ? (Number.isFinite(reference) ? roundPrice(symbol, reference + pips * symbol.pip) : Number.NaN)
    : parseDecimal(bracket.text)
  const tpPrice = takeProfit.on ? bracketPrice(takeProfit, sign * TAKE_PROFIT_PIPS) : null
  const slPrice = stopLoss.on ? bracketPrice(stopLoss, -sign * STOP_LOSS_PIPS) : null
  const lotsOk = lotsValid(symbol, lotsValue)
  const sized = lotsOk ? lotsValue : Number.NaN
  // MT5's margin per lot when it gave one; it knows the symbol's margin rate, the estimate does not.
  const perLot = rules?.marginPerLot[side] ?? null
  const margin = perLot !== null ? perLot * sized
    : quote !== undefined && rate !== null ? marginFor(symbol, sized, isPending ? pendingValue : quote.last, rate, account?.leverage ?? 100) : Number.NaN
  const pipWorth = rate === null ? Number.NaN : pipValue(symbol, sized, rate)
  const notional = rate === null || !Number.isFinite(reference) ? Number.NaN : symbol.contractSize * sized * reference * rate

  const modeBroken = rules === null ? null : tradeModeError(rules, side, type)
  let error: string | null = null
  if (account === null) error = t('ticket.noAccount')
  else if (modeBroken !== null) error = t(RULE_ERRORS[modeBroken])
  else if (!lotsOk) error = t('ticket.errorLots', { min: formatLots(symbol, symbol.minLots), max: formatLots(symbol, symbol.maxLots), step: formatLots(symbol, symbol.lotStep) })
  else if (isPending && !(pendingValue > 0)) error = t('ticket.errorPrice')
  else if (isPending && quote !== undefined && !pendingPriceValid(side, type, pendingValue, quote)) error = pendingSideText(t, side, type)
  else if (!isPending && quote !== undefined && !quote.marketOpen) error = t('ticket.errorClosed')
  else if (Number.isFinite(reference)) {
    const wrong = bracketError(side, reference, { takeProfit: tpPrice, stopLoss: slPrice })
    if (wrong === 'takeProfit') error = t('ticket.errorTakeProfit')
    if (wrong === 'stopLoss') error = t('ticket.errorStopLoss')
  }
  if (error === null && rules !== null && quote !== undefined) {
    const base = isPending ? pendingValue : exitPrice(quote, side)
    const near = stopsDistanceError(rules, type, entryPrice(quote, side), base, { takeProfit: tpPrice, stopLoss: slPrice })
    if (near !== null) error = t(RULE_ERRORS[near], { distance: t('ticket.pipsAway', { pips: formatPips(rules.stopsDistance / symbol.pip) }) })
  }
  const warning = error === null && account !== null && margin > account.freeMargin ? t('ticket.warnMargin') : null

  const sideName = t(side === 'buy' ? 'ticket.buy' : 'ticket.sell')
  const submitLabel = t('ticket.submit', {
    side: sideName,
    lots: lotsOk ? formatLots(symbol, lotsValue) : lots,
    symbol: symbol.ticker,
    price: isPending ? (pendingValue > 0 ? formatPrice(symbol, pendingValue) : '—') : t('ticket.atMarket'),
  })

  const commitLots = (value: number): void => {
    const rounded = roundLots(symbol, value)
    setLots(lotsText(symbol, rounded))
    if (lotsValid(symbol, rounded)) actions.setLots(rounded)
  }
  const stepLots = (delta: number): void => {
    const current = Number.isFinite(lotsValue) ? lotsValue : symbol.minLots
    commitLots(Math.min(symbol.maxLots, Math.max(symbol.minLots, current + delta)))
  }
  const needsDisclaimer = blocked === 'disclaimer'
  const submit = (): void => {
    // Agreeing does not send the order: the trader submits it again.
    if (needsDisclaimer) { onDisclaimer(); return }
    if (error !== null || sending || blocked !== undefined) return
    setSending(true)
    trading.sendOrder({
      ticker: symbol.ticker, side, type, lots: lotsValue, price: isPending ? pendingValue : null, takeProfit: tpPrice, stopLoss: slPrice,
    }).then((result) => {
      const notice = resultNotice(t, result, 'order', { price: value => formatPrice(symbol, value), lots: value => formatLots(symbol, value) })
      notify(notice.text, notice.tone)
    }, (reason: unknown) => {
      notify(t('result.rejected', { message: String(reason) }), 'error')
    }).finally(() => {
      if (alive.current) setSending(false)
    })
  }

  const bracketRow = (kind: 'takeProfit' | 'stopLoss', bracket: Bracket, price: number | null, set: (value: Bracket) => void) => {
    const label = t(kind === 'takeProfit' ? 'ticket.takeProfit' : 'ticket.stopLoss')
    const id = `dsh-mk-ticket-${kind}`
    const pips = price === null || !Number.isFinite(price) || !Number.isFinite(reference) ? Number.NaN : pipsBetween(symbol, side, reference, price)
    const amount = price === null || rate === null || !Number.isFinite(pips) ? Number.NaN : profitFor(symbol, side, sized, reference, price, rate)
    return <div className="dshMkBracket" data-on={bracket.on || undefined}>
      <label className="dshMkCheck">
        <input type="checkbox" checked={bracket.on} onChange={(event) => { set({ on: event.target.checked, text: '' }) }} />
        <span>{label}</span>
      </label>
      <PriceField
        t={t}
        id={id}
        label={label}
        value={bracket.on ? (bracket.text === '' && price !== null && Number.isFinite(price) ? priceText(symbol, price) : bracket.text) : ''}
        step={symbol.pip}
        decimals={symbol.decimals}
        disabled={!bracket.on}
        onChange={(value) => { set({ on: true, text: value }) }}
      />
      {bracket.on && <div className="dshMkBracketInfo">
        <span>{Number.isFinite(pips) ? t('ticket.pipsAway', { pips: formatPips(pips) }) : '—'}</span>
        <span data-trend={trend(amount)}>{Number.isFinite(amount) ? t('ticket.expected', { amount: formatSigned(amount, 2), currency }) : ''}</span>
      </div>}
    </div>
  }

  const spread = quote === undefined ? Number.NaN : (quote.ask - quote.bid) / symbol.pip
  return <section className="dshMkPanel dshMkTicket" aria-label={t('ticket.title')}>
    <header className="dshMkPanelHeader">
      <h2>{t('ticket.title')}</h2>
      <span className="dshMkTicketSymbol"><strong>{symbol.ticker}</strong><span className="dshMkMuted">{describeSymbol(t, symbol)}</span></span>
    </header>
    <div className="dshMkTicketBody">
      <div className="dshMkSides" role="radiogroup" aria-label={t('col.side')}>
        <button type="button" role="radio" aria-checked={side === 'sell'} className="dshMkSide" data-side="sell" onClick={() => { setSide('sell') }}>
          <span>{t('ticket.sell')}</span>
          <strong>{formatPrice(symbol, quote?.bid)}</strong>
        </button>
        <span className="dshMkSpread" aria-label={t('details.spread')}>{Number.isFinite(spread) ? formatNumber(spread, 1) : '—'}</span>
        <button type="button" role="radio" aria-checked={side === 'buy'} className="dshMkSide" data-side="buy" onClick={() => { setSide('buy') }}>
          <span>{t('ticket.buy')}</span>
          <strong>{formatPrice(symbol, quote?.ask)}</strong>
        </button>
      </div>

      <div className="dshMkTabs" role="tablist" aria-label={t('col.type')}>
        {ORDER_TYPES.map(value => <button key={value} type="button" role="tab" aria-selected={type === value} className="dshMkTab" onClick={() => { actions.setOrderType(value) }}>
          {t(`ticket.${value}`)}
        </button>)}
      </div>

      {isPending && <div className="dshMkField">
        <label htmlFor="dsh-mk-ticket-price">{t('ticket.price')}</label>
        <PriceField t={t} id="dsh-mk-ticket-price" label={t('ticket.price')} value={pending} step={symbol.pip} decimals={symbol.decimals} onChange={setPending} />
        {quote !== undefined && pendingValue > 0 && <span className="dshMkFieldInfo">
          {t('ticket.pipsAway', { pips: formatPips(Math.abs(pendingValue - entryPrice(quote, side)) / symbol.pip) })}
        </span>}
      </div>}

      <div className="dshMkField">
        <label htmlFor="dsh-mk-ticket-lots">{t('ticket.lots')}</label>
        <div className="dshMkStepper">
          <button type="button" className="dshMkStepButton" aria-label={t('ticket.decrease', { field: t('ticket.lots') })} onClick={() => { stepLots(-symbol.lotStep) }}><Minus size={14} /></button>
          <input id="dsh-mk-ticket-lots" value={lots} inputMode="decimal" autoComplete="off" spellCheck={false}
            onChange={(event) => { setLots(event.target.value) }}
            onBlur={() => { if (Number.isFinite(lotsValue)) commitLots(lotsValue) }} />
          <button type="button" className="dshMkStepButton" aria-label={t('ticket.increase', { field: t('ticket.lots') })} onClick={() => { stepLots(symbol.lotStep) }}><Plus size={14} /></button>
        </div>
        <div className="dshMkPresets">
          {LOT_PRESETS.map(preset => <button key={preset} type="button" className="dshMkChip" aria-pressed={lotsOk && Math.abs(lotsValue - preset) < 1e-9} onClick={() => { commitLots(preset) }}>
            {formatLots(symbol, preset)}
          </button>)}
        </div>
        <span className="dshMkFieldInfo">{lotsOk ? t('ticket.units', { units: formatNumber(symbol.contractSize * lotsValue, 0), currency: symbol.baseCurrency }) : ''}</span>
      </div>

      {bracketRow('takeProfit', takeProfit, tpPrice, setTakeProfit)}
      {bracketRow('stopLoss', stopLoss, slPrice, setStopLoss)}

      <dl className="dshMkSummary">
        <div><dt>{t('ticket.margin')}</dt><dd>{Number.isFinite(margin) ? `${formatMoney(margin)} ${currency}` : '—'}</dd></div>
        <div><dt>{t('ticket.pipValue')}</dt><dd>{Number.isFinite(pipWorth) ? `${formatMoney(pipWorth)} ${currency}` : '—'}</dd></div>
        <div><dt>{t('ticket.notional')}</dt><dd>{Number.isFinite(notional) ? `${formatMoney(notional)} ${currency}` : '—'}</dd></div>
        <div><dt>{t('ticket.freeMargin')}</dt><dd>{account === null ? '—' : `${formatMoney(account.freeMargin)} ${currency}`}</dd></div>
      </dl>

      {(error ?? warning) !== null && <p className="dshMkMessage" data-tone={error === null ? 'warning' : 'error'} role="alert">{error ?? warning}</p>}
      <div className="dshMkSubmitRow">
        {source === 'mt5' && account !== null && <span className="dshMkAccountTag" data-mode={account.mode}
          title={account.mode === 'real' ? t('ticket.realTitle') : undefined}>{t(`ticket.${account.mode}`)}</span>}
        <button type="button" className="dshMkSubmit" data-side={side} disabled={error !== null || sending || (blocked !== undefined && !needsDisclaimer)} onClick={submit}>
          {sending ? t('ticket.sending') : submitLabel}
        </button>
      </div>
      {source === 'mock' && <p className="dshMkHint">{t('ticket.demoHint')}</p>}
      {needsDisclaimer
        ? <p className="dshMkHint">{t('ticket.disclaimerHint')} <button type="button" className="dshMkTextButton" onClick={onDisclaimer}>{t('ticket.disclaimerOpen')}</button></p>
        : blocked !== undefined && <p className="dshMkHint">{t('ticket.blockedHint', { reason: blockText(t, blocked) })}</p>}
    </div>
  </section>
}
