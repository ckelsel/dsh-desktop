/** MT5 bridge protocol 2: frame shapes, the handshake's proofs, the payloads the EA sends, and what the renderer may ask for. */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isMt5Hex32, mt5Nonce, mt5Proof, mt5ProofMatches, mt5RequestMac, mt5SignedPayload } from '../src/mt5/bridge-auth.ts'
import {
  Mt5ProtocolError, parseAccount, parseAuth, parseBars, parseFrame, parseGreeting, parseHistoryAnswer, parseOrders, parsePositions,
  parseSubscribeAnswer, parseSymbolInfo, parseSymbolsPage, parseTerminalStatus, parseTicks, parseTradeEvent, parseTradeHistory, parseTradeOutcome,
} from '../src/mt5/protocol.ts'
import {
  parseHistoryBarsInput, parseHistoryBarsOptions, parseHistoryRangeInput, parseSubscriptionInput, parseSymbolInput, parseTradeInput,
} from '../src/mt5/renderer-input.ts'
import {
  ACCOUNT, BAR, DEAL, DEPOSIT, EURUSD, HELLO, HISTORY_ORDER, ORDER, POSITION, SYMBOL_INFO, TERMINAL, TICK, US500, XAUUSD,
} from './mt5-fixtures.ts'

describe('parseFrame', () => {
  it('reads requests, events, and both kinds of responses', () => {
    expect(parseFrame('{"v":2,"id":"r1","type":"system.hello","payload":{"a":1}}')).toEqual({ kind: 'request', id: 'r1', type: 'system.hello', payload: { a: 1 } })
    expect(parseFrame('{"v":2,"type":"account.snapshot"}')).toEqual({ kind: 'event', type: 'account.snapshot', payload: {} })
    expect(parseFrame('{"v":2,"id":"r1","type":"response","ok":true}')).toEqual({ kind: 'response', id: 'r1', ok: true, payload: {} })
    expect(parseFrame('{"v":2,"id":"r1","type":"response","ok":false,"error":{"code":"timeout","message":"slow","retcode":10004}}'))
      .toEqual({ kind: 'response', id: 'r1', ok: false, error: { code: 'timeout', message: 'slow', retcode: 10004 } })
    // A failed response without a usable code still fails its request.
    expect(parseFrame('{"v":2,"id":"r1","type":"response","ok":false,"error":{}}')).toEqual({ kind: 'response', id: 'r1', ok: false, error: { code: 'unknown', message: '' } })
  })

  it.each([
    ['not JSON', '{"v":2,'],
    ['an array', '[1]'],
    ['protocol 1, as EAs older than 1.2.0 send', '{"v":1,"type":"system.ping"}'],
    ['no type', '{"v":2}'],
    ['a type without a namespace', '{"v":2,"type":"ping"}'],
    ['an uppercase type', '{"v":2,"type":"System.Ping"}'],
    ['an empty id', '{"v":2,"id":"","type":"system.ping"}'],
    ['a numeric id', '{"v":2,"id":7,"type":"system.ping"}'],
    ['a payload that is not an object', '{"v":2,"type":"system.ping","payload":[1]}'],
    ['a response without id', '{"v":2,"type":"response","ok":true}'],
    ['a response without ok', '{"v":2,"id":"r1","type":"response"}'],
    ['a failed response without error', '{"v":2,"id":"r1","type":"response","ok":false}'],
    ['a response payload that is not an object', '{"v":2,"id":"r1","type":"response","ok":true,"payload":"x"}'],
  ])('refuses %s', (_name, line) => {
    expect(() => parseFrame(line)).toThrow(Mt5ProtocolError)
  })
})

