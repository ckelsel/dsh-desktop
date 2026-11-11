/**
 * Watchlist panel, after the TradingView web watchlist: grouped rows with last price and change,
 * sortable columns, a price flash on every tick, symbol search to add rows, and the details of the
 * chart symbol below the list. Selecting a row shows the symbol on the chart.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Plus, Search, X } from 'lucide-react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { ASSET_CLASSES, type MarketDataProvider, type MarketSymbol, type Quote } from './data/market-data.ts'
import { conversionRate, pipValue } from './data/trading.ts'
import { formatMoney, formatNumber, formatPercent, formatPrice, formatSigned, formatVolume, trend } from './format.ts'
import { describeSymbol, sessionLines } from './labels.ts'
import type { MarketActions, MarketPageProps, MarketT, UseQuotes } from './page-types.ts'
import type { SortKey } from './store.ts'

export interface WatchlistProps {
  t: MarketT
  market: MarketDataProvider
  useQuotes: UseQuotes
  useStore: MarketPageProps['useStore']
  actions: MarketActions
  accountCurrency: string
}

/** Direction and generation of the latest price change, for the row flash. */
function useFlash(value: number | undefined): { direction: 'up' | 'down' | undefined; generation: number } {
  const previous = useRef(value)
  const [flash, setFlash] = useState<{ direction: 'up' | 'down' | undefined; generation: number }>({ direction: undefined, generation: 0 })
  useEffect(() => {
    const before = previous.current
    previous.current = value
    if (before === undefined || value === undefined || before === value) return
    setFlash(current => ({ direction: value > before ? 'up' : 'down', generation: current.generation + 1 }))
  }, [value])
  return flash
}

interface RowProps {
  symbol: MarketSymbol
  quote: Quote | undefined
  active: boolean
  description: string
  removeLabel: string
  onSelect(ticker: string): void
  onRemove(ticker: string): void
}

const Row = memo(function Row({ symbol, quote, active, description, removeLabel, onSelect, onRemove }: RowProps) {
  const flash = useFlash(quote?.last)
  const change = quote?.change ?? 0
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onSelect(symbol.ticker)
    }
  }
  return <div
    className="dshMkWlRow dshMkWlGrid"
    role="row"
    tabIndex={0}
    aria-selected={active}
    data-active={active || undefined}
    data-closed={quote !== undefined && !quote.marketOpen ? '' : undefined}
    title={description}
    onClick={() => { onSelect(symbol.ticker) }}
    onKeyDown={onKeyDown}
  >
    <span className="dshMkWlSymbol" role="cell">
      <span className="dshMkWlBadge" data-asset={symbol.assetClass} aria-hidden="true">{symbol.baseCurrency.slice(0, 1)}</span>
      <span className="dshMkWlTicker">{symbol.ticker}</span>
    </span>
    <span className="dshMkNum" role="cell">
      <span key={flash.generation} className="dshMkFlash" data-flash={flash.direction}>{formatPrice(symbol, quote?.last)}</span>
    </span>
    <span className="dshMkNum" role="cell" data-trend={trend(change)}>{quote === undefined ? '—' : formatSigned(change, symbol.decimals)}</span>
    <span className="dshMkNum" role="cell" data-trend={trend(change)}>{quote === undefined ? '—' : formatPercent(quote.changePercent)}</span>
    <button
      type="button"
      className="dshMkWlRemove"
      aria-label={`${removeLabel} ${symbol.ticker}`}
      title={removeLabel}
      onClick={(event) => { event.stopPropagation(); onRemove(symbol.ticker) }}
    >
      <X size={12} strokeWidth={2} />
    </button>
  </div>
})

const SORT_COLUMNS: readonly { key: SortKey; label: 'column.symbol' | 'column.last' | 'column.change' | 'column.changePercent' }[] = [
  { key: 'ticker', label: 'column.symbol' },
  { key: 'last', label: 'column.last' },
  { key: 'change', label: 'column.change' },
  { key: 'changePercent', label: 'column.changePercent' },
]

