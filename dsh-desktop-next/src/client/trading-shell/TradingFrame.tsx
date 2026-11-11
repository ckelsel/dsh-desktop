/**
 * Root frame of the trading workspace, registered into the runtime's 'root' slot in place of the
 * official AppFrame. Columns: activity bar | session list ('sidebar') | market ('trading.market') |
 * main ('main': Conversation or a global panel) | right column ('rightbar'), with 'shell.bottom',
 * 'shell.overlay' and 'shell.leading' as in ui-layout 0.2.2. Hidden columns stay mounted, so the
 * chart and the Conversation keep their state; the market mounts on first display.
 * The frame keeps the official data attributes other plugins' styles select on.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { ActivityBar } from './ActivityBar.tsx'
import {
  ACTIVITY_WIDTH, CENTER_MIN, clampWidth, computeColumns, RIGHTBAR_MAX_RATIO, RIGHTBAR_MIN, SIDEBAR_DEFAULT,
} from './columns.ts'
import { columnInput, defaultRightbar, isDrawer, type TradingLayoutStore } from './layout-store.ts'

/** Values the root registration injects. */
export interface TradingFrameInjected {
  /** Browser title restored when no Session title applies. */
  productTitle: string
}

/** Full composed props of the frame. */
export type TradingFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'main' | 'rightbar' | 'shell.bottom' | 'shell.overlay' | 'shell.leading' | 'trading.market'>
  & PropsStore<TradingLayoutStore>
  & PropsLocale<'desktop-trading'>
  & InjectFace<TradingFrameInjected>

/** Inline clearance of the leading seat inside the main column: 12 + 28 + 8 + 28 + 8 px. */
const LEADING_CLEARANCE = 84

const inert = (value: boolean): { inert?: '' } => value ? { inert: '' } : {}

/** Subscribe to the main key without re-rendering the column on every panel id. */
function MainPanel({ usePanelInfo, renderSlot }: Pick<TradingFrameProps, 'usePanelInfo'> & PropsRenderSlots<'main'>) {
  const panelId = usePanelInfo(info => info.activePanelId)
  return <div className="dshTwMainPanel" data-global-panel={panelId !== null || undefined}>
    {renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })}
  </div>
}

/** Project the selected Session title into the browser title, like the official frame. */
function DocumentTitle({ useSessions, usePanelInfo, productTitle }: Pick<TradingFrameProps, 'useSessions' | 'usePanelInfo'> & { productTitle: string }): null {
  const showSessionTitle = usePanelInfo(info => info.activePanelId === null)
  const title = useSessions((state) => {
    const current = Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
    return !showSessionTitle || current === undefined ? undefined : state.byId[current]?.title
  })
  useEffect(() => {
    document.title = title === undefined ? productTitle : `${title} — ${productTitle}`
    return () => { document.title = productTitle }
  }, [productTitle, title])
  return null
}

/** One column drag handle: pointer capture and rAF-throttled offsets from the drag origin. */
function DragHandle(props: { side: 'sidebar' | 'chat' | 'rightbar'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const capture = useRef<{ element: HTMLDivElement; id: number } | null>(null)
  const callbacks = useRef(props)
  callbacks.current = props

  const endDrag = useCallback(() => {
    const active = capture.current
    if (active === null) return
    capture.current = null
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])
  useEffect(() => endDrag, [endDrag])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || capture.current !== null) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    capture.current = { element: event.currentTarget, id: event.pointerId }
    origin.current = event.clientX
    latest.current = event.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== event.pointerId) return
    latest.current = event.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (capture.current?.id !== event.pointerId) return
    callbacks.current.onDrag(event.clientX - origin.current)
    endDrag()
  }, [endDrag])
  const onPointerCancel = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (capture.current?.id === event.pointerId) endDrag()
  }, [endDrag])

  return <div
    className="dshTwHandle"
    style={{ left: props.left }}
    data-side={props.side}
    data-dragging={dragging || undefined}
    onPointerDown={onPointerDown}
    onPointerMove={onPointerMove}
    onPointerUp={onPointerUp}
    onPointerCancel={onPointerCancel}
    onLostPointerCapture={onPointerCancel}
  />
}

