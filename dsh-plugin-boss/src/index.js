/**
 * dsh-plugin-boss — host half.
 *
 * BOSS zhipin plugin for DeepSeek Harness. The embedded webview (desktop
 * only, M3) exists purely for human login and cookie harvest; every business
 * call runs through the Node-side HTTP client in ./boss/client.js.
 *
 * Only `tools` is a hard injection. `webServer` (the HTTP surface for the
 * client panel) is resolved dynamically: a hard `inject: ['webServer']` would
 * leave this entry permanently pending in any profile without a web server,
 * which DSH reports as a boot failure (dsh-iab pattern).
 */
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { BossClient } from './boss/client.js'
import { ConsoleData } from './boss/console-data.js'
import { RECRUITER_ENDPOINTS } from './boss/endpoints.js'
import { accountFingerprint, BossLedger, ledgerFileFor } from './boss/ledger.js'
import { BossSession } from './boss/session.js'
import { RequestThrottle, RiskLock } from './boss/throttle.js'
import { RecruiterAutomation } from './boss/recruiter/automation.js'
import { registerBossTools } from './tools/index.js'
import { registerHrTools } from './tools/hr/index.js'

export const name = 'dsh-plugin-boss'
export const inject = ['tools']

/**
 * Schemastery is an optional peer; resolve it lazily via createRequire so a
 * missing install degrades to defaults instead of breaking module evaluation.
 */
function loadSchema() {
  try {
    const require = createRequire(import.meta.url)
    const mod = require('@deepseek-ai/schemastery')
    return mod?.default ?? mod
  } catch {
    return null
  }
}

const Schema = loadSchema()

export let Config
if (Schema && typeof Schema.object === 'function') {
  Config = Schema.object({
    dataDir: Schema.string()
      .description('Data directory for credentials and the risk lock. Defaults to <home>/.dsh/dsh-plugin-boss.')
      .default('')
      .volatile(),
    readDelay: Schema.tuple([Schema.number(), Schema.number()])
      .description('Gaussian delay range [mean, high] in seconds between read requests. Field-tested default is deliberately slow.')
      .default([30, 60])
      .volatile(),
    writeDelay: Schema.tuple([Schema.number(), Schema.number()])
      .description('Gaussian delay range [mean, high] in seconds between write requests (greet/apply).')
      .default([60, 120])
      .volatile(),
    searchMethod: Schema.union(['post', 'get'])
      .description('Search transport: the 2026-10 POST full-form shape, or the older GET shape for A/B comparison.')
      .default('post')
      .volatile(),
    role: Schema.union(['candidate', 'recruiter', 'auto'])
      .description('Which side the plugin exposes: candidate tools only, recruiter (hr) tools only, or both (auto decides per session via boss_hr_whoami).')
      .default('auto')
      .volatile(),
    resumeMaxBytes: Schema.number()
      .description('Size ceiling in bytes for recruiter resume attachment downloads; oversize is refused, never truncated.')
      .default(20 * 1024 * 1024)
      .volatile(),
    hrBatchSize: Schema.number()
      .description('Conversation count per last-message enrichment batch (recruiter chat).')
      .default(50)
      .volatile(),
    hrEnrichCap: Schema.number()
      .description('Maximum conversations enriched per boss_hr_chat call; the report names the cap.')
      .default(100)
      .volatile(),
  })
}

/**
 * Read one config field across the shapes the loader hands to apply: absent,
 * plain value, or a `.get()` live wrapper (schemastery volatile fields).
 * @param {any} config
 * @param {string} key
 * @param {T} fallback
 * @template T
 */
function readConfig(config, key, fallback) {
  const value = config?.[key]
  if (value === undefined || value === null) return fallback
  if (typeof value.get === 'function') {
    const inner = value.get()
    return inner === undefined || inner === null ? fallback : inner
  }
  return value
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} [config]
 */
