/**
 * Console dataset aggregation — the P0 read-only resume pipeline.
 *
 * One snapshot joins three sources into the shape the console UI renders:
 * - lane ① greeted-awaiting-reply: 'greets' ledger records joined with the
 *   recruiter inbox (conversation list + last-message enrichment). A greet
 *   sits in the lane while the recruiter side was the last to speak (or no
 *   last message is known); once the candidate spoke last it counts as
 *   replied and leaves the lane.
 * - lane ② resume-requested-awaiting-arrival: 'resumeRequests' ledger
 *   records still in outcome 'requested'. Operator's local marking only —
 *   no platform write, no network.
 * - lane ③ resume-received-unread: inbox threads with unreadCount > 0.
 *
 * Plus the leadership numbers strip (greet count today, reply rate,
 * requested-vs-arrived, unread) and the morning triage chips (new resumes
 * unread / new replies unanswered / offline jobs).
 *
 * Resilience contract: snapshot() NEVER throws. Absent session → empty
 * dataset with loggedIn:false. A failing network source degrades the
 * snapshot (listed in `errors`) instead of failing it. Every network call
 * goes through the recruiter client, so the shared read throttle and the
 * risk lock apply unchanged.
 *
 * Cost note: the read throttle paces requests 30–60s apart by default, so a
 * cold network fetch takes minutes. The network half is therefore cached
 * with a short TTL and single-flight; the ledger halves are re-read on every
 * snapshot (local files, always fresh, so lane ② markings and the strip
 * reflect immediately).
 */
import { accountFingerprint, BossLedger, LEDGER_MAX_RECORDS, ledgerFileFor } from './ledger.js'
import { batchEnrich } from './recruiter/chat.js'
import { listConversations } from './recruiter/conversations.js'
import { listJobs } from './recruiter/jobs.js'

/** Network-half cache lifetime; consecutive snapshot() calls inside it share one fetch. */
const NETWORK_TTL_MS = 30_000
/** Inbox depth per network fetch (pages of the conversation list). */
const MAX_CONVERSATION_PAGES = 2
/** Greet ledger entries considered per snapshot (newest first). */
const GREET_SCAN_LIMIT = 200

export class ConsoleData {
  /**
   * @param {{
   *   session: import('./session.js').BossSession,
   *   recruiter: import('./client.js').BossClient,
   *   riskLock: import('./throttle.js').RiskLock,
   *   dataDir: string,
   *   limits?: {batchSize?: number, enrichCap?: number},
   * }} deps
   */
  constructor(deps) {
    this.#deps = deps
  }

  #deps
  /** @type {{at: string, conversations: any[], enriched: any[], jobs: any[], errors: {source: string, message: string}[]}} */
  #network = null
  /** @type {Promise | null} single-flight guard for the network half */
  #inFlight = null

  /**
   * Build one console snapshot. Never rejects.
   * @returns {Promise<ConsoleDataset>}
   */
  async snapshot() {
    const { session, riskLock, dataDir } = this.#deps
    const sessionState = session.status()
    const riskLockState = riskLock.current()
    const envelope = {
      loggedIn: false,
      generatedAt: new Date().toISOString(),
      session: sessionState,
      riskLock: riskLockState,
    }
    const wt2 = session.cookies().wt2
    if (!wt2) {
      // Logged out: an honest empty pipeline rather than a half-populated one.
      return { ...envelope, ...composeConsoleDataset([], [], emptyNetwork()) }
    }
    try {
      const network = await this.#networkSnapshot()
      // Fresh ledger read every snapshot: local, cheap, and it keeps lane ②
      // and the strip current the instant an operator marks something.
      const ledger = new BossLedger(ledgerFileFor(dataDir), accountFingerprint(wt2))
      const greets = ledger.list('greets', GREET_SCAN_LIMIT).filter((record) => record.outcome === 'ok')
      const requests = ledger.list('resumeRequests', LEDGER_MAX_RECORDS)
      return { ...envelope, loggedIn: true, ...composeConsoleDataset(greets, requests, network) }
    } catch (error) {
      // Defensive only: the halves above already swallow their errors. A bug
      // in composition still yields a usable, flagged snapshot.
      const errors = [{ source: 'compose', message: String(error?.message ?? error) }]
      return {
        ...envelope,
        loggedIn: true,
        ...composeConsoleDataset([], [], { ...emptyNetwork(), errors }),
      }
    }
  }

