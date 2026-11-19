/**
 * Greet/apply deduplication ledger (boss-agent-cli's SQLite greet_records /
 * apply_records, JSON edition), extended with the console pipeline's
 * resume-request marking. Greets/applies: one record per account fingerprint
 * + job + securityId, so a repeated greet on the same job is short-circuited
 * before any request leaves the host. ResumeRequests: one open marking per
 * account + conversation, purely a local record of operator intent — it
 * never triggers a platform send.
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
  /** @type {{greets: LedgerRecord[], applies: LedgerRecord[], resumeRequests: ResumeRequestRecord[]}} */
  #data = { greets: [], applies: [], resumeRequests: [] }
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
   * Identity key for a resume-request marking: one open marking per account
   * and conversation, independent of the greet key space.
   * @param {string} friendId conversation/friend id from the inbox
   * @returns {string} marking key
   */
  resumeRequestKey(friendId) {
    return `${this.#account}:resume:${friendId}`
  }

  /**
   * @param {LedgerKind} kind
   * @param {string} key
   * @returns {LedgerRecord | ResumeRequestRecord | undefined}
   */
  find(kind, key) {
    this.#load()
    return this.#data[kind].find((record) => record.key === key)
  }

  /**
   * Append a record (newest first). Generic across kinds; resume-request
   * markings should use the semantic helpers below instead.
   * @param {LedgerKind} kind
   * @param {LedgerRecord | ResumeRequestRecord} entry key/at plus outcome fields
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
   * @returns {(LedgerRecord | ResumeRequestRecord)[]}
   */
  list(kind, limit = 50) {
    this.#load()
    return this.#data[kind].slice(0, limit)
  }

  // ------------------------------------------------- resume-request marking

  /**
   * Mark (or re-mark) a conversation as resume-requested. Local operator
   * marking only — records intent, never a platform send. Upsert by key: an
   * open (non-cancelled) marking is refreshed in place instead of stacking a
   * duplicate, and re-marking resets the clock because the operator
   * re-anchored the request time.
   * @param {{friendId: string, peerName?: string, jobId?: string, jobTitle?: string, securityId?: string, note?: string}} entry
   * @returns {ResumeRequestRecord}
   */
  markResumeRequested(entry) {
    this.#load()
    const base = {
      peerName: entry.peerName,
      jobId: entry.jobId,
      jobTitle: entry.jobTitle,
      securityId: entry.securityId,
      note: entry.note,
      key: this.resumeRequestKey(entry.friendId),
      friendId: entry.friendId,
      at: new Date().toISOString(),
      outcome: 'requested',
      account: this.#account,
    }
    const open = this.#data.resumeRequests.find((r) => r.key === base.key && r.outcome !== 'cancelled')
    let record
    if (open) {
      // Merge over the open marking so a re-mark keeps its position/history
      // entry while updating labels and the request timestamp. Arrival and
      // cancellation stamps from a previous lifecycle are cleared: the
      // marking is open again.
      Object.assign(open, base)
      delete open.arrivedAt
      delete open.cancelledAt
      record = open
    } else {
      record = base
      this.#data.resumeRequests.unshift(record)
      if (this.#data.resumeRequests.length > MAX_RECORDS) this.#data.resumeRequests.length = MAX_RECORDS
    }
    this.#flush()
    return record
  }

  /**
   * Mark an open request as arrived (the resume landed). Strict: requires a
   * prior open 'requested' marking, so arrival bookkeeping never invents a
   * request the operator never recorded.
   * @param {string} friendId conversation/friend id used at mark time
   * @returns {ResumeRequestRecord | undefined} undefined when no open marking exists
   */
  markResumeArrived(friendId) {
    this.#load()
    const record = this.#openRequest(friendId)
    if (!record) return undefined
    record.outcome = 'arrived'
    record.arrivedAt = new Date().toISOString()
    this.#flush()
    return record
  }

  /**
   * Cancel a marking (mis-mark, or the thread is dead). Works on 'requested'
   * and 'arrived' alike; cancelled records stay in the file as history and
   * are excluded from every live lane.
   * @param {string} friendId
   * @returns {ResumeRequestRecord | undefined} undefined when there is nothing to cancel
   */
  cancelResumeRequest(friendId) {
    this.#load()
    const key = this.resumeRequestKey(friendId)
    const record = this.#data.resumeRequests.find((r) => r.key === key && r.outcome !== 'cancelled')
    if (!record) return undefined
    record.outcome = 'cancelled'
    record.cancelledAt = new Date().toISOString()
    this.#flush()
    return record
  }

  /**
   * @param {string} friendId
   * @returns {ResumeRequestRecord | undefined}
   */
  #openRequest(friendId) {
    const key = this.resumeRequestKey(friendId)
    return this.#data.resumeRequests.find((r) => r.key === key && r.outcome === 'requested')
  }

  // ------------------------------------------------------------------- io

  #load() {
    if (this.#loaded) return
    this.#loaded = true
    try {
      if (existsSync(this.#file)) {
        const parsed = JSON.parse(readFileSync(this.#file, 'utf8'))
        if (parsed && Array.isArray(parsed.greets) && Array.isArray(parsed.applies)) {
          // Older files predate the resumeRequests kind; a missing or malformed
          // array starts empty rather than rejecting the whole ledger.
          this.#data = {
            greets: parsed.greets,
            applies: parsed.applies,
            resumeRequests: Array.isArray(parsed.resumeRequests) ? parsed.resumeRequests : [],
          }
        }
      }
    } catch {
      this.#data = { greets: [], applies: [], resumeRequests: [] }
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

/** @typedef {'greets' | 'applies' | 'resumeRequests'} LedgerKind */

/**
 * @typedef {{key: string, at: string, jobId: string, securityId: string, jobName?: string, brandName?: string, outcome: string, platformMessage?: string}} LedgerRecord
 */

/**
 * @typedef {{
 *   key: string, at: string, friendId: string,
 *   peerName?: string, jobId?: string, jobTitle?: string, securityId?: string, note?: string,
 *   outcome: 'requested' | 'arrived' | 'cancelled',
 *   arrivedAt?: string, cancelledAt?: string, account?: string,
 * }} ResumeRequestRecord
 */
