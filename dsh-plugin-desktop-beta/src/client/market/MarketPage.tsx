/**
 * Market page of the trading workspace, laid out like TradingView web: the chart with the trading
 * panel below it, the watchlist or order ticket on the right, and an icon strip at the right edge
 * toggling them. The side panel and the trading panel resize by dragging their borders.
 *
 * The chart and the side panel show the current data source. While MT5 has not sent its symbols
 * they show why instead; when the source changes they mount afresh with that source's preferences.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { List, PanelBottom, Ticket, X } from 'lucide-react'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { MT5_MIN_EA_VERSION, type Mt5Status } from '../../mt5/contract.ts'
import { conversionTickers } from './data/trading.ts'
import { datafeedLabels } from './labels.ts'
import { OrderTicket } from './OrderTicket.tsx'
import type { MarketPageProps, MarketT, Notice, Notify } from './page-types.ts'
import { Splitter } from './Splitter.tsx'
import { BOTTOM_MIN, PANEL_MAX, PANEL_MIN } from './store.ts'
import { TradePanel } from './TradePanel.tsx'
import { chartStorageKey, TradingViewChart } from './tradingview/TradingViewChart.tsx'
import { Watchlist } from './Watchlist.tsx'

/** Largest share of the page height the trading panel takes. */
const BOTTOM_MAX_RATIO = 0.7
const NOTICE_MS = 4500

function StripButton({ label, pressed, onClick, children }: { label: string; pressed: boolean; onClick(): void; children: ReactNode }) {
  return <Tooltip label={label} side="left" delayMs={400}>
    <button type="button" className="dshMkStripButton" aria-label={label} aria-pressed={pressed} onClick={onClick}>{children}</button>
  </Tooltip>
}

/** Why MT5 market data is not there yet. */
function waitingText(t: MarketT, status: Mt5Status | null): string {
  if (status === null) return t('source.starting')
  if (status.eaOutdated) return t('source.outdated', { version: status.peer?.eaVersion ?? '', minimum: MT5_MIN_EA_VERSION })
  switch (status.phase) {
    case 'error': return t('source.error')
    case 'disabled':
    case 'listening': return t('source.listening')
    case 'handshaking':
    case 'syncing':
    case 'ready': return t('source.syncing')
  }
}

function Waiting({ t, status, compact }: { t: MarketT; status: Mt5Status | null; compact?: boolean }) {
  return <div className="dshMkWaiting" role="status" data-compact={compact || undefined}>
    {!compact && <strong>{t('source.title')}</strong>}
    <span>{waitingText(t, status)}</span>
  </div>
}

