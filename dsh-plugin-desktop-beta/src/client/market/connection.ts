/** How the market page names the account's connection: the badge text key and tone, and time zones. */
import type { TradingConnection } from './data/trading.ts'

/** Colour of the badge: demo data, idle, in progress, in sync, needs attention, failed. */
export type ConnectionTone = 'mock' | 'idle' | 'busy' | 'ok' | 'warning' | 'error'

type BadgeKey = 'account.mock' | 'conn.waiting' | 'conn.error' | 'conn.listening' | 'conn.handshaking' | 'conn.syncing' | 'conn.ready'
  | 'conn.brokerLost' | 'conn.eaOutdated'

/** The badge's label key and tone for a connection. */
export function connectionBadge(connection: TradingConnection): { key: BadgeKey; tone: ConnectionTone } {
  const status = connection.mt5
  if (connection.source === 'mock') return { key: 'account.mock', tone: 'mock' }
  if (status === null) return { key: 'conn.waiting', tone: 'busy' }
  switch (status.phase) {
    // The demo account stands in while the bridge is off, so an MT5 connection is never disabled.
    case 'disabled': return { key: 'account.mock', tone: 'mock' }
    case 'error': return { key: 'conn.error', tone: 'error' }
    case 'listening': return { key: 'conn.listening', tone: 'idle' }
    case 'handshaking': return { key: 'conn.handshaking', tone: 'busy' }
    case 'syncing': return { key: 'conn.syncing', tone: 'busy' }
    case 'ready':
      if (status.eaOutdated) return { key: 'conn.eaOutdated', tone: 'warning' }
      return status.terminal?.connected === false ? { key: 'conn.brokerLost', tone: 'warning' } : { key: 'conn.ready', tone: 'ok' }
  }
}

/** `UTC+3`, `UTC+5:30`, `UTC−4` for an offset in seconds. */
export function utcOffsetText(seconds: number): string {
  const minutes = Math.round(Math.abs(seconds) / 60)
  const sign = seconds < 0 ? '−' : '+'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return `UTC${sign}${hours}${rest === 0 ? '' : `:${String(rest).padStart(2, '0')}`}`
}