export function apply(ctx, config) {
  const configuredDataDir = readConfig(config, 'dataDir', '')
  const dataDir = resolveDataDir(typeof configuredDataDir === 'string' ? configuredDataDir : '')
  mkdirSync(dataDir, { recursive: true })
  ctx.logger.info(`dsh-plugin-boss loaded (dataDir=${dataDir})`)

  const session = new BossSession(dataDir)
  const riskLock = new RiskLock(join(dataDir, 'risk-lock.json'))
  const throttle = new RequestThrottle({
    readDelay: asDelayPair(readConfig(config, 'readDelay', undefined)),
    writeDelay: asDelayPair(readConfig(config, 'writeDelay', undefined)),
  })
  const client = new BossClient({
    cookies: () => session.cookies(),
    userAgent: () => session.userAgent(),
    throttle,
    riskLock,
    searchMethod: readConfig(config, 'searchMethod', 'post'),
    onSessionRefreshNeeded: (reason) => {
      ctx.logger.warn(`boss session needs refresh: ${reason}`)
      session.markStokenStale(reason)
    },
  })

  const deps = { session, client, riskLock, dataDir }
  const role = readConfig(config, 'role', 'auto')
  const recruiter = new BossClient({
    cookies: () => session.cookies(),
    userAgent: () => session.userAgent(),
    throttle,
    riskLock,
    endpoints: RECRUITER_ENDPOINTS,
    onSessionRefreshNeeded: (reason) => {
      ctx.logger.warn(`boss recruiter session needs refresh: ${reason}`)
      session.markStokenStale(reason)
    },
  })
  const automation = new RecruiterAutomation(join(dataDir, 'automation-state.json'), { logger: ctx.logger })
  // Panel-only extras layered on the shared substrate: the recruiter client
  // (console reads) and the enrichment limits (same config the hr tools use).
  // Business tool wiring above stays untouched.
  const panelDeps = {
    ...deps,
    recruiter,
    consoleLimits: {
      batchSize: readConfig(config, 'hrBatchSize', 50),
      enrichCap: readConfig(config, 'hrEnrichCap', 100),
    },
  }
  if (role !== 'candidate') {
    registerHrTools(ctx, {
      baseClient: client,
      recruiter,
      automation,
      session,
      limits: {
        resumeMaxBytes: readConfig(config, 'resumeMaxBytes', 20 * 1024 * 1024),
        batchSize: readConfig(config, 'hrBatchSize', 50),
        enrichCap: readConfig(config, 'hrEnrichCap', 100),
      },
    })
  }
  registerBossTools(ctx, deps, role === 'recruiter' ? { business: false } : {})

  // Optional HTTP surface for the client panel; absent in headless profiles.
  // Resolve through dynamic injection (dsh-iab pattern): a hard inject would
  // pend forever in profiles without a web server, while ctx.get() does not
  // reach the isolated scope the server lives in.
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scope) => {
        const webServer = scope?.webServer
        if (webServer?.register) registerPanelRoutes(ctx, webServer, panelDeps)
      })
    } else if (ctx.webServer?.register) {
      registerPanelRoutes(ctx, ctx.webServer, panelDeps)
    }
  } catch (error) {
    ctx.logger.info?.(`dsh-plugin-boss: no web server, panel disabled (${error?.message ?? error})`)
  }

  ctx.effect(() => () => { client.dispose(); recruiter.dispose() })
}

/**
 * @param {string | undefined} configured
 * @returns {string}
 */
function resolveDataDir(configured) {
  if (configured && configured.trim() !== '') return configured
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(dshHome, 'dsh-plugin-boss')
}

/**
 * Normalize a configured delay pair; anything malformed falls back to the
 * throttle defaults (undefined passthrough).
 * @param {unknown} value
 * @returns {[number, number] | undefined}
 */
function asDelayPair(value) {
  if (!Array.isArray(value) || value.length !== 2) return undefined
  const [lo, hi] = value
  if (typeof lo !== 'number' || typeof hi !== 'number' || !(hi > lo)) return undefined
  return [lo, hi]
}

/**
 * Narrow JSON surface the client panel consumes, mounted under one prefix
 * route with internal dispatch (dsh-iab pattern). Anonymous loopback only;
 * the webServer binds 127.0.0.1.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{register: (route: any) => () => void}} webServer
 * @param {{session: BossSession, client: BossClient, recruiter: BossClient, riskLock: RiskLock, dataDir: string, consoleLimits: {batchSize: number, enrichCap: number}}} deps
 */
