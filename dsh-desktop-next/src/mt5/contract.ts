/**
 * What the MT5 bridge shares with the preload and the market page: IPC channel names and the
 * public bridge status. Types and constants only, so renderer bundles import it without Node.
 * The wire protocol itself is specified in `mt5/PROTOCOL.md` at the repository root.
 */

/** IPC channels between the main process bridge and the application renderer. */
export const MT5_IPC = {
  status: 'dsh-mt5:status',
  statusChanged: 'dsh-mt5:status-changed',
  resync: 'dsh-mt5:resync',
  request: 'dsh-mt5:request',
  token: 'dsh-mt5:token',
  regenerateToken: 'dsh-mt5:regenerate-token',
} as const

/** TCP port the bridge listens on unless the user picks another. */
export const MT5_DEFAULT_PORT = 19500

/**
 * Where the bridge stands:
 * - `disabled`: turned off in settings, or Safe Mode.
 * - `error`: it could not listen, for example because the port is taken.
 * - `listening`: waiting for the EA.
 * - `handshaking`: an EA connected and has not authenticated yet.
 * - `syncing`: the EA authenticated; the account state is being read.
 * - `ready`: the account state is in sync.
 */
export type Mt5BridgePhase = 'disabled' | 'error' | 'listening' | 'handshaking' | 'syncing' | 'ready'

/**
 * Why new trades are refused, in the order the UI reports them:
 * - `bridge-disabled`, `bridge-error`, `ea-disconnected`, `syncing`: the bridge is not ready.
 * - `broker-disconnected`: the terminal lost its trade server.
 * - `terminal-trade-disabled`: the terminal's Algo Trading button is off.
 * - `ea-trade-disabled`: the EA's own "Allow Algo Trading" option is off.
 * - `account-trade-disabled`: the account cannot trade, for example with the investor password.
 * - `account-expert-disabled`: the broker forbids Expert Advisors on this account.
 * - `real-account-locked`: a real-money account, which this build does not trade.
 */
export type Mt5BlockReason =
  | 'bridge-disabled' | 'bridge-error' | 'ea-disconnected' | 'syncing'
  | 'broker-disconnected' | 'terminal-trade-disabled' | 'ea-trade-disabled'
  | 'account-trade-disabled' | 'account-expert-disabled' | 'real-account-locked'

/** Why the bridge turned a connection away. */
export type Mt5RejectReason = 'address' | 'token' | 'protocol' | 'busy' | 'handshake-timeout' | 'invalid'

/** The EA session in use. */
export interface Mt5Peer {
  address: string
  port: number
  eaVersion: string
  /** Unix ms. */
  connectedAt: number
}

/** Terminal side of `system.status`. */
export interface Mt5TerminalStatus {
  /** Connected to the broker's trade server (`TERMINAL_CONNECTED`). */
  connected: boolean
  /** The terminal's Algo Trading button (`TERMINAL_TRADE_ALLOWED`). */
  tradeAllowed: boolean
  /** The EA's own permission (`MQL_TRADE_ALLOWED`). */
  eaTradeAllowed: boolean
  build: number
  name: string
  company: string
  /** Last ping to the trade server; null when the terminal has none. */
  pingMs: number | null
  /** Trade server time minus UTC, in seconds. */
  serverUtcOffset: number
}

/** `account.snapshot`, money in the account currency. */
export interface Mt5Account {
  login: string
  name: string
  server: string
  /** The broker. */
  company: string
  currency: string
  currencyDigits: number
  leverage: number
  tradeMode: 'demo' | 'contest' | 'real'
  /** `exchange` nets positions like `netting`, under exchange rules. */
  marginMode: 'netting' | 'exchange' | 'hedging'
  /** `ACCOUNT_TRADE_ALLOWED`. */
  tradeAllowed: boolean
  /** `ACCOUNT_TRADE_EXPERT`. */
  tradeExpert: boolean
  /** Pending order limit; 0 means none. */
  limitOrders: number
  balance: number
  credit: number
  profit: number
  equity: number
  margin: number
  marginFree: number
  /** Percent; null while no margin is in use. */
  marginLevel: number | null
  /** Margin call and stop out levels, in `marginSoMode` units. */
  marginCall: number
  stopOut: number
  marginSoMode: 'percent' | 'money'
}

/** Public bridge status: everything except the token. */
export interface Mt5Status {
  phase: Mt5BridgePhase
  /** Where the bridge listens and the LAN addresses an EA may use; null while it does not listen. */
  listen: { host: string; port: number; addresses: readonly string[] } | null
  /** Why listening failed, in phase `error`. */
  error: string | null
  peer: Mt5Peer | null
  terminal: Mt5TerminalStatus | null
  account: Mt5Account | null
  /** Empty when new trades may be sent. */
  blocked: readonly Mt5BlockReason[]
  /** When the last full sync finished (Unix ms). */
  syncedAt: number | null
  /** The last connection the bridge turned away, for setup diagnostics. */
  lastRejection: { address: string; reason: Mt5RejectReason; at: number } | null
}

/** The renderer API the preload exposes as `window.dshMt5`. */
export interface Mt5RendererBridge {
  status(): Promise<Mt5Status>
  /** @returns the unsubscribe function. */
  onStatus(listener: (status: Mt5Status) => void): () => void
  resync(): Promise<void>
  request(type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>>
  token(): Promise<string>
  regenerateToken(): Promise<string>
}
