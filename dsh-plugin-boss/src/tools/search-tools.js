/**
 * Job discovery tools: search, detail, recommend.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveCity, resolveFilter } from '../boss/endpoints.js'
import { failure, jsonOutput, makeRegisterRead, ok } from './shared.js'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{client: import('../boss/client.js').BossClient}} deps
 */
export function registerSearchTools(ctx, deps) {
  const { client } = deps
  const registerRead = makeRegisterRead(ctx, client)

  ctx.tools.register(defineTool({
    name: 'boss_search',
    description: 'Search jobs on BOSS zhipin. Returns jobList entries keyed by securityId/lid for boss_detail.',
    parameters: {
      query: { type: 'string', description: 'Keyword, e.g. "golang" or "前端".', required: true },
      city: { type: 'string', description: 'Chinese city name (北京/上海/…) or a 6-digit city code; default 全国.' },
      page: { type: 'number', description: '1-based page number, default 1.' },
      pageSize: { type: 'number', description: 'Items per page, default 15.' },
      salary: { type: 'string', description: 'e.g. "15-25K" or a code like 406.' },
      experience: { type: 'string', description: 'e.g. "3-5年".' },
      degree: { type: 'string', description: 'e.g. "本科".' },
      scale: { type: 'string', description: 'Company size, e.g. "1000-9999人".' },
      stage: { type: 'string', description: 'Funding stage, e.g. "已上市".' },
      jobType: { type: 'string', description: '全职/兼职/校园.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
    },
    async execute(args) {
      /** @type {Record<string, string | number>} */
      const filters = { query: args.query, page: args.page ?? 1, pageSize: args.pageSize ?? 15 }
      try {
        if (args.city) filters.city = resolveCity(args.city)
        for (const key of ['salary', 'experience', 'degree', 'scale', 'stage', 'jobType']) {
          const value = args[key]
          if (value !== undefined) filters[key] = resolveFilter(key, value)
        }
        const zpData = await client.search(filters)
        return ok({ jobList: zpData?.jobList ?? [], hasMore: zpData?.hasMore ?? false, hint: zpData?.hint ?? '' })
      } catch (error) {
        return failure(error)
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'boss_detail',
    description: 'Fetch one job detail. Pass securityId (+lid when available) from boss_search, or encryptJobId when only that is known.',
    parameters: {
      securityId: { type: 'string', description: 'securityId from a search result.' },
      encryptJobId: { type: 'string', description: 'Encrypted job id alternative.' },
      lid: { type: 'string', description: 'lid from a search result; improves fidelity.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderDetail(value) }],
    },
    async execute(args) {
      /** @type {Record<string, string>} */
      const query = {}
      if (args.lid) query.lid = args.lid
      try {
        if (args.securityId) {
          query.securityId = args.securityId
          return ok(await client.call('jobDetail', { query }))
        }
        if (args.encryptJobId) {
          query.encryptJobId = args.encryptJobId
          return ok(await client.call('jobDetail', { query }))
        }
        return ok({ ok: false, message: '需要 securityId 或 encryptJobId 之一' })
      } catch (error) {
        return failure(error)
      }
    },
  }))

  registerRead('boss_recommend',
    'Fetch the recommended-jobs feed for the logged-in BOSS zhipin user.',
    { page: { type: 'number', description: '1-based page, default 1.' } },
    async (args) => {
      const zpData = await client.call('recommend', { query: { page: args.page ?? 1 } })
      return { jobList: zpData?.jobList ?? [], hasMore: zpData?.hasMore ?? false }
    })
}

/**
 * Compact model-facing rendering of a search page.
 * @param {{ok: boolean, data?: {jobList?: any[], hasMore?: boolean}}} value
 */
function renderSearch(value) {
  if (!value.ok) return JSON.stringify(value)
  const jobs = value.data?.jobList ?? []
  const lines = jobs.map((job, index) => {
    const skills = Array.isArray(job.skills) ? job.skills.join('/') : ''
    return [
      `${index + 1}. ${job.jobName ?? '?'} — ${job.brandName ?? '?'}`,
      `   ${job.salaryDesc ?? ''} | ${job.cityName ?? ''}${job.areaDistrict ?? ''} | ${job.jobExperience ?? ''} | ${job.jobDegree ?? ''}${skills ? ` | ${skills}` : ''}`,
      `   securityId: ${job.securityId ?? ''}${job.lid ? `  lid: ${job.lid}` : ''}`,
    ].join('\n')
  })
  return `共 ${jobs.length} 条${value.data?.hasMore ? '（有更多页）' : ''}\n${lines.join('\n')}`
}

/**
 * @param {{ok: boolean, data?: any}} value
 */
function renderDetail(value) {
  if (!value.ok) return JSON.stringify(value)
  const d = value.data ?? {}
  const job = d.jobInfo ?? {}
  const boss = d.bossInfo ?? {}
  const brand = d.brandComInfo ?? {}
  return [
    `${job.jobName ?? '?'} — ${job.salaryDesc ?? '?'}`,
    `${job.postDescription ?? job.jobDesc ?? ''}`.slice(0, 1500),
    `公司：${brand.brandName ?? '?'} | ${brand.industryName ?? ''} | ${brand.scaleName ?? ''} | ${brand.stageName ?? ''}`,
    `招聘者：${boss.name ?? '?'}（${boss.title ?? ''}）`,
  ].join('\n')
}
