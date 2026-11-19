/**
 * Session lifecycle tools: status, manual login, logout, risk-unlock.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { jsonOutput, ok } from './shared.js'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{session: import('../boss/session.js').BossSession, riskLock: import('../boss/throttle.js').RiskLock}} deps
 */
export function registerSessionTools(ctx, deps) {
  const { session, riskLock } = deps

  ctx.tools.register(defineTool({
    name: 'boss_status',
    description: 'Check the BOSS zhipin session: whether a login is stored, where it came from (webview/manual), cookie age, missing required cookies, and whether the anti-crawler token needs a refresh.',
    parameters: {},
    output: jsonOutput,
    async execute() {
      return ok({ session: session.status(), riskLock: riskLock.current() })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_login',
    description: 'Import a BOSS zhipin session manually. Accepts either a raw cookie header ("wt2=...; __zp_stoken__=...") or a browser DevTools "Copy as cURL" blob containing the cookie header. Use after logging in to zhipin.com in a normal browser, or when running the web build without the desktop webview.',
    parameters: {
      cookies: {
        type: 'string',
        description: 'Raw cookie header string ("k=v; k2=v2") or a full "Copy as cURL" command; the parser detects which.',
        required: true,
      },
    },
    output: jsonOutput,
    async execute({ cookies }) {
      const trimmed = cookies.trim()
      const result = trimmed.startsWith('curl') || trimmed.includes('--header') || trimmed.includes('-H ')
        ? session.importCurl(trimmed)
        : session.importHeader(trimmed)
      if (!result.ok) {
        return ok({ imported: true, complete: false, missing: result.missing, hint: '缺少关键 cookie，部分接口可能不可用；建议从已登录的浏览器完整复制。' })
      }
      return ok({ imported: true, complete: true })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_logout',
    description: 'Forget the stored BOSS zhipin session (does not touch the website itself).',
    parameters: {},
    output: jsonOutput,
    async execute() {
      session.clear()
      return ok({ cleared: true })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_risk_unlock',
    description: 'Clear the local risk lock after a platform risk-control hit. Only call after the user has confirmed the risk situation is resolved (captcha passed, account verified).',
    parameters: {
      confirmed: { type: 'boolean', description: 'Must be true to actually clear the lock.', required: true },
    },
    output: jsonOutput,
    async execute({ confirmed }) {
      if (!confirmed) return ok({ cleared: false, reason: '需要用户确认 confirmed=true' })
      return ok({ cleared: riskLock.clear() })
    },
  }))
}
