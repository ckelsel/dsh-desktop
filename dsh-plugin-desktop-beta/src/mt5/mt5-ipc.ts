/**
 * IPC between the MT5 bridge and the application renderer. Only the main window's application
 * document may call; status changes are pushed to it at most every `STATUS_PUSH_MS`.
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { APP_URL } from '../ipc.ts'
import type { Mt5BridgeRuntime } from './bridge-runtime.ts'
import { MT5_IPC, type Mt5Status } from './contract.ts'

const STATUS_PUSH_MS = 100

const isPayload = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Register the bridge's IPC handlers.
 * @returns a function that removes them.
 */
export function installMt5Ipc(bridge: Mt5BridgeRuntime, window: () => BrowserWindow | undefined): () => void {
  const target = (): BrowserWindow | undefined => {
    const owner = window()
    return owner === undefined || owner.isDestroyed() || !owner.webContents.mainFrame.url.startsWith(APP_URL) ? undefined : owner
  }
  const assertSender = (event: IpcMainInvokeEvent): void => {
    const owner = window()
    if (owner === undefined || owner.isDestroyed() || event.sender !== owner.webContents
      || event.senderFrame !== owner.webContents.mainFrame || !event.senderFrame.url.startsWith(APP_URL)) throw new Error('MT5 bridge: rejected sender')
  }
  ipcMain.handle(MT5_IPC.status, (event) => { assertSender(event); return bridge.status() })
  ipcMain.handle(MT5_IPC.resync, async (event) => { assertSender(event); await bridge.resync() })
  ipcMain.handle(MT5_IPC.request, (event, type: unknown, payload: unknown) => {
    assertSender(event)
    if (typeof type !== 'string' || (payload !== undefined && !isPayload(payload))) throw new Error('MT5 bridge: invalid request')
    return bridge.request(type, payload)
  })
  ipcMain.handle(MT5_IPC.token, (event) => { assertSender(event); return bridge.token() })
  ipcMain.handle(MT5_IPC.regenerateToken, (event) => { assertSender(event); return bridge.regenerateToken() })

  let timer: NodeJS.Timeout | undefined
  let last = 0
  const push = (): void => {
    timer = undefined
    last = Date.now()
    target()?.webContents.send(MT5_IPC.statusChanged, bridge.status())
  }
  const unsubscribe = bridge.subscribe((_status: Mt5Status) => {
    if (timer !== undefined) return
    timer = setTimeout(push, Math.max(0, STATUS_PUSH_MS - (Date.now() - last)))
  })
  return () => {
    unsubscribe()
    clearTimeout(timer)
    for (const channel of [MT5_IPC.status, MT5_IPC.resync, MT5_IPC.request, MT5_IPC.token, MT5_IPC.regenerateToken]) ipcMain.removeHandler(channel)
  }
}
