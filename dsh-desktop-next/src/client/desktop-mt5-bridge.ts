/**
 * The Desktop's MT5 bridge as built-in pages see it: `window.dshMt5`, which the preload exposes
 * in the Desktop window only (a browser session has none). The market page reads the same
 * channel from the mt5-bridge-panel plugin; this module is the driver-layer stub the Desktop's
 * own Settings page uses.
 */
import type { Mt5RendererBridge } from '../mt5/contract.ts'

declare global { interface Window { dshMt5?: Mt5RendererBridge } }

/** The preload's bridge, or null outside the Desktop window. */
export function desktopMt5Bridge(): Mt5RendererBridge | null {
  return typeof window === 'undefined' ? null : window.dshMt5 ?? null
}
