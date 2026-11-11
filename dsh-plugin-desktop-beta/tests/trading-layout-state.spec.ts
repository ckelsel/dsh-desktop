import { describe, expect, it, vi } from 'vitest'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import {
  ACTIVITY_WIDTH, CHAT_MIN, computeColumns, MARKET_MIN, RIGHTBAR_MIN, SIDEBAR_DEFAULT, type ColumnInput,
} from '../src/client/trading-shell/columns.ts'
import {
  columnInput, createTradingLayoutStore, DEFAULT_WORKBENCH, parseWorkbench, persistWorkbench, readWorkbench,
  WORKBENCH_STORAGE_KEY, type WorkbenchPreferences,
} from '../src/client/trading-shell/layout-store.ts'
import { TradingLayoutController } from '../src/client/trading-shell/layout-service.ts'

const base: ColumnInput = {
  viewport: 1600, sidebar: SIDEBAR_DEFAULT, market: true, chat: true, lastOpened: 'market',
  chatWidth: 420, globalPanel: false, rightbar: 0,
}

function store(workbench: Partial<WorkbenchPreferences> = {}, viewportWidth = 1600) {
  return createTradingLayoutStore({ viewportWidth, drawerEnabled: true, workbench: { ...DEFAULT_WORKBENCH, ...workbench } }).create()
}

describe('trading workspace columns', () => {
  it('puts the chat beside a flexible market and fills the frame exactly', () => {
    const cols = computeColumns(base)
    expect(cols).toMatchObject({ showMarket: true, showMain: true, mainFills: false, sidebar: SIDEBAR_DEFAULT, main: 420, rightbar: 0 })
    expect(ACTIVITY_WIDTH + cols.sidebar + cols.market + cols.main + cols.rightbar).toBe(1600)
  })

  it('keeps the chat inside its range and leaves the market its minimum', () => {
    expect(computeColumns({ ...base, chatWidth: 100 }).main).toBe(CHAT_MIN)
    // Half the frame at most.
    expect(computeColumns({ ...base, sidebar: 0, viewport: 2000, chatWidth: 1500 }).main).toBe(1000)
    const tight = computeColumns({ ...base, viewport: ACTIVITY_WIDTH + SIDEBAR_DEFAULT + MARKET_MIN + CHAT_MIN + 50, chatWidth: 900 })
    expect(tight.market).toBeGreaterThanOrEqual(MARKET_MIN)
  })

  it('lets the main column fill the content when the market is off or a global panel is selected', () => {
    expect(computeColumns({ ...base, market: false })).toMatchObject({ showMarket: false, mainFills: true, main: 1600 - ACTIVITY_WIDTH - SIDEBAR_DEFAULT })
    expect(computeColumns({ ...base, globalPanel: true })).toMatchObject({ showMarket: false, showMain: true, mainFills: true })
    // A global panel shows even with the chat switched off.
    expect(computeColumns({ ...base, chat: false, globalPanel: true }).showMain).toBe(true)
    expect(computeColumns({ ...base, chat: false })).toMatchObject({ showMain: false, main: 0, market: 1600 - ACTIVITY_WIDTH - SIDEBAR_DEFAULT })
  })

  it('keeps only the column opened last when both cannot fit', () => {
    const narrow = { ...base, viewport: 1100 }
    expect(computeColumns({ ...narrow, lastOpened: 'market' })).toMatchObject({ showMarket: true, showMain: false })
    expect(computeColumns({ ...narrow, lastOpened: 'chat' })).toMatchObject({ showMarket: false, showMain: true })
    // Closing the session list makes room for both again.
    expect(computeColumns({ ...narrow, sidebar: 0 })).toMatchObject({ showMarket: true, showMain: true })
  })

  it('gives the right column a track only beside a visible main column with room to spare', () => {
    expect(computeColumns({ ...base, rightbar: 400, viewport: 2400 }).rightbar).toBe(400)
    // 1600 leaves 1600 - 48 - 280 - 560 - 360 = 352 px: the request shrinks to what fits.
    expect(computeColumns({ ...base, rightbar: 400 }).rightbar).toBe(352)
    expect(computeColumns({ ...base, rightbar: 400, viewport: 1500 }).rightbar).toBe(0)
    expect(computeColumns({ ...base, rightbar: 400, chat: false }).rightbar).toBe(0)
    expect(computeColumns({ ...base, rightbar: 400, market: false }).rightbar).toBeGreaterThanOrEqual(RIGHTBAR_MIN)
  })
})

