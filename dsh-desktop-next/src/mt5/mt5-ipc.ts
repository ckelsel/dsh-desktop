/**
 * IPC between the MT5 bridge and the application renderer. Only the main window's application
 * document may call. Pushes are coalesced: the status at most every `STATUS_PUSH_MS`, positions and
 * orders every `TRADING_PUSH_MS`, and quotes, bars and trade events every `MARKET_PUSH_MS`, each
 * symbol with its latest quote. A document that navigates away loses its subscriptions.
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { APP_URL } from '../ipc.ts'
import type { Mt5BridgeRuntime } from './bridge-runtime.ts'
import { MT5_IPC, type Mt5Bar, type Mt5Status, type Mt5Tick, type Mt5TradeEvent } from './contract.ts'
import {
  parseHistoryBarsInput, parseHistoryBarsOptions, parseHistoryRangeInput, parseSubscriptionInput, parseSymbolInput, parseTradeInput,
} from './renderer-input.ts'

const STATUS_PUSH_MS = 100
const TRADING_PUSH_MS = 200
const MARKET_PUSH_MS = 100

const isPayload = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Calls `push` at most once every `intervalMs`, after the first change of each interval. */
function throttle(intervalMs: number, push: () => void): { schedule(): void; cancel(): void } {
  let timer: NodeJS.Timeout | undefined
  let last = 0
  return {
    schedule() {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        last = Date.now()
        push()
      }, Math.max(0, intervalMs - (Date.now() - last)))
    },
    cancel() {
      clearTimeout(timer)
      timer = undefined
    },
  }
}

/**
 * Register the bridge's IPC handlers. `setDisclaimer` records the user's agreement to the trading
 * risk disclaimer, or its withdrawal, in the preferences and applies them to the bridge.
 * @returns a function that removes them.
 */
export function installMt5Ipc(bridge: Mt5BridgeRuntime, window: () => BrowserWindow | undefined,
  setDisclaimer: (accepted: boolean) => Promise<void>): () => void {
  const target = (): BrowserWindow | undefined => {
    const owner = window()
    return owner === undefined || owner.isDestroyed() || !owner.webContents.mainFrame.url.startsWith(APP_URL) ? undefined : owner
  }
  const assertSender = (event: IpcMainInvokeEvent): void => {
    const owner = window()
    if (owner === undefined || owner.isDestroyed() || event.sender !== owner.webContents
      || event.senderFrame !== owner.webContents.mainFrame || !event.senderFrame.url.startsWith(APP_URL)) throw new Error('MT5 bridge: rejected sender')
  }
  const send = (channel: string, value: unknown): void => { target()?.webContents.send(channel, value) }

  // The document that subscribed; its subscriptions end when it navigates away or its renderer goes.
  let subscriber: WebContents | undefined
  function unwatch(): void {
    if (subscriber !== undefined && !subscriber.isDestroyed()) {
      subscriber.removeListener('did-navigate', release)
      subscriber.removeListener('render-process-gone', release)
      subscriber.removeListener('destroyed', release)
    }
    subscriber = undefined
  }
  function release(): void {
    unwatch()
    bridge.setSubscription({ quotes: [], bars: [] })
  }
  const watch = (contents: WebContents): void => {
    if (subscriber === contents) return
    unwatch()
    subscriber = contents
    contents.on('did-navigate', release)
    contents.on('render-process-gone', release)
    contents.on('destroyed', release)
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
  ipcMain.handle(MT5_IPC.catalog, (event) => { assertSender(event); return bridge.catalog() })
  ipcMain.handle(MT5_IPC.trading, (event) => { assertSender(event); return bridge.trading() })
  ipcMain.handle(MT5_IPC.subscribe, (event, subscription: unknown) => {
    assertSender(event)
    const parsed = parseSubscriptionInput(subscription)
    watch(event.sender)
    bridge.setSubscription(parsed)
  })
  ipcMain.handle(MT5_IPC.historyBars, (event, request: unknown, options: unknown) => {
    assertSender(event)
    return bridge.historyBars(parseHistoryBarsInput(request), parseHistoryBarsOptions(options))
  })
  ipcMain.handle(MT5_IPC.historyTrades, (event, range: unknown) => { assertSender(event); return bridge.historyTrades(parseHistoryRangeInput(range)) })
  ipcMain.handle(MT5_IPC.trade, (event, input: unknown) => { assertSender(event); return bridge.trade(parseTradeInput(input)) })
  ipcMain.handle(MT5_IPC.symbolInfo, (event, symbol: unknown) => { assertSender(event); return bridge.symbolInfo(parseSymbolInput(symbol)) })
  ipcMain.handle(MT5_IPC.acceptDisclaimer, async (event) => { assertSender(event); await setDisclaimer(true) })
  ipcMain.handle(MT5_IPC.withdrawDisclaimer, async (event) => { assertSender(event); await setDisclaimer(false) })

  const status = throttle(STATUS_PUSH_MS, () => { send(MT5_IPC.statusChanged, bridge.status()) })
  const unsubscribeStatus = bridge.subscribe((_status: Mt5Status) => { status.schedule() })

  const trading = throttle(TRADING_PUSH_MS, () => { send(MT5_IPC.tradingChanged, bridge.trading()) })
  const ticks = new Map<string, Mt5Tick>()
  // A bar keeps its own entry, so the final state of a bar goes out with the one that follows it.
  const bars = new Map<string, Mt5Bar>()
  const tradeEvents: Mt5TradeEvent[] = []
  const market = throttle(MARKET_PUSH_MS, () => {
    if (ticks.size > 0) send(MT5_IPC.ticks, [...ticks.values()])
    if (bars.size > 0) send(MT5_IPC.bars, [...bars.values()])
    if (tradeEvents.length > 0) send(MT5_IPC.tradeEvents, [...tradeEvents])
    ticks.clear()
    bars.clear()
    tradeEvents.length = 0
  })
  const unsubscribeData = bridge.subscribeData((event) => {
    switch (event.kind) {
      case 'catalog':
        send(MT5_IPC.catalogChanged, event.catalog)
        return
      case 'trading':
        trading.schedule()
        return
      case 'ticks':
        for (const tick of event.ticks) ticks.set(tick.symbol, tick)
        break
      case 'bars':
        for (const bar of event.bars) bars.set(`${bar.symbol}\n${bar.timeframe}\n${String(bar.time)}`, bar)
        break
      case 'trade-event':
        tradeEvents.push(event.event)
        break
    }
    market.schedule()
  })

  return () => {
    unsubscribeStatus()
    unsubscribeData()
    status.cancel()
    trading.cancel()
    market.cancel()
    unwatch()
    for (const channel of [MT5_IPC.status, MT5_IPC.resync, MT5_IPC.request, MT5_IPC.token, MT5_IPC.regenerateToken,
      MT5_IPC.catalog, MT5_IPC.trading, MT5_IPC.subscribe, MT5_IPC.historyBars, MT5_IPC.historyTrades, MT5_IPC.trade, MT5_IPC.symbolInfo,
      MT5_IPC.acceptDisclaimer, MT5_IPC.withdrawDisclaimer]) ipcMain.removeHandler(channel)
  }
}
