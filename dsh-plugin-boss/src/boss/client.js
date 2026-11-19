/**
 * Node-side HTTP client for the BOSS zhipin wapi.
 *
 * Deliberately browser-free: this is the business plane the project brief
 * demands — every query and application goes through plain HTTP with a
 * replayed session, never through page automation. The webview half only
 * feeds {@link BossSession} with cookies.
 *
 * Hardened transport details ported from the references:
 * - HTTP/2 forced (undici allowH2), matching boss-agent-cli's httpx http2=True.
 * - Fixed Chrome UA with aligned sec-ch-ua headers; one stable identity.
 * - Per-request random `traceid` (F- + 24 [0-9a-z]).
 * - `zp_token` header lifted from the `bst` cookie when present.
 * - GET requests append `__zp_stoken__` as a query parameter.
 * - Endpoint-specific Referer mapping.
 * - HTML-body detection (login redirect / security interstitial) before JSON parse.
 * - One in-band retry after a code-9 cooldown; 429/5xx exponential backoff up to 3.
 */
import { Agent, request as undiciRequest } from 'undici'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { BASE_URL, ENDPOINTS, SEARCH_FORM_KEYS } from './endpoints.js'
import { BossError, RISK_LOCKED, classifyCode } from './errors.js'

/** Fixed identity — UA never varies mid-session. */
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'
const SEC_CH_UA = '"Chromium";v="156", "Not(A:Brand";v="99", "Google Chrome";v="156"'

function traceid() {
  let tail = ''
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
  for (let i = 0; i < 24; i += 1) tail += alphabet[Math.floor(Math.random() * alphabet.length)]
  return `F-${tail}`
}

/**
 * @param {Record<string, string>} cookies
 * @returns {string} "k=v; k=v" header value
 */
function cookieHeader(cookies) {
  return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
}

/**
 * @param {string} body
 * @returns {boolean} true when the response is an HTML interstitial rather than wapi JSON.
 */
function looksLikeHtml(body) {
  const head = body.slice(0, 200).trimStart().toLowerCase()
  return head.startsWith('<!doctype html') || head.startsWith('<html')
}

export class BossClient {
  /**
   * @param {{
   *   cookies: () => Record<string, string>,
   *   userAgent?: () => string,
   *   throttle: import('./throttle.js').RequestThrottle,
   *   riskLock: import('./throttle.js').RiskLock,
   *   onSessionRefreshNeeded?: (reason: string) => void,
   *   searchMethod?: 'post' | 'get',
   *   endpoints?: Record<string, {path: string, method: 'get' | 'post', body?: 'form' | 'json', referer: string, effect: 'read' | 'write'}>,
   * }} deps
   */
  constructor(deps) {
    this.deps = deps
    /** One connection pool; H2 multiplexes. */
    this.agent = new Agent({
      allowH2: true,
      connections: 8,
      connectTimeout: 15_000,
      headersTimeout: 30_000,
      bodyTimeout: 40_000,
    })
  }

  dispose() {
    this.agent.destroy()
  }

