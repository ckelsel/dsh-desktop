/**
 * Request throttle and local risk lock, ported from boss-agent-cli's
 * throttle.py / cdp_risk_lock semantics.
 *
 * Defaults follow the 2026 field measurements recorded there: three searches
 * at 15s intervals already tripped code 37, while 90s spacing passed, so the
 * base delay is a 30-60s gaussian — deliberately far more conservative than
 * boss-cli's 1s. Burst penalties, a 5% "reading pause", and a rate-limit
 * cooldown ladder are layered on top. All numbers are config fields, never
 * constants.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'

/** Box-Muller gaussian in seconds, clamped to >= 0. */
function gaussSeconds(mean, sigma) {
  const u = 1 - Math.random()
  const v = Math.random()
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  return Math.max(0, mean + sigma * z)
}

export class RequestThrottle {
  /**
   * @param {{readDelay?: [number, number], writeDelay?: [number, number], burst?: {shortWindowMs?: number, shortMax?: number, shortPenalty?: [number, number], longWindowMs?: number, longMax?: number, longPenalty?: [number, number]}, readPauseChance?: number, readPauseSeconds?: [number, number]}}} [config]
   */
  constructor(config = {}) {
    const read = config.readDelay ?? [30, 60]
    const write = config.writeDelay ?? [60, 120]
    this.readMean = read[0]
    this.readSigma = Math.max(1, (read[1] - read[0]) / 3)
    this.writeMean = write[0]
    this.writeSigma = Math.max(1, (write[1] - write[0]) / 3)
    this.burst = {
      shortWindowMs: config.burst?.shortWindowMs ?? 15_000,
      shortMax: config.burst?.shortMax ?? 3,
      shortPenalty: config.burst?.shortPenalty ?? [1.2, 2.8],
      longWindowMs: config.burst?.longWindowMs ?? 45_000,
      longMax: config.burst?.longMax ?? 6,
      longPenalty: config.burst?.longPenalty ?? [4, 7],
    }
    this.readPauseChance = config.readPauseChance ?? 0.05
    this.readPauseSeconds = config.readPauseSeconds ?? [2, 5]
    /** @type {number[]} unix-ms send timestamps */
    this.sends = []
    /** Rate-limit cooldown state: consecutive code-9 ladder. */
    this.rateStrikes = 0
    /** @type {Map<string, {until: number, reason: string}>} */
    this.inFlightWaiters = new Map()
  }

  /** Record one send for burst accounting. */
  #recordSend() {
    const now = Date.now()
    this.sends.push(now)
    const cutoff = now - this.burst.longWindowMs
    while (this.sends.length > 0 && this.sends[0] < cutoff) this.sends.shift()
  }

  /** @returns {number} extra penalty seconds from recent burst windows. */
  #burstPenalty() {
    const now = Date.now()
    const shortCount = this.sends.filter((t) => now - t < this.burst.shortWindowMs).length
    const longCount = this.sends.length
    if (longCount >= this.burst.longMax) {
      const [lo, hi] = this.burst.longPenalty
      return lo + Math.random() * (hi - lo)
    }
    if (shortCount >= this.burst.shortMax) {
      const [lo, hi] = this.burst.shortPenalty
      return lo + Math.random() * (hi - lo)
    }
    return 0
  }

  /**
   * Serialize access per effect bucket and wait the computed delay.
   * @param {'read' | 'write'} effect
   * @param {AbortSignal} [signal]
   */
  async acquire(effect, signal) {
    const bucket = this.inFlightWaiters.get(effect) ?? { until: 0, reason: '' }
    while (bucket.until > Date.now()) {
      await sleep(Math.min(bucket.until - Date.now(), 5_000), signal)
    }
    let delay = effect === 'write'
      ? gaussSeconds(this.writeMean, this.writeSigma)
      : gaussSeconds(this.readMean, this.readSigma)
    delay += this.#burstPenalty()
    if (effect === 'read' && Math.random() < this.readPauseChance) {
      delay += this.readPauseSeconds[0] + Math.random() * (this.readPauseSeconds[1] - this.readPauseSeconds[0])
    }
    bucket.until = Date.now() + delay * 1000
    this.inFlightWaiters.set(effect, bucket)
    await sleep(delay * 1000, signal)
    this.#recordSend()
  }

  /**
   * Code-9 cooldown: min(60, 10 * 2^(n-1)) seconds, doubling the base delay
   * ladder afterwards. Returns the cooldown applied.
   */
  noteRateLimited() {
    this.rateStrikes += 1
    const cooldown = Math.min(60, 10 * 2 ** (this.rateStrikes - 1))
    for (const bucket of this.inFlightWaiters.values()) {
      bucket.until = Math.max(bucket.until, Date.now() + cooldown * 1000)
    }
    this.readMean *= 2
    this.writeMean *= 2
    return cooldown
  }

  /** Successful send resets the strike ladder. */
  noteSuccess() {
    this.rateStrikes = 0
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    function finish() {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort() {
      clearTimeout(timer)
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Local send-freeze persisted next to the credential store. While locked,
 * every channel refuses to send; only {@link clear} (wired to the
 * boss_risk_unlock tool) releases it.
 */
export class RiskLock {
  /** @param {string} file absolute path of the lock file */
  constructor(file) {
    this.file = file
  }

  /** @returns {{reason: string, at: string} | null} */
  current() {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return null
    }
  }

  /** @param {string} reason */
  trip(reason) {
    mkdirSync(dirname(this.file), { recursive: true })
    const record = { reason, at: new Date().toISOString(), id: randomUUID() }
    writeFileSync(this.file, JSON.stringify(record, null, 2))
    return record
  }

  /** @returns {boolean} true if a lock existed. */
  clear() {
    if (!existsSync(this.file)) return false
    rmSync(this.file)
    return true
  }
}
