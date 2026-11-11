/** The EA address allowlist as typed in Settings. */
import { expect, it } from 'vitest'
import { formatAddressList, isIPv4Address, parseAddressList } from '../src/mt5/addresses.ts'

it('accepts dotted IPv4 literals only', () => {
  for (const address of ['10.0.0.13', '0.0.0.0', '255.255.255.255', '192.168.1.1']) expect(isIPv4Address(address)).toBe(true)
  for (const address of ['10.0.0', '10.0.0.256', '010.0.0.1', '10.0.0.1/24', '::1', 'localhost', ' 10.0.0.1', '1.2.3.4.5']) expect(isIPv4Address(address)).toBe(false)
})

it('splits on commas, semicolons and whitespace, including full-width ones, keeping the first of each address', () => {
  expect(parseAddressList('10.0.0.13，10.0.0.14；10.0.0.15\n10.0.0.13  10.0.0.16')).toEqual({ addresses: ['10.0.0.13', '10.0.0.14', '10.0.0.15', '10.0.0.16'], invalid: [] })
  expect(parseAddressList(' , ;')).toEqual({ addresses: [], invalid: [] })
  expect(parseAddressList('10.0.0.13, mt5-host')).toEqual({ addresses: ['10.0.0.13'], invalid: ['mt5-host'] })
  expect(formatAddressList(['10.0.0.13', '10.0.0.14'])).toBe('10.0.0.13, 10.0.0.14')
})
