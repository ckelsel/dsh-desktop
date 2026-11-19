/**
 * hr_* tool registration: the recruiter surface as DSH tools.
 *
 * Read plane: whoami, jobs, candidates, recommendations, chat-list with
 * enrichment, chatmsg. Write plane (all behind the ask gate, all with a
 * dry_run preview the gate bypasses): greet, reply, send_location,
 * request_resume, accept_resume, exchange. Automation plane: lifecycle
 * control and training.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { failure, jsonOutput, makeRegisterRead, ok } from '../shared.js'
import { scoreConversation } from '../../boss/recruiter/automation.js'
import * as chat from '../../boss/recruiter/chat.js'
import * as conversations from '../../boss/recruiter/conversations.js'
import * as jobs from '../../boss/recruiter/jobs.js'

/** Write tools gated by the ask decision below (dry_run bypasses, same as candidate-side). */
const HR_WRITE_TOOLS = new Set([
  'boss_hr_greet', 'boss_hr_reply', 'boss_hr_send_location',
  'boss_hr_request_resume', 'boss_hr_accept_resume', 'boss_hr_exchange',
  'boss_hr_interview', 'boss_hr_job_online', 'boss_hr_job_offline',
])

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{
 *   baseClient: import('../../boss/client.js').BossClient,
 *   recruiter: import('../../boss/client.js').BossClient,
 *   automation: import('../../boss/recruiter/automation.js').RecruiterAutomation,
 *   session: import('../../boss/session.js').BossSession,
 *   limits?: {resumeMaxBytes?: number, batchSize?: number, enrichCap?: number},
 * }} deps
 */
