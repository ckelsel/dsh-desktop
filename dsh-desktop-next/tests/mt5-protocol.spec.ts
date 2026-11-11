/** MT5 bridge protocol v1: frame shapes and the payloads the EA sends. */
import { describe, expect, it } from 'vitest'
import { Mt5ProtocolError, parseAccount, parseFrame, parseHello, parseTerminalStatus } from '../src/mt5/protocol.ts'
import { ACCOUNT, HELLO, TERMINAL, TOKEN } from './mt5-fixtures.ts'

describe('parseFrame', () => {
  it('reads requests, events, and both kinds of responses', () => {
    expect(parseFrame('{"v":1,"id":"r1","type":"system.hello","payload":{"a":1}}')).toEqual({ kind: 'request', id: 'r1', type: 'system.hello', payload: { a: 1 } })
    expect(parseFrame('{"v":1,"type":"account.snapshot"}')).toEqual({ kind: 'event', type: 'account.snapshot', payload: {} })
    expect(parseFrame('{"v":1,"id":"r1","type":"response","ok":true}')).toEqual({ kind: 'response', id: 'r1', ok: true, payload: {} })
    expect(parseFrame('{"v":1,"id":"r1","type":"response","ok":false,"error":{"code":"timeout","message":"slow","retcode":10004}}'))
      .toEqual({ kind: 'response', id: 'r1', ok: false, error: { code: 'timeout', message: 'slow', retcode: 10004 } })
    // A failed response without a usable code still fails its request.
    expect(parseFrame('{"v":1,"id":"r1","type":"response","ok":false,"error":{}}')).toEqual({ kind: 'response', id: 'r1', ok: false, error: { code: 'unknown', message: '' } })
  })

  it.each([
    ['not JSON', '{"v":1,'],
    ['an array', '[1]'],
    ['another version', '{"v":2,"type":"system.ping"}'],
    ['no type', '{"v":1}'],
    ['a type without a namespace', '{"v":1,"type":"ping"}'],
    ['an uppercase type', '{"v":1,"type":"System.Ping"}'],
    ['an empty id', '{"v":1,"id":"","type":"system.ping"}'],
    ['a numeric id', '{"v":1,"id":7,"type":"system.ping"}'],
    ['a payload that is not an object', '{"v":1,"type":"system.ping","payload":[1]}'],
    ['a response without id', '{"v":1,"type":"response","ok":true}'],
    ['a response without ok', '{"v":1,"id":"r1","type":"response"}'],
    ['a failed response without error', '{"v":1,"id":"r1","type":"response","ok":false}'],
    ['a response payload that is not an object', '{"v":1,"id":"r1","type":"response","ok":true,"payload":"x"}'],
  ])('refuses %s', (_name, line) => {
    expect(() => parseFrame(line)).toThrow(Mt5ProtocolError)
  })
})

describe('payloads', () => {
  it('reads the hello, accepting a numeric login', () => {
    expect(parseHello(HELLO)).toEqual({ token: TOKEN, protocol: 1, eaVersion: '1.0.0', terminalBuild: 5120, terminalName: 'MetaTrader 5', login: '50123456', server: 'Example-Demo' })
    expect(parseHello({ ...HELLO, login: 50123456 }).login).toBe('50123456')
    expect(() => parseHello({ ...HELLO, login: '-1' })).toThrow('system.hello.login')
    expect(() => parseHello({ ...HELLO, protocol: 1.5 })).toThrow('system.hello.protocol')
    expect(() => parseHello({ ...HELLO, token: undefined })).toThrow('system.hello.token')
  })

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