describe('trading workspace store', () => {
  it('never leaves both market and chat off from the activity bar', () => {
    const instance = store()
    instance.actions.toggleColumn('market')
    expect(instance.getSnapshot().workbench).toMatchObject({ market: false, chat: true, lastOpened: 'chat' })
    instance.actions.toggleColumn('chat')
    expect(instance.getSnapshot().workbench).toMatchObject({ market: true, chat: false, lastOpened: 'market' })
    instance.actions.toggleColumn('chat')
    expect(instance.getSnapshot().workbench).toMatchObject({ market: true, chat: true, lastOpened: 'chat' })
  })

  it('shows a column hidden by a narrow frame instead of switching it off', () => {
    const instance = store({ lastOpened: 'market' }, 1100)
    expect(computeColumns(columnInput(instance.getSnapshot())).showMain).toBe(false)
    instance.actions.toggleColumn('chat')
    const state = instance.getSnapshot()
    expect(state.workbench).toMatchObject({ market: true, chat: true, lastOpened: 'chat' })
    expect(computeColumns(columnInput(state))).toMatchObject({ showMain: true, showMarket: false })
  })

  it('returns from a global panel when the market or chat button is used', () => {
    const instance = store()
    instance.actions.selectPanel('plugins' as MainPanelId)
    expect(computeColumns(columnInput(instance.getSnapshot())).showMarket).toBe(false)
    instance.actions.toggleColumn('market')
    expect(instance.getSnapshot().panelInfo.activePanelId).toBeNull()
    expect(computeColumns(columnInput(instance.getSnapshot()))).toMatchObject({ showMarket: true, showMain: true })
  })

  it('reveals the chat when navigation returns to the Conversation', () => {
    const instance = store({ chat: false })
    instance.actions.selectPanel('plugins' as MainPanelId)
    expect(instance.getSnapshot().workbench.chat).toBe(false)
    instance.actions.selectPanel(null)
    expect(instance.getSnapshot().workbench).toMatchObject({ chat: true, lastOpened: 'chat' })
  })

  it('toggles the session list, or the drawer on narrow frames', () => {
    const instance = store()
    instance.actions.toggleSidebar()
    expect(instance.getSnapshot().workbench.sessions).toBe(false)
    instance.actions.setViewportWidth(700)
    instance.actions.toggleSidebar()
    expect(instance.getSnapshot().layoutInfo.drawerOpen).toBe(true)
    expect(instance.getSnapshot().workbench.sessions).toBe(false)
    // Crossing the breakpoint closes the drawer.
    instance.actions.setViewportWidth(1200)
    expect(instance.getSnapshot().layoutInfo.drawerOpen).toBe(false)
    const windows = createTradingLayoutStore({ viewportWidth: 700, drawerEnabled: false, workbench: { ...DEFAULT_WORKBENCH } }).create()
    windows.actions.toggleSidebar()
    expect(windows.getSnapshot().workbench.sessions).toBe(false)
  })

  it('records the right column presentation reported by its occupant', () => {
    const instance = store()
    instance.actions.openRightbar(true, false)
    expect(instance.getSnapshot().layoutInfo).toMatchObject({ rightbarShown: true, rightbarTrack: true, rightbarFullscreen: false, rightbar: 480 })
    instance.actions.openRightbar(true, true)
    instance.actions.closeRightbar()
    expect(instance.getSnapshot().layoutInfo).toMatchObject({ rightbarShown: false, rightbarTrack: false, rightbarFullscreen: false, rightbarInstant: true })
    expect(columnInput(instance.getSnapshot()).rightbar).toBe(0)
    expect(columnInput(instance.getSnapshot(), 'preference').rightbar).toBe(480)
  })
})

describe('trading layout service', () => {
  it('rejects unregistered panels and supersedes pending navigations', () => {
    const instance = store()
    const panels = new Set(['plugins'])
    const layout = new TradingLayoutController(instance.actions, id => panels.has(id), {
      getSnapshot: () => instance.getSnapshot().panelInfo, subscribe: listener => instance.subscribe(listener),
    })
    expect(() => layout.selectPanel('missing' as MainPanelId)).toThrow('not registered')
    const first = layout.beginNavigation()
    layout.selectPanel('plugins' as MainPanelId)
    expect(first.aborted).toBe(true)
    expect(layout.panelInfo.getSnapshot().activePanelId).toBe('plugins')
    instance.actions.retainMainPanels([])
    expect(layout.panelInfo.getSnapshot().activePanelId).toBeNull()
    const pending = layout.beginNavigation()
    layout.dispose()
    expect(pending.aborted).toBe(true)
  })
})

describe('workbench persistence', () => {
  it('parses saved values field by field and keeps a content column on', () => {
    expect(parseWorkbench(undefined)).toEqual(DEFAULT_WORKBENCH)
    expect(parseWorkbench({ market: false, chat: false, sidebar: 9999, chatWidth: 'wide', lastOpened: 'x' }))
      .toEqual({ ...DEFAULT_WORKBENCH, market: true, chat: false, sidebar: 420 })
  })

  it('writes only when the workbench slice changes and survives storage failures', () => {
    const values = new Map<string, string>()
    const setItem = vi.fn((key: string, value: string) => { values.set(key, value) })
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem }
    const instance = store()
    const stop = persistWorkbench(instance, storage)
    instance.actions.setViewportWidth(1400)
    expect(setItem).not.toHaveBeenCalled()
    instance.actions.toggleColumn('market')
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(readWorkbench(storage)).toMatchObject({ market: false, chat: true })
    stop()
    expect(readWorkbench({ getItem: () => { throw new Error('blocked') }, setItem })).toEqual(DEFAULT_WORKBENCH)
    expect(readWorkbench({ getItem: () => '{not json', setItem })).toEqual(DEFAULT_WORKBENCH)
    expect(values.has(WORKBENCH_STORAGE_KEY)).toBe(true)
  })
})
