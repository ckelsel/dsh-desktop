/**
 * Recruiter automation: the auto-reply pipeline lifecycle and its training
 * loop.
 *
 * Lifecycle (canonical contract):
 * - Plugin-scope single-flight: at most one cycle runs for this plugin
 *   instance; a second start is refused, not queued.
 * - A plugin-owned stop flag is honored within the running instance and
 *   persisted so a restart resumes the stopped state. It governs automation
 *   only — manual writes obey the ask gate and risk lock alone.
 * - A cycle scans conversations, scores them, and PROPOSES actions. Proposed
 *   sends leave this module as suggestions; actual sending goes through the
 *   hr write tools, which sit behind the ask gate. Training adjusts
 *   configuration; it never bypasses the gate.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Review thresholds (config layer defaults; operators retune, contracts stay numeric-free). */
export const DEFAULT_AUTOMATION_OPTIONS = Object.freeze({
  humanReviewThreshold: 0.65,
  autoExecuteThreshold: 0.82,
  maxActionsPerCycle: 20,
  maxConsecutiveErrors: 3,
})

/**
 * Score one inbox row for the propose-only automation cycle. The score is a
 * local triage signal, never a platform decision: unread replies and recent
 * candidate activity rise to the top, while quiet threads remain visible.
 * @param {{unreadCount?: number, lastActivityAt?: string | number}} conversation
 * @param {{lastMessageSender?: string, lastMessageAt?: string | number} | undefined} [message]
 * @param {number} [now]
 * @returns {{score: number, reasons: string[]}}
 */
export function scoreConversation(conversation, message, now = Date.now()) {
  const reasons = []
  let score = 0
  const unread = Number(conversation?.unreadCount ?? 0) || 0
  if (unread > 0) {
    score += Math.min(0.5, 0.2 + unread * 0.05)
    reasons.push(`未读 ${unread} 条`)
  }
  if (message?.lastMessageSender === 'candidate') {
    score += 0.25
    reasons.push('候选人最后发言')
  }
  const rawTime = message?.lastMessageAt ?? conversation?.lastActivityAt
  const at = typeof rawTime === 'number' ? rawTime : Date.parse(String(rawTime ?? ''))
  if (Number.isFinite(at)) {
    const ageHours = Math.max(0, (now - at) / 3_600_000)
    if (ageHours <= 2) {
      score += 0.25
      reasons.push('最近 2 小时有活动')
    } else if (ageHours <= 24) {
      score += 0.15
      reasons.push('最近 24 小时有活动')
    } else if (ageHours <= 72) {
      score += 0.05
      reasons.push('最近 3 天有活动')
    }
  }
  return { score: Number(Math.min(1, score).toFixed(4)), reasons }
}

export class RecruiterAutomation {
  /**
   * @param {string} stateFile absolute path under the plugin data dir
   * @param {{logger?: {info?: (m: string) => void, warn?: (m: string) => void}}} [io]
   */
  constructor(stateFile, io = {}) {
    this.stateFile = stateFile
    this.io = io
    this.options = { ...DEFAULT_AUTOMATION_OPTIONS }
    /** @type {'idle' | 'running' | 'stopped'} */
    this.phase = 'idle'
    /** @type {string | null} stop reason when the persisted flag is set */
    this.stopReason = null
    /** @type {any[] | null} proposals from the last completed cycle, for operator review */
    this.lastSuggestions = null
    this.#load()
  }

  /**
   * Start one automation cycle. Single-flight: refuses while a cycle runs.
   * @param {(progress: {scanned: number, proposed: number}) => Promise<void>} cycle
   * implementation supplied by the caller (tool layer composes reads)
   */
  async runCycle(cycle) {
    if (this.phase === 'running') {
      return { started: false, reason: '已有一个自动化周期在运行（插件内单飞）。' }
    }
    if (this.stopReason) {
      return { started: false, reason: `自动化已停止：${this.stopReason}；请先清除停止标志再启动。` }
    }
    this.phase = 'running'
    try {
      const progress = { scanned: 0, proposed: 0 }
      await cycle(progress)
      if (this.stopReason) {
        return { started: true, completed: false, stopped: true, reason: this.stopReason, progress }
      }
      return { started: true, completed: true, progress }
    } catch (error) {
      return { started: true, completed: false, error: String(error?.message ?? error) }
    } finally {
      this.phase = 'idle'
    }
  }

  /** Set the persisted stop flag. Governs automation only. @param {string} reason */
  stop(reason = 'operator') {
    this.stopReason = reason
    this.#persist()
    return { stopped: true, reason }
  }

  /** Clear the stop flag (explicit operator action). */
  resume() {
    const had = this.stopReason
    this.stopReason = null
    this.#persist()
    return { resumed: true, hadReason: had }
  }

  /**
   * Training: fold reviewed history (approvals, rejections, edits observed at
   * the ask gate) back into scoring thresholds. Adjusts configuration only.
   * @param {{approved: number, rejected: number, edited: number}} reviewCounts
   */
  train(reviewCounts) {
    const total = (reviewCounts.approved ?? 0) + (reviewCounts.rejected ?? 0)
    if (total < 10) {
      return { trained: false, reason: `审阅样本不足（${total} < 10）；继续积累审阅记录。` }
    }
    const approveRate = (reviewCounts.approved ?? 0) / total
    // Converge thresholds toward observed approval: heavy rejection tightens
    // the human-review line; heavy approval relaxes it toward the ceiling.
    const options = this.options
    const target = Math.min(0.75, Math.max(0.5, approveRate - 0.1))
    const previous = options.humanReviewThreshold
    options.humanReviewThreshold = Number(((options.humanReviewThreshold * 0.7) + (target * 0.3)).toFixed(4))
    this.#persist()
    return {
      trained: true,
      previousHumanReviewThreshold: previous,
      humanReviewThreshold: options.humanReviewThreshold,
      note: '训练只调整打分阈值；自动化发送仍走 ask 审批门，不会被绕过。',
    }
  }

  status() {
    return {
      phase: this.phase,
      stopReason: this.stopReason,
      options: { ...this.options },
    }
  }

  /** Fail-open on a missing state file (nothing persisted yet), fail-safe on corruption (treat as stopped=false, keep going). */
  #load() {
    try {
      if (existsSync(this.stateFile)) {
        const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'))
        this.stopReason = typeof parsed.stopReason === 'string' ? parsed.stopReason : null
        if (parsed.options && typeof parsed.options === 'object') {
          this.options = { ...DEFAULT_AUTOMATION_OPTIONS, ...parsed.options }
        }
      }
    } catch {
      this.io.logger?.warn?.('automation state unreadable; starting fresh')
    }
  }

  #persist() {
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true })
      const tmp = `${this.stateFile}.tmp`
      writeFileSync(tmp, JSON.stringify({ stopReason: this.stopReason, options: this.options, updatedAt: new Date().toISOString() }))
      renameSync(tmp, this.stateFile)
    } catch (error) {
      this.io.logger?.warn?.(`automation state persist failed: ${String(error?.message ?? error)}`)
    }
  }
}
