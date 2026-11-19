/**
 * Per-conversation recruiter operations on an opened thread: reading history,
 * batched list enrichment, and every recruiter-side write (greeting, reply,
 * location card, resume view/request/accept/download, contact exchange).
 *
 * Every write participates in the plugin write gate (tools/pre-execute ask);
 * nothing here sends on its own. The known boss-agent-cli HTTP paths are
 * used directly, while an unknown platform capability still fails loudly
 * instead of being approximated with page automation.
 */
import { BossError } from '../errors.js'

/** Enrichment tuning defaults (config layer; capability contracts stay numeric-free). */
export const DEFAULT_ENRICH_OPTIONS = Object.freeze({ batchSize: 50, cap: 100 })

/**
 * Read the message history of a conversation, oldest to newest. Cursor-based
 * paging backwards: pass the oldest message id from the previous page.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{conversationId: string}} handle
 * @param {{count?: number, maxMsgId?: string | number}} [options]
 */
export async function readConversation(recruiter, handle, options = {}) {
  const query = { gid: handle.conversationId, c: options.count ?? 20, src: 0 }
  if (options.maxMsgId !== undefined && options.maxMsgId !== null && String(options.maxMsgId) !== '') {
    query.maxMsgId = options.maxMsgId
  }
  const zpData = await recruiter.call('bossChatHistory', { query })
  const messages = normalizeMessages(zpData?.result ?? zpData?.messages ?? [])
  return { messages, raw: zpData }
}

/**
 * Trailing slice of a conversation, newest first.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{conversationId: string}} handle
 * @param {{count?: number}} [options]
 */
export async function lastMessages(recruiter, handle, options = {}) {
  const result = await readConversation(recruiter, handle, { count: options.count ?? 10 })
  return result.messages.slice().reverse()
}

/**
 * Enrich a conversation list with last-message summaries, in serial batches,
 * stopping at an operator-visible cap and reporting enriched vs skipped.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{conversationId: string}[]} conversations
 * @param {{batchSize?: number, cap?: number}} [options]
 */
export async function batchEnrich(recruiter, conversations, options = {}) {
  const batchSize = options.batchSize ?? DEFAULT_ENRICH_OPTIONS.batchSize
  const cap = options.cap ?? DEFAULT_ENRICH_OPTIONS.cap
  const targets = conversations.slice(0, cap)
  const enriched = []
  let failedBatch = null
  for (let offset = 0; offset < targets.length; offset += batchSize) {
    const chunk = targets.slice(offset, offset + batchSize)
    try {
      const zpData = await recruiter.call('lastMessages', {
        form: { friendIds: chunk.map((c) => c.conversationId).join(','), src: 0 },
      })
      const rows = Array.isArray(zpData?.result) ? zpData.result : []
      for (const row of rows) {
        enriched.push({
          conversationId: String(row.uid ?? row.friendId ?? row.friendUid ?? ''),
          lastMessageSnippet: snippetOf(row),
          lastMessageSender: row.source === 1 ? 'recruiter' : 'candidate',
          lastMessageAt: row.lastTS ?? row.updateTime ?? undefined,
        })
      }
    } catch (error) {
      // A refused batch stops the read instead of hammering; report partial.
      failedBatch = { at: offset, error: String(error?.message ?? error) }
      break
    }
  }
  return {
    enriched,
    report: {
      enriched: enriched.length,
      skipped: conversations.length - targets.length,
      capped: conversations.length > targets.length,
      failedBatch,
    },
  }
}

/**
 * Send the opening greeting that creates a conversation with a candidate.
 * HTTP-reachable first-contact path; all first-contact parameters come from
 * the recommendations read.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{geekId: string, jobId: string, expectId?: string, lid?: string, securityId: string}} target
 * @param {string} greeting
 */
export async function greet(recruiter, target, greeting) {
  const text = (greeting ?? '').trim()
  if (!text) throw new BossError('args', '打招呼内容不能为空。')
  const zpData = await recruiter.call('startChat', {
    form: {
      gid: target.geekId,
      jid: target.jobId,
      expectId: target.expectId ?? '',
      lid: target.lid ?? '',
      securityId: target.securityId ?? '',
      greet: text,
      from: '',
      customGreetingGuide: -1,
      suid: '',
    },
  })
  return { sent: true, data: zpData }
}

/**
 * Free-text reply inside an existing conversation. The recruiter API requires
 * a bossEnter handshake immediately before the send path.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{conversationId: string}} handle
 * @param {string} text
 */
export async function reply(recruiter, handle, text) {
  if (!text || !text.trim()) throw new BossError('args', '回复内容不能为空。')
  await enterConversation(recruiter, handle)
  const zpData = await recruiter.call('sendReply', {
    form: { gid: handle.geekId ?? handle.conversationId, content: text.trim() },
  })
  return { sent: true, data: zpData }
}

/**
 * Share the recruiter's location card. HTTP-reachable.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{conversationId: string, securityId?: string}} handle
 * @param {{jobId: string}} locationSource job whose location to share
 */
export async function sendLocation(recruiter, handle, locationSource) {
  await enterConversation(recruiter, { ...handle, jobId: locationSource.jobId ?? handle.jobId })
  const zpData = await recruiter.call('sendJobLocation', {
    form: {
      jobId: locationSource.jobId,
      toUserId: handle.conversationId,
      ...(handle.securityId ? { securityId: handle.securityId } : {}),
    },
  })
  return { sent: true, data: zpData }
}

/**
 * View the candidate resume attached to a conversation. Read-only; requires
 * the candidate to have shared (it neither requests nor accepts).
 * @param {import('../client.js').BossClient} recruiter
 * @param {{conversationId: string, securityId?: string}} handle
 */
