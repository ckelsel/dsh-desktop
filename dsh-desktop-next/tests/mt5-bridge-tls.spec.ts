/** The MT5 bridge certificate: made once, kept owner-only, and replaced when damaged or about to expire. */
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createMt5TlsIdentity, loadMt5TlsIdentity, mt5TlsPath } from '../src/mt5/bridge-tls.ts'

const DAY = 86_400_000
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'dsh-mt5-tls-spec-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

it('makes a self-signed RSA 2048 certificate once, owner-only, and reports the SHA-1 the EA reads', async () => {
  const path = mt5TlsPath(directory)
  const first = await loadMt5TlsIdentity(path)
  expect(first.created).toBe('missing')
  const x509 = new X509Certificate(first.identity.cert)
  expect(x509.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048)
  expect(x509.issuer).toBe(x509.subject)
  expect(first.identity.fingerprint).toMatch(/^[0-9a-f]{40}$/u)
  expect(first.identity.fingerprint).toBe(x509.fingerprint.replaceAll(':', '').toLowerCase())
  expect(first.identity.notAfter - Date.now()).toBeGreaterThan(3_600 * DAY)
  if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(await loadMt5TlsIdentity(path)).toEqual({ identity: first.identity })
})

it('replaces a damaged file, a key that belongs to another certificate, and a certificate about to expire', async () => {
  const path = mt5TlsPath(directory)
  writeFileSync(path, '{ not json', { mode: 0o600 })
  const repaired = await loadMt5TlsIdentity(path)
  expect(repaired.created).toBe('damaged')
  const other = await createMt5TlsIdentity(join(directory, 'other.json'))
  writeFileSync(path, JSON.stringify({ cert: repaired.identity.cert, key: other.key }), { mode: 0o600 })
  const rekeyed = await loadMt5TlsIdentity(path)
  expect(rekeyed.created).toBe('damaged')
  expect(rekeyed.identity.fingerprint).not.toBe(repaired.identity.fingerprint)
  const renewed = await loadMt5TlsIdentity(path, rekeyed.identity.notAfter - 10 * DAY)
  expect(renewed.created).toBe('expiring')
  expect(renewed.identity.fingerprint).not.toBe(rekeyed.identity.fingerprint)
})
