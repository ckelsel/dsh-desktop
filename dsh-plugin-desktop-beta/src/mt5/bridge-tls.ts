/**
 * The TLS identity of the MT5 bridge: a self-signed RSA 2048 certificate kept in its own
 * owner-only file beside the token. MetaTrader 5 accepts any certificate (it checks neither the
 * issuer, the name nor the dates), so TLS alone only encrypts. The EA authenticates the Desktop by
 * this certificate's SHA-1 fingerprint, which every handshake proof binds (`mt5/PROTOCOL.md`).
 */
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { join } from 'node:path'
import { generate } from 'selfsigned'
import { atomicJson, readPrivateFile } from '../private-files.ts'

export interface Mt5TlsIdentity {
  /** PEM certificate. */
  cert: string
  /** PEM private key. */
  key: string
  /** SHA-1 of the certificate, lowercase hex without separators: what the EA reads from the connection. */
  fingerprint: string
  /** Unix ms. */
  notAfter: number
}

export const mt5TlsPath = (home: string): string => join(home, 'mt5-bridge-tls.json')

const VALIDITY_DAYS = 3650
/** A certificate this close to its end is replaced. */
const RENEW_MS = 30 * 86_400_000
const COMMON_NAME = 'DSH Desktop MT5 bridge'

/** The fingerprint the EA sees: SHA-1, lowercase hex without colons. */
export const mt5Fingerprint = (x509: X509Certificate): string => x509.fingerprint.replaceAll(':', '').toLowerCase()

/**
 * Read the identity, or create it when the file is missing, damaged or about to expire.
 * @param path - Identity file.
 * @param now - Unix ms.
 * @returns the identity, and why a new one was made, if one was.
 */
export async function loadMt5TlsIdentity(path: string, now = Date.now()): Promise<{ identity: Mt5TlsIdentity; created?: string }> {
  const text = readPrivateFile(path, 64 * 1024)
  if (text === undefined) return { identity: await createMt5TlsIdentity(path, now), created: 'missing' }
  const identity = parseIdentity(text)
  if (identity === undefined) return { identity: await createMt5TlsIdentity(path, now), created: 'damaged' }
  if (identity.notAfter - RENEW_MS <= now) return { identity: await createMt5TlsIdentity(path, now), created: 'expiring' }
  return { identity }
}

/**
 * Make a new identity and save it.
 * @returns the identity.
 */
export async function createMt5TlsIdentity(path: string, now = Date.now()): Promise<Mt5TlsIdentity> {
  const notBeforeDate = new Date(now - 5 * 60_000)
  const generated = await generate([{ name: 'commonName', value: COMMON_NAME }], {
    algorithm: 'sha256',
    keyType: 'rsa',
    keySize: 2048,
    notBeforeDate,
    notAfterDate: new Date(notBeforeDate.getTime() + VALIDITY_DAYS * 86_400_000),
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true },
    ],
  })
  const identity = parseIdentity(JSON.stringify({ cert: generated.cert, key: generated.private }))
  if (identity === undefined) throw new Error('The generated MT5 bridge certificate does not match its key')
  atomicJson(path, { cert: identity.cert, key: identity.key })
  return identity
}

function parseIdentity(text: string): Mt5TlsIdentity | undefined {
  try {
    const { cert, key } = JSON.parse(text) as { cert?: unknown; key?: unknown }
    if (typeof cert !== 'string' || typeof key !== 'string') return undefined
    const x509 = new X509Certificate(cert)
    const privateKey = createPrivateKey(key)
    if (privateKey.asymmetricKeyType !== 'rsa' || !x509.checkPrivateKey(privateKey)) return undefined
    const notAfter = Date.parse(x509.validTo)
    if (!Number.isFinite(notAfter)) return undefined
    return { cert, key, fingerprint: mt5Fingerprint(x509), notAfter }
  } catch {
    return undefined
  }
}
