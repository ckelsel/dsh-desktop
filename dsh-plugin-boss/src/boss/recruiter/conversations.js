/**
 * Recruiter inbox surface: conversation listing, resolution to exactly one
 * target, and the open-conversation handle every chat capability consumes.
 *
 * Behavioral contracts (canonical draft):
 * - list: read-only snapshot of the recruiter's conversation threads.
 * - resolve: exactly-one invariant — zero matches fails not-found, multiple
 *   matches fails ambiguous carrying the candidates; it never guesses.
 * - open: idempotent presence handshake; navigation/focus primitive only.
 */
import { BossError } from '../errors.js'

/**
 * Map one raw filterByLabel row into the conversation summary shape.
 * Field names follow the observed platform envelope; unknown fields pass
 * through untouched for the model to inspect.
 * @param {Record<string, any>} row
 */
function toConversation(row) {
  if (!row || typeof row !== 'object') return null
  const id = row.friendId ?? row.friendUid ?? row.encryptFriendId ?? row.uid
  if (id === undefined || id === null) return null
  return {
    conversationId: String(id),
    peerName: row.name ?? row.encryptName ?? row.friendName ?? '',
    geekId: row.geekId ?? row.encryptGeekId ?? row.uid ?? row.friendUid ?? undefined,
    jobId: row.encryptJobId ?? row.jobId ?? undefined,
    jobTitle: row.jobName ?? row.jobTitle ?? undefined,
    expectId: row.expectId ?? row.encryptExpectId ?? undefined,
    securityId: row.securityId ?? row.encryptSecurityId ?? undefined,
    unreadCount: Number(row.unreadNum ?? row.unread ?? 0) || 0,
    lastActivityAt: row.updateTime ?? row.lastTime ?? undefined,
    raw: row,
  }
}

/**
 * One page of the recruiter's conversation list, optionally filtered.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{page?: number, jobId?: string, labelId?: number}} [filter]
 * @returns {Promise<{conversations: any[], page: number, hasMore: boolean | 'unknown'}>}
 */
export async function listConversations(recruiter, filter = {}) {
  const zpData = await recruiter.call('conversationsByLabel', {
    form: {
      page: filter.page ?? 1,
      encJobId: filter.jobId ?? '',
      labelId: filter.labelId ?? 0,
    },
  })
  const rows = firstArray(zpData, ['friendList', 'result', 'list'])
  const conversations = rows.map(toConversation).filter(Boolean)
  // Pagination evidence: honor an explicit platform flag when present, and
  // otherwise report unknown rather than inferring from row count.
  const hasMore = typeof zpData?.hasMore === 'boolean' ? zpData.hasMore : 'unknown'
  return { conversations, page: filter.page ?? 1, hasMore }
}

/**
 * Resolve a conversation reference to exactly one live conversation.
 * Zero matches → not-found; multiple matches → ambiguous with candidates.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{friendId: string | number}} ref
 */
export async function resolveConversation(recruiter, ref) {
  const friendId = ref.friendId !== undefined && ref.friendId !== null ? String(ref.friendId) : ''
  if (friendId === '') {
    throw new BossError('not-found', '需要 friendId 来定位会话目标（从 boss_hr_chat 的结果获取）。')
  }
  const zpData = await recruiter.call('friendDetail', { form: { friendIds: friendId } })
  const rows = firstArray(zpData, ['friendList', 'result', 'list'])
  const matches = rows.map(toConversation).filter(Boolean)
  if (matches.length === 0) {
    throw new BossError('not-found', `未找到会话目标（friendId=${friendId}）；请在官方页面核对后重试。`)
  }
  if (matches.length > 1) {
    throw new BossError('ambiguous', `目标不唯一（${matches.length} 条匹配），请补充定位条件：${matches.map((c) => `${c.conversationId}:${c.peerName}`).join(' | ')}`)
  }
  return matches[0]
}

/**
 * Open a conversation: idempotent presence handshake that returns the handle
 * the chat module consumes. Establishes no message state.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{conversationId: string, securityId?: string, geekId?: string, jobId?: string, expectId?: string}} target
 */
export async function openConversation(recruiter, target) {
  const handle = {
    conversationId: String(target.conversationId),
    securityId: target.securityId,
    geekId: target.geekId,
    jobId: target.jobId,
    expectId: target.expectId,
    openedAt: new Date().toISOString(),
  }
  await recruiter.call('bossEnter', {
    form: {
      geekId: handle.geekId ?? handle.conversationId,
      ...(handle.jobId ? { jobId: handle.jobId } : {}),
      ...(handle.expectId ? { expectId: handle.expectId } : {}),
      ...(handle.securityId ? { securityId: handle.securityId } : {}),
    },
  })
  return handle
}

/**
 * First array found under the listed keys of a wapi zpData payload; []
 * when none matches. Key order follows the live-capture shapes.
 * @param {Record<string, any> | null | undefined} zpData
 * @param {string[]} keys
 * @returns {any[]}
 */
function firstArray(zpData, keys) {
  for (const key of keys) {
    if (Array.isArray(zpData?.[key])) return zpData[key]
  }
  return []
}
