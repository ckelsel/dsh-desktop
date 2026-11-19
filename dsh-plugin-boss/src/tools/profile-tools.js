/**
 * Self-profile tools: me probe and resume.
 */
import { makeRegisterRead } from './shared.js'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{client: import('../boss/client.js').BossClient}} deps
 */
export function registerProfileTools(ctx, deps) {
  const registerRead = makeRegisterRead(ctx, deps.client)

  registerRead('boss_me',
    'Fetch the logged-in BOSS zhipin user profile (name, identity, avatar) — also the session liveness probe.',
    {},
    () => deps.client.call('userInfo'))

  registerRead('boss_resume',
    'Fetch the user\'s BOSS zhipin resume: base profile plus all job expectations.',
    {},
    async () => {
      const [base, expect] = await Promise.all([
        deps.client.call('resumeBase').catch((error) => ({ error: String(error?.message ?? error) })),
        deps.client.call('resumeExpect').catch((error) => ({ error: String(error?.message ?? error) })),
      ])
      return { base, expect }
    })
}