export async function viewResume(recruiter, handle) {
  const query = {
    geekId: handle.geekId ?? handle.conversationId,
    encryptGeekId: handle.geekId ?? handle.conversationId,
    ...(handle.jobId ? { encryptJobId: handle.jobId } : {}),
    ...(handle.securityId ? { securityId: handle.securityId } : {}),
  }
  // The v2 route requires a browser-generated challenge. Headless callers can
  // supply one when they have obtained it from a separate approved source;
  // otherwise use the stable HTTP route documented by boss-agent-cli.
  const zpData = await recruiter.call(handle.challenge ? 'viewGeekV2' : 'viewGeek', {
    query: { ...query, ...(handle.challenge ? { challenge: handle.challenge } : {}) },
  })
  return zpData
}

/**
 * Ask the candidate to share their resume through the exchange request API.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{conversationId: string}} handle
 */
export async function requestResume(recruiter, handle) {
  await enterConversation(recruiter, handle)
  const zpData = await recruiter.call('exchangeRequest', {
    form: {
      type: 3,
      uid: handle.geekId ?? handle.conversationId,
      jobId: handle.jobId ?? '',
      gid: handle.conversationId,
    },
  })
  return { sent: true, kind: 'resume', data: zpData }
}

/**
 * Finalize accepting a candidate-shared resume. HTTP-reachable.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{conversationId: string, securityId?: string}} handle
 * @param {{messageId: string}} exchange the incoming exchange message id from the chat history
 */
export async function acceptResume(recruiter, handle, exchange) {
  const zpData = await recruiter.call('exchangeAccept', {
    form: {
      mid: exchange.messageId,
      ...(handle.securityId ? { securityId: handle.securityId } : {}),
      type: 3,
    },
  })
  return { sent: true, data: zpData }
}

/**
 * Download a shared resume attachment to local storage. Bounded by the
 * caller-supplied size limit; oversize is refused, never truncated. The
 * download target comes from the conversation's attachment metadata at call
 * time (the preview check tells us a download is offerable).
 * @param {import('../client.js').BossClient} recruiter
 * @param {{conversationId: string}} handle
 * @param {{toFile: string, maxBytes: number}} options
 */
export async function downloadResume(recruiter, handle, options) {
  await recruiter.call('resumePreviewCheck', {
    query: { friendId: handle.conversationId },
  })
  // The preview check gates availability; the concrete download URL arrives
  // with the conversation's attachment metadata — the caller supplies it
  // after reading the thread (viewResume / chat history exposes it).
  if (!options.downloadUrl) {
    throw new BossError('args', '缺少附件下载地址；请先读取会话拿到附件元数据（downloadResumeUrl）。')
  }
  return recruiter.download(options.downloadUrl, { toFile: options.toFile, maxBytes: options.maxBytes })
}

/**
 * Propose a contact exchange through the exchange request API. Type 1 is
 * phone, type 2 is WeChat; accepting an incoming resume remains separate.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{conversationId: string}} handle
 */
export async function offerContactExchange(recruiter, handle, options = {}) {
  const type = Number(options.type ?? 1)
  if (![1, 2].includes(type)) throw new BossError('args', '联系方式交换 type 只能是 1（手机）或 2（微信）。')
  await enterConversation(recruiter, handle)
  const zpData = await recruiter.call('exchangeRequest', {
    form: {
      type,
      uid: handle.geekId ?? handle.conversationId,
      jobId: handle.jobId ?? '',
      gid: handle.conversationId,
    },
  })
  return { sent: true, kind: type === 1 ? 'phone' : 'wechat', data: zpData }
}

/**
 * Invite a candidate to an interview. boss-agent-cli captured this endpoint
 * as JSON; the shared client keeps it separate from form-encoded chat writes.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{geekId: string, jobId: string, securityId?: string, address?: string, startTime?: string, description?: string}} target
 */
export async function inviteInterview(recruiter, target) {
  if (!target.geekId || !target.jobId) throw new BossError('args', '约面试需要 geekId 和 jobId。')
  await enterConversation(recruiter, target)
  const json = {
    encryptGeekId: target.geekId,
    encryptJobId: target.jobId,
    ...(target.securityId ? { securityId: target.securityId } : {}),
    ...(target.address ? { address: target.address } : {}),
    ...(target.startTime ? { startTime: target.startTime } : {}),
    ...(target.description ? { description: target.description } : {}),
  }
  const zpData = await recruiter.call('interviewInvite', { json })
  return { sent: true, data: zpData }
}

/** Entering a recruiter thread is required before chat and exchange writes. */
async function enterConversation(recruiter, handle) {
  await recruiter.call('bossEnter', {
    form: {
      geekId: handle.geekId ?? handle.conversationId,
      ...(handle.expectId ? { expectId: handle.expectId } : {}),
      ...(handle.jobId ? { jobId: handle.jobId } : {}),
      ...(handle.securityId ? { securityId: handle.securityId } : {}),
    },
  })
}

/**
 * @param {any[]} rows
 * @returns {{sender: 'recruiter' | 'candidate' | 'system', text: string, sentAt?: any}[]}
 */
function normalizeMessages(rows) {
  if (!Array.isArray(rows)) return []
  return rows.map((row) => ({
    sender: row.source === 1 ? 'recruiter' : row.source === 2 ? 'candidate' : 'system',
    text: row.content ?? row.text ?? '',
    sentAt: row.time ?? row.createTime ?? undefined,
    raw: row,
  }))
}

/**
 * @param {Record<string, any>} row
 * @returns {string}
 */
function snippetOf(row) {
  const text = String(row.lastMsgInfo?.showText ?? row.content ?? row.text ?? row.msg ?? '')
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}