/** The market page (see module doc). */
export function MarketPage(props: MarketPageProps) {
  const { t, market, trading, quotes, useQuotes, useAccount, useSource, useScheme, useLanguage, useStore, actions } = props
  const source = useSource(value => value)
  const current = useStore(state => state.source)
  const symbol = useStore(state => state.symbol)
  const resolution = useStore(state => state.resolution)
  const watchlist = useStore(state => state.watchlist)
  const panel = useStore(state => state.panel)
  const panelWidth = useStore(state => state.panelWidth)
  const bottomOpen = useStore(state => state.bottomOpen)
  const bottomHeight = useStore(state => state.bottomHeight)
  const upColor = useStore(state => state.upColor)
  const scheme = useScheme(value => value)
  const language = useLanguage(value => value)
  const accountCurrency = useAccount(state => state.account?.currency ?? 'USD')
  const mt5Status = useAccount(state => state.connection.mt5)
  const ready = source.state === 'ready' && current === source.key

  // A source with symbols becomes the store's, before the chart and lists show it; a catalogue
  // update of the same source drops what it no longer lists.
  useLayoutEffect(() => {
    if (source.state !== 'ready') return
    actions.selectSource(source.key, { tickers: market.symbols().map(entry => entry.ticker), watch: source.watch })
  }, [market, source, actions])

  // One quote stream for the rows on screen, the chart symbol and its account-currency conversion.
  useEffect(() => {
    if (!ready) { quotes.follow([]); return }
    const info = market.symbol(symbol)
    const conversion = info === undefined ? [] : conversionTickers(info, accountCurrency).filter(ticker => market.symbol(ticker) !== undefined)
    quotes.follow([...watchlist, symbol, ...conversion])
  }, [market, quotes, ready, watchlist, symbol, accountCurrency])
  useEffect(() => () => { quotes.follow([]) }, [quotes])

  // Page height bounds the trading panel.
  const mainRef = useRef<HTMLDivElement | null>(null)
  const [mainHeight, setMainHeight] = useState(0)
  useLayoutEffect(() => {
    const element = mainRef.current
    if (element === null) return
    const measure = (): void => { setMainHeight(element.getBoundingClientRect().height) }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])
  const bottomMax = Math.max(BOTTOM_MIN, Math.floor(mainHeight * BOTTOM_MAX_RATIO))
  const bottom = Math.min(bottomHeight, bottomMax)

  const [dragging, setDragging] = useState(false)
  const base = useRef(0)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])

  const [notices, setNotices] = useState<Notice[]>([])
  const counter = useRef(0)
  const timers = useRef(new Set<number>())
  useEffect(() => () => { for (const timer of timers.current) window.clearTimeout(timer) }, [])
  const dismiss = useCallback((id: number) => { setNotices(list => list.filter(notice => notice.id !== id)) }, [])
  const notify = useCallback<Notify>((text, tone = 'info') => {
    const id = ++counter.current
    setNotices(list => [...list.filter(notice => notice.text !== text).slice(-2), { id, text, tone }])
    const timer = window.setTimeout(() => { timers.current.delete(timer); dismiss(id) }, NOTICE_MS)
    timers.current.add(timer)
  }, [dismiss])

  const labels = useMemo(() => datafeedLabels(t), [t])
  const chartText = useMemo(() => ({
    loading: t('chart.loading'), missing: t('chart.missing'), missingDetail: t('chart.missingDetail'), retry: t('chart.retry'),
  }), [t])

  const side = panel === null ? null : !ready ? <Waiting t={t} status={mt5Status} compact /> : panel === 'watchlist'
    ? <Watchlist key={source.key} t={t} market={market} live={source.live} useQuotes={useQuotes} useStore={useStore} actions={actions} accountCurrency={accountCurrency} />
    : <OrderTicket key={source.key} t={t} market={market} trading={trading} useQuotes={useQuotes} useAccount={useAccount} useStore={useStore} actions={actions} notify={notify} />

  return <div className="dshMkPage" data-up={upColor} data-dragging={dragging || undefined} style={{ '--mk-panel-width': `${panelWidth}px` } as CSSProperties}>
    <div ref={mainRef} className="dshMkMain">
      <div className="dshMkChartArea">
        {!ready ? <Waiting t={t} status={mt5Status} /> : <TradingViewChart
          key={source.key}
          market={market}
          storageKey={chartStorageKey(source.key)}
          symbol={symbol}
          resolution={resolution}
          scheme={scheme}
          language={language}
          upColor={upColor}
          labels={labels}
          text={chartText}
          onSymbol={actions.setSymbol}
          onResolution={actions.setResolution}
        />}
        <div className="dshMkNotices" role="status" aria-live="polite">
          {notices.map(notice => <div key={notice.id} className="dshMkNotice" data-tone={notice.tone}>
            <span>{notice.text}</span>
            <button type="button" className="dshMkIconButton" aria-label={t('notice.dismiss')} onClick={() => { dismiss(notice.id) }}><X size={14} /></button>
          </div>)}
        </div>
      </div>
      {bottomOpen && <Splitter
        axis="row"
        label={t('panel.resize')}
        value={bottom}
        min={BOTTOM_MIN}
        max={bottomMax}
        onStart={() => { base.current = bottom; setDragging(true) }}
        onDrag={(delta) => { actions.setBottomHeight(Math.min(bottomMax, base.current - delta)) }}
        onEnd={onDragEnd}
        onStep={(delta) => { actions.setBottomHeight(Math.min(bottomMax, bottom - delta)) }}
      />}
      <div className="dshMkBottom" style={bottomOpen ? { height: bottom } : undefined}>
        <TradePanel t={t} market={market} trading={trading} useAccount={useAccount} useStore={useStore} actions={actions} notify={notify} />
      </div>
    </div>
    {side !== null && <Splitter
      axis="column"
      label={t(panel === 'watchlist' ? 'widget.watchlist' : 'widget.ticket')}
      value={panelWidth}
      min={PANEL_MIN}
      max={PANEL_MAX}
      onStart={() => { base.current = panelWidth; setDragging(true) }}
      onDrag={(delta) => { actions.setPanelWidth(base.current - delta) }}
      onEnd={onDragEnd}
      onStep={(delta) => { actions.setPanelWidth(panelWidth - delta) }}
    />}
    {side !== null && <aside className="dshMkSidePanel">{side}</aside>}
    <nav className="dshMkStrip" aria-label={t('widget.bar')}>
      <StripButton label={t('widget.watchlist')} pressed={panel === 'watchlist'} onClick={() => { actions.togglePanel('watchlist') }}>
        <List size={18} strokeWidth={1.75} />
      </StripButton>
      <StripButton label={t('widget.ticket')} pressed={panel === 'ticket'} onClick={() => { actions.togglePanel('ticket') }}>
        <Ticket size={18} strokeWidth={1.75} />
      </StripButton>
      <span className="dshMkStripSpacer" />
      <StripButton label={t('widget.tradePanel')} pressed={bottomOpen} onClick={() => { actions.toggleBottom() }}>
        <PanelBottom size={18} strokeWidth={1.75} />
      </StripButton>
    </nav>
  </div>
}
