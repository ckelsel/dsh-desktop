/**
 * Load the TradingView standalone bundle once. The Desktop protocol handler serves the vendored
 * library under {@link LIBRARY_PATH} on the app origin, so the chart iframe is same-origin.
 */
import type { TvGlobal } from './tv-types.ts'

/** Library root on the app origin; also the widget's `library_path`. */
export const LIBRARY_PATH = '/charting_library/'
const SCRIPT = `${LIBRARY_PATH}charting_library.standalone.js`

let loading: Promise<TvGlobal> | undefined

function loaded(): TvGlobal | undefined {
  const value = (window as { TradingView?: Partial<TvGlobal> }).TradingView
  return typeof value?.widget === 'function' ? value as TvGlobal : undefined
}

/**
 * Inject the library script on first use.
 * @returns the `TradingView` global; rejects when the library is missing, and a later call retries.
 */
export function loadTradingView(): Promise<TvGlobal> {
  const ready = loaded()
  if (ready !== undefined) return Promise.resolve(ready)
  loading ??= new Promise<TvGlobal>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SCRIPT
    script.async = true
    script.dataset.plugin = 'dsh-desktop-next/tradingview'
    script.addEventListener('load', () => {
      const global = loaded()
      if (global !== undefined) resolve(global)
      else reject(new Error('The TradingView library loaded without a widget constructor'))
    }, { once: true })
    script.addEventListener('error', () => {
      script.remove()
      reject(new Error(`The TradingView library is unavailable at ${SCRIPT}`))
    }, { once: true })
    document.head.append(script)
  }).catch((error: unknown) => {
    loading = undefined
    throw error
  })
  return loading
}
