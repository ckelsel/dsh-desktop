/**
 * Trading lines on the chart: a line at each position's open price, at its take-profit and
 * stop-loss levels, and at each pending order's price — only for the chart's own symbol. The lines
 * are chart drawings, so the library places them and the user drags them with its native grip; a
 * poll notices when a dragged price settles and sends it to the trading provider, snapping the
 * line back when the request is refused. Closing and cancelling stay in the trading panel below
 * the chart. (The library's own position and order line APIs are gated to its Trading Platform
 * edition, which is why these are plain drawings.)
 */
import type { PendingOrder, Position, TradeResult, TradingProvider } from '../data/trading.ts'
import type { MarketDataProvider } from '../data/market-data.ts'
import { orderKind, resultNotice, sideLabel } from '../labels.ts'
import type { MarketT, Notify } from '../page-types.ts'
import { tickerOf } from './datafeed.ts'
import type { TvChart, TvEntityId, TvLineDataSource } from './tv-types.ts'

/** The chart's own blue, and the candle palette the exits reuse. */
const BLUE = '#2962FF'
const GREEN = '#089981'
const RED = '#F23645'
/** `LineToolSolid`; exits keep the dashed default to tell levels from entries. */
const SOLID = 0
const DASHED = 2

/** How often a dragged line's price is read. */
const POLL_MS = 300

/** Prices within this gap count as the same level. */
const SAME_PRICE = 1e-9

/** What a line is: a position's open price, one of its exits, or a pending order's price. */
type LineKind = 'position' | 'takeProfit' | 'stopLoss' | 'order'

/** The drags a kind takes: entries cannot move, exits set one bracket, orders reprice. */
const DRAGGABLE: ReadonlySet<LineKind> = new Set(['takeProfit', 'stopLoss', 'order'])

interface LineEntry {
  entityId: TvEntityId
  shape: TvLineDataSource
  /** The price the provider last confirmed; a refused drag snaps back to it. */
  price: number
  /** A drag request is in flight: snapshot updates and the poll leave the line alone. */
  busy: boolean
  /** A price that differs from the confirmed one, waiting to hold steady before it is sent. */
  settling: number | null
}

export interface TradeLinesProps {
  positions: readonly Position[]
  orders: readonly PendingOrder[]
  trading: Pick<TradingProvider, 'modifyPosition' | 'modifyOrder'>
  market: Pick<MarketDataProvider, 'symbol'>
  t: MarketT
  notify: Notify
}

export interface TradeLinesHandle {
  /** Add, remove and re-label the lines for an account snapshot. */
  update(positions: readonly Position[], orders: readonly PendingOrder[]): void
  dispose(): void
}

/** A drawing's look. Both key spellings go in: the library takes the one it knows. */
function lineOverrides(color: string, style: number): Record<string, string | number> {
  return { strokeColor: color, linecolor: color, lineWidth: 1, linewidth: 1, lineStyle: style, linestyle: style }
}