  /**
   * Stream a binary attachment to disk through the shared connection pool,
   * bounded by `maxBytes` (missing/invalid bounds are refused, not defaulted).
   * Same protections as call(): risk lock, throttle, session presence; the
   * URL must stay on the zhipin host family so session cookies never leave
   * it. Oversize fails with the actual size instead of truncating.
   * @param {string} url absolute https URL on a zhipin.com host
   * @param {{toFile: string, maxBytes: number}} options
   * @returns {Promise<{path: string, size: number}>}
   */
  async download(url, options) {
    const maxBytes = Number(options.maxBytes)
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new BossError('args', 'download 需要有效的大于零的 maxBytes 上限。')
    }
    let target
    try {
      target = new URL(url)
    } catch {
      throw new BossError('args', `无效的下载地址：${String(url).slice(0, 120)}`)
    }
    const host = target.hostname.toLowerCase().replace(/\.$/, '')
    if (target.protocol !== 'https:' || (!host.endsWith('.zhipin.com') && host !== 'zhipin.com')) {
      throw new BossError('args', `下载地址超出 zhipin.com 域（${host}）；已拒绝以免会话凭据外泄。`)
    }
    const lock = this.deps.riskLock.current()
    if (lock) {
      throw new BossError(RISK_LOCKED, `本地风控锁未解除（${lock.reason}）；确认风险已处理后调用 boss_risk_unlock。`, { retryable: false })
    }
    await this.deps.throttle.acquire('read')
    const cookies = this.deps.cookies()
    if (!cookies.wt2) throw new BossError('auth', '没有登录会话（缺少 wt2）。')
    let response
    try {
      response = await undiciRequest(url, {
        method: 'GET',
        dispatcher: this.agent,
        maxRedirections: 0,
        headers: {
          'user-agent': this.deps.userAgent?.() ?? USER_AGENT,
          'referer': new URL('/', BASE_URL).toString(),
          'cookie': cookieHeader(cookies),
        },
      })
    } catch (error) {
      throw new BossError('transport', `附件下载失败：${String(error?.message ?? error)}`)
    }
    if (response.statusCode !== 200) {
      response.body.destroy()
      throw new BossError('transport', `附件下载失败（HTTP ${response.statusCode}）。`)
    }
    const declared = Number(response.headers['content-length'] ?? 0)
    if (declared > maxBytes) {
      response.body.destroy()
      throw new BossError('args', `附件过大（${declared} 字节，上限 ${maxBytes}）；已拒绝下载。`)
    }
    const chunks = []
    let total = 0
    try {
      for await (const chunk of response.body) {
        total += chunk.length
        if (total > maxBytes) {
          throw new BossError('args', `附件超过大小上限（>${maxBytes} 字节）；已中止。`)
        }
        chunks.push(chunk)
      }
    } catch (error) {
      if (error instanceof BossError) throw error
      throw new BossError('transport', `附件下载中断：${String(error?.message ?? error)}`)
    }
    mkdirSync(dirname(options.toFile), { recursive: true })
    writeFileSync(options.toFile, Buffer.concat(chunks))
    return { path: options.toFile, size: total }
  }

  /**
   * Core send path. Validates the risk lock, throttles, dispatches, and
   * normalizes the `{code, message, zpData}` envelope into zpData or a
   * classified BossError.
   * @param {string} name endpoint key in ENDPOINTS
   * @param {{query?: Record<string, string | number>, form?: Record<string, string | number>, json?: Record<string, any>, methodOverride?: 'get' | 'post'}} [input]
   * @param {{retriesLeft?: number}} [state]
   */
  async call(name, input = {}, state = {}) {
    const spec = (this.deps.endpoints ?? ENDPOINTS)[name]
    if (!spec) throw new BossError('args', `未知端点「${name}」`)
    const lock = this.deps.riskLock.current()
    if (lock) {
      throw new BossError(RISK_LOCKED, `本地风控锁未解除（${lock.reason}）；确认风险已处理后调用 boss_risk_unlock。`, { retryable: false })
    }
    const method = input.methodOverride ?? spec.method
    await this.deps.throttle.acquire(spec.effect)

    const cookies = this.deps.cookies()
    if (!cookies.wt2) throw new BossError('auth', '没有登录会话（缺少 wt2）；先用 boss_login 导入或在桌面版完成 webview 登录。')

    const url = new URL(spec.path, BASE_URL)
    const query = { ...input.query }
    if (method === 'get' && cookies.__zp_stoken__ && !('token' in query)) query.__zp_stoken__ = cookies.__zp_stoken__
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v))

    /** @type {Record<string, string>} */
    const headers = {
      'user-agent': this.deps.userAgent?.() ?? USER_AGENT,
      'sec-ch-ua': SEC_CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'x-requested-with': 'XMLHttpRequest',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'traceid': traceid(),
      'origin': BASE_URL,
      'referer': new URL(spec.referer, BASE_URL).toString(),
      'cookie': cookieHeader(cookies),
      'dnt': '1',
      'priority': 'u=1, i',
    }
    if (cookies.bst) headers['zp_token'] = cookies.bst

    let body = null
    if (method === 'post' && spec.body === 'json') {
      body = JSON.stringify(input.json ?? input.form ?? {})
      headers['content-type'] = 'application/json'
    } else if (method === 'post') {
      const form = new URLSearchParams()
      for (const [k, v] of Object.entries(input.form ?? {})) form.set(k, String(v))
      body = form.toString()
      headers['content-type'] = 'application/x-www-form-urlencoded'
    }

    const attempt = await dispatch(this.agent, { method: method.toUpperCase(), url, headers, body })
    // Write-effect requests are never auto-retried: a transport-level failure
    // leaves the outcome unknown, and replaying an unknown-outcome write can
    // double-send. The caller surfaces the uncertainty instead.
    const mayRetry = spec.effect !== 'write' && (state.retriesLeft ?? 3) > 0
    if (attempt.transportRetryable && mayRetry) {
      const backoff = 2 ** (4 - (state.retriesLeft ?? 3)) + Math.random()
      await new Promise((r) => setTimeout(r, backoff * 1000))
      return this.call(name, input, { retriesLeft: (state.retriesLeft ?? 3) - 1 })
    }
    if (attempt.status === 429) {
      if (mayRetry) {
        const backoff = 2 ** (4 - (state.retriesLeft ?? 3)) + Math.random()
        await new Promise((r) => setTimeout(r, backoff * 1000))
        return this.call(name, input, { retriesLeft: (state.retriesLeft ?? 3) - 1 })
      }
      if (spec.effect === 'write') {
        throw new BossError('unknown', `HTTP 429：写请求发送状态未知，请先核对平台实际记录，勿直接重试。`, { retryable: false })
      }
      throw new BossError('rate', 'HTTP 429：请求过于频繁。', { retryable: true })
    }
    if (looksLikeHtml(attempt.body)) {
      if (spec.effect === 'write') {
        throw new BossError('unknown', `接口返回 HTML（HTTP ${attempt.status}）：写请求结果未确认，请核对平台记录，勿直接重试。`, { retryable: false })
      }
      throw new BossError('html', `接口返回 HTML 而非 JSON（HTTP ${attempt.status}）——通常是登录失效或命中安全验证页。`, { retryable: false })
    }

    let envelope
    try {
      envelope = JSON.parse(attempt.body)
    } catch {
      if (spec.effect === 'write') {
        throw new BossError('unknown', `响应不是合法 JSON（HTTP ${attempt.status}）：写请求结果未确认，请核对平台记录，勿直接重试。`, { retryable: false })
      }
      throw new BossError('transport', `响应不是合法 JSON（HTTP ${attempt.status}，前 80 字符：${attempt.body.slice(0, 80)}）`)
    }
    const code = typeof envelope.code === 'number' ? envelope.code : -1
    const message = typeof envelope.message === 'string' ? envelope.message : ''
    if (code === 0) {
      this.deps.throttle.noteSuccess()
      return envelope.zpData
    }
    const kind = classifyCode(code, message)
    if (kind === 'rate') {
      const cooldown = this.deps.throttle.noteRateLimited()
      if ((state.rateRetries ?? 0) < 1) {
        await new Promise((r) => setTimeout(r, (cooldown + 1) * 1000))
        return this.call(name, input, { ...state, rateRetries: (state.rateRetries ?? 0) + 1 })
      }
      throw new BossError('rate', `code 9 限频，冷却 ${cooldown}s 后仍失败：${message}`, { retryable: true })
    }
    if (kind === 'risk') {
      this.deps.riskLock.trip(`code ${code}：${message}`)
      throw new BossError('risk', `平台风控（code ${code}）：${message}；已停止所有发送，解锁需调用 boss_risk_unlock。`)
    }
    if (kind === 'stoken') {
      this.deps.onSessionRefreshNeeded?.(`code 37：${message}`)
      throw new BossError('stoken', `__zp_stoken__ 过期（code 37）：请在桌面版重新打开登录面板刷新会话。`, { retryable: false })
    }
    throw new BossError(kind === 'args' ? 'args' : 'unknown', `code ${code}：${message}`, { code, platformMessage: message })
  }

  // ---------------------------------------------------------------- helpers

  /**
   * Search via the configured transport: the 2026-10 POST full-form shape by
   * default, or the older GET shape (boss-cli) for live A/B comparison.
   * @param {Record<string, string | number>} filters fully resolved (city code, filter codes) form fields
   */
  search(filters) {
    if (this.deps.searchMethod === 'get') return this.searchGet(filters)
    const form = {}
    for (const key of SEARCH_FORM_KEYS) {
      const value = filters[key]
      form[key] = value === undefined ? '' : String(value)
    }
    form.scene = filters.scene === undefined ? '1' : String(filters.scene)
    form.page = filters.page === undefined ? '1' : String(filters.page)
    form.pageSize = filters.pageSize === undefined ? '15' : String(filters.pageSize)
    return this.call('search', { form })
  }

  /** GET search variant (boss-cli shape) for live comparison. */
  searchGet(filters) {
    return this.call('search', { query: filters, methodOverride: 'get' })
  }
}

/**
 * One undici dispatch with the status/body captured.
 * @returns {Promise<{status: number, body: string, transportRetryable: boolean}>}
 */
async function dispatch(agent, { method, url, headers, body }) {
  try {
    const response = await undiciRequest(url.toString(), {
      method,
      headers,
      body,
      dispatcher: agent,
      maxRedirections: 0,
    })
    const text = await response.body.text()
    const transportRetryable = response.statusCode >= 500
    return { status: response.statusCode, body: text, transportRetryable }
  } catch (error) {
    return { status: 0, body: String(error), transportRetryable: true }
  }
}
