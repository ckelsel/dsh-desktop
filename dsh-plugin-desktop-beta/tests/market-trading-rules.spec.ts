import { describe, expect, it } from 'vitest'
import { closeLotsValid, stopsDistanceError, tradeModeError, type TradeResult, type TradeRules } from '../src/client/market/data/trading.ts'
import { refusalText, resultNotice } from '../src/client/market/labels.ts'
import { en, zh } from '../src/client/market/locales.ts'
import type { MarketT } from '../src/client/market/page-types.ts'

/** A translator over one of the page's dictionaries, filling `{name}` placeholders. */
const translator = (dictionary: Readonly<Record<string, string>>): MarketT => (key, params) =>
  (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (whole, name: string) => params?.[name] === undefined ? whole : String(params[name]))
const t = translator(en)

const RULES: TradeRules = {
  stopsDistance: 0.0005, tradeMode: 'full', orderTypes: ['market', 'limit', 'stop'], marginPerLot: { buy: null, sell: null },
}
const NO_STOPS = { stopLoss: null, takeProfit: null }
const RESULT: TradeResult = { status: 'done', retcode: 10009, code: 'sent', message: '', orderTicket: '3002', price: 1.07255, volume: 0.1 }

describe('trade rules', () => {
  it('refuses the sides and order types a symbol\'s trade mode excludes', () => {
    expect(tradeModeError(RULES, 'sell', 'stop')).toBeNull()
    expect(tradeModeError({ ...RULES, tradeMode: 'disabled' }, 'buy', 'market')).toBe('tradeDisabled')
    expect(tradeModeError({ ...RULES, tradeMode: 'close_only' }, 'buy', 'market')).toBe('closeOnly')
    expect(tradeModeError({ ...RULES, tradeMode: 'long_only' }, 'buy', 'limit')).toBeNull()
    expect(tradeModeError({ ...RULES, tradeMode: 'long_only' }, 'sell', 'market')).toBe('longOnly')
    expect(tradeModeError({ ...RULES, tradeMode: 'short_only' }, 'sell', 'market')).toBeNull()
    expect(tradeModeError({ ...RULES, tradeMode: 'short_only' }, 'buy', 'stop')).toBe('shortOnly')
    expect(tradeModeError({ ...RULES, orderTypes: ['market'] }, 'buy', 'limit')).toBe('orderType')
  })

  it('keeps pending prices and stops the stops level away, measured from where MQL5 measures them', () => {
    // A market buy fills at the ask (1.1002) and its stops are measured from the bid it closes at (1.1000).
    expect(stopsDistanceError(RULES, 'market', 1.1002, 1.1000, { stopLoss: 1.0995, takeProfit: 1.1005 })).toBeNull()
    expect(stopsDistanceError(RULES, 'market', 1.1002, 1.1000, { stopLoss: 1.0996, takeProfit: null })).toBe('stopsDistance')
    expect(stopsDistanceError(RULES, 'market', 1.1002, 1.1000, { stopLoss: null, takeProfit: 1.1004 })).toBe('stopsDistance')
    // A buy limit is measured from the ask, and its stops from its own price.
    expect(stopsDistanceError(RULES, 'limit', 1.1002, 1.0997, NO_STOPS)).toBeNull()
    expect(stopsDistanceError(RULES, 'limit', 1.1002, 1.0998, NO_STOPS)).toBe('pendingDistance')
    expect(stopsDistanceError(RULES, 'stop', 1.1002, 1.1010, { stopLoss: 1.1006, takeProfit: null })).toBe('stopsDistance')
    expect(stopsDistanceError(RULES, 'stop', 1.1002, 1.1010, { stopLoss: 1.1005, takeProfit: 1.1015 })).toBeNull()
    // A stops level of 0 leaves the distance to the server.
    expect(stopsDistanceError({ ...RULES, stopsDistance: 0 }, 'limit', 1.1002, 1.1002, { stopLoss: 1.1002, takeProfit: null })).toBeNull()
  })

  it('closes the whole position, or a part on the lot step that leaves at least the minimum', () => {
    const symbol = { minLots: 0.01, lotStep: 0.01 }
    expect(closeLotsValid(symbol, 0.03, 0.03)).toBe(true)
    expect(closeLotsValid(symbol, 0.03, 0.01)).toBe(true)
    expect(closeLotsValid(symbol, 0.03, 0.02)).toBe(true)
    expect(closeLotsValid(symbol, 0.03, 0.025)).toBe(false)
    expect(closeLotsValid(symbol, 0.03, 0.04)).toBe(false)
    expect(closeLotsValid(symbol, 0.03, 0)).toBe(false)
    expect(closeLotsValid(symbol, 0.03, Number.NaN)).toBe(false)
    expect(closeLotsValid({ minLots: 0.1, lotStep: 0.1 }, 0.15, 0.1)).toBe(false)
    // An odd remainder below the step still closes whole.
    expect(closeLotsValid({ minLots: 0.1, lotStep: 0.1 }, 0.15, 0.15)).toBe(true)
  })
})