export function installTradeLines(options: TradeLinesProps & { chart: TvChart }): TradeLinesHandle {
  const { chart, trading, market, t, notify } = options
  const entries = new Map<string, LineEntry>()
  /** Keys whose drawing is still being created, so one snapshot cannot start a second one. */
  const creating = new Set<string>()
  let disposed = false
  let latest: { positions: readonly Position[]; orders: readonly PendingOrder[] } | null = null

  const key = (kind: LineKind, ticket: string): string => `${kind}:${ticket}`
  const kindOf = (id: string): { kind: LineKind; ticket: string } | null => {
    const [kind, ticket] = id.split(':')
    return kind !== undefined && ticket !== undefined && (DRAGGABLE.has(kind as LineKind) || kind === 'position')
      ? { kind: kind as LineKind, ticket }
      : null
  }
  const findPosition = (ticket: string): Position | undefined =>
    latest?.positions.find(item => item.ticket === ticket)
  const findOrder = (ticket: string): PendingOrder | undefined =>
    latest?.orders.find(item => item.ticket === ticket)

  /** Snap a dragged price to the symbol's tick, the finest change the terminal accepts. */
  const snapped = (ticker: string, price: number): number => {
    const tick = market.symbol(ticker)?.tickSize
    return tick === undefined || tick <= 0 ? price : Math.round(price / tick) * tick
  }

  /**
   * Send a settled drag. A refused or lost request snaps the line back to its confirmed price; an
   * accepted one keeps it, and the next snapshot confirms or corrects it.
   */
  const commit = (entry: LineEntry, request: () => Promise<TradeResult>, requested: number): void => {
    entry.busy = true
    entry.settling = null
    void request().then(result => {
      const accepted = result.status === 'done' || result.status === 'placed' || result.status === 'unconfirmed'
      if (accepted) entry.price = requested
      else entry.shape.setPoints([{ price: entry.price }])
      const notice = resultNotice(t, result, 'modify')
      notify(notice.text, notice.tone)
    }).catch(() => {
      entry.shape.setPoints([{ price: entry.price }])
      notify(t('line.requestFailed'), 'error')
    }).finally(() => { entry.busy = false })
  }

  /** What a settled price means depends on the line it settled on. */
  const commitSettled = (id: string, entry: LineEntry, requested: number): void => {
    const line = kindOf(id)
    if (line === null) { entry.settling = null; return }
    if (line.kind === 'order') {
      const order = findOrder(line.ticket)
      if (order === undefined) { entry.settling = null; return }
      const price = snapped(order.ticker, requested)
      commit(entry, () => trading.modifyOrder(line.ticket, { price, takeProfit: order.takeProfit, stopLoss: order.stopLoss }), price)
      return
    }
    const position = findPosition(line.ticket)
    if (position === undefined) { entry.settling = null; return }
    const level = snapped(position.ticker, requested)
    commit(entry, () => trading.modifyPosition(line.ticket, {
      takeProfit: line.kind === 'takeProfit' ? level : position.takeProfit,
      stopLoss: line.kind === 'stopLoss' ? level : position.stopLoss,
    }), level)
  }

  // The library offers no drag callback, so a poll reads each line's price; one that holds steady
  // for two reads is a dropped grip, not a drag in progress.
  const poll = window.setInterval(() => {
    if (disposed) return
    for (const [id, entry] of entries) {
      if (entry.busy) continue
      const price = entry.shape.getPoints()[0]?.price
      if (typeof price !== 'number' || Math.abs(price - entry.price) <= SAME_PRICE) { entry.settling = null; continue }
      if (entry.settling !== null && Math.abs(price - entry.settling) <= SAME_PRICE) commitSettled(id, entry, entry.settling)
      else entry.settling = price
    }
  }, POLL_MS)

  /** Place a line unless it exists or is being created; the label says what the level is. */
  const add = (kind: LineKind, ticket: string, label: { price: number; text: string; color: string; style: number }): void => {
    const id = key(kind, ticket)
    if (entries.has(id) || creating.has(id)) return
    creating.add(id)
    void chart.createShape({ price: label.price }, {
      shape: 'horizontal_line',
      text: label.text,
      // An entry's price cannot change, so its line holds still instead of being dragged.
      lock: kind === 'position',
      disableSelection: true,
      disableSave: true,
      disableUndo: true,
      overrides: lineOverrides(label.color, label.style),
    }).then(entityId => {
      creating.delete(id)
      if (disposed) { chart.removeEntity(entityId); return }
      entries.set(id, { entityId, shape: chart.getShapeById(entityId), price: label.price, busy: false, settling: null })
    })
  }

  /** Bring the lines to the last snapshot: drop what closed, re-place what moved, add what is new. */
  const sync = (): void => {
    if (disposed || latest === null) return
    const ticker = tickerOf(chart.symbol())
    const wanted = new Map<string, { price: number; text: string; color: string; style: number }>()
    for (const position of latest.positions) {
      if (position.ticker !== ticker) continue
      wanted.set(key('position', position.ticket), {
        price: position.openPrice,
        text: `${sideLabel(t, position.side)} ${position.lots}`,
        color: position.side === 'buy' ? BLUE : RED, style: SOLID,
      })
      if (position.takeProfit !== null) wanted.set(key('takeProfit', position.ticket), {
        price: position.takeProfit, text: `${t('line.takeProfit')} ${position.lots}`, color: GREEN, style: DASHED,
      })
      if (position.stopLoss !== null) wanted.set(key('stopLoss', position.ticket), {
        price: position.stopLoss, text: `${t('line.stopLoss')} ${position.lots}`, color: RED, style: DASHED,
      })
    }
    for (const order of latest.orders) {
      if (order.ticker !== ticker) continue
      wanted.set(key('order', order.ticket), {
        price: order.price,
        text: `${orderKind(t, order.side, order.type)} ${order.lots}`,
        color: order.side === 'buy' ? BLUE : RED, style: DASHED,
      })
    }
    for (const [id, entry] of entries) {
      const line = wanted.get(id)
      if (line === undefined) {
        entries.delete(id)
        chart.removeEntity(entry.entityId)
        continue
      }
      // A dragged line keeps its place until its request replies.
      if (entry.busy || entry.settling !== null) continue
      const drawn = entry.shape.getPoints()[0]?.price
      if (Math.abs(entry.price - line.price) > SAME_PRICE || drawn === undefined || Math.abs(drawn - line.price) > SAME_PRICE) {
        entry.price = line.price
        entry.shape.setPoints([{ price: line.price }])
      }
    }
    for (const [id, line] of wanted) {
      const info = kindOf(id)
      if (info === null) continue
      add(info.kind, info.ticket, line)
    }
  }

  return {
    update(positions, orders): void {
      if (disposed) return
      latest = { positions, orders }
      sync()
    },
    dispose(): void {
      disposed = true
      latest = null
      window.clearInterval(poll)
      entries.clear()
    },
  }
}