/** Search box listing symbols not yet in the list. */
function AddSymbol({ t, market, listed, onAdd, onClose }: { t: MarketT; market: MarketDataProvider; listed: readonly string[]; onAdd(ticker: string): void; onClose(): void }) {
  const [query, setQuery] = useState('')
  const input = useRef<HTMLInputElement | null>(null)
  useEffect(() => { input.current?.focus() }, [])
  const results = market.search(query.trim()).filter(symbol => !listed.includes(symbol.ticker))
  return <div className="dshMkWlAdd" onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <label className="dshMkSearch">
      <Search size={14} strokeWidth={1.75} aria-hidden="true" />
      <input
        ref={input}
        value={query}
        placeholder={t('watchlist.search')}
        aria-label={t('watchlist.search')}
        onChange={(event) => { setQuery(event.target.value) }}
        onKeyDown={(event) => { if (event.key === 'Enter' && results[0] !== undefined) onAdd(results[0].ticker) }}
      />
      <button type="button" className="dshMkIconButton" aria-label={t('action.discard')} onClick={onClose}><X size={14} /></button>
    </label>
    <div className="dshMkWlAddList" role="listbox" aria-label={t('watchlist.add')}>
      {results.length === 0 && <div className="dshMkEmpty">{t('watchlist.noMatch')}</div>}
      {results.map(symbol => <button key={symbol.ticker} type="button" role="option" aria-selected={false} className="dshMkWlAddItem" onClick={() => { onAdd(symbol.ticker) }}>
        <span className="dshMkWlTicker">{symbol.ticker}</span>
        <span className="dshMkMuted">{describeSymbol(t, symbol)}</span>
        <Plus size={14} aria-hidden="true" />
      </button>)}
    </div>
  </div>
}

const sortValue = (symbol: MarketSymbol, quote: Quote | undefined, key: SortKey): number | string =>
  key === 'ticker' ? symbol.ticker : quote === undefined ? Number.NEGATIVE_INFINITY : quote[key]

