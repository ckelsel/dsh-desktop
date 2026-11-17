/** Number and time formatting of the market page: fixed decimals, grouping, and a true minus sign. */
import { stepDecimals, type MarketSymbol } from './data/market-data.ts'

const MINUS = '−'
const formatters = new Map<number, Intl.NumberFormat>()

function formatter(decimals: number): Intl.NumberFormat {
  let value = formatters.get(decimals)
  if (value === undefined) {
    value = new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    formatters.set(decimals, value)
  }
  return value
}

/** Grouped fixed-decimal text; values that round to zero lose their sign. */
export function formatNumber(value: number, decimals: number): string {
  if (!Number.isFinite(value)) return '—'
  const text = formatter(decimals).format(Math.abs(value))
  return value < 0 && /[1-9]/.test(text) ? `${MINUS}${text}` : text
}

/** Like {@link formatNumber}, with a plus sign on positive values. */
export function formatSigned(value: number, decimals: number): string {
  const text = formatNumber(value, decimals)
  return value > 0 && /[1-9]/.test(text) ? `+${text}` : text
}

export const formatPrice = (symbol: Pick<MarketSymbol, 'decimals'>, value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : formatNumber(value, symbol.decimals)

export const formatPercent = (value: number): string => `${formatSigned(value, 2)}%`
export const formatMoney = (value: number): string => formatNumber(value, 2)
export const formatPips = (value: number): string => formatSigned(value, 1)
export const formatLots = (symbol: Pick<MarketSymbol, 'lotStep'>, lots: number): string => formatNumber(lots, stepDecimals(symbol.lotStep))

/** Compact count: 1.2K, 3.4M. */
export function formatVolume(value: number): string {
  if (!Number.isFinite(value)) return '—'
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (value >= 1e4) return `${(value / 1e3).toFixed(1)}K`
  return String(Math.round(value))
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** Local `MM-DD HH:mm:ss`. */
export function formatTime(time: number): string {
  const date = new Date(time)
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Colour class of a signed value. */
export const trend = (value: number): 'up' | 'down' | 'flat' => value > 0 ? 'up' : value < 0 ? 'down' : 'flat'

/** Parse user input such as `1,234.5`; NaN when it is not a number. */
export function parseDecimal(text: string): number {
  const cleaned = text.replace(/[,\s]/g, '').replace(MINUS, '-')
  return cleaned === '' || !/^-?\d*\.?\d*$/.test(cleaned) ? Number.NaN : Number(cleaned)
}
