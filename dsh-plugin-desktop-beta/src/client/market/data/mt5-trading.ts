/**
 * The account through the Desktop's MT5 bridge. MT5 is the source of truth: the snapshot changes
 * only when the bridge reports, and nothing is shown ahead of it. This stage reads the account and
 * its funds; positions, orders and history come with the next protocol stage, and trade requests
 * answer `blocked` without reaching MT5. While the bridge is turned off in Settings the demo account
 * stands in, as it does where there is no bridge at all.
 */
import type { Mt5Account, Mt5BridgePhase, Mt5RendererBridge, Mt5Status } from '../../../mt5/contract.ts'
import type { MockTrading } from './mock-trading.ts'
import { createMt5StatusSource } from './mt5-bridge.ts'
import type { AccountInfo, TradeBlock, TradeResult, TradingConnection, TradingProvider, TradingSnapshot } from './trading.ts'

export interface Mt5TradingOptions {
  bridge: Mt5RendererBridge
  /** The demo account shown while the bridge is turned off; this provider disposes it. */
  demo: MockTrading
  /** Receives a failed first status read. */
  onError?: (error: unknown) => void
}

/** The MT5 account, with teardown. */
export interface Mt5Trading extends TradingProvider {
  resync(): Promise<void>
  dispose(): void
}

/** The market page's account fields of an MT5 account snapshot. */
export function accountInfo(account: Mt5Account): AccountInfo {
  return {
    login: account.login, name: account.name, server: account.server, company: account.company,
    currency: account.currency, leverage: account.leverage, mode: account.tradeMode,
    accounting: account.marginMode === 'hedging' ? 'hedging' : 'netting',
    balance: account.balance, credit: account.credit, equity: account.equity, profit: account.profit,
    margin: account.margin, freeMargin: account.marginFree, marginLevel: account.marginLevel,
  }
}

const LINK: Record<Mt5BridgePhase, TradingConnection['status']> = {
  disabled: 'disconnected', error: 'disconnected', listening: 'disconnected',
  handshaking: 'connecting', syncing: 'connecting', ready: 'connected',
}

/**
 * The connection an MT5 status shows. Sending trades is not implemented yet, so `unsupported` keeps
 * the gate closed where the bridge itself would open it.
 * @param status - null until the main process answered.
 */
export function mt5Connection(status: Mt5Status | null): TradingConnection {
  if (status === null) return { source: 'mt5', status: 'connecting', blocked: ['syncing'], mt5: null }
  const blocked: TradeBlock[] = status.blocked.length > 0 ? [...status.blocked] : ['unsupported']
  return { source: 'mt5', status: LINK[status.phase], blocked, mt5: status }
}

const NONE: readonly never[] = Object.freeze([])

/**
 * Create the MT5 account provider.
 * @returns the provider; it follows the bridge status from creation and the demo account's quotes
 * while the demo account is shown and anything is subscribed.
 */
export function createMt5Trading(options: Mt5TradingOptions): Mt5Trading {
  const { bridge, demo } = options
  const source = createMt5StatusSource(bridge, options.onError)
  const listeners = new Set<() => void>()
  let stopDemo: (() => void) | undefined
  let cache: { status: Mt5Status | null; demo: TradingSnapshot | null; value: TradingSnapshot } | undefined

  const usesDemo = (): boolean => source.get()?.phase === 'disabled'
  const getSnapshot = (): TradingSnapshot => {
    const status = source.get()
    const shown = status?.phase === 'disabled' ? demo.getSnapshot() : null
    if (cache !== undefined && cache.status === status && cache.demo === shown) return cache.value
    const value: TradingSnapshot = shown !== null
      ? { ...shown, connection: { ...shown.connection, mt5: status } }
      : {
        connection: mt5Connection(status),
        account: status?.account == null ? null : accountInfo(status.account),
        positions: NONE, orders: NONE, history: NONE, deals: NONE,
      }
    cache = { status, demo: shown, value }
    return value
  }
  const notify = (): void => { for (const listener of [...listeners]) listener() }
  // The demo account follows quotes only while it is on screen.
  const followDemo = (): void => {
    const wanted = listeners.size > 0 && usesDemo()
    if (wanted && stopDemo === undefined) stopDemo = demo.subscribe(notify)
    else if (!wanted && stopDemo !== undefined) { stopDemo(); stopDemo = undefined }
  }
  const stopStatus = source.subscribe(() => { followDemo(); notify() })

  const refuse = async (): Promise<TradeResult> => ({
    status: 'blocked', blocked: getSnapshot().connection.blocked[0] ?? 'unsupported',
    retcode: null, message: '', orderTicket: null, price: null,
  })

  return {
    getSnapshot,
    subscribe(listener) {
      listeners.add(listener)
      followDemo()
      return () => {
        listeners.delete(listener)
        followDemo()
      }
    },
    sendOrder: request => usesDemo() ? demo.sendOrder(request) : refuse(),
    closePosition: (ticket, lots) => usesDemo() ? demo.closePosition(ticket, lots) : refuse(),
    modifyPosition: (ticket, brackets) => usesDemo() ? demo.modifyPosition(ticket, brackets) : refuse(),
    modifyOrder: (ticket, changes) => usesDemo() ? demo.modifyOrder(ticket, changes) : refuse(),
    cancelOrder: ticket => usesDemo() ? demo.cancelOrder(ticket) : refuse(),
    resync: () => bridge.resync(),
    dispose() {
      stopStatus()
      stopDemo?.()
      stopDemo = undefined
      listeners.clear()
      source.dispose()
      demo.dispose()
    },
  }
}