export function registerHrTools(ctx, deps) {
  const { baseClient, recruiter, automation } = deps
  const limits = {
    resumeMaxBytes: deps.limits?.resumeMaxBytes ?? 20 * 1024 * 1024,
    batchSize: deps.limits?.batchSize ?? 50,
    enrichCap: deps.limits?.enrichCap ?? 100,
  }
  const registerRead = makeRegisterRead(ctx, recruiter)

  // ---------------------------------------------------------------- read

  registerRead('boss_hr_whoami',
    'Detect which side the current BOSS login session is on (recruiter / candidate / unknown) and whether the account has dual identity. Read-only; never switches sides. Uses the shared profile endpoint.',
    {},
    async () => {
      const zpData = await baseClient.call('userInfo')
      return classifySide(zpData)
    })

  registerRead('boss_hr_jobs',
    'List the recruiter\'s posted jobs (one page), or describe one job in full when jobId is given.',
    {
      page: { type: 'number', description: '1-based page for listing, default 1.' },
      jobId: { type: 'string', description: 'When given, return the full JD of this job instead of a page listing.' },
    },
    async (args) => (args.jobId
      ? jobs.describeJob(recruiter, { jobId: args.jobId })
      : jobs.listJobs(recruiter, { page: args.page })))

  registerRead('boss_hr_job_status',
    'Read the recruiter job list used by the chat workspace. Use boss_hr_job_online or boss_hr_job_offline for an explicit status change.',
    { page: { type: 'number', description: '1-based page, default 1.' } },
    (args) => jobs.listJobs(recruiter, { page: args.page }))

  registerRead('boss_hr_candidates',
    'Search the candidate pool for the recruiter. Pass filter codes through unchanged from prior results; carry every filter when paging so page 2 matches page 1.',
    {
      query: { type: 'string', description: 'Keyword.' },
      jobId: { type: 'string', description: 'Scope the search to one posted job.' },
      city: { type: 'string', description: 'City code from prior results.' },
      experience: { type: 'string' },
      degree: { type: 'string' },
      age: { type: 'string' },
      schoolLevel: { type: 'string' },
      activeness: { type: 'string' },
      source: { type: 'string' },
      salary: { type: 'string' },
      select: { type: 'string' },
      page: { type: 'number', description: '1-based page, default 1.' },
    },
    (args) => jobs.searchCandidates(recruiter, args))

  registerRead('boss_hr_candidate',
    'Read one candidate card from the recruiter chat/search context. This is the compact profile; use boss_hr_view_resume for the full resume path.',
    {
      geekId: { type: 'string', description: 'Candidate id from boss_hr_candidates or boss_hr_chat.', required: true },
      jobId: { type: 'string', description: 'Posted job id associated with the candidate.' },
      securityId: { type: 'string', description: 'Conversation security id.' },
    },
    (args) => jobs.describeCandidate(recruiter, args))

  registerRead('boss_hr_recommendations',
    'Read platform-recommended candidates for one posted job, including every first-contact parameter (geekId/jobId/expectId/lid/securityId) that boss_hr_greet needs. Preview the greeting before sending.',
    {
      jobId: { type: 'string', description: 'The posted job to read recommendations for.', required: true },
      page: { type: 'number', description: '1-based page, default 1.' },
    },
    async (args) => {
      const zpData = await recruiter.call('recommendGeeks', { query: { jobId: args.jobId, page: args.page ?? 1 } })
      return { geekList: zpData?.geekList ?? zpData?.result ?? [], hint: '发送打招呼前先 dry_run 预览；确认后真实发送会请求人工审批。' }
    })

  registerRead('boss_hr_chat',
    'List recruiter conversation threads, optionally filtered, and enrich each with its last-message summary (batched, operator-visible cap).',
    {
      page: { type: 'number', description: '1-based page, default 1.' },
      jobId: { type: 'string', description: 'Filter threads to one job.' },
      labelId: { type: 'number', description: '0 all / 1 new greetings / 2 in communication.' },
      enrich: { type: 'boolean', description: 'Also fetch last-message summaries (default true).' },
    },
    async (args) => {
      const listing = await conversations.listConversations(recruiter, {
        page: args.page, jobId: args.jobId, labelId: args.labelId,
      })
      if (args.enrich === false) return listing
      const enrichment = await chat.batchEnrich(recruiter, listing.conversations, {
        batchSize: limits.batchSize, cap: limits.enrichCap,
      })
      return { ...listing, enrichment: enrichment.enriched, report: enrichment.report }
    })

  registerRead('boss_hr_chatmsg',
    'Read chat history with one candidate (recruiter side), most recent first. Cursor-paged: pass maxMsgId from the previous page for older messages.',
    {
      friendId: { type: 'string', description: 'Conversation/friend id from boss_hr_chat.', required: true },
      count: { type: 'number', description: 'Messages per page, default 20.' },
      maxMsgId: { type: 'string', description: 'Oldest message id from the previous page, to page backwards.' },
    },
    async (args) => {
      const result = await chat.readConversation(recruiter, { conversationId: args.friendId }, {
        count: args.count, maxMsgId: args.maxMsgId,
      })
      const messages = result.messages.slice().reverse()
      const oldest = messages[0]?.raw?.mid ?? messages[0]?.raw?.msgId
      return {
        messages,
        nextPage: oldest !== undefined ? { maxMsgId: String(oldest) } : undefined,
      }
    })

  registerRead('boss_hr_view_resume',
    'View the candidate resume attached to a conversation (read-only; requires the candidate to have shared it — it neither requests nor accepts).',
    {
      friendId: { type: 'string', description: 'Conversation id from boss_hr_chat.', required: true },
      securityId: { type: 'string', description: 'securityId from the conversation row, improves fidelity.' },
      geekId: { type: 'string', description: 'Candidate id when the conversation row provides it.' },
      jobId: { type: 'string', description: 'Posted job id associated with the conversation.' },
      challenge: { type: 'string', description: 'Optional challenge for the newer /v2 resume endpoint.' },
    },
    async (args) => chat.viewResume(recruiter, await mergeConversationHandle(recruiter, args)))

  registerRead('boss_hr_download_resume',
    'Download a shared resume attachment to local storage (bounded by the configured size limit; oversize is refused, never truncated). Read the thread first to obtain the attachment\'s download URL.',
    {
      friendId: { type: 'string', description: 'Conversation id from boss_hr_chat.', required: true },
      downloadUrl: { type: 'string', description: 'Attachment download URL from the conversation metadata.', required: true },
      toFile: { type: 'string', description: 'Absolute local path to write the file to.', required: true },
    },
    async (args) => chat.downloadResume(recruiter, await mergeConversationHandle(recruiter, args), {
      downloadUrl: args.downloadUrl, toFile: args.toFile, maxBytes: limits.resumeMaxBytes,
    }))

  // --------------------------------------------------------------- write

  ctx.tools.register(defineTool({
    name: 'boss_hr_greet',
    description: 'Send the opening greeting that creates a conversation with a recommended candidate. Write action: requires user approval unless dry_run=true. All first-contact parameters come from boss_hr_recommendations.',
    parameters: {
      geekId: { type: 'string', description: 'Candidate id from recommendations.', required: true },
      jobId: { type: 'string', description: 'Job id from recommendations.', required: true },
      securityId: { type: 'string', description: 'securityId from recommendations.', required: true },
      expectId: { type: 'string', description: 'expectId from recommendations, when present.' },
      lid: { type: 'string', description: 'lid from recommendations, when present.' },
      greeting: { type: 'string', description: 'Greeting text (required on real sends).' },
      dry_run: { type: 'boolean', description: 'Preview the exact request without sending (no approval needed).' },
    },
    output: jsonOutput,
    async execute(args) {
      const greeting = (args.greeting ?? '').trim()
      if (!args.dry_run && !greeting) return ok({ sent: false, errorKind: 'args', message: '缺少打招呼内容（greeting）。' })
      if (args.dry_run) {
        return ok({ dryRun: true, wouldSend: { endpoint: 'zpjob/chat/start', geekId: args.geekId, jobId: args.jobId, greeting } })
      }
      try {
        return ok(await chat.greet(recruiter, args, greeting))
      } catch (error) {
        return failure(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_hr_reply',
    description: 'Send a free-text reply inside an existing candidate conversation through the recruiter HTTP API. Write action: requires user approval unless dry_run=true.',
    parameters: {
      friendId: { type: 'string', description: 'Conversation id from boss_hr_chat.', required: true },
      geekId: { type: 'string', description: 'Candidate id when available.' },
      jobId: { type: 'string', description: 'Posted job id when available.' },
      expectId: { type: 'string', description: 'Candidate expectation id when available.' },
      securityId: { type: 'string', description: 'Conversation security id when available.' },
      text: { type: 'string', description: 'Reply text.', required: true },
      dry_run: { type: 'boolean', description: 'Preview without sending (no approval needed).' },
    },
    output: jsonOutput,
    async execute(args) {
      if (args.dry_run) return ok({ dryRun: true, wouldSend: { friendId: args.friendId, text: args.text } })
      try {
        return ok(await chat.reply(recruiter, await mergeConversationHandle(recruiter, args), args.text))
      } catch (error) {
        return failure(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_hr_send_location',
    description: 'Share a job location card into a candidate conversation. Write action: requires user approval unless dry_run=true.',
    parameters: {
      friendId: { type: 'string', description: 'Conversation id from boss_hr_chat.', required: true },
      jobId: { type: 'string', description: 'The posted job whose location to share.', required: true },
      geekId: { type: 'string', description: 'Candidate id when available.' },
      expectId: { type: 'string', description: 'Candidate expectation id when available.' },
      securityId: { type: 'string', description: 'Conversation security id when available.' },
      dry_run: { type: 'boolean', description: 'Preview without sending (no approval needed).' },
    },
    output: jsonOutput,
    async execute(args) {
      if (args.dry_run) return ok({ dryRun: true, wouldSend: { friendId: args.friendId, jobId: args.jobId } })
      try {
        const handle = await mergeConversationHandle(recruiter, args)
        return ok(await chat.sendLocation(recruiter, handle, { jobId: args.jobId }))
      } catch (error) {
        return failure(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_hr_request_resume',
    description: 'Ask a candidate to share their resume through the recruiter exchange HTTP API. Write action: requires user approval unless dry_run=true.',
    parameters: {
      friendId: { type: 'string', description: 'Conversation id from boss_hr_chat.', required: true },
      geekId: { type: 'string', description: 'Candidate id when available.' },
      jobId: { type: 'string', description: 'Posted job id associated with the conversation.' },
      expectId: { type: 'string', description: 'Candidate expectation id when available.' },
      securityId: { type: 'string', description: 'Conversation security id when available.' },
      dry_run: { type: 'boolean', description: 'Preview without sending (no approval needed).' },
    },
    output: jsonOutput,
    async execute(args) {
      if (args.dry_run) return ok({ dryRun: true, wouldSend: { friendId: args.friendId, action: 'request-resume' } })
      try {
        return ok(await chat.requestResume(recruiter, await mergeConversationHandle(recruiter, args)))
      } catch (error) {
        return failure(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_hr_accept_resume',
    description: 'Finalize accepting a resume a candidate has shared in a conversation. Write action: requires user approval unless dry_run=true.',
    parameters: {
      friendId: { type: 'string', description: 'Conversation id from boss_hr_chat.', required: true },
      messageId: { type: 'string', description: 'The incoming exchange message id from the chat history.', required: true },
      geekId: { type: 'string', description: 'Candidate id when available.' },
      jobId: { type: 'string', description: 'Posted job id associated with the conversation.' },
      securityId: { type: 'string', description: 'Conversation security id when available.' },
      dry_run: { type: 'boolean', description: 'Preview without sending (no approval needed).' },
    },
    output: jsonOutput,
    async execute(args) {
      if (args.dry_run) return ok({ dryRun: true, wouldSend: { friendId: args.friendId, messageId: args.messageId } })
      try {
        const handle = await mergeConversationHandle(recruiter, args)
        return ok(await chat.acceptResume(recruiter, handle, { messageId: args.messageId }))
      } catch (error) {
        return failure(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_hr_exchange',
    description: 'Request a phone or WeChat exchange with a candidate through the recruiter HTTP API. Write action: requires user approval unless dry_run=true.',
    parameters: {
      friendId: { type: 'string', description: 'Conversation id from boss_hr_chat.', required: true },
      type: { type: 'number', description: '1 = phone, 2 = WeChat; default 1.' },
      geekId: { type: 'string', description: 'Candidate id when available.' },
      jobId: { type: 'string', description: 'Posted job id associated with the conversation.' },
      expectId: { type: 'string', description: 'Candidate expectation id when available.' },
      securityId: { type: 'string', description: 'Conversation security id when available.' },
      dry_run: { type: 'boolean', description: 'Preview without sending (no approval needed).' },
    },
    output: jsonOutput,
    async execute(args) {
      if (args.dry_run) return ok({ dryRun: true, wouldSend: { friendId: args.friendId, action: 'offer-contact-exchange' } })
      try {
        return ok(await chat.offerContactExchange(recruiter, await mergeConversationHandle(recruiter, args), { type: args.type }))
      } catch (error) {
        return failure(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_hr_interview',
    description: 'Invite a candidate to an interview through the recruiter JSON API. Write action: requires user approval unless dry_run=true.',
    parameters: {
      friendId: { type: 'string', description: 'Conversation id from boss_hr_chat.' },
      geekId: { type: 'string', description: 'Candidate id from the conversation or candidate search.', required: true },
      jobId: { type: 'string', description: 'Posted job id.', required: true },
      securityId: { type: 'string', description: 'Conversation security id.' },
      address: { type: 'string', description: 'Interview address.' },
      startTime: { type: 'string', description: 'Interview start time in the platform accepted format.' },
      description: { type: 'string', description: 'Interview note.' },
      dry_run: { type: 'boolean', description: 'Preview without sending (no approval needed).' },
    },
    output: jsonOutput,
    async execute(args) {
      const target = {
        geekId: args.geekId,
        jobId: args.jobId,
        securityId: args.securityId,
        address: args.address,
        startTime: args.startTime,
        description: args.description,
      }
      if (args.dry_run) return ok({ dryRun: true, wouldSend: { endpoint: 'zpinterview/boss/interview/invite', json: target } })
      try {
        return ok(await chat.inviteInterview(recruiter, target))
      } catch (error) {
        return failure(error)
      }
    },
  }))

  for (const [name, online, label] of [
    ['boss_hr_job_online', true, '上线'],
    ['boss_hr_job_offline', false, '下线'],
  ]) {
    ctx.tools.register(defineTool({
      name,
      description: `将一个招聘职位${label}。写操作需要人工审批，dry_run=true 时只预览。`,
      parameters: {
        jobId: { type: 'string', description: '职位 id。', required: true },
        dry_run: { type: 'boolean', description: '只预览请求，不发送。' },
      },
      output: jsonOutput,
      async execute(args) {
        if (args.dry_run) return ok({ dryRun: true, wouldSend: { jobId: args.jobId, online } })
        try {
          return ok(await jobs.setJobOnline(recruiter, { jobId: args.jobId, online }))
        } catch (error) {
          return failure(error)
        }
      },
    }))
  }

  // ---------------------------------------------------------- automation

  registerRead('boss_hr_automation',
    'Inspect or control the recruiter automation lifecycle: status (default), run (one scan-score-propose cycle; proposes actions for review, never sends — sending goes through the gated write tools), stop (persisted; blocks future cycles until cleared), resume (clears the stop flag). The stop flag governs automation only, never manual writes.',
    {
      action: { type: 'string', description: 'status | run | stop | resume, default status.' },
      reason: { type: 'string', description: 'Why the cycle is being stopped.' },
    },
    async (args) => {
      if (args.action === 'stop') return automation.stop(args.reason ?? 'operator')
      if (args.action === 'resume') return automation.resume()
      if (args.action === 'run') {
        return automation.runCycle(async (progress) => {
          // One propose-only cycle: scan the inbox, enrich, rank by urgency
          // (unread recency), and surface suggestions for operator review.
          const listing = await conversations.listConversations(recruiter, { labelId: 2 })
          progress.scanned = listing.conversations.length
          const enrichment = await chat.batchEnrich(recruiter, listing.conversations, {
            batchSize: limits.batchSize, cap: limits.enrichCap,
          })
          const byId = new Map(enrichment.enriched.map((e) => [e.conversationId, e]))
          const suggestions = listing.conversations
            .map((c) => {
              const extra = byId.get(c.conversationId)
              const scored = scoreConversation(c, extra)
              return {
                friendId: c.conversationId,
                peerName: c.peerName,
                jobTitle: c.jobTitle,
                unreadCount: c.unreadCount,
                lastMessage: extra?.lastMessageSnippet ?? null,
                lastMessageAt: extra?.lastMessageAt ?? c.lastActivityAt,
                suggestedAction: c.unreadCount > 0 ? 'reply' : 'follow-up',
                score: scored.score,
                scoreReasons: scored.reasons,
                review: scored.score >= automation.options.autoExecuteThreshold
                  ? 'high'
                  : scored.score >= automation.options.humanReviewThreshold ? 'review' : 'low',
              }
            })
            .sort((a, b) => (b.unreadCount - a.unreadCount) || String(b.lastMessageAt ?? '').localeCompare(String(a.lastMessageAt ?? '')))
            .slice(0, automation.options.maxActionsPerCycle)
          progress.proposed = suggestions.length
          automation.lastSuggestions = suggestions
        })
      }
      const status = automation.status()
      return { ...status, lastSuggestions: automation.lastSuggestions ?? [] }
    })

  registerRead('boss_hr_train',
    'Fold reviewed history back into the automation scoring thresholds. Adjusts configuration only — automated sends still pass the ask gate.',
    {
      approved: { type: 'number', description: 'Count of approved actions at the ask gate.' },
      rejected: { type: 'number', description: 'Count of rejected actions at the ask gate.' },
      edited: { type: 'number', description: 'Count of edits made at the ask gate.' },
    },
    (args) => automation.train(args ?? {}))

  // Human gate for the hr write plane: ask approval unless dry-run.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!HR_WRITE_TOOLS.has(exec.name)) return next()
    const args = (exec.arguments && typeof exec.arguments === 'object') ? exec.arguments : {}
    if (args.dry_run === true) return next()
    return {
      kind: 'ask',
      reason: `boss hr ${exec.name}: ${String(args.friendId ?? args.geekId ?? '?')}`,
      displayReason: {
        en: `Allow this recruiter-side ${exec.name.replace('boss_hr_', '')} to be sent?`,
        zh: `允许发送招聘端操作 ${exec.name.replace('boss_hr_', '')} 吗？`,
      },
    }
  })
}

/**
 * Side classification from the shared profile response. identity is numeric
 * in the live envelope (1 = recruiter-side, 0 = candidate-side) with a
 * boolean doubleIdentity; calibration against live recruiter accounts is
 * pending, so unknown shapes fall through to guidance rather than a guess.
 * @param {any} zpData
 */
function classifySide(zpData) {
  const user = zpData?.user ?? zpData ?? {}
  const identity = Number(user.identity)
  const doubleIdentity = user.doubleIdentity === true
  const side = identity === 1 ? 'recruiter' : identity === 0 ? 'candidate' : 'unknown'
  return {
    side,
    doubleIdentity,
    ready: side === 'recruiter',
    guidance: side === 'recruiter'
      ? '会话在招聘端，可使用 hr 工具。'
      : '当前会话不在招聘端：请在官方端切换到"我要招聘"后重新探测（boss_hr_whoami）。',
    raw: user,
  }
}

/** Resolve the live conversation and let callers provide fresher identifiers. */
async function mergeConversationHandle(recruiter, args) {
  // Workbench callers can carry the identifiers returned by boss_hr_chat or
  // boss_hr_candidates. Reuse them directly to avoid an extra friend-detail
  // request before every reply/exchange operation.
  if (args.geekId) {
    return {
      conversationId: String(args.friendId),
      geekId: args.geekId,
      ...(args.jobId ? { jobId: args.jobId } : {}),
      ...(args.expectId ? { expectId: args.expectId } : {}),
      ...(args.securityId ? { securityId: args.securityId } : {}),
      ...(args.challenge ? { challenge: args.challenge } : {}),
    }
  }
  const handle = await conversations.resolveConversation(recruiter, { friendId: args.friendId })
  return {
    ...handle,
    ...(args.geekId ? { geekId: args.geekId } : {}),
    ...(args.jobId ? { jobId: args.jobId } : {}),
    ...(args.expectId ? { expectId: args.expectId } : {}),
    ...(args.securityId ? { securityId: args.securityId } : {}),
    ...(args.challenge ? { challenge: args.challenge } : {}),
  }
}
