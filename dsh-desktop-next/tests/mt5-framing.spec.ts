/** MT5 bridge framing: lines split and joined across TCP reads, and the frame size limit. */
import { describe, expect, it } from 'vitest'
import { encodeLine, Mt5FrameTooLargeError, Mt5LineDecoder } from '../src/mt5/framing.ts'

const bytes = (text: string): Buffer => Buffer.from(text, 'utf8')

describe('Mt5LineDecoder', () => {
  it('joins a line split across reads and returns every line a read completes', () => {
    const decoder = new Mt5LineDecoder()
    expect(decoder.push(bytes('{"a":'))).toEqual([])
    expect(decoder.pending).toBe(5)
    expect(decoder.push(bytes('1}\n{"b":2}\n{"c"'))).toEqual(['{"a":1}', '{"b":2}'])
    expect(decoder.push(bytes(':3}\n'))).toEqual(['{"c":3}'])
    expect(decoder.pending).toBe(0)
  })

  it('decodes a UTF-8 character split between reads once its line completes', () => {
    const decoder = new Mt5LineDecoder()
    const line = bytes('{"name":"演示账户"}\n')
    // Cut inside the three bytes of 演.
    const cut = line.indexOf(0xe6) + 1
    expect(decoder.push(line.subarray(0, cut))).toEqual([])
    expect(decoder.push(line.subarray(cut))).toEqual(['{"name":"演示账户"}'])
  })

  it('strips CRLF endings and skips blank lines', () => {
    const decoder = new Mt5LineDecoder()
    expect(decoder.push(bytes('\n\r\n  \n{"a":1}\r\n'))).toEqual(['{"a":1}'])
  })

  it('owns buffered bytes, so a reused read buffer cannot corrupt them', () => {
    const decoder = new Mt5LineDecoder()
    const chunk = bytes('{"a"')
    decoder.push(chunk)
    chunk.fill(0x20)
    expect(decoder.push(bytes(':1}\n'))).toEqual(['{"a":1}'])
  })

  it('refuses a line longer than the limit, whether or not its newline arrived', () => {
    expect(() => new Mt5LineDecoder(8).push(bytes('123456789'))).toThrow(Mt5FrameTooLargeError)
    expect(() => new Mt5LineDecoder(8).push(bytes('123456789\n'))).toThrow(Mt5FrameTooLargeError)
    const decoder = new Mt5LineDecoder(8)
    decoder.push(bytes('12345'))
    expect(() => decoder.push(bytes('6789\n'))).toThrow(Mt5FrameTooLargeError)
    expect(new Mt5LineDecoder(8).push(bytes('12345678\n'))).toEqual(['12345678'])
  })
})

it('encodes a frame as one UTF-8 JSON line', () => {
  const line = encodeLine({ v: 1, type: 'system.ping', payload: { note: '账户' } })
  expect(line.toString('utf8')).toBe('{"v":1,"type":"system.ping","payload":{"note":"账户"}}\n')
  expect(new Mt5LineDecoder().push(line)).toEqual(['{"v":1,"type":"system.ping","payload":{"note":"账户"}}'])
})
