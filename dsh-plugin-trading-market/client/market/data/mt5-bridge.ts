/**
 * The Desktop's MT5 bridge as the market page sees it: `window.dshMt5`, which the preload exposes
 * in the Desktop window only (a browser session has none), and a store of its latest status.
 */
import type { Mt5RendererBridge, Mt5Status } from '../../contract.ts'

declare global { interface Window { dshMt5?: Mt5RendererBridge } }

/** The preload's bridge, or null outside the Desktop window. */
export function desktopMt5Bridge(): Mt5RendererBridge | null {
  return typeof window === 'undefined' ? null : window.dshMt5 ?? null
}

/** The bridge's latest status, kept while anything reads it. */
export interface Mt5StatusSource {
  /** The latest status; null until the main process answered. */
  get(): Mt5Status | null
  subscribe(listener: () => void): () => void
  dispose(): void
}

/**
 * Follow the bridge status. The main process answers the first read and pushes later changes on
 * the same channel, so whichever arrives last is the newest.
 * @param onError - receives a failed first read; pushes keep arriving after it.
 */
export function createMt5StatusSource(bridge: Mt5RendererBridge, onError?: (error: unknown) => void): Mt5StatusSource {
  let status: Mt5Status | null = null
  let disposed = false
  const listeners = new Set<() => void>()
  const set = (next: Mt5Status): void => {
    if (disposed) return
    status = next
    for (const listener of [...listeners]) listener()
  }
  const stop = bridge.onStatus(set)
  bridge.status().then(set, (error: unknown) => { if (!disposed) onError?.(error) })
  return {
    get: () => status,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      disposed = true
      stop()
      listeners.clear()
    },
  }
}