function registerPanelRoutes(ctx, webServer, deps) {
  // Console data source: one instance so the network half is cached and
  // single-flighted across panel polls (throttle-friendly).
  const consoleData = new ConsoleData({
    session: deps.session,
    recruiter: deps.recruiter,
    riskLock: deps.riskLock,
    dataDir: deps.dataDir,
    limits: deps.consoleLimits,
  })
  const dispose = webServer.register({
    kind: 'prefix',
    path: '/boss-plugin',
    auth: 'anonymous',
    handler: (req, res) => {
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      const route = url.pathname.replace(/^\/boss-plugin/, '').replace(/\/+$/, '') || '/'
      const json = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(body))
      }
      try {
        if (route === '/status' && req.method === 'GET') {
          const wt2 = deps.session.cookies().wt2 ?? ''
          json(200, {
            session: deps.session.status(),
            riskLock: deps.riskLock.current(),
            // Leading characters of wt2 so the panel can detect that the
            // webview partition now holds a different login (side switch or
            // account switch) without exposing the full token.
            wt2Hint: wt2 ? wt2.slice(0, 8) : '',
          })
          return
        }
        if (route === '/logout' && req.method === 'POST') {
          deps.session.clear()
          json(200, { cleared: true })
          return
        }
        if (route === '/import' && req.method === 'POST') {
          const chunks = []
          req.on('data', (chunk) => chunks.push(chunk))
          req.on('end', () => {
            try {
              const { cookies } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              if (typeof cookies !== 'string' || cookies.trim() === '') {
                json(400, { imported: false, message: 'cookies 字段缺失' })
                return
              }
              const text = cookies.trim()
              const result = text.startsWith('curl') || text.includes('--header') || text.includes('-H ')
                ? deps.session.importCurl(text)
                : deps.session.importHeader(text)
              json(200, { imported: true, complete: result.ok, missing: result.missing ?? [] })
            } catch (error) {
              json(400, { imported: false, message: String(error?.message ?? error) })
            }
          })
          return
        }
        if (route === '/console' && req.method === 'GET') {
          // Aggregated resume-pipeline dataset (P0 read-only console). The
          // network half passes the shared read throttle (30–60s pacing by
          // default), so a cold build can take minutes; snapshot() caches
          // and single-flights to keep polling cheap.
          consoleData.snapshot().then(
            (dataset) => json(200, dataset),
            (error) => json(500, { error: String(error?.message ?? error) }),
          )
          return
        }
        if (route === '/console/resume-request' && req.method === 'POST') {
          // Lane ② manual local marking — the only write P0 allows. Touches
          // the ledger file only; never the platform, never the throttle.
          const chunks = []
          req.on('data', (chunk) => chunks.push(chunk))
          req.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              json(200, applyResumeRequestMarking(deps, body))
            } catch (error) {
              json(400, { ok: false, message: String(error?.message ?? error) })
            }
          })
          return
        }
        json(404, { error: `unknown route ${route}` })
      } catch (error) {
        json(500, { error: String(error?.message ?? error) })
      }
    },
  })
  ctx.effect(() => () => dispose())
}

/**
 * Validate and apply one local resume-request marking (console lane ②)
 * against the account-scoped ledger. Ledger write only — no platform send,
 * no throttle, no risk-lock involvement.
 * @param {{session: BossSession, dataDir: string}} deps
 * @param {any} body parsed request body:
 *   {action: 'mark-requested' | 'mark-arrived' | 'cancel', friendId, peerName?, jobId?, jobTitle?, securityId?, note?}
 * @returns {{ok: boolean, message?: string, action?: string, record?: any}}
 */
function applyResumeRequestMarking(deps, body) {
  const action = body?.action
  const friendId = body?.friendId === undefined || body?.friendId === null ? '' : String(body.friendId).trim()
  if (action !== 'mark-requested' && action !== 'mark-arrived' && action !== 'cancel') {
    return { ok: false, message: 'action 必须是 mark-requested / mark-arrived / cancel 之一。' }
  }
  if (!friendId) {
    return { ok: false, message: '缺少 friendId（会话 id，来自 console 数据的泳道条目）。' }
  }
  const wt2 = deps.session.cookies().wt2
  if (!wt2) {
    return { ok: false, message: '未登录（缺少 wt2）；先完成登录再做本地标记。' }
  }
  const ledger = new BossLedger(ledgerFileFor(deps.dataDir), accountFingerprint(wt2))
  if (action === 'mark-requested') {
    const record = ledger.markResumeRequested({
      friendId,
      peerName: optionalText(body.peerName),
      jobId: optionalText(body.jobId),
      jobTitle: optionalText(body.jobTitle),
      securityId: optionalText(body.securityId),
      note: optionalText(body.note),
    })
    return { ok: true, action, record }
  }
  if (action === 'mark-arrived') {
    const record = ledger.markResumeArrived(friendId)
    if (!record) return { ok: false, message: `会话 ${friendId} 没有「待收简历」的标记；先执行 mark-requested。` }
    return { ok: true, action, record }
  }
  const record = ledger.cancelResumeRequest(friendId)
  if (!record) return { ok: false, message: `会话 ${friendId} 没有可取消的简历标记。` }
  return { ok: true, action, record }
}

/** Undefined for null/missing/blank values, so the ledger stores no empty labels. */
function optionalText(value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).trim()
  return text === '' ? undefined : text
}