describe('trade notices', () => {
  it('names a refusal by the EA\'s reason, else MT5\'s return code, else MT5\'s comment', () => {
    expect(refusalText(t, { code: 'busy', retcode: null, message: '' })).toBe(en['code.busy'])
    expect(refusalText(t, { code: 'sent', retcode: 10018, message: 'Market closed' })).toBe(`${en['retcode.10018']} (10018)`)
    expect(refusalText(t, { code: 'sent', retcode: 10099, message: 'Broker says no' })).toBe('Broker says no (10099)')
    expect(refusalText(t, { code: 'sent', retcode: 10099, message: '' })).toBe('10099')
    expect(refusalText(t, { code: 'odd', retcode: null, message: 'MT5 bridge: invalid trade request' })).toBe('MT5 bridge: invalid trade request')
    expect(refusalText(t, { code: 'odd', retcode: null, message: '' })).toBe('odd')
  })

  it('tells what a request did, formatting a fill and warning of a partial one', () => {
    const format = { price: (value: number) => value.toFixed(5), lots: (value: number) => value.toFixed(2) }
    expect(resultNotice(t, RESULT, 'order', format)).toEqual({ text: 'Filled 0.10 lots at 1.07255, order #3002', tone: 'success' })
    expect(resultNotice(t, { ...RESULT, retcode: 10010, volume: 0.04 }, 'order', format))
      .toEqual({ text: 'Partly filled: 0.04 lots at 1.07255, order #3002', tone: 'warning' })
    expect(resultNotice(t, { ...RESULT, price: null, volume: null })).toEqual({ text: 'Filled #3002', tone: 'success' })
    expect(resultNotice(t, RESULT, 'close')).toEqual({ text: en['result.closed'], tone: 'success' })
    expect(resultNotice(t, RESULT, 'modify')).toEqual({ text: en['result.modified'], tone: 'success' })
    expect(resultNotice(t, RESULT, 'cancel')).toEqual({ text: en['result.cancelled'], tone: 'success' })
    expect(resultNotice(t, { ...RESULT, status: 'placed', orderTicket: '2009' })).toEqual({ text: 'Order placed #2009', tone: 'success' })
    expect(resultNotice(t, { ...RESULT, status: 'unconfirmed' })).toEqual({ text: en['result.unconfirmed'], tone: 'warning' })
    expect(resultNotice(t, { ...RESULT, status: 'rejected', code: 'no_position', retcode: null }))
      .toEqual({ text: `Rejected: ${en['code.no_position']}`, tone: 'error' })
    expect(resultNotice(t, { ...RESULT, status: 'blocked', blocked: 'disclaimer' }))
      .toEqual({ text: en['result.blocked'].replace('{reason}', en['block.disclaimer']), tone: 'warning' })
  })

  it('gives every Chinese string an English one with the same placeholders', () => {
    const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]!).sort()
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    const mismatched = Object.keys(zh).filter(key => placeholders(zh[key as keyof typeof zh]).join() !== placeholders(en[key as keyof typeof zh]).join())
    expect(mismatched).toEqual([])
  })
})