describe('handshake', () => {
  const NONCE = 'a'.repeat(64)

  it('reads the hello, leaving the nonce of another protocol unchecked', () => {
    expect(parseGreeting({ protocol: 2, nonce: NONCE })).toEqual({ protocol: 2, nonce: NONCE })
    expect(parseGreeting({ protocol: 1, token: 'x' })).toEqual({ protocol: 1, nonce: '' })
    expect(() => parseGreeting({ protocol: 2, nonce: NONCE.toUpperCase() })).toThrow('system.hello.nonce')
    expect(() => parseGreeting({ protocol: 2 })).toThrow('system.hello.nonce')
    expect(() => parseGreeting({ protocol: 1.5 })).toThrow('system.hello.protocol')
  })

  it('reads system.auth, accepting a numeric login', () => {
    const auth = { proof: 'b'.repeat(64), ...HELLO }
    expect(parseAuth(auth)).toEqual({
      proof: 'b'.repeat(64),
      hello: { eaVersion: '1.2.0', terminalBuild: 5120, terminalName: 'MetaTrader 5', login: '50123456', server: 'Example-Demo', instance: HELLO.instance },
    })
    expect(parseAuth({ ...auth, login: 50123456 }).hello.login).toBe('50123456')
    expect(() => parseAuth({ ...auth, login: '-1' })).toThrow('system.auth.login')
    expect(() => parseAuth({ ...auth, instance: 'not hex' })).toThrow('system.auth.instance')
    expect(() => parseAuth({ ...auth, proof: undefined })).toThrow('system.auth.proof')
  })

  it('computes HMAC-SHA256 as RFC 4231 specifies, and the proofs from it', () => {
    // RFC 4231 test case 2, through the same construction the proofs use.
    expect(createHmac('sha256', 'Jefe').update('what do ya want for nothing?').digest('hex')).toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
    const message = `dsh-mt5/2 desktop\n${NONCE}\n${'c'.repeat(64)}\n${'d'.repeat(40)}`
    expect(mt5Proof('token', 'desktop', NONCE, 'c'.repeat(64), 'd'.repeat(40))).toEqual(createHmac('sha256', 'token').update(message).digest())
    // Each label gives another value, so no proof stands in for another.
    const proofs = new Set((['desktop', 'ea', 'session'] as const).map(label => mt5Proof('token', label, NONCE, NONCE, 'f').toString('hex')))
    expect(proofs.size).toBe(3)
  })

  it('compares proofs in full and only as 32 bytes of lowercase hex', () => {
    const expected = mt5Proof('token', 'ea', NONCE, NONCE, 'f')
    expect(mt5ProofMatches(expected.toString('hex'), expected)).toBe(true)
    expect(mt5ProofMatches(expected.toString('hex').toUpperCase(), expected)).toBe(false)
    expect(mt5ProofMatches(`${expected.toString('hex').slice(0, 63)}0`, expected)).toBe(false)
    expect(mt5ProofMatches(expected.toString('hex').slice(0, 62), expected)).toBe(false)
    expect(mt5ProofMatches(undefined, expected)).toBe(false)
    expect(isMt5Hex32(mt5Nonce())).toBe(true)
    expect(mt5Nonce()).not.toBe(mt5Nonce())
  })

  it('signs the body text with the id and type, matching what the EA computed on the real terminal', () => {
    const key = mt5Proof('token', 'session', NONCE, NONCE, 'f')
    const signed = mt5SignedPayload(key, 'trade-1', 'order.place', { symbol: 'EURUSD', volume: 0.01 })
    expect(signed.body).toBe('{"symbol":"EURUSD","volume":0.01}')
    expect(signed.mac).toBe(mt5RequestMac(key, 'trade-1', 'order.place', signed.body).toString('hex'))
    expect(mt5RequestMac(key, 'trade-2', 'order.place', signed.body)).not.toEqual(mt5RequestMac(key, 'trade-1', 'order.place', signed.body))
    // The EA's HMAC of UTF-8 text with escapes, CJK and an astral character, from the TLS probe on build 6230.
    expect(createHmac('sha256', Buffer.from('令牌-€ "quoted"', 'utf8')).update('下单\nEURUSD\n{"a":1,"b":"\\u00e9"} ✓ 𝄞', 'utf8').digest('hex'))
      .toBe('bb9f2c9f0569fdd4f91e36188449284d49a57ca409904be0384680dd5ce9d273')
  })
})