/** The watchlist with the details card (see module doc). */
export function Watchlist({ t, market, useQuotes, useStore, actions, accountCurrency }: WatchlistProps) {
  const watchlist = useStore(state => state.watchlist)
  const collapsed = useStore(state => state.collapsed)
  const sort = useStore(state => state.sort)
  const current = useStore(state => state.symbol)
  const quotes = useQuotes(map => map)
  const [adding, setAdding] = useState(false)
  // Quote sorts follow live prices; list order needs no quotes.
  const sortQuotes = sort !== null && sort.key !== 'ticker' ? quotes : undefined

  const groups = useMemo(() => ASSET_CLASSES.map((assetClass) => {
    const symbols = watchlist.flatMap(ticker => {
      const symbol = market.symbol(ticker)
      return symbol?.assetClass === assetClass ? [symbol] : []
    })
    if (sort !== null) {
      symbols.sort((left, right) => {
        const a = sortValue(left, sortQuotes?.[left.ticker], sort.key)
        const b = sortValue(right, sortQuotes?.[right.ticker], sort.key)
        return (a < b ? -1 : a > b ? 1 : 0) * sort.direction
      })
    }
    return { assetClass, symbols }
  }).filter(group => group.symbols.length > 0), [market, watchlist, sort, sortQuotes])

  return <section className="dshMkPanel dshMkWatchlist" aria-label={t('watchlist.title')}>
    <header className="dshMkPanelHeader">
      <h2>{t('watchlist.title')}</h2>
      <Tooltip label={t('watchlist.add')} side="bottom" delayMs={400}>
        <button type="button" className="dshMkIconButton" aria-label={t('watchlist.add')} aria-pressed={adding} onClick={() => { setAdding(value => !value) }}>
          <Plus size={16} strokeWidth={1.75} />
        </button>
      </Tooltip>
    </header>
    {adding && <AddSymbol t={t} market={market} listed={watchlist} onAdd={(ticker) => { actions.addSymbol(ticker) }} onClose={() => { setAdding(false) }} />}
    <div className="dshMkWlTable" role="grid" aria-label={t('watchlist.title')}>
      <div className="dshMkWlHead dshMkWlGrid" role="row">
        {SORT_COLUMNS.map(column => {
          const sorted = sort?.key === column.key ? sort.direction : 0
          return <button
            key={column.key}
            type="button"
            role="columnheader"
            className="dshMkWlHeadCell"
            data-numeric={column.key !== 'ticker' || undefined}
            aria-sort={sorted === 1 ? 'ascending' : sorted === -1 ? 'descending' : 'none'}
            title={t('watchlist.sort', { column: t(column.label) })}
            onClick={() => { actions.cycleSort(column.key) }}
          >
            {t(column.label)}
            {sorted === 1 && <ArrowUp size={11} aria-hidden="true" />}
            {sorted === -1 && <ArrowDown size={11} aria-hidden="true" />}
          </button>
        })}
      </div>
      <div className="dshMkWlBody">
        {groups.length === 0 && <div className="dshMkEmpty">{t('watchlist.empty')}</div>}
        {groups.map(group => {
          const closed = collapsed.includes(group.assetClass)
          return <div key={group.assetClass} role="rowgroup">
            <button type="button" className="dshMkWlGroup" aria-expanded={!closed} onClick={() => { actions.toggleGroup(group.assetClass) }}>
              {closed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
              <span>{t(`group.${group.assetClass}`)}</span>
              <span className="dshMkMuted">{group.symbols.length}</span>
            </button>
            {!closed && group.symbols.map(symbol => <Row
              key={symbol.ticker}
              symbol={symbol}
              quote={quotes[symbol.ticker]}
              active={symbol.ticker === current}
              description={describeSymbol(t, symbol)}
              removeLabel={t('watchlist.remove')}
              onSelect={actions.setSymbol}
              onRemove={actions.removeSymbol}
            />)}
          </div>
        })}
      </div>
    </div>
    <SymbolDetails t={t} market={market} ticker={current} quote={quotes[current]} accountCurrency={accountCurrency} />
  </section>
}

/** Details card of the chart symbol. */
export function SymbolDetails({ t, market, ticker, quote, accountCurrency }: { t: MarketT; market: MarketDataProvider; ticker: string; quote: Quote | undefined; accountCurrency: string }) {
  const symbol = market.symbol(ticker)
  if (symbol === undefined) return null
  const rate = conversionRate(symbol.currency, accountCurrency, value => market.quote(value))
  const range = quote === undefined ? 0 : quote.high - quote.low
  const position = quote === undefined || range <= 0 ? 50 : (quote.last - quote.low) / range * 100
  const spread = quote === undefined ? undefined : (quote.ask - quote.bid) / symbol.pip
  return <section className="dshMkDetails" aria-label={symbol.ticker}>
    <div className="dshMkDetailsHead">
      <div>
        <div className="dshMkDetailsTicker">{symbol.ticker}</div>
        <div className="dshMkMuted">{describeSymbol(t, symbol)} · {symbol.exchange}</div>
      </div>
      <span className="dshMkStatus" data-open={quote?.marketOpen || undefined}>
        {quote?.marketOpen === true ? t('details.open') : t('details.closed')}
      </span>
    </div>
    {quote === undefined ? <div className="dshMkEmpty">{t('details.noQuote')}</div> : <>
      <div className="dshMkDetailsPrice">
        <span className="dshMkDetailsLast">{formatPrice(symbol, quote.last)}</span>
        <span className="dshMkNum" data-trend={trend(quote.change)}>{formatSigned(quote.change, symbol.decimals)}</span>
        <span className="dshMkNum" data-trend={trend(quote.change)}>{formatPercent(quote.changePercent)}</span>
      </div>
      <div className="dshMkQuoteBox">
        <div><span className="dshMkMuted">{t('details.bid')}</span><strong data-side="sell">{formatPrice(symbol, quote.bid)}</strong></div>
        <div data-center=""><span className="dshMkMuted">{t('details.spread')}</span><strong>{formatNumber(spread ?? 0, 1)}</strong></div>
        <div data-end=""><span className="dshMkMuted">{t('details.ask')}</span><strong data-side="buy">{formatPrice(symbol, quote.ask)}</strong></div>
      </div>
      <div className="dshMkRange" aria-label={t('details.dayRange')}>
        <div className="dshMkRangeLabels"><span>{formatPrice(symbol, quote.low)}</span><span className="dshMkMuted">{t('details.dayRange')}</span><span>{formatPrice(symbol, quote.high)}</span></div>
        <div className="dshMkRangeTrack"><span className="dshMkRangeMarker" style={{ left: `${Math.min(100, Math.max(0, position))}%` }} /></div>
      </div>
      <dl className="dshMkStats">
        <div><dt>{t('details.dayOpen')}</dt><dd>{formatPrice(symbol, quote.open)}</dd></div>
        <div><dt>{t('details.prevClose')}</dt><dd>{formatPrice(symbol, quote.prevClose)}</dd></div>
        <div><dt>{t('details.volume')}</dt><dd>{formatVolume(quote.volume)}</dd></div>
        <div><dt>{t('details.contract')}</dt><dd>{formatNumber(symbol.contractSize, 0)} {symbol.baseCurrency}</dd></div>
        <div><dt>{t('details.pipValue')}</dt><dd>{rate === null ? '—' : `${formatMoney(pipValue(symbol, 1, rate))} ${accountCurrency}`}</dd></div>
      </dl>
    </>}
    <div className="dshMkSession">
      <span className="dshMkMuted">{t('details.session')}</span>
      {sessionLines(t, symbol).map(line => <span key={line}>{line}</span>)}
    </div>
  </section>
}