/** The trading workspace frame (see module doc). */
export function TradingFrame({ useStore, useSessions, usePanelInfo, actions, renderSlot, t, productTitle }: TradingFrameProps) {
  const state = useStore(value => value)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const info = state.layoutInfo
  const viewport = info.viewportWidth

  // Track the frame's own box: a rAF-throttled ResizeObserver.
  useLayoutEffect(() => {
    const element = frameRef.current
    if (element === null) return
    let raf: number | null = null
    let disposed = false
    const measure = () => {
      const width = element.getBoundingClientRect().width
      if (width > 0) actions.setViewportWidth(width)
    }
    measure()
    const observer = new ResizeObserver(() => {
      if (disposed) return
      raf ??= requestAnimationFrame(() => { raf = null; measure() })
    })
    observer.observe(element)
    return () => {
      disposed = true
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [actions])

  const root = document.documentElement
  const darwin = root.dataset.platform === 'darwin'
  const windowsTitlebar = root.hasAttribute('data-windows-titlebar')
  const drawer = isDrawer(state)
  const sidebarOpen = drawer ? info.drawerOpen : state.workbench.sessions
  const sidebarCollapsed = !sidebarOpen
  const drawerOpen = drawer && sidebarOpen
  const cols = computeColumns(columnInput(state))
  const normal = computeColumns(columnInput(state, 'preference'))
  const rightbarPreference = info.rightbar ?? defaultRightbar(viewport)
  const content = Math.max(0, viewport - ACTIVITY_WIDTH - cols.sidebar)
  const rightbarMax = cols.rightbar === 0 ? 0 : clampWidth(rightbarPreference, RIGHTBAR_MIN, content * RIGHTBAR_MAX_RATIO)
  const conversationShown = cols.showMain && state.panelInfo.activePanelId === null

  // The market mounts the first time it is shown and stays mounted while hidden.
  const [marketMounted, setMarketMounted] = useState(cols.showMarket)
  if (cols.showMarket && !marketMounted) setMarketMounted(true)

  const colsRef = useRef(cols)
  colsRef.current = cols
  const normalRef = useRef(normal)
  normalRef.current = normal
  const [dragging, setDragging] = useState(false)
  const base = useRef(0)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { base.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => { actions.setSidebar(base.current + dx) }, [actions])
  const onChatStart = useCallback(() => { base.current = colsRef.current.main; setDragging(true) }, [])
  const onChatDrag = useCallback((dx: number) => { actions.setChatWidth(base.current - dx) }, [actions])
  const onRightbarStart = useCallback(() => { base.current = normalRef.current.rightbar; setDragging(true) }, [])
  const onRightbarDrag = useCallback((dx: number) => { actions.setRightbar(base.current - dx) }, [actions])

  const sidebarWidth = drawer
    ? Math.min(state.workbench.sidebar || SIDEBAR_DEFAULT, Math.max(0, viewport - ACTIVITY_WIDTH - 48))
    : cols.sidebar
  const sidebar = useMemo(() => renderSlot('sidebar', { collapsed: sidebarCollapsed, width: sidebarWidth, drawer }),
    [renderSlot, sidebarCollapsed, sidebarWidth, drawer])
  const main = useMemo(() => <MainPanel usePanelInfo={usePanelInfo} renderSlot={renderSlot} />, [usePanelInfo, renderSlot])
  const market = useMemo(() => marketMounted ? renderSlot('trading.market', {}) : null, [marketMounted, renderSlot])
  const overlays = useMemo(() => renderSlot('shell.overlay', {}), [renderSlot])
  const leading = useMemo(() => renderSlot('shell.leading', {}), [renderSlot])
  const rightbar = renderSlot('rightbar', { width: normal.rightbar, viewportWidth: viewport, canShow: cols.showMain && normal.rightbar > 0 })
  // The Windows caption keeps the session list's own reopen controls; elsewhere a hidden list leaves
  // its reopen and New Session controls at the main column's top-left.
  const leadingMounted = cols.showMain && (drawer || (sidebarCollapsed && !windowsTitlebar))
  const caption = windowsTitlebar || darwin

  const template = [
    `${ACTIVITY_WIDTH}px`,
    `${drawer ? 0 : cols.sidebar}px`,
    cols.showMarket ? 'minmax(0px, 1fr)' : '0px',
    !cols.showMain ? '0px' : cols.mainFills ? `minmax(${cols.rightbar === 0 ? 0 : CENTER_MIN}px, 1fr)` : `${cols.main}px`,
    cols.showMain ? `minmax(0px, ${rightbarMax}px)` : '0px',
  ].join(' ')
  const mainStyle = leadingMounted ? { '--dsh-frame-leading-clearance': `${LEADING_CLEARANCE}px` } as CSSProperties : undefined

  return (
    <div
      ref={frameRef}
      className="dshTwFrame"
      style={{
        gridTemplateColumns: template,
        // The right Sidebar caps its width by the columns left of it under the Windows caption.
        ...(windowsTitlebar ? { '--dsh-windows-sidebar-width': `${ACTIVITY_WIDTH + cols.sidebar}px` } : {}),
      } as CSSProperties}
      data-tw-caption={caption || undefined}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-sidebar-drawer={drawer || undefined}
      data-rightbar-collapsed={cols.rightbar === 0 || undefined}
      data-rightbar-fullscreen={info.rightbarFullscreen || undefined}
      data-rightbar-instant={info.rightbarInstant || undefined}
      data-dragging={dragging || undefined}
    >
      <DocumentTitle productTitle={productTitle} useSessions={useSessions} usePanelInfo={usePanelInfo} />
      {caption && <div className="dshTwCaption" data-window-drag="" aria-hidden="true" />}
      <ActivityBar
        t={t}
        sessions={sidebarOpen}
        chat={conversationShown}
        market={cols.showMarket}
        onSessions={() => { actions.toggleSidebar() }}
        onChat={() => { actions.toggleColumn('chat') }}
        onMarket={() => { actions.toggleColumn('market') }}
      />
      {drawer && <div className="dshTwDrawerMask" data-sidebar-mask aria-hidden="true"
        onClick={drawerOpen ? () => { actions.toggleSidebar() } : undefined} />}
      <div className="dshTwSidebarCol" style={drawer ? { width: sidebarWidth } : undefined} {...inert(drawer && sidebarCollapsed)}>
        {sidebar}
      </div>
      <div className="dshTwMarketCol" data-tw-hidden={!cols.showMarket || undefined} {...inert(!cols.showMarket || drawerOpen)}>
        {market}
      </div>
      <div className="dshTwMainCol" style={mainStyle} data-tw-hidden={!cols.showMain || undefined} {...inert(!cols.showMain || drawerOpen)}>
        {main}
        {leadingMounted && <div className="dshTwLeadingSeat" data-shell-leading {...inert(drawerOpen)}>{leading}</div>}
      </div>
      <div className="dshTwRightbarCol" data-rightbar-col data-tw-hidden={!cols.showMain || undefined} {...inert(drawerOpen)}>
        {rightbar}
      </div>
      <div className="dshTwBottomRow" data-shell-bottom {...inert(drawerOpen)}>
        {renderSlot('shell.bottom', {})}
      </div>
      <div className="dshTwOverlayLayer" data-shell-overlay>
        {overlays}
      </div>
      {!drawer && sidebarOpen && cols.sidebar > 0
        && <DragHandle side="sidebar" left={ACTIVITY_WIDTH + cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {cols.showMarket && cols.showMain
        && <DragHandle side="chat" left={ACTIVITY_WIDTH + cols.sidebar + cols.market} onStart={onChatStart} onDrag={onChatDrag} onEnd={onDragEnd} />}
      {cols.showMain && info.rightbarShown && !info.rightbarFullscreen && normal.rightbar > 0
        && <DragHandle side="rightbar" left={viewport - normal.rightbar} onStart={onRightbarStart} onDrag={onRightbarDrag} onEnd={onDragEnd} />}
    </div>
  )
}
