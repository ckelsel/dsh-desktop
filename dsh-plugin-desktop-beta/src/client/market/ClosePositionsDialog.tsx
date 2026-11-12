/**
 * Closing several positions at once, by symbol or all of them. The dialog first lists the positions
 * and their total floating profit; once confirmed it closes them at the market one by one and shows
 * each outcome. A refused close, such as one in a closed market, does not stop the rest; an
 * unconfirmed one does, so nothing more is sent before the trader has checked MT5. The parent mounts
 * the dialog for each use, so every use starts over.
 */
import { useState } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketSymbol } from './data/market-data.ts'
import type { Position, TradeResult, TradingProvider } from './data/trading.ts'
import { formatLots, formatSigned, trend } from './format.ts'
import { blockText, refusalText, sideLabel } from './labels.ts'
import type { MarketT } from './page-types.ts'

type RowState = 'waiting' | 'sending' | 'done' | 'failed' | 'unconfirmed' | 'skipped'
interface Row { state: RowState; text: string }

/** A row's outcome text, and whether the closing goes on after it. */
function outcome(t: MarketT, result: TradeResult): Row {
  switch (result.status) {
    case 'done':
    case 'placed': return { state: 'done', text: t('close.done') }
    case 'unconfirmed': return { state: 'unconfirmed', text: t('close.unconfirmed') }
    case 'rejected': return { state: 'failed', text: refusalText(t, result) }
    case 'blocked': return { state: 'failed', text: blockText(t, result.blocked ?? 'syncing') }
    case 'offline': return { state: 'failed', text: t('result.offline') }
  }
}

export function ClosePositionsDialog({ t, symbol, positions, trading, symbolOf, upColor, onClose }: {
  t: MarketT
  /** The symbol whose positions close; null for every position. */
  symbol: string | null
  /** The positions to close, as listed when the dialog opened. */
  positions: readonly Position[]
  trading: TradingProvider
  symbolOf(ticker: string): MarketSymbol | undefined
  /** The page's price colours, which the profits follow. */
  upColor: 'green' | 'red'
  onClose(): void
}) {
  const [rows, setRows] = useState<Readonly<Record<string, Row>>>({})
  const [phase, setPhase] = useState<'confirm' | 'running' | 'finished'>('confirm')
  const [stopped, setStopped] = useState(false)
  const set = (ticket: string, row: Row): void => { setRows(current => ({ ...current, [ticket]: row })) }

  const run = async (): Promise<void> => {
    setPhase('running')
    let halted = false
    for (const position of positions) {
      if (halted) { set(position.ticket, { state: 'skipped', text: t('close.skipped') }); continue }
      set(position.ticket, { state: 'sending', text: t('close.sending') })
      const result = await trading.closePosition(position.ticket).catch((error: unknown): TradeResult => ({
        status: 'rejected', retcode: null, code: null, message: error instanceof Error ? error.message : String(error),
        orderTicket: null, price: null, volume: null,
      }))
      const row = outcome(t, result)
      set(position.ticket, row)
      halted = row.state === 'unconfirmed'
    }
    setStopped(halted)
    setPhase('finished')
  }

  const close = (): void => { if (phase !== 'running') onClose() }
  const total = positions.reduce((sum, position) => sum + position.profit, 0)
  const done = Object.values(rows).filter(row => row.state === 'done').length
  const lots = (position: Position): string => {
    const info = symbolOf(position.ticker)
    return info === undefined ? String(position.lots) : formatLots(info, position.lots)
  }
  const footer = phase === 'confirm'
    ? <>
      <Button variant="ghost" size="sm" onClick={close}>{t('close.cancel')}</Button>
      <Button variant="primary" size="sm" onClick={() => { void run() }} data-modal-autofocus="">{t('close.start', { count: String(positions.length) })}</Button>
    </>
    : <Button variant="primary" size="sm" disabled={phase === 'running'} onClick={close}>{phase === 'running' ? t('close.running') : t('close.finish')}</Button>

  return <Modal open onClose={close} title={symbol === null ? t('close.titleAll') : t('close.titleSymbol', { symbol })} closeLabel={t('close.finish')}
    className="dshMkLayer dshMkCloseDialog" footer={footer}>
    <div data-up={upColor}>
    <p className="dshMkCloseIntro">{t('close.intro', { count: String(positions.length) })}</p>
    <div className="dshMkCloseList">
      <table className="dshMkTable" aria-label={symbol === null ? t('close.titleAll') : t('close.titleSymbol', { symbol })}>
        <thead><tr>
          <th scope="col">{t('col.symbol')}</th>
          <th scope="col">{t('col.ticket')}</th>
          <th scope="col">{t('col.side')}</th>
          <th scope="col" data-numeric="">{t('col.lots')}</th>
          <th scope="col" data-numeric="">{t('col.profit')}</th>
          <th scope="col">{t('col.state')}</th>
        </tr></thead>
        <tbody>
          {positions.map((position) => {
            const row = rows[position.ticket] ?? { state: 'waiting', text: t('close.waiting') }
            return <tr key={position.ticket}>
              <td><strong>{position.ticker}</strong></td>
              <td>{position.ticket}</td>
              <td><span data-side={position.side}>{sideLabel(t, position.side)}</span></td>
              <td data-numeric="">{lots(position)}</td>
              <td data-numeric=""><span data-trend={trend(position.profit)}>{formatSigned(position.profit, 2)}</span></td>
              <td><span className="dshMkCloseState" data-state={row.state}>{row.text}</span></td>
            </tr>
          })}
        </tbody>
      </table>
    </div>
    <p className="dshMkCloseTotal">
      <span>{t('close.total')}</span>
      <span data-trend={trend(total)}>{formatSigned(total, 2)}</span>
    </p>
    {phase === 'finished' && <p className="dshMkMessage" data-tone={stopped ? 'warning' : done === positions.length ? undefined : 'error'} role="status">
      {stopped ? t('close.stopped') : t('close.summary', { done: String(done), failed: String(positions.length - done) })}
    </p>}
    </div>
  </Modal>
}
