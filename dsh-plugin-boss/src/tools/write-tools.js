/**
 * Write-plane tools: greet and apply. Both go through the shared
 * ledger-dedup + dry-run + one friend/add pipeline, and the domain index
 * adds the `tools/pre-execute` ask gate over them.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BossError, RISK_LOCKED } from '../boss/errors.js'
import { BossLedger, accountFingerprint } from '../boss/ledger.js'
import { failure, jsonOutput, ok } from './shared.js'

const DEFAULT_GREETING = '您好，我对这个职位很感兴趣，期待进一步沟通。'
/** Ledger outcomes for failures whose request may already have reached the platform; these are never replayed. */
const UNREPLAYABLE_KINDS = new Set(['args', RISK_LOCKED, 'transport', 'html'])

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{session: import('../boss/session.js').BossSession, client: import('../boss/client.js').BossClient, dataDir: string}} deps
 */
export function registerWriteTools(ctx, deps) {
  const { session, client, dataDir } = deps

  /** Fresh per-call ledger bound to the current account fingerprint. */
  const ledgerFor = () => new BossLedger(`${dataDir}/ledger.json`.replaceAll('\\', '/'), accountFingerprint(session.cookies().wt2 ?? ''))

  /**
   * Shared body for greet/apply: ledger dedup, dry-run, one friend/add call,
   * and post-outcome recording. Failures whose request may have reached the
   * platform are recorded and never replayed.
   * @param {'greets' | 'applies'} kind
   * @param {{securityId: string, jobId: string, lid?: string, greeting?: string, jobName?: string, brandName?: string, dry_run?: boolean}} args
   * @param {Record<string, string>} form
   */
  const runWriteAction = async (kind, args, form) => {
    if (!session.cookies().wt2) return ok({ sent: false, errorKind: 'auth', message: '未登录（缺少 wt2）；先完成登录再执行写操作。' })
    const ledger = ledgerFor()
    const key = ledger.key(args.jobId, args.securityId)
    const seen = ledger.find(kind, key)
    if (seen) {
      return ok({ sent: false, already: true, record: seen, message: `该职位已记录过${kind === 'greets' ? '打招呼' : '投递'}，未重复发送。` })
    }
    if (args.dry_run) {
      return ok({ dryRun: true, wouldSend: { endpoint: 'friend/add.json', form } })
    }
    const record = (outcome, platformMessage) => ledger.record(kind, {
      key,
      at: new Date().toISOString(),
      jobId: args.jobId,
      securityId: args.securityId,
      jobName: args.jobName,
      brandName: args.brandName,
      outcome,
      platformMessage,
    })
    try {
      const zpData = await client.call('friendAdd', { form })
      record('ok')
      return ok({ sent: true, data: zpData })
    } catch (error) {
      const errorKind = error instanceof BossError ? error.kind : 'internal'
      if (!UNREPLAYABLE_KINDS.has(errorKind)) record(errorKind, error?.message)
      return failure(error)
    }
  }

  ctx.tools.register(defineTool({
    name: 'boss_greet',
    description: 'Greet the recruiter of one job on BOSS zhipin (opens a chat; the job "hello" action). Write action: requires user approval unless dry_run=true; jobs already greeted are skipped via the local ledger.',
    parameters: {
      securityId: { type: 'string', description: 'securityId from boss_search results.', required: true },
      jobId: { type: 'string', description: 'encryptJobId from boss_search results.', required: true },
      greeting: { type: 'string', description: 'Optional custom greeting text; defaults to a neutral opener.' },
      jobName: { type: 'string', description: 'Optional job label stored in the ledger for review.' },
      brandName: { type: 'string', description: 'Optional company label stored in the ledger.' },
      dry_run: { type: 'boolean', description: 'Preview the exact request without sending (no approval needed).' },
    },
    output: jsonOutput,
    async execute(args) {
      const greeting = (args.greeting ?? '').trim() || DEFAULT_GREETING
      return runWriteAction('greets', args, { securityId: args.securityId, jobId: args.jobId, greeting })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_apply',
    description: 'Apply to one job on BOSS zhipin (the "立即沟通" delivery path). Write action: requires user approval unless dry_run=true; jobs already applied are skipped via the local ledger.',
    parameters: {
      securityId: { type: 'string', description: 'securityId from boss_search results.', required: true },
      jobId: { type: 'string', description: 'encryptJobId from boss_search results.', required: true },
      lid: { type: 'string', description: 'lid from boss_search results; improves fidelity when present.' },
      jobName: { type: 'string', description: 'Optional job label stored in the ledger for review.' },
      brandName: { type: 'string', description: 'Optional company label stored in the ledger.' },
      dry_run: { type: 'boolean', description: 'Preview the exact request without sending (no approval needed).' },
    },
    output: jsonOutput,
    async execute(args) {
      /** @type {Record<string, string>} */
      const form = { securityId: args.securityId, jobId: args.jobId }
      if (args.lid) form.lid = args.lid
      return runWriteAction('applies', args, form)
    },
  }))
}