describe('payloads', () => {

  it('reads the terminal status, with no ping while the terminal has none', () => {
    expect(parseTerminalStatus(TERMINAL)).toEqual({
      connected: true, tradeAllowed: true, eaTradeAllowed: true, build: 5120, name: 'MetaTrader 5', company: 'Example Ltd', pingMs: 23.5, serverUtcOffset: 7200,
    })
    expect(parseTerminalStatus({ ...TERMINAL, ping_ms: null }).pingMs).toBeNull()
    expect(() => parseTerminalStatus({ ...TERMINAL, terminal_connected: 1 })).toThrow('system.status.terminal_connected')
  })

  it('reads the account, with no margin level while no margin is in use', () => {
    expect(parseAccount(ACCOUNT)).toMatchObject({ login: '50123456', tradeMode: 'demo', marginMode: 'hedging', marginFree: 9_792.1, marginLevel: 4_542.88, marginCall: 100, stopOut: 50, marginSoMode: 'percent' })
    expect(parseAccount({ ...ACCOUNT, margin: 0, margin_level: 0 }).marginLevel).toBeNull()
    expect(() => parseAccount({ ...ACCOUNT, trade_mode: 'paper' })).toThrow('account.snapshot.trade_mode must be one of demo, contest, real')
    expect(() => parseAccount({ ...ACCOUNT, equity: Number.NaN })).toThrow('account.snapshot.equity')
    expect(() => parseAccount({ ...ACCOUNT, name: 'x'.repeat(1025) })).toThrow('account.snapshot.name')
  })
})

