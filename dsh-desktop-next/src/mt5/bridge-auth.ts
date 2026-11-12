/**
 * The proofs and signatures of protocol 2 (`mt5/PROTOCOL.md`). The bridge token never crosses the
 * wire: it is the HMAC-SHA256 key of each side's proof, and each proof binds both sides' nonces and
 * the fingerprint of the Desktop certificate the EA saw. A man in the middle shows the EA another
 * certificate, so the real Desktop's proof cannot convince the EA. The session key, derived the same
 * way, signs every trade request.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export type Mt5ProofLabel = 'desktop' | 'ea' | 'session'

const HEX_32 = /^[0-9a-f]{64}$/u

/** 32 random bytes as lowercase hex. */
export const mt5Nonce = (): string => randomBytes(32).toString('hex')

/** A nonce, proof or MAC: 32 bytes as lowercase hex. */
export const isMt5Hex32 = (value: unknown): value is string => typeof value === 'string' && HEX_32.test(value)

/** HMAC-SHA256 under the token of `dsh-mt5/2 <label>`, the EA nonce, the Desktop nonce and the fingerprint, one per line. */
export function mt5Proof(token: string, label: Mt5ProofLabel, eaNonce: string, desktopNonce: string, fingerprint: string): Buffer {
  return createHmac('sha256', Buffer.from(token, 'utf8')).update(`dsh-mt5/2 ${label}\n${eaNonce}\n${desktopNonce}\n${fingerprint}`, 'utf8').digest()
}

/** Whether a received hex proof or MAC equals the expected bytes, compared in constant time. */
export function mt5ProofMatches(received: unknown, expected: Buffer): boolean {
  return isMt5Hex32(received) && expected.length === 32 && timingSafeEqual(Buffer.from(received, 'hex'), expected)
}

/** MAC of a signed request: HMAC-SHA256 under the session key of its id, type and body text, one per line. */
export function mt5RequestMac(sessionKey: Buffer, id: string, type: string, body: string): Buffer {
  return createHmac('sha256', sessionKey).update(`${id}\n${type}\n${body}`, 'utf8').digest()
}

/** The payload of a signed request: the body as JSON text, so the EA checks the very bytes it parses, and their MAC. */
export function mt5SignedPayload(sessionKey: Buffer, id: string, type: string, body: Record<string, unknown>): { body: string; mac: string } {
  const text = JSON.stringify(body)
  return { body: text, mac: mt5RequestMac(sessionKey, id, type, text).toString('hex') }
}