  /**
   * Cached, single-flight network half. On a failed refetch the last good
   * inbox keeps serving (its failure rides along in `errors`) so one
   * transport hiccup never blanks the console.
   */
  async #networkSnapshot() {
    if (this.#network && Date.now() - Date.parse(this.#network.at) < NETWORK_TTL_MS) {
      return this.#network
    }
    if (!this.#inFlight) {
      this.#inFlight = this.#fetchNetwork()
        .then((fresh) => {
          const failedFetch = fresh.errors.length > 0 && fresh.conversations.length === 0
          if (failedFetch && this.#network && this.#network.conversations.length > 0) {
            return { ...this.#network, errors: fresh.errors }
          }
          this.#network = fresh
          return fresh
        })
        .finally(() => { this.#inFlight = null })
    }
    return this.#inFlight
  }

  /**
   * One throttled sweep: inbox pages, last-message enrichment, jobs list.
   * Every source is individually guarded; the result always resolves.
   */
  async #fetchNetwork() {
    /** @type {{source: string, message: string}[]} */
    const errors = []

    const lock = this.#deps.riskLock.current()
    if (lock) {
      // Fail fast without touching the throttle queue: every client call
      // would refuse anyway while the lock holds.
      errors.push({ source: 'risk-lock', message: `本地风控锁未解除（${lock.reason}）；本轮未发起网络读取。` })
      return { at: new Date().toISOString(), conversations: [], enriched: [], jobs: [], errors }
    }

    const conversations = []
    try {
      let page = 1
      while (page <= MAX_CONVERSATION_PAGES) {
        const listing = await listConversations(this.#deps.recruiter, { page })
        conversations.push(...listing.conversations)
        if (listing.hasMore !== true) break
        page += 1
      }
    } catch (error) {
      errors.push({ source: 'conversations', message: String(error?.message ?? error) })
    }

    let enriched = []
    if (conversations.length > 0) {
      try {
        const result = await batchEnrich(this.#deps.recruiter, conversations, {
          batchSize: this.#deps.limits?.batchSize,
          cap: this.#deps.limits?.enrichCap,
        })
        enriched = result.enriched
        if (result.report?.failedBatch) {
          errors.push({ source: 'enrichment', message: `部分会话摘要获取失败：${result.report.failedBatch.error}` })
        }
      } catch (error) {
        errors.push({ source: 'enrichment', message: String(error?.message ?? error) })
      }
    }

    let jobs = []
    try {
      const listing = await listJobs(this.#deps.recruiter, { page: 1 })
      jobs = listing.jobs
    } catch (error) {
      errors.push({ source: 'jobs', message: String(error?.message ?? error) })
    }

    return { at: new Date().toISOString(), conversations, enriched, jobs, errors }
  }
}

// ------------------------------------------------------------------ compose

/**
 * @typedef {ReturnType<typeof composeConsoleDataset> & {
 *   loggedIn: boolean,
 *   generatedAt: string,
 *   session: ReturnType<import('./session.js').BossSession['status']>,
 *   riskLock: {reason: string, at: string, id?: string} | null,
 * }} ConsoleDataset
 */

/**
 * Pure composition: ledger halves + one network sweep → the console dataset
 * body (lanes, strip, triage, jobs, diagnostics). Kept pure so the empty
 * and degraded shapes are literally the same code path as the full one.
 * @param {import('./ledger.js').LedgerRecord[]} greets outcome==='ok' greet records, newest first
 * @param {import('./ledger.js').ResumeRequestRecord[]} requests resume-request records, any outcome
 * @param {{at: string, conversations: any[], enriched: any[], jobs: any[], errors: {source: string, message: string}[]}} network
 */
export function composeConsoleDataset(greets, requests, network) {
  const lastById = new Map(network.enriched.map((e) => [e.conversationId, e]))
  const conversationBySecurity = new Map()
  const conversationByJob = new Map()
  for (const conversation of network.conversations) {
    if (conversation.securityId !== undefined) conversationBySecurity.set(String(conversation.securityId), conversation)
    if (conversation.jobId !== undefined) conversationByJob.set(String(conversation.jobId), conversation)
  }

  // -------------------------------------------------- lane ① greeted
  // Join greet records to the inbox by securityId (jobId as fallback — the
  // greet's securityId and the conversation row's securityId name the same
  // candidate-thread identity on both write paths). Dedupe by key, newest
  // record wins; ledger.list is newest-first.
  const seenGreetKeys = new Set()
  /** @type {any[]} */
  const greetedItems = []
  let greetedTotal = 0
  let greetedReplied = 0
  for (const entry of greets) {
    if (seenGreetKeys.has(entry.key)) continue
    seenGreetKeys.add(entry.key)
    greetedTotal += 1
    const conversation = conversationBySecurity.get(String(entry.securityId))
      ?? conversationByJob.get(String(entry.jobId))
    const last = conversation ? lastById.get(conversation.conversationId) : undefined
    const replied = last?.lastMessageSender === 'candidate'
    if (replied) {
      greetedReplied += 1
      continue
    }
    greetedItems.push({
      key: entry.key,
      jobId: entry.jobId,
      securityId: entry.securityId,
      jobName: entry.jobName ?? '',
      brandName: entry.brandName ?? '',
      greetedAt: entry.at,
      daysSinceGreet: daysSince(entry.at),
      conversationId: conversation?.conversationId,
      peerName: conversation?.peerName ?? '',
      jobTitle: conversation?.jobTitle,
      lastMessage: last
        ? { snippet: last.lastMessageSnippet, sender: last.lastMessageSender, at: last.lastMessageAt }
        : null,
    })
  }
  greetedItems.sort((a, b) => timeMs(a.greetedAt) - timeMs(b.greetedAt))
  const laneGreeted = {
    count: greetedItems.length,
    total: greetedTotal,
    replied: greetedReplied,
    oldestDays: maxDays(greetedItems, (item) => item.daysSinceGreet),
    items: greetedItems,
  }

  // ------------------------------------- lane ② resume-requested (ledger only)
  const awaitingItems = requests
    .filter((record) => record.outcome === 'requested')
    .map((record) => ({
      key: record.key,
      friendId: record.friendId,
      peerName: record.peerName ?? '',
      jobId: record.jobId,
      jobTitle: record.jobTitle,
      securityId: record.securityId,
      note: record.note,
      requestedAt: record.at,
      daysSinceRequested: daysSince(record.at),
    }))
    .sort((a, b) => timeMs(a.requestedAt) - timeMs(b.requestedAt)) // oldest first
  const awaitingOldestDays = maxDays(awaitingItems, (item) => item.daysSinceRequested)
  const laneResumeRequested = {
    count: awaitingItems.length,
    oldestDays: awaitingOldestDays,
    bannerText: awaitingItems.length > 0
      ? `待收简历 ${awaitingItems.length} 人·最久 ${awaitingOldestDays ?? 0} 天`
      : null,
    items: awaitingItems,
  }

  // ------------------------------------------- lane ③ resume-received-unread
  const unreadItems = network.conversations
    .filter((conversation) => conversation.unreadCount > 0)
    .map((conversation) => {
      const last = lastById.get(conversation.conversationId)
      return {
        conversationId: conversation.conversationId,
        peerName: conversation.peerName ?? '',
        jobId: conversation.jobId,
        jobTitle: conversation.jobTitle,
        securityId: conversation.securityId,
        unreadCount: conversation.unreadCount,
        lastActivityAt: conversation.lastActivityAt,
        lastMessage: last
          ? { snippet: last.lastMessageSnippet, sender: last.lastMessageSender, at: last.lastMessageAt }
          : null,
      }
    })
    .sort((a, b) => (b.unreadCount - a.unreadCount) || (timeMs(b.lastActivityAt) - timeMs(a.lastActivityAt)))
  const laneResumeReceived = {
    count: unreadItems.length,
    totalUnread: unreadItems.reduce((sum, item) => sum + item.unreadCount, 0),
    items: unreadItems,
  }

  // ------------------------------------------------------ leadership strip
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const greetedToday = greets.filter((record) => Date.parse(record.at) >= startOfToday.getTime()).length
  const arrivedCount = requests.filter((record) => record.outcome === 'arrived').length
  const strip = {
    greetedToday,
    reply: {
      greeted: greetedTotal,
      replied: greetedReplied,
      awaitingReply: laneGreeted.count,
      // Honest only when the inbox joined; raw counts above carry the nuance.
      rate: greetedTotal > 0 ? greetedReplied / greetedTotal : null,
    },
    resume: {
      requested: laneResumeRequested.count + arrivedCount,
      arrived: arrivedCount,
      awaiting: laneResumeRequested.count,
    },
    unread: { threads: laneResumeReceived.count, messages: laneResumeReceived.totalUnread },
  }

  // ---------------------------------------------------------- triage chips
  // "New replies unanswered": threads whose last message came from the
  // candidate — the best read-only proxy for "they spoke, we have not".
  const newRepliesUnanswered = network.conversations
    .filter((conversation) => lastById.get(conversation.conversationId)?.lastMessageSender === 'candidate')
    .length
  const offlineJobs = network.jobs.filter((job) => job.status === 'offline')
  const triage = {
    newResumeUnread: { active: laneResumeReceived.count > 0, count: laneResumeReceived.count },
    newRepliesUnanswered: { active: newRepliesUnanswered > 0, count: newRepliesUnanswered },
    offlineJobs: {
      active: offlineJobs.length > 0,
      count: offlineJobs.length,
      jobs: offlineJobs.map((job) => ({ jobId: job.jobId, jobName: job.jobName })),
    },
  }

  return {
    lanes: {
      greeted: laneGreeted,
      resumeRequested: laneResumeRequested,
      resumeReceived: laneResumeReceived,
    },
    strip,
    triage,
    jobs: network.jobs.map((job) => ({ jobId: job.jobId, jobName: job.jobName, status: job.status })),
    network: { fetchedAt: network.at, conversationCount: network.conversations.length },
    degraded: network.errors.length > 0,
    errors: network.errors,
  }
}

/** @returns {{at: string, conversations: any[], enriched: any[], jobs: any[], errors: never[]}} */
function emptyNetwork() {
  return { at: new Date().toISOString(), conversations: [], enriched: [], jobs: [], errors: [] }
}

/**
 * Whole days between an ISO timestamp and now (floor, never negative);
 * null when the timestamp is unreadable.
 * @param {string} iso
 * @returns {number | null}
 */
function daysSince(iso) {
  const ms = Date.now() - Date.parse(iso)
  return Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 86_400_000)) : null
}

/** Max of the day-counts in a lane, ignoring nulls; null when empty. */
function maxDays(items, pick) {
  let max = null
  for (const item of items) {
    const days = pick(item)
    if (days !== null && (max === null || days > max)) max = days
  }
  return max
}

/**
 * Best-effort sort key for platform timestamps: seconds-epoch numbers
 * (BOSS chat fields are second-granularity), millisecond numbers, numeric
 * strings, and ISO strings all resolve to unix-ms; anything else sorts as 0.
 * @param {any} value
 * @returns {number}
 */
function timeMs(value) {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) {
      const n = Number(value)
      return n < 1e12 ? n * 1000 : n
    }
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}
