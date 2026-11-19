/**
 * BOSS zhipin error taxonomy.
 *
 * The unified response envelope is `{code, message, zpData}`; every non-zero
 * code maps to one error class below. Risk codes (31/32/35/36 and the
 * token-vs-environment split inside 37) trip the local risk lock: every
 * channel refuses to send until the user explicitly clears it, mirroring
 * boss-agent-cli's `cdp_risk_lock.json` semantics.
 */

/** Business error codes with a stable meaning across both references. */
export const CODE = Object.freeze({
  OK: 0,
  RATE_LIMITED: 9,
  BAD_ARGS: 17,
  BAD_ARGS_2: 19,
  IP_BLOCKED: 31,
  ACCOUNT_RISK: 32,
  RISK_35: 35,
  RISK_36: 36,
  STOKEN_EXPIRED: 37,
  SECURITY_121: 121,
  SECURITY_122: 122,
})

/** Codes that always trip the local risk lock (send-freeze until cleared). */
const RISK_LOCK_CODES = new Set([CODE.IP_BLOCKED, CODE.ACCOUNT_RISK, CODE.RISK_35, CODE.RISK_36])

/** Substrings that mark a code-37 as "stoken expired" rather than "environment risk". */
const STOKEN_EXPIRED_HINTS = ['token', '过期', 'stoken', '登录']

/**
 * @param {number} code business code from the zpData envelope
 * @param {string} message raw platform message
 * @returns {'risk' | 'stoken' | 'rate' | 'auth' | 'args' | 'unknown'}
 */
export function classifyCode(code, message) {
  if (code === CODE.RATE_LIMITED) return 'rate'
  if (code === CODE.BAD_ARGS || code === CODE.BAD_ARGS_2) return 'args'
  if (RISK_LOCK_CODES.has(code)) return 'risk'
  if (code === CODE.STOKEN_EXPIRED) {
    const text = message.toLowerCase()
    return STOKEN_EXPIRED_HINTS.some((hint) => text.includes(hint)) ? 'stoken' : 'risk'
  }
  if (code === CODE.SECURITY_121 || code === CODE.SECURITY_122) return 'risk'
  return 'unknown'
}

/** Local send-freeze marker; distinct from platform errors so tool output can name it. */
export const RISK_LOCKED = 'RISK_LOCKED'

/** Thrown for every non-zero envelope code and for transport/shape failures. */
export class BossError extends Error {
  /**
   * @param {string} kind one of the classifyCode kinds, or 'transport' | 'html' | RISK_LOCKED
   * @param {string} message
   * @param {{code?: number, platformMessage?: string, retryable?: boolean}} [detail]
   */
  constructor(kind, message, detail = {}) {
    super(message)
    this.name = 'BossError'
    this.kind = kind
    this.code = detail.code
    this.platformMessage = detail.platformMessage
    this.retryable = detail.retryable ?? false
  }
}