describe('stage 2 payloads', () => {
  it('reads a catalogue page, leaving out invalid symbols and keeping the Market Watch order', () => {
    const page = parseSymbolsPage({
      total: 5, watch: ['XAUUSD', 'EURUSD'],
      symbols: [EURUSD, { ...XAUUSD, tick_size: 0 }, { ...US500, digits: 11 }, { ...US500, name: '' }, 'US30'],
    })
    expect(page.total).toBe(5)
    expect(page.watch).toEqual(['XAUUSD', 'EURUSD'])
    expect(page.symbols.items).toHaveLength(2)
    expect(page.symbols.items[0]).toEqual({
      name: 'EURUSD', description: 'Euro vs US Dollar', path: 'Forex\\Majors\\EURUSD', currencyBase: 'EUR', currencyProfit: 'USD', currencyMargin: 'EUR',
      digits: 5, point: 0.00001, tickSize: 0.00001, contractSize: 100_000, volumeMin: 0.01, volumeMax: 100, volumeStep: 0.01,
      tradeMode: 'full', calcMode: 'forex', sector: 'currency', selected: true,
    })
    // A symbol without a tick size moves by points.
    expect(page.symbols.items[1]?.tickSize).toBe(0.01)
    expect(page.symbols).toMatchObject({ skipped: 3, firstError: expect.stringContaining('digits') })
    expect(parseSymbolsPage({ total: 1, symbols: [EURUSD] }).watch).toBeNull()
    expect(() => parseSymbolsPage({ total: 1, symbols: {} })).toThrow('symbols.list.symbols must be an array')
    expect(() => parseSymbolsPage({ total: -1, symbols: [] })).toThrow('symbols.list.total')
  })

  it('reads quotes, with the day figures empty until MT5 has them', () => {
    const ticks = parseTicks({ ticks: [TICK, { ...TICK, symbol: 'XAUUSD', day_open: null, day_high: null, day_low: null, prev_close: null, day_volume: null }, { ...TICK, bid: 'x' }] })
    expect(ticks.items[0]).toEqual({
      symbol: 'EURUSD', time: 1_762_000_200_000, bid: 1.07251, ask: 1.07253, dayOpen: 1.0701, dayHigh: 1.0731, dayLow: 1.0695,
      prevClose: 1.0702, dayVolume: 51_234, sessionOpen: true,
    })
    expect(ticks.items[1]).toMatchObject({ symbol: 'XAUUSD', dayOpen: null, prevClose: null, dayVolume: null })
    expect(ticks.skipped).toBe(1)
    expect(parseBars({ bars: [BAR, { ...BAR, timeframe: 'M2' }] })).toMatchObject({ items: [{ symbol: 'EURUSD', timeframe: 'M5', close: 1.07251, volume: 87 }], skipped: 1 })
  })

  it('reads history bars oldest first, leaving out invalid and out-of-order rows', () => {
    expect(parseHistoryAnswer({ pending: true })).toEqual({ pending: true })
    const answer = parseHistoryAnswer({ no_data: false, bars: [[1_000, 1, 2, 0.5, 1.5, 10], [2_000, 1.5, 2, 1, 1.8, 7], [2_000, 1, 1, 1, 1, 1], [3_000, 1, 'x', 1, 1, 1], [4_000, 1, 1, 1], [5_000, 1.8, 1.9, 1.7, 1.75, 3]] })
    expect(answer).toEqual({
      pending: false, noData: false, complete: true, skipped: 3,
      bars: [
        { time: 1_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
        { time: 2_000, open: 1.5, high: 2, low: 1, close: 1.8, volume: 7 },
        { time: 5_000, open: 1.8, high: 1.9, low: 1.7, close: 1.75, volume: 3 },
      ],
    })
    expect(parseHistoryAnswer({ bars: [], no_data: true })).toMatchObject({ pending: false, bars: [], noData: true })
    expect(() => parseHistoryAnswer({ bars: [] })).toThrow('market.history.no_data')
    // A partial answer says whether older bars of the page are still downloading.
    expect(parseHistoryAnswer({ bars: [], no_data: false, complete: false })).toMatchObject({ pending: false, complete: false })
    expect(() => parseHistoryAnswer({ bars: [], no_data: false, complete: 'no' })).toThrow('market.history.complete')
  })

  it('reads positions and pending orders', () => {
    expect(parsePositions({ positions: [POSITION] }).items).toEqual([{
      ticket: '1001', symbol: 'EURUSD', side: 'buy', volume: 0.1, priceOpen: 1.0712, sl: null, tp: 1.08, priceCurrent: 1.0725,
      profit: 13, swap: -0.5, time: 1_762_000_000_000, comment: '', magic: 0,
    }])
    expect(parsePositions({ positions: [{ ...POSITION, side: 'long' }] })).toMatchObject({ items: [], skipped: 1 })
    expect(parseOrders({ orders: [ORDER, { ...ORDER, type: 'buy' }] })).toMatchObject({
      items: [{ ticket: '2001', type: 'buy_limit', state: 'placed', volumeInitial: 0.05, price: 2300, stopLimit: null, sl: 2280, tp: null, timeType: 'gtc', expiration: null, comment: 'dip' }],
      // A market order still executing is not a pending order.
      skipped: 1,
    })
    expect(() => parsePositions({})).toThrow('positions.snapshot.positions must be an array')
  })

  it('reads history, with balance operations and no ticket for MT5\'s 0', () => {
    const history = parseTradeHistory({ orders: [HISTORY_ORDER], deals: [DEAL, DEPOSIT, { ...DEAL, entry: 'sideways' }], truncated: true })
    expect(history.truncated).toBe(true)
    expect(history.orders.items[0]).toMatchObject({ ticket: '3001', type: 'buy', state: 'filled', price: 1.0712, position: '1001', positionBy: null, timeDone: 1_761_990_000_120 })
    expect(history.deals.items).toEqual([
      expect.objectContaining({ ticket: '4001', order: '3001', position: '1001', type: 'buy', entry: 'in', commission: -0.35 }),
      expect.objectContaining({ ticket: '4000', order: null, position: null, symbol: '', type: 'balance', profit: 10_000, comment: 'Deposit' }),
    ])
    expect(history.deals.skipped).toBe(1)
    expect(parseTradeEvent({ type: 'deal_add', deal: '4002', order: '3002', position: '0', symbol: 'EURUSD' }))
      .toEqual({ type: 'deal_add', deal: '4002', order: '3002', position: null, symbol: 'EURUSD' })
    expect(parseSubscribeAnswer({ unknown: ['FOO'] })).toEqual(['FOO'])
  })
})

describe('trade payloads', () => {
  it('reads a trade result, with no ticket for MT5\'s 0 and nothing for what did not happen', () => {
    expect(parseTradeOutcome('id-1', { status: 'done', retcode: 10010, code: 'sent', message: 'partial', order: '3002', deal: '4002', price: 1.07255, volume: 0.02, duplicate: false }))
      .toEqual({ status: 'done', id: 'id-1', blocked: null, retcode: 10010, code: 'sent', message: 'partial', order: '3002', deal: '4002', price: 1.07255, volume: 0.02, duplicate: false })
    expect(parseTradeOutcome('id-2', { status: 'rejected', retcode: 0, code: 'invalid_volume', message: 'off the grid', order: null, deal: '0', price: null, volume: null, duplicate: true }))
      .toMatchObject({ status: 'rejected', order: null, deal: null, price: null, volume: null, duplicate: true })
    expect(() => parseTradeOutcome('id-3', { status: 'blocked', retcode: 0, code: 'x', message: '', duplicate: false })).toThrow('trade result.status')
    expect(() => parseTradeOutcome('id-4', { status: 'done', retcode: 10009, code: 'sent', message: '' })).toThrow('trade result.duplicate')
  })

  it('reads a symbol\'s trade rules', () => {
    expect(parseSymbolInfo(SYMBOL_INFO)).toEqual({
      symbol: 'EURUSD', digits: 5, point: 0.00001, tickSize: 0.00001, contractSize: 100000, volumeMin: 0.01, volumeMax: 500, volumeStep: 0.01,
      volumeLimit: 0, stopsLevel: 0, freezeLevel: 0, tradeMode: 'full', execution: 'market', orderModes: ['market', 'limit', 'stop', 'sl', 'tp'],
      marginBuy: 214.5, marginSell: 214.48, sessionOpen: true,
    })
    expect(parseSymbolInfo({ ...SYMBOL_INFO, margin_buy: null, trade_mode: 'close_only' })).toMatchObject({ marginBuy: null, tradeMode: 'close_only' })
    expect(() => parseSymbolInfo({ ...SYMBOL_INFO, order_modes: ['market', 'teleport'] })).toThrow('symbol.info.order_modes')
  })
})

describe('renderer input', () => {
  it('takes a subscription without duplicates and within the caps', () => {
    const quotes = Array.from({ length: 250 }, (_, index) => `S${String(index)}`)
    const bars = Array.from({ length: 30 }, (_, index) => ({ symbol: `S${String(index)}`, timeframe: 'M5' }))
    const subscription = parseSubscriptionInput({ quotes: ['EURUSD', 'EURUSD', ...quotes], bars: [{ symbol: 'EURUSD', timeframe: 'H1' }, { symbol: 'EURUSD', timeframe: 'H1' }, ...bars] })
    expect(subscription.quotes).toHaveLength(200)
    expect(subscription.quotes.slice(0, 2)).toEqual(['EURUSD', 'S0'])
    expect(subscription.bars).toHaveLength(20)
    expect(subscription.bars[0]).toEqual({ symbol: 'EURUSD', timeframe: 'H1' })
    expect(() => parseSubscriptionInput({ quotes: [''], bars: [] })).toThrow('invalid quote subscription')
    expect(() => parseSubscriptionInput({ quotes: [], bars: [{ symbol: 'EURUSD', timeframe: '5' }] })).toThrow('invalid bar subscription')
    expect(() => parseSubscriptionInput({ quotes: [] })).toThrow('invalid subscription')
  })

  it('takes history requests only with sane bounds', () => {
    expect(parseHistoryBarsInput({ symbol: 'EURUSD', timeframe: 'D1', to: 1_762_000_000_000, count: 300, extra: true }))
      .toEqual({ symbol: 'EURUSD', timeframe: 'D1', to: 1_762_000_000_000, count: 300 })
    expect(() => parseHistoryBarsInput({ symbol: 'EURUSD', timeframe: 'D1', to: 1, count: 5001 })).toThrow('invalid history bars request')
    expect(() => parseHistoryBarsInput({ symbol: 'EURUSD', timeframe: 'D1', to: 0, count: 1 })).toThrow('invalid history bars request')
    expect(parseHistoryBarsOptions(undefined)).toEqual({})
    expect(parseHistoryBarsOptions({ partial: true, extra: 1 })).toEqual({ partial: true })
    expect(() => parseHistoryBarsOptions({ partial: 'yes' })).toThrow('invalid history bars options')
    expect(() => parseHistoryBarsOptions(null)).toThrow('invalid history bars options')
    expect(parseHistoryRangeInput({ from: 0, to: 1 })).toEqual({ from: 0, to: 1 })
    expect(() => parseHistoryRangeInput({ from: 5, to: 5 })).toThrow('invalid history range')
  })

  it('takes trade requests only with the fields their type has, each in range', () => {
    const account = { login: '50123456', server: 'Example-Demo' }
    const market = { type: 'order.place', account, symbol: 'EURUSD', side: 'sell', orderType: 'market', volume: 0.01, price: null, sl: null, tp: 1.06 }
    expect(parseTradeInput({ ...market, extra: true, account: { ...account, name: 'x' } })).toEqual(market)
    expect(parseTradeInput({ ...market, orderType: 'limit', price: 1.09 })).toMatchObject({ orderType: 'limit', price: 1.09 })
    expect(parseTradeInput({ type: 'position.close', account, symbol: 'EURUSD', ticket: '1001', volume: 0.01, sl: 1 }))
      .toEqual({ type: 'position.close', account, symbol: 'EURUSD', ticket: '1001', volume: 0.01 })
    expect(parseTradeInput({ type: 'position.modify', account, symbol: 'EURUSD', ticket: '1001', sl: null, tp: null })).toMatchObject({ sl: null, tp: null })
    expect(parseTradeInput({ type: 'order.modify', account, symbol: 'EURUSD', ticket: '2001', price: 1.06, sl: null, tp: 1.1 })).toMatchObject({ price: 1.06 })
    expect(parseTradeInput({ type: 'order.cancel', account, symbol: 'EURUSD', ticket: '18446744073709551615' })).toMatchObject({ ticket: '18446744073709551615' })
    for (const value of [
      null, { ...market, type: 'order.delete' }, { ...market, side: 'long' }, { ...market, orderType: 'stop_limit', price: 1 },
      // A market order has no price, and a pending order needs one.
      { ...market, price: 1.07 }, { ...market, orderType: 'stop', price: null },
      { ...market, volume: 0 }, { ...market, volume: -0.01 }, { ...market, volume: Number.NaN }, { ...market, volume: '0.01' },
      { ...market, sl: 0 }, { ...market, tp: Number.POSITIVE_INFINITY }, { ...market, sl: undefined },
      { ...market, account: { login: 50123456, server: 'Example-Demo' } }, { ...market, account: { login: '50123456', server: '' } }, { ...market, account: undefined },
      { ...market, symbol: '' }, { ...market, symbol: 'S'.repeat(129) },
      { type: 'position.close', account, symbol: 'EURUSD', ticket: 1001, volume: 0.01 },
      { type: 'position.close', account, symbol: 'EURUSD', ticket: '0', volume: 0.01 },
      { type: 'position.close', account, symbol: 'EURUSD', ticket: '1001' },
      { type: 'order.modify', account, symbol: 'EURUSD', ticket: '2001', price: null, sl: null, tp: null },
      { type: 'order.cancel', account, symbol: 'EURUSD', ticket: '-5' },
    ]) expect(() => parseTradeInput(value)).toThrow('invalid trade request')
    expect(parseSymbolInput('XAUUSD')).toBe('XAUUSD')
    expect(() => parseSymbolInput(7)).toThrow('invalid symbol')
  })
})
