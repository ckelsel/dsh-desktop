/**
 * Greet/apply deduplication ledger (boss-agent-cli's SQLite greet_records /
 * apply_records, JSON edition). One record per account fingerprint + job +
 * securityId, so a repeated action is short-circuited before a request leaves
 * the host.
 *
 * Atomic tmp+rename writes; corruption starts a fresh ledger rather than
 * blocking sends (a lost dedup entry only risks a duplicate greeting, never
 * a lost one).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MAX_RECORDS = 5000

/** Write ceiling per kind, exported so readers can page a whole kind in one call. */
export const LEDGER_MAX_RECORDS = MAX_RECORDS

/**
 * Canonical ledger.json path under the plugin data dir. Backslashes are
 * normalized so the same string works everywhere it is logged or compared
 * (Windows hosts hand out drive-letter paths).
 * @param {string} dataDir
 * @returns {string}
 */
export function ledgerFileFor(dataDir) {
  return join(dataDir, 'ledger.json').replaceAll('\\', '/')
}

export class BossLedger {
  /** @type {string} */
  #file
  /** @type {string} */
  #account
  /** @type {{greets: LedgerRecord[], applies: LedgerRecord[]}} */
  #data = { greets: [], applies: [] }
  #loaded = false

  /**
   * @param {string} file ledger.json path under the plugin data dir
   * @param {string} account account fingerprint (SHA-256 of wt2, first 16 hex)
   */
  constructor(file, account) {
    this.#file = file
    this.#account = account
  }

  /**
   * Dedup key for greet/apply records.
   * @param {string} jobId
   * @param {string} securityId
   * @returns {string} dedup key
   */
  key(jobId, securityId) {
    return `${this.#account}:${jobId}:${securityId}`
  }

  /**
   * @param {LedgerKind} kind
   * @param {string} key
   * @returns {LedgerRecord | undefined}
   */
  find(kind, key) {
    this.#load()
    return this.#data[kind].find((record) => record.key === key)
  }

  /**
   * Append a record (newest first).
   * @param {LedgerKind} kind
   * @param {LedgerRecord} entry key/at plus outcome fields
   */
  record(kind, entry) {
    this.#load()
    this.#data[kind].unshift({ ...entry, account: this.#account })
    if (this.#data[kind].length > MAX_RECORDS) this.#data[kind].length = MAX_RECORDS
    this.#flush()
  }

  /**
   * @param {LedgerKind} kind
   * @param {number} [limit]
   * @returns {LedgerRecord[]}
   */
  list(kind, limit = 50) {
    this.#load()
    return this.#data[kind].slice(0, limit)
  }

  // ------------------------------------------------------------------- io

  #load() {
    if (this.#loaded) return
    this.#loaded = true
    try {
      if (existsSync(this.#file)) {
        const parsed = JSON.parse(readFileSync(this.#file, 'utf8'))
        if (parsed && Array.isArray(parsed.greets) && Array.isArray(parsed.applies)) {
          this.#data = {
            greets: parsed.greets,
            applies: parsed.applies,
          }
        }
      }
    } catch {
      this.#data = { greets: [], applies: [] }
    }
  }

  /** Same atomic tmp+rename pattern as every other state file in the plugin. */
  #flush() {
    const tmp = `${this.#file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.#data))
    renameSync(tmp, this.#file)
  }
}

/**
 * @param {string} wt2
 * @returns {string} account fingerprint
 */
export function accountFingerprint(wt2) {
  return createHash('sha256').update(wt2).digest('hex').slice(0, 16)
}

/** @typedef {'greets' | 'applies'} LedgerKind */

/**
 * @typedef {{key: string, at: string, jobId: string, securityId: string, jobName?: string, brandName?: string, outcome: string, platformMessage?: string}} LedgerRecord
 */
