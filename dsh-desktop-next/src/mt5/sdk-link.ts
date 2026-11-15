/**
 * The MT5 bridge in process: the Desktop runs the mt5bridge SDK itself, and the terminal's DLL
 * dials the Desktop directly on the terminal face (18850) — no external gateway process and no
 * SDK face, one hop less than the gateway mode. The link keeps `Mt5GatewayLink`'s shape, so the
 * runtime above it does not change: a terminal table (the SDK's probed accounts), JSON-RPC calls
 * routed by `params.terminal_id`, and the terminal events with their session seq.
 *
 * The port is the deployment's single-host rule: exactly one process may serve a terminal face
 * per machine, so the legacy gateway script must not run beside the Desktop. A busy port is not
 * fatal here — the link retries with the growing pause of the socket link it replaces, which
 * also covers the window while an old gateway process is being shut down.
 */
import { Mt5Bridge, Mt5Error, type RawTerminalEvent } from 'mt5bridge'
import { Mt5RequestError } from './bridge-server.ts'
import type { GatewayEvent, GatewayTerminal } from './gateway-link.ts'

/** Where the terminal face listens, unless the deployment says otherwise. */
export const MT5_SDK_PORT = 18850

const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 15_000

/** The SDK's numeric error codes as the runtime's string codes, which its failures branch on. */
const ERROR_CODES: Readonly<Record<number, string>> = {
  [-32001]: 'not_connected',
  [-32003]: 'timeout',
  [-32010]: 'not_connected',
}

export interface Mt5SdkLinkOptions {
  /** The terminal face port; 18850 by the single-host rule. */
  port?: number
  /** Diagnostic log; never throws. */
  log?: (event: string, fields?: Record<string, string | number | boolean | null>, level?: 'debug' | 'info' | 'warn' | 'error') => void
}

export class Mt5SdkLink {
  private readonly log: NonNullable<Mt5SdkLinkOptions['log']>
  private bridge: Mt5Bridge | null = null
  private retryTimer: NodeJS.Timeout | undefined
  private attempts = 0
  private stopped = true

  constructor(private readonly options: Mt5SdkLinkOptions = {}) {
    this.log = options.log ?? (() => {})
  }

  /** The terminal face port being served, for the status the page shows. */
  get port(): number {
    return this.bridge?.port ?? this.options.port ?? MT5_SDK_PORT
  }

  /** Start serving the terminal face, and keep retrying while the port is busy. */
  open(): void {
    if (!this.stopped || this.bridge !== null) return
    this.stopped = false
    void this.serve()
  }

  /** Stop for good; the terminal table empties and pending requests fail. */
  close(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    const bridge = this.bridge
    this.bridge = null
    if (bridge !== null) void bridge.stop()
  }

  /** The SDK's accounts: terminals that answered the probe, the gateway's table minus its dead. */
  snapshot(): readonly GatewayTerminal[] {
    const bridge = this.bridge
    if (bridge === null) return []
    return bridge.getAccounts().map(account => ({
      terminal_id: account.id,
      role: 'SERVICE',
      components: new Map<string, { symbol: string | null }>(),
    }))
  }

  onTerminals(listener: (terminals: readonly GatewayTerminal[]) => void): () => void {
    this.terminalsListeners.add(listener)
    return () => { this.terminalsListeners.delete(listener) }
  }

  onEvent(listener: (event: GatewayEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => { this.eventListeners.delete(listener) }
  }

  /** `true` while the terminal face is being served. */
  onConnection(listener: (up: boolean) => void): () => void {
    this.connectionListeners.add(listener)
    return () => { this.connectionListeners.delete(listener) }
  }

  /**
   * A request to a terminal through the SDK.
   * @throws Mt5RequestError when no terminal answers it, or no answer comes in time.
   */
  async call(method: string, params: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    const bridge = this.bridge
    if (bridge === null) throw new Mt5RequestError('not_connected', 'The SDK bridge is not running')
    const { terminal_id: terminalId, ...rest } = params
    try {
      return await bridge.call(method, rest, typeof terminalId === 'string' ? terminalId : undefined, options.timeoutMs) as Record<string, unknown>
    } catch (error) {
      if (error instanceof Mt5Error) throw new Mt5RequestError(ERROR_CODES[error.code] ?? error.label, error.message)
      throw error
    }
  }

  private readonly terminalsListeners = new Set<(terminals: readonly GatewayTerminal[]) => void>()
  private readonly eventListeners = new Set<(event: GatewayEvent) => void>()
  private readonly connectionListeners = new Set<(up: boolean) => void>()

  private async serve(): Promise<void> {
    try {
      const bridge = await Mt5Bridge.start({ port: this.options.port ?? MT5_SDK_PORT })
      if (this.stopped || this.bridge !== null) {
        void bridge.stop()
        return
      }
      this.attempts = 0
      this.bridge = bridge
      bridge.onAccounts(() => { this.terminalsChanged() })
      bridge.onRawEvent(event => this.fanOut(event))
      this.log('mt5.sdk-up', { port: bridge.port })
      for (const listener of [...this.connectionListeners]) listener(true)
      this.terminalsChanged()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      this.log('mt5.sdk-start-failed', { detail, attempt: this.attempts }, 'warn')
      if (this.stopped) return
      const pause = Math.min(RETRY_MIN_MS * 2 ** this.attempts, RETRY_MAX_MS)
      this.attempts++
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined
        void this.serve()
      }, pause)
      this.retryTimer.unref?.()
    }
  }

  private terminalsChanged(): void {
    const terminals = this.snapshot()
    for (const listener of [...this.terminalsListeners]) listener(terminals)
  }

  private fanOut(raw: RawTerminalEvent): void {
    const event: GatewayEvent = {
      method: raw.method,
      params: raw.params,
      terminalId: raw.terminalId,
      seq: raw.seq ?? null,
    }
    for (const listener of [...this.eventListeners]) listener(event)
  }
}
