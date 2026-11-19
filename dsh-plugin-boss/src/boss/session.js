/**
 * Credential store: the single source of truth for the replayed session.
 *
 * Sources, in adoption order:
 * 1. `webview` — desktop login panel harvests `document.cookie` from the
 *    embedded BOSS page (M3; everything __zp_stoken__ needs is non-HttpOnly).
 * 2. `manual` — user pastes a raw cookie header or a browser "Copy as cURL"
 *    blob (works everywhere, including the web build; mirrors boss-agent-cli's
 *    curl-file path).
 *
 * Storage is a plain JSON file under the configured data dir. Single-user
 * local machine assumption, same as both references; document.lock-file-free
 * writes rely on the plugin fiber being single-threaded per host.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Cookies both references treat as load-bearing for the wapi. */
export const REQUIRED_COOKIES = Object.freeze(['wt2', '__zp_stoken__'])

const CREDENTIAL_FILE = 'credential.json'

/**
 * @param {string} header "k=v; k2=v2" (segments without '=' are dropped)
 * @returns {Record<string, string>}
 */
export function parseCookieHeader(header) {
  /** @type {Record<string, string>} */
  const cookies = {}
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name) cookies[name] = value
  }
  return cookies
}

/**
 * Parse a "Copy as cURL" blob for its cookie and user-agent headers.
 * Accepts both `-H 'cookie: ...'` and `--cookie '...'` spellings; single or
 * double quoted.
 * @param {string} curl
 * @returns {{cookies: Record<string, string>, userAgent?: string}}
 */
export function parseCurl(curl) {
  /** @type {Record<string, string>} */
  const cookies = {}
  let userAgent
  const headerRe = /(?:-H|--header)\s+(['"])(.*?)\1/gis
  const cookieFlagRe = /(?:--cookie|-b)\s+(['"])(.*?)\1/gis
  let match
  while ((match = headerRe.exec(curl)) !== null) {
    const raw = match[2]
    const colon = raw.indexOf(':')
    if (colon <= 0) continue
    const name = raw.slice(0, colon).trim().toLowerCase()
    const value = raw.slice(colon + 1).trim()
    if (name === 'cookie') Object.assign(cookies, parseCookieHeader(value))
    if (name === 'user-agent') userAgent = value
  }
  while ((match = cookieFlagRe.exec(curl)) !== null) {
    Object.assign(cookies, parseCookieHeader(match[2]))
  }
  return { cookies, userAgent }
}

export class BossSession {
  /** @type {{reason: string, at: string} | null} set when the platform rejected the stored __zp_stoken__ (code 37). */
  #stokenStale = null

  /**
   * @param {string} dataDir directory for credential.json (created on save)
   */
  constructor(dataDir) {
    this.file = join(dataDir, CREDENTIAL_FILE)
    /** @type {{cookies: Record<string, string>, userAgent?: string, savedAt: string, source: 'webview' | 'manual'} | null} */
    this.credential = null
    this.#load()
  }

  #load() {
    try {
      this.credential = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      this.credential = null
    }
  }

  /** @returns {Record<string, string>} current cookie map (empty when logged out) */
  cookies() {
    return this.credential?.cookies ?? {}
  }

  /** @returns {string | undefined} stored UA, if the source carried one */
  userAgent() {
    return this.credential?.userAgent
  }

  /**
   * @returns {{loggedIn: boolean, count: number, source?: string, savedAt?: string, age?: string, missing: string[], stokenStale?: {reason: string, at: string}}}
   */
  status() {
    if (!this.credential) return { loggedIn: false, count: 0, missing: [...REQUIRED_COOKIES] }
    const have = this.credential.cookies
    const missing = REQUIRED_COOKIES.filter((name) => !have[name])
    return {
      loggedIn: missing.length === 0,
      count: Object.keys(have).length,
      source: this.credential.source,
      savedAt: this.credential.savedAt,
      age: ageDescription(this.credential.savedAt),
      missing,
      ...(this.#stokenStale ? { stokenStale: this.#stokenStale } : {}),
    }
  }

  /**
   * Merge a freshly harvested/pasted cookie header into the store.
   * @param {string} header
   * @param {{source?: 'webview' | 'manual', userAgent?: string}} [meta]
   */
  importHeader(header, meta = {}) {
    const incoming = parseCookieHeader(header)
    return this.#commit(incoming, meta)
  }

  /**
   * Import from a "Copy as cURL" blob.
   * @param {string} curl
   */
  importCurl(curl) {
    const { cookies, userAgent } = parseCurl(curl)
    return this.#commit(cookies, { source: 'manual', userAgent })
  }

  /**
   * @param {Record<string, string>} cookies
   * @param {{source?: 'webview' | 'manual', userAgent?: string}} [meta]
   */
  #commit(cookies, meta = {}) {
    const merged = { ...this.credential?.cookies, ...cookies }
    for (const [name, value] of Object.entries(merged)) {
      if (value === '' || value === undefined) delete merged[name]
    }
    const missing = REQUIRED_COOKIES.filter((name) => !merged[name])
    this.credential = {
      cookies: merged,
      userAgent: meta.userAgent ?? this.credential?.userAgent,
      savedAt: new Date().toISOString(),
      source: meta.source ?? 'manual',
    }
    this.#stokenStale = null
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.credential, null, 2))
    return { ok: missing.length === 0, missing }
  }

  /** Drop the stored session (boss_logout). */
  clear() {
    this.credential = null
    this.#stokenStale = null
    if (existsSync(this.file)) rmSync(this.file)
  }

  /**
   * Flag the stored __zp_stoken__ as rejected by the platform (code 37) so the
   * client panel refreshes it from the webview without user action.
   * @param {string} reason
   */
  markStokenStale(reason) {
    this.#stokenStale = { reason: String(reason), at: new Date().toISOString() }
  }
}

/**
 * Human-readable age of an ISO timestamp.
 * @param {string} iso
 */
function ageDescription(iso) {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return '未知'
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 1) return `${Math.max(0, Math.floor(ms / 60_000))} 分钟前`
  if (hours < 48) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
