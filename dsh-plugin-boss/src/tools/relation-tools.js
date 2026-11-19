/**
 * Relation-plane read tools: delivery history, favorites, chat contacts,
 * chat history, interviews.
 */
import { makeRegisterRead } from './shared.js'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{client: import('../boss/client.js').BossClient}} deps
 */
export function registerRelationTools(ctx, deps) {
  const registerRead = makeRegisterRead(ctx, deps.client)

  registerRead('boss_delivered',
    'List resumes the user has already delivered (applied) on BOSS zhipin.',
    { page: { type: 'number', description: '1-based page, default 1.' } },
    async (args) => {
      const zpData = await deps.client.call('deliverList', { query: { page: args.page ?? 1 } })
      return { list: zpData?.list ?? [], hasMore: zpData?.hasMore ?? false }
    })

  registerRead('boss_favorites',
    'List jobs the user collected (favorited) on BOSS zhipin.',
    { page: { type: 'number', description: '1-based page, default 1.' } },
    async (args) => {
      const zpData = await deps.client.call('favoriteList', { query: { page: args.page ?? 1, tag: 4, isActive: 'true' } })
      return { list: zpData?.list ?? [], hasMore: zpData?.hasMore ?? false }
    })

  registerRead('boss_friends',
    'List chat contacts (recruiters) on BOSS zhipin; each entry carries gid/securityId for boss_chat.',
    { page: { type: 'number', description: '1-based page, default 1.' } },
    async (args) => {
      const zpData = await deps.client.call('friendList', { query: { page: args.page ?? 1 } })
      return zpData ?? {}
    })

  registerRead('boss_chat',
    'Read chat history with one recruiter on BOSS zhipin.',
    {
      gid: { type: 'string', description: 'Conversation gid from boss_friends.', required: true },
      securityId: { type: 'string', description: 'securityId of the contact.', required: true },
      page: { type: 'number', description: '1-based page, default 1.' },
    },
    async (args) => {
      const zpData = await deps.client.call('chatHistory', {
        query: { gid: args.gid, securityId: args.securityId, page: args.page ?? 1, c: 20, src: 0 },
      })
      return zpData ?? {}
    })

  registerRead('boss_interviews',
    'Fetch interview-related data (invitations/counts) for the logged-in geek account.',
    {},
    () => deps.client.call('interviewData'))
}
