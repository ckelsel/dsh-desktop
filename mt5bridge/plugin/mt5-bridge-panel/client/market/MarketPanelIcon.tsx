/**
 * The market page's sidebar entry icon (the panel-list row next to the label).
 */
import { CandlestickChart } from 'lucide-react'

/** The candlestick glyph the trading workspace's activity bar used; the panel entry keeps it. */
export function MarketPanelIcon(): React.JSX.Element {
  return <CandlestickChart size={18} strokeWidth={1.75} />
}
