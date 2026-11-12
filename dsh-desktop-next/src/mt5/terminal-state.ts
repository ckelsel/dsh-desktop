/**
 * The MT5 bridge's trading gate. A connection alone never opens it: the account state must be in
 * sync, the terminal connected to its trade server, every permission MT5 reports granted, and the
 * trading risk disclaimer agreed to. Real-money accounts trade like demo accounts once it is.
 */
import type { Mt5Account, Mt5BlockReason, Mt5BridgePhase, Mt5TerminalStatus } from './contract.ts'

/** The bridge's own progress, before the terminal's state is known. */
export interface Mt5PhaseInput {
  enabled: boolean
  /** Why listening failed, if it did. */
  error: string | null
  listening: boolean
  /** The connection furthest along: none, unauthenticated, authenticated but syncing, or in sync. */
  session: 'none' | 'handshaking' | 'syncing' | 'ready'
}

export function bridgePhase(input: Mt5PhaseInput): Mt5BridgePhase {
  if (!input.enabled) return 'disabled'
  if (input.error !== null) return 'error'
  if (!input.listening) return 'listening'
  return input.session === 'none' ? 'listening' : input.session
}

export interface Mt5GateInput {
  phase: Mt5BridgePhase
  terminal: Mt5TerminalStatus | null
  account: Mt5Account | null
  /** The user agreed to the current trading risk disclaimer. */
  disclaimerAccepted: boolean
}

/**
 * Why new trades are refused right now.
 * @returns the reasons in reporting order; empty when new trades may be sent.
 */
export function blockReasons(input: Mt5GateInput): Mt5BlockReason[] {
  switch (input.phase) {
    case 'disabled': return ['bridge-disabled']
    case 'error': return ['bridge-error']
    case 'listening':
    case 'handshaking': return ['ea-disconnected']
    case 'syncing': return ['syncing']
    case 'ready': break
  }
  const { terminal, account } = input
  if (terminal === null || account === null) return ['syncing']
  const reasons: Mt5BlockReason[] = []
  if (!terminal.connected) reasons.push('broker-disconnected')
  if (!terminal.tradeAllowed) reasons.push('terminal-trade-disabled')
  if (!terminal.eaTradeAllowed) reasons.push('ea-trade-disabled')
  if (!account.tradeAllowed) reasons.push('account-trade-disabled')
  if (!account.tradeExpert) reasons.push('account-expert-disabled')
  if (!input.disclaimerAccepted) reasons.push('disclaimer')
  return reasons
}
