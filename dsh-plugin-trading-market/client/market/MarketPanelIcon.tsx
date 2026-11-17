/**
 * The market page's sidebar panel-list icon (the sidebar owns the button and label).
 */
import { CandlestickChart } from 'lucide-react'

/** The candlestick glyph shown in the sidebar panel list. */
export function MarketPanelIcon(): React.JSX.Element {
  return <CandlestickChart size={18} strokeWidth={1.75} />
}
