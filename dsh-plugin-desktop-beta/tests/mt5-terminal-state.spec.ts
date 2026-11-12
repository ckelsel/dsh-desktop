/** The MT5 bridge phase and trading gate. */
import { describe, expect, it } from 'vitest'
import type { Mt5Account, Mt5TerminalStatus } from '../src/mt5/contract.ts'
import { parseAccount, parseTerminalStatus } from '../src/mt5/protocol.ts'
import { blockReasons, bridgePhase } from '../src/mt5/terminal-state.ts'
import { ACCOUNT, TERMINAL } from './mt5-fixtures.ts'

const terminal = (overrides: Partial<Mt5TerminalStatus> = {}): Mt5TerminalStatus => ({ ...parseTerminalStatus(TERMINAL), ...overrides })
const account = (overrides: Partial<Mt5Account> = {}): Mt5Account => ({ ...parseAccount(ACCOUNT), ...overrides })

describe('bridgePhase', () => {
  it('ranks off, a listen failure, and the furthest connection', () => {
    expect(bridgePhase({ enabled: false, error: 'EADDRINUSE', listening: true, session: 'ready' })).toBe('disabled')
    expect(bridgePhase({ enabled: true, error: 'EADDRINUSE', listening: false, session: 'none' })).toBe('error')
    expect(bridgePhase({ enabled: true, error: null, listening: false, session: 'none' })).toBe('listening')
    expect(bridgePhase({ enabled: true, error: null, listening: true, session: 'none' })).toBe('listening')
    expect(bridgePhase({ enabled: true, error: null, listening: true, session: 'handshaking' })).toBe('handshaking')
    expect(bridgePhase({ enabled: true, error: null, listening: true, session: 'syncing' })).toBe('syncing')
    expect(bridgePhase({ enabled: true, error: null, listening: true, session: 'ready' })).toBe('ready')
  })
})

describe('blockReasons', () => {
  const ready = { phase: 'ready' as const, terminal: terminal(), account: account(), disclaimerAccepted: true }

  it('opens only for a synced, connected, fully permitted account, once the disclaimer is agreed to', () => {
    expect(blockReasons(ready)).toEqual([])
  })

  it.each([
    ['disabled', ['bridge-disabled']],
    ['error', ['bridge-error']],
    ['listening', ['ea-disconnected']],
    ['handshaking', ['ea-disconnected']],
    ['syncing', ['syncing']],
  ] as const)('stays closed while the bridge is %s', (phase, reasons) => {
    expect(blockReasons({ ...ready, phase })).toEqual(reasons)
  })

  it('stays closed while a ready session lacks its state', () => {
    expect(blockReasons({ ...ready, terminal: null })).toEqual(['syncing'])
    expect(blockReasons({ ...ready, account: null })).toEqual(['syncing'])
  })

  it('reports each terminal and account refusal, in order', () => {
    expect(blockReasons({ ...ready, terminal: terminal({ connected: false }) })).toEqual(['broker-disconnected'])
    expect(blockReasons({ ...ready, terminal: terminal({ tradeAllowed: false }) })).toEqual(['terminal-trade-disabled'])
    expect(blockReasons({ ...ready, terminal: terminal({ eaTradeAllowed: false }) })).toEqual(['ea-trade-disabled'])
    expect(blockReasons({ ...ready, account: account({ tradeAllowed: false }) })).toEqual(['account-trade-disabled'])
    expect(blockReasons({ ...ready, account: account({ tradeExpert: false }) })).toEqual(['account-expert-disabled'])
    expect(blockReasons({
      ...ready,
      terminal: terminal({ connected: false, tradeAllowed: false, eaTradeAllowed: false }),
      account: account({ tradeAllowed: false, tradeExpert: false }),
      disclaimerAccepted: false,
    })).toEqual(['broker-disconnected', 'terminal-trade-disabled', 'ea-trade-disabled', 'account-trade-disabled', 'account-expert-disabled', 'disclaimer'])
  })

  it('needs the disclaimer agreed to on every account, and then trades real-money accounts like the rest', () => {
    for (const tradeMode of ['demo', 'contest', 'real'] as const) {
      expect(blockReasons({ ...ready, account: account({ tradeMode }), disclaimerAccepted: false })).toEqual(['disclaimer'])
      expect(blockReasons({ ...ready, account: account({ tradeMode }) })).toEqual([])
    }
  })

  it('reports no disclaimer before the session is ready', () => {
    expect(blockReasons({ ...ready, phase: 'listening', disclaimerAccepted: false })).toEqual(['ea-disconnected'])
  })
})
