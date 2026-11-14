/**
 * The gateway runtime against a live MT5Bridge gateway and a terminal. Skipped unless
 * `MT5_GATEWAY_LIVE=1`: the gateway must listen on 18860 and the terminal's BridgeService must
 * run with the symbol.get build (the order-modes and margin fields). The quotes come from the
 * terminal's snapshot when the market is closed; live ticks need market hours — or a 1:1
 * strategy-tester replay of BridgeTesterEA, which stands in for the market on a weekend:
 *
 *   MT5_GATEWAY_LIVE=1 yarn vitest run tests/mt5-gateway-live.spec.ts                # real terminal
 *   MT5_GATEWAY_LIVE=1 MT5_GATEWAY_TERMINAL=tester yarn vitest run ...               # replay agent
 *
 * The tester variant prefers the replay agent, follows its tick feed, and expects history bars
 * from the tester's own series — which the replay engine serves even while the real terminal's
 * HistoryCenter is stuck.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Mt5GatewayRuntime } from '../src/mt5/gateway-runtime.ts'
import { MT5_DISCLAIMER_VERSION, type Mt5DataEvent, type Mt5Status } from '../src/mt5/contract.ts'

const live = process.env.MT5_GATEWAY_LIVE === '1' ? describe : describe.skip
const replay = process.env.MT5_GATEWAY_TERMINAL === 'tester'

const waitFor = async <T>(read: () => T, ok: (value: T) => boolean, ms: number): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (ok(value)) return value
    if (Date.now() > end) return value
    await new Promise(resolve => { setTimeout(resolve, 250) })
  }
}

live('the live gateway', () => {
  let runtime: Mt5GatewayRuntime
  const data: Mt5DataEvent[] = []

  beforeAll(() => {
    runtime = new Mt5GatewayRuntime({
      terminal: replay ? 'tester' : 'real',
      log: (event, fields, level) => { console.log(`[mt5] ${level} ${event} ${JSON.stringify(fields ?? {})}`) },
    })
    runtime.subscribeData(event => { data.push(event) })
    return () => { void runtime.stop() }
  }, 30_000)

  it('reaches ready on the real terminal', { retry: 1, timeout: 60_000 }, async () => {
    await runtime.configure({ mt5Enabled: true, mt5DisclaimerVersion: MT5_DISCLAIMER_VERSION, mt5DisclaimerAcceptedAt: 1 }, { safeMode: false })
    const status: Mt5Status = await waitFor(() => runtime.status(), value => value.phase === 'ready', 45_000)
    expect(status.phase).toBe('ready')
    expect(status.account?.login ?? '').toMatch(/^\d+$/u)
    expect(runtime.catalog()?.symbols.length ?? 0).toBeGreaterThan(0)
  })

  it('reads a symbol with the trading-rule fields', async () => {
    const info = await runtime.symbolInfo('EURUSD')
    expect(info).toMatchObject({ symbol: 'EURUSD', digits: 5, contractSize: 100_000 })
    expect(info.orderModes).toContain('market')
  }, 30_000)

  it('subscribes quotes and bars, seeding one quote even with the market closed', { timeout: 60_000 }, async () => {
    runtime.setSubscription({ quotes: ['EURUSD'], bars: [{ symbol: 'EURUSD', timeframe: 'M1' }] })
    await vi.waitFor(() => {
      expect(data.some(event => event.kind === 'ticks' && event.ticks.some(tick => tick.symbol === 'EURUSD' && tick.bid > 0))).toBe(true)
    }, { timeout: 20_000 })
    // A 1:1 replay pushes its own tick feed on top of the seeded quote.
    if (replay) {
      await vi.waitFor(() => {
        expect(data.some(event => event.kind === 'ticks' && event.ticks.some(tick => tick.symbol === 'EURUSD' && tick.time > 0))).toBe(true)
      }, { timeout: 30_000 })
    }
    // The bars wait while the real terminal's HistoryCenter catches up. A weekend-blocked
    // terminal (a stuck `history download 0 %` in its journal) keeps answering CopyRates 4401
    // for every symbol and period — an environment condition, not a code path; the replay
    // agent serves its series from the tester engine and has no such stall.
    const history = await runtime.historyBars({ symbol: 'EURUSD', timeframe: 'M1', to: Date.now(), count: 5 })
    expect(history.bars.length).toBeGreaterThan(0)
    expect(history.bars).toEqual(expect.arrayContaining([expect.objectContaining({ open: expect.any(Number) })]))
  })
})
