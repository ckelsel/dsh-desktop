/**
 * TradingView chart host. The widget is created once per language (the library cannot switch its
 * locale at runtime) and per retry; symbol, interval, theme and price colours change in place.
 * Chart state (indicators, drawings, chart type) is saved to local storage and restored on the next
 * creation. The chart keeps TradingView's default theme colours; only the red-up setting swaps the
 * candle colours.
 */
import { useEffect, useRef, useState } from 'react'
import type { MarketDataProvider } from '../data/market-data.ts'
import { createDatafeed, normalizeResolution, tickerOf, type DatafeedLabels } from './datafeed.ts'
import { LIBRARY_PATH, loadTradingView } from './loader.ts'
import type { TvChart, TvOverrides, TvWidget } from './tv-types.ts'

export type ColorScheme = 'light' | 'dark'
export type ChartLanguage = 'zh' | 'en'

/** Chart state saved by the library: indicators, drawings and chart properties. */
const CHART_STORAGE_KEY = 'dsh-desktop-beta.market-chart.v1'

/** Timezones the library accepts (`TimezoneId` in its declarations). */
const TIMEZONES = new Set([
  'Africa/Cairo', 'Africa/Casablanca', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi', 'Africa/Tunis',
  'America/Anchorage', 'America/Argentina/Buenos_Aires', 'America/Bogota', 'America/Caracas', 'America/Chicago',
  'America/El_Salvador', 'America/Juneau', 'America/Lima', 'America/Los_Angeles', 'America/Mexico_City',
  'America/New_York', 'America/Phoenix', 'America/Santiago', 'America/Sao_Paulo', 'America/Toronto', 'America/Vancouver',
  'Asia/Almaty', 'Asia/Ashkhabad', 'Asia/Bahrain', 'Asia/Bangkok', 'Asia/Chongqing', 'Asia/Colombo', 'Asia/Dhaka',
  'Asia/Dubai', 'Asia/Ho_Chi_Minh', 'Asia/Hong_Kong', 'Asia/Jakarta', 'Asia/Jerusalem', 'Asia/Karachi', 'Asia/Kathmandu',
  'Asia/Kolkata', 'Asia/Kuala_Lumpur', 'Asia/Kuwait', 'Asia/Manila', 'Asia/Muscat', 'Asia/Nicosia', 'Asia/Qatar',
  'Asia/Riyadh', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Taipei', 'Asia/Tehran', 'Asia/Tokyo', 'Asia/Yangon',
  'Atlantic/Azores', 'Atlantic/Reykjavik', 'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Perth', 'Australia/Sydney',
  'Europe/Amsterdam', 'Europe/Athens', 'Europe/Belgrade', 'Europe/Berlin', 'Europe/Bratislava', 'Europe/Brussels',
  'Europe/Bucharest', 'Europe/Budapest', 'Europe/Copenhagen', 'Europe/Dublin', 'Europe/Helsinki', 'Europe/Istanbul',
  'Europe/Lisbon', 'Europe/London', 'Europe/Luxembourg', 'Europe/Madrid', 'Europe/Malta', 'Europe/Moscow', 'Europe/Oslo',
  'Europe/Paris', 'Europe/Prague', 'Europe/Riga', 'Europe/Rome', 'Europe/Stockholm', 'Europe/Tallinn', 'Europe/Vienna',
  'Europe/Vilnius', 'Europe/Warsaw', 'Europe/Zurich', 'Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Fakaofo',
  'Pacific/Honolulu', 'Pacific/Norfolk', 'US/Mountain',
])

/** The machine's timezone when the library knows it, else UTC. */
export function chartTimezone(): string {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return TIMEZONES.has(zone) ? zone : 'Etc/UTC'
  } catch {
    return 'Etc/UTC'
  }
}

/**
 * TradingView's default candle colours (the `candleStyle` defaults); the page's `--mk-green` and
 * `--mk-red` use the same values. Everything else keeps the library's theme defaults.
 */
