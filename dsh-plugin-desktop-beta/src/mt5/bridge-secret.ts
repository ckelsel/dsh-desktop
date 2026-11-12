/**
 * The MT5 bridge token: the secret the EA and the Desktop prove to each other, never sent. It lives in its own
 * owner-only file beside the Desktop preferences, never in the preferences or the general renderer
 * state; the settings page reads it through a dedicated IPC call.
 */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { atomicJson, readPrivateFile } from '../private-files.ts'

const TOKEN = /^[A-Za-z0-9_-]{32,128}$/u

export const mt5SecretPath = (home: string): string => join(home, 'mt5-bridge.json')

/** 32 random bytes, base64url: 43 characters an EA input field holds. */
export const createMt5Token = (): string => randomBytes(32).toString('base64url')

/**
 * Read the token, creating it on first use.
 * @param path - Secret file.
 * @returns the token.
 */
export function readMt5Token(path: string): string {
  const text = readPrivateFile(path, 4096)
  if (text !== undefined) {
    try {
      const token = (JSON.parse(text) as { token?: unknown }).token
      if (typeof token === 'string' && TOKEN.test(token)) return token
    } catch { /* A damaged file is replaced below. */ }
  }
  return writeMt5Token(path)
}

/**
 * Replace the token; EAs holding the old one must be given the new one.
 * @returns the new token.
 */
export function writeMt5Token(path: string): string {
  const token = createMt5Token()
  atomicJson(path, { token })
  return token
}
