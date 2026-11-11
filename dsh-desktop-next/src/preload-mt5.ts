/** `window.dshMt5`: the market page's channel to the main process MT5 bridge. */
import { ipcRenderer } from 'electron'
import { MT5_IPC, type Mt5RendererBridge, type Mt5Status } from './mt5/contract.ts'

export function createMt5Bridge(): Mt5RendererBridge {
  return {
    status: () => ipcRenderer.invoke(MT5_IPC.status) as Promise<Mt5Status>,
    onStatus: (listener) => {
      const receive = (_event: unknown, status: Mt5Status): void => { listener(status) }
      ipcRenderer.on(MT5_IPC.statusChanged, receive)
      return () => { ipcRenderer.removeListener(MT5_IPC.statusChanged, receive) }
    },
    resync: () => ipcRenderer.invoke(MT5_IPC.resync) as Promise<void>,
    request: (type, payload) => ipcRenderer.invoke(MT5_IPC.request, type, payload) as Promise<Record<string, unknown>>,
    token: () => ipcRenderer.invoke(MT5_IPC.token) as Promise<string>,
    regenerateToken: () => ipcRenderer.invoke(MT5_IPC.regenerateToken) as Promise<string>,
  }
}