const TV_GREEN = '#089981'
const TV_RED = '#F23645'
const TV_GREEN_VOLUME = 'rgba(8, 153, 129, 0.5)'
const TV_RED_VOLUME = 'rgba(242, 54, 69, 0.5)'

type UpColor = 'green' | 'red'

/**
 * Price colours for the setting: the defaults for green-up, the same pair swapped for red-up. Both
 * are set explicitly, so switching back restores the defaults.
 */
function priceOverrides(upColor: UpColor): TvOverrides {
  const up = upColor === 'green' ? TV_GREEN : TV_RED
  const down = upColor === 'green' ? TV_RED : TV_GREEN
  const candles = (prefix: string): TvOverrides => ({
    [`${prefix}.upColor`]: up,
    [`${prefix}.downColor`]: down,
    [`${prefix}.borderUpColor`]: up,
    [`${prefix}.borderDownColor`]: down,
    [`${prefix}.wickUpColor`]: up,
    [`${prefix}.wickDownColor`]: down,
  })
  return {
    ...candles('mainSeriesProperties.candleStyle'),
    ...candles('mainSeriesProperties.hollowCandleStyle'),
    ...candles('mainSeriesProperties.haStyle'),
    'mainSeriesProperties.barStyle.upColor': up,
    'mainSeriesProperties.barStyle.downColor': down,
    'mainSeriesProperties.showCountdown': true,
  }
}

const volumeOverrides = (upColor: UpColor): Record<string, string> => ({
  'volume.volume.color.0': upColor === 'green' ? TV_RED_VOLUME : TV_GREEN_VOLUME,
  'volume.volume.color.1': upColor === 'green' ? TV_GREEN_VOLUME : TV_RED_VOLUME,
})

function applyPriceColors(widget: TvWidget, upColor: UpColor): void {
  widget.applyOverrides(priceOverrides(upColor))
  widget.applyStudiesOverrides(volumeOverrides(upColor))
}

