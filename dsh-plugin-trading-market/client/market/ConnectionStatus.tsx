/**
 * The account's connection badge in the trading panel bar, and the details it opens: where the MT5
 * bridge listens or why it cannot, the EA and terminal in session (and whether the EA needs an
 * update), the trade server link, why new trades are refused, and a resync action. The details float over the page from `document.body`,
 * so the chart frame and the floating side panel cannot cover them.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MenuSurface, useAnchoredPosition, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Mt5Status } from '../contract.ts'
import { connectionBadge, utcOffsetText } from './connection.ts'
import type { TradingConnection, TradingProvider } from './data/trading.ts'
import { formatNumber, formatTime } from './format.ts'
import { blockText, rejectText } from './labels.ts'
import type { MarketT, Notify } from './page-types.ts'

export interface ConnectionStatusProps {
  t: MarketT
  connection: TradingConnection
  trading: TradingProvider
  notify: Notify
}

/** The badge and its details (see module doc). */
export function ConnectionStatus({ t, connection, trading, notify }: ConnectionStatusProps) {
  const [open, setOpen] = useState(false)
  const [resyncing, setResyncing] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const anchor = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const position = useAnchoredPosition({ open, anchorRef: anchor, panelRef: panel, side: 'top', align: 'end', gap: 6, margin: 8 })
  useDismissOnOutsidePointer(root, open, setOpen, panel)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Captured first, so a dialog behind the details keeps its own Escape.
      event.stopPropagation()
      setOpen(false)
      anchor.current?.focus()
    }
    // A click in the chart lands in its frame, which the outside-pointer check does not see.
    const onBlur = (): void => { setOpen(false) }
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open])

  const badge = connectionBadge(connection)
  const resync = trading.resync
  const onResync = resync === undefined ? undefined : (): void => {
    if (resyncing) return
    setResyncing(true)
    resync().catch((error: unknown) => {
      notify(t('conn.resyncFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
    }).finally(() => { if (alive.current) setResyncing(false) })
  }

  return <span ref={root} className="dshMkConn">
    <button ref={anchor} type="button" className="dshMkConnBadge" data-tone={badge.tone} aria-haspopup="dialog" aria-expanded={open}
      aria-label={`${t('conn.details')}: ${t(badge.key)}`} onClick={() => { setOpen(value => !value) }}>
      {t(badge.key)}
    </button>
    {open && createPortal(<MenuSurface
      ref={panel}
      role="dialog"
      aria-label={t('conn.title')}
      className="dshMkLayer dshMkConnPanel"
      style={position ?? { visibility: 'hidden' }}
    >
      <header className="dshMkConnHeader">
        <h3>{t('conn.title')}</h3>
        <span className="dshMkConnBadge" data-tone={badge.tone} data-static="">{t(badge.key)}</span>
      </header>
      <Details t={t} connection={connection} resyncing={resyncing} onResync={onResync} />
    </MenuSurface>, document.body)}
  </span>
}

function Details({ t, connection, resyncing, onResync }: { t: MarketT; connection: TradingConnection; resyncing: boolean; onResync: (() => void) | undefined }) {
  const status = connection.mt5
  if (connection.source === 'mock') return <p>{t(status === null ? 'conn.noBridge' : 'conn.disabled')}</p>
  if (status === null) return <p>{t('conn.starting')}</p>
  const { peer, terminal, account, listen } = status
  const rows: [string, ReactNode][] = []
  if (peer !== null) {
    rows.push([t('conn.peer'), peer.address], [t('conn.eaVersion'), peer.eaVersion])
    if (terminal !== null) {
      rows.push([t('conn.terminal'), `${terminal.name} · ${t('conn.build', { build: String(terminal.build) })}`])
      const ping = terminal.connected && terminal.pingMs !== null ? ` · ${formatNumber(terminal.pingMs, 0)} ms` : ''
      rows.push([t('conn.broker'), <span data-tone={terminal.connected ? 'ok' : 'warning'}>{t(terminal.connected ? 'conn.brokerOn' : 'conn.brokerOff')}{ping}</span>])
      rows.push([t('conn.serverZone'), utcOffsetText(terminal.serverUtcOffset)])
    }
    if (account !== null) rows.push([t('account.company'), account.company], [t('account.server'), account.server])
    if (status.syncedAt !== null) rows.push([t('conn.syncedAt'), formatTime(status.syncedAt)])
  }
  return <>
    <PhaseText t={t} status={status} />
    {listen !== null && status.phase === 'listening' && <p className="dshMkConnHint">
      {listen.host === '127.0.0.1' ? t('conn.loopbackOnly') : t('conn.hostHint', { addresses: listen.addresses.join(', ') || '—' })}
    </p>}
    <Rejection t={t} status={status} />
    {rows.length > 0 && <dl className="dshMkConnRows">
      {rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
    </dl>}
    <section className="dshMkConnTrading" aria-label={t('conn.trading')}>
      <h4>{t('conn.trading')}</h4>
      {connection.blocked.length === 0
        ? <p data-tone="ok">{t('account.tradingOk')}</p>
        : <ul>{connection.blocked.map(reason => <li key={reason}>{blockText(t, reason)}</li>)}</ul>}
    </section>
    {peer !== null && onResync !== undefined && <div className="dshMkConnActions">
      <button type="button" className="dshMkButton" disabled={resyncing || status.phase !== 'ready'} onClick={onResync}>
        {t(resyncing || status.phase === 'syncing' ? 'conn.resyncing' : 'conn.resync')}
      </button>
    </div>}
  </>
}

function PhaseText({ t, status }: { t: MarketT; status: Mt5Status }) {
  switch (status.phase) {
    case 'error': return <p data-tone="error">{t('conn.listenFailed', { message: status.error ?? '' })}</p>
    case 'listening': return <p>{t('conn.listeningOn', { address: status.listen === null ? '—' : `${status.listen.host}:${status.listen.port}` })}</p>
    case 'handshaking': return <p>{t('conn.handshakingHint')}</p>
    case 'syncing': return <p>{t('conn.syncingHint')}</p>
    case 'disabled':
    case 'ready': return null
  }
}

/** The last refused connection, while it may explain why no EA is in session or a second one is not. */
function Rejection({ t, status }: { t: MarketT; status: Mt5Status }) {
  const rejection = status.lastRejection
  if (rejection === null) return null
  if (status.peer !== null && rejection.at < status.peer.connectedAt) return null
  return <p className="dshMkConnHint" data-tone="warning">
    {t('conn.rejected', { address: rejection.address, reason: rejectText(t, rejection.reason), time: formatTime(rejection.at) })}
  </p>
}
