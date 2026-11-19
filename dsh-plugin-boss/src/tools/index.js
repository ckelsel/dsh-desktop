/**
 * boss_* tool registration entry: assembles the tool domains and installs the
 * human gate over the write plane.
 *
 * Domains:
 * - session-tools   status / login / logout / risk_unlock
 * - search-tools    search / detail / recommend
 * - profile-tools   me / resume
 * - relation-tools  delivered / favorites / friends / chat / interviews
 * - write-tools     greet / apply (ledger-backed)
 */
import { registerProfileTools } from './profile-tools.js'
import { registerRelationTools } from './relation-tools.js'
import { registerSearchTools } from './search-tools.js'
import { registerSessionTools } from './session-tools.js'
import { registerWriteTools } from './write-tools.js'

/** Write tools gated by the ask decision below. */
const WRITE_TOOLS = new Set(['boss_greet', 'boss_apply'])

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{session: import('../boss/session.js').BossSession, client: import('../boss/client.js').BossClient, riskLock: import('../boss/throttle.js').RiskLock, dataDir: string}} deps
 * @param {{business?: boolean}} [options] business=false (recruiter role) registers only session tools
 */
export function registerBossTools(ctx, deps, options = {}) {
  registerSessionTools(ctx, deps)
  if (options.business === false) return
  registerSearchTools(ctx, deps)
  registerProfileTools(ctx, deps)
  registerRelationTools(ctx, deps)
  registerWriteTools(ctx, deps)

  // Human gate for the write plane: ask approval unless dry-run. Without an
  // approval service in the host, ask degrades to denial — the safe default.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!WRITE_TOOLS.has(exec.name)) return next()
    const args = (exec.arguments && typeof exec.arguments === 'object') ? exec.arguments : {}
    if (args.dry_run === true) return next()
    const label = exec.name === 'boss_greet' ? '打招呼' : '投递'
    return {
      kind: 'ask',
      reason: `boss ${exec.name}: jobId=${String(args.jobId ?? '?')}`,
      displayReason: {
        en: `Allow BOSS zhipin to send this ${label === '打招呼' ? 'greeting' : 'application'} (jobId=${String(args.jobId ?? '?')})?`,
        zh: `允许向 BOSS 直聘发送${label}请求吗？（jobId=${String(args.jobId ?? '?')}）`,
      },
    }
  })
}