function readSaved(): object | undefined {
  try {
    const raw = window.localStorage.getItem(CHART_STORAGE_KEY)
    const value: unknown = raw === null ? undefined : JSON.parse(raw)
    return value !== null && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

function writeSaved(state: object): void {
  try { window.localStorage.setItem(CHART_STORAGE_KEY, JSON.stringify(state)) } catch {
    // Full or blocked storage only loses the saved chart layout.
  }
}

export interface TradingViewChartProps {
  market: MarketDataProvider
  symbol: string
  resolution: string
  scheme: ColorScheme
  language: ChartLanguage
  upColor: 'green' | 'red'
  labels: DatafeedLabels
  text: { loading: string; missing: string; missingDetail: string; retry: string }
  onSymbol(ticker: string): void
  onResolution(resolution: string): void
  /** Receives the chart once it is ready, and null when it goes away. */
  onChart?(chart: TvChart | null): void
}

interface Mounted {
  widget: TvWidget
  ready: boolean
  theme: ColorScheme
}

/** The chart area (see module doc). */
export function TradingViewChart(props: TradingViewChartProps) {
  const { symbol, resolution, scheme, upColor, language, text } = props
  const hostRef = useRef<HTMLDivElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mounted = useRef<Mounted | null>(null)
  const latest = useRef(props)
  latest.current = props
  const [status, setStatus] = useState<'loading' | 'ready' | 'missing'>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    const container = containerRef.current
    if (host === null || container === null) return
    let disposed = false
    let cleanup: (() => void) | undefined
    setStatus('loading')
    loadTradingView().then((tv) => {
      if (disposed) return
      const initial = latest.current
      const datafeed = createDatafeed(initial.market, initial.labels)
      const widget = new tv.widget({
        container,
        datafeed,
        symbol: initial.symbol,
        interval: initial.resolution,
        library_path: LIBRARY_PATH,
        locale: initial.language,
        theme: initial.scheme,
        timezone: chartTimezone(),
        autosize: true,
        // Fullscreen requests from the chart frame are refused in the Desktop window, and no chart
        // storage server backs the save/load menu.
        disabled_features: ['header_fullscreen_button', 'header_saveload', 'popup_hints'],
        enabled_features: ['iframe_loading_same_origin'],
        saved_data: readSaved(),
        auto_save_delay: 2,
        overrides: priceOverrides(initial.upColor),
        studies_overrides: volumeOverrides(initial.upColor),
        favorites: { intervals: ['1', '5', '15', '60', '240', '1D'] },
      })
      const entry: Mounted = { widget, ready: false, theme: initial.scheme }
      mounted.current = entry
      const save = (): void => { widget.save(writeSaved) }
      widget.subscribe('onAutoSaveNeeded', save)
      const onSymbolChanged = (): void => {
        const ticker = tickerOf(widget.activeChart().symbol())
        if (latest.current.market.symbol(ticker) !== undefined) latest.current.onSymbol(ticker)
      }
      const onIntervalChanged = (interval: string): void => { latest.current.onResolution(normalizeResolution(interval)) }
      widget.onChartReady(() => {
        if (disposed) return
        const chart = widget.activeChart()
        chart.onSymbolChanged().subscribe(null, onSymbolChanged)
        chart.onIntervalChanged().subscribe(null, onIntervalChanged)
        // Saved chart properties carry the colours of when they were saved.
        applyPriceColors(widget, latest.current.upColor)
        entry.ready = true
        setStatus('ready')
        latest.current.onChart?.(chart)
      })
      cleanup = () => {
        mounted.current = null
        if (entry.ready) latest.current.onChart?.(null)
        // On unmount React runs this after removing the container. The chart frame's window went
        // with it, taking these subscriptions along, and the library would throw reaching into it.
        if (container.isConnected) {
          widget.unsubscribe('onAutoSaveNeeded', save)
          if (entry.ready) {
            const chart = widget.activeChart()
            chart.onSymbolChanged().unsubscribe(null, onSymbolChanged)
            chart.onIntervalChanged().unsubscribe(null, onIntervalChanged)
          }
        }
        // remove() only touches this window: its resize listener, its global and the frame element.
        widget.remove()
        datafeed.dispose()
      }
    }, () => {
      if (!disposed) setStatus('missing')
    })
    return () => {
      disposed = true
      cleanup?.()
    }
  }, [language, attempt])

  // Follow the page's symbol and interval without recreating the widget.
  useEffect(() => {
    const entry = mounted.current
    if (status !== 'ready' || entry === null || !entry.ready) return
    const chart = entry.widget.activeChart()
    if (tickerOf(chart.symbol()) !== symbol) void chart.setSymbol(symbol)
  }, [status, symbol])
  useEffect(() => {
    const entry = mounted.current
    if (status !== 'ready' || entry === null || !entry.ready) return
    const chart = entry.widget.activeChart()
    if (normalizeResolution(chart.resolution()) !== resolution) void chart.setResolution(resolution)
  }, [status, resolution])

  // Theme switches reset chart colours, so colours are applied after the theme settles.
  useEffect(() => {
    const entry = mounted.current
    const host = hostRef.current
    if (status !== 'ready' || entry === null || !entry.ready || host === null) return
    let cancelled = false
    const paint = (): void => { if (!cancelled && mounted.current === entry) applyPriceColors(entry.widget, upColor) }
    if (entry.theme === scheme) paint()
    else {
      entry.theme = scheme
      entry.widget.changeTheme(scheme, { disableUndo: true }).then(paint, paint)
    }
    return () => { cancelled = true }
  }, [status, scheme, upColor])

  return <div ref={hostRef} className="dshMkChart">
    <div ref={containerRef} className="dshMkChartWidget" data-hidden={status === 'missing' || undefined} />
    {status === 'loading' && <div className="dshMkChartState" role="status">{text.loading}</div>}
    {status === 'missing' && <div className="dshMkChartState" role="alert">
      <strong>{text.missing}</strong>
      <span>{text.missingDetail}</span>
      <button type="button" className="dshMkButton" onClick={() => { setAttempt(value => value + 1) }}>{text.retry}</button>
    </div>}
  </div>
}
