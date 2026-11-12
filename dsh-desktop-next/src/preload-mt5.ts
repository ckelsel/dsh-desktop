/** `window.dshMt5`: the market page's channel to the main process MT5 bridge. */
import { ipcRenderer } from 'electron'
import {
  MT5_IPC, type Mt5Bar, type Mt5Catalog, type Mt5HistoryBars, type Mt5RendererBridge, type Mt5Status, type Mt5Tick,
  type Mt5TradeEvent, type Mt5TradeHistory, type Mt5Trading,
} from './mt5/contract.ts'

/** Follow a push channel. @returns the unsubscribe function. */
function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const receive = (_event: unknown, value: T): void => { listener(value) }
  ipcRenderer.on(channel, receive)
  return () => { ipcRenderer.removeListener(channel, receive) }
}

export function createMt5Bridge(): Mt5RendererBridge {
  return {
    status: () => ipcRenderer.invoke(MT5_IPC.status) as Promise<Mt5Status>,
    onStatus: listener => listen<Mt5Status>(MT5_IPC.statusChanged, listener),
    resync: () => ipcRenderer.invoke(MT5_IPC.resync) as Promise<void>,
    request: (type, payload) => ipcRenderer.invoke(MT5_IPC.request, type, payload) as Promise<Record<string, unknown>>,
    token: () => ipcRenderer.invoke(MT5_IPC.token) as Promise<string>,
    regenerateToken: () => ipcRenderer.invoke(MT5_IPC.regenerateToken) as Promise<string>,
    catalog: () => ipcRenderer.invoke(MT5_IPC.catalog) as Promise<Mt5Catalog | null>,
    onCatalog: listener => listen<Mt5Catalog | null>(MT5_IPC.catalogChanged, listener),
    trading: () => ipcRenderer.invoke(MT5_IPC.trading) as Promise<Mt5Trading | null>,
    onTrading: listener => listen<Mt5Trading | null>(MT5_IPC.tradingChanged, listener),
    subscribe: subscription => ipcRenderer.invoke(MT5_IPC.subscribe, subscription) as Promise<void>,
    onTicks: listener => listen<readonly Mt5Tick[]>(MT5_IPC.ticks, listener),
    onBars: listener => listen<readonly Mt5Bar[]>(MT5_IPC.bars, listener),
    onTradeEvents: listener => listen<readonly Mt5TradeEvent[]>(MT5_IPC.tradeEvents, listener),
    historyBars: (request, options) => ipcRenderer.invoke(MT5_IPC.historyBars, request, options) as Promise<Mt5HistoryBars>,
    historyTrades: range => ipcRenderer.invoke(MT5_IPC.historyTrades, range) as Promise<Mt5TradeHistory>,
  }
}
