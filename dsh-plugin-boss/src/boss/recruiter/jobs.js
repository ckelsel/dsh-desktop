/**
 * Job-facing recruiter operations: listing posted jobs, describing one job,
 * and searching the candidate pool against a job.
 */
import { BossError } from '../errors.js'

/**
 * One page of the recruiter's posted jobs, with honest pagination evidence.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{page?: number}} [options]
 */
export async function listJobs(recruiter, options = {}) {
  const zpData = await recruiter.call('jobChattedList', { query: { page: options.page ?? 1 } })
  const rows = firstArray(zpData, ['data', 'result', 'list'])
  const hasMore = typeof zpData?.hasMore === 'boolean' ? zpData.hasMore : 'unknown'
  return { jobs: rows.map(toJob).filter(Boolean), page: options.page ?? 1, hasMore }
}

/**
 * Full JD of one posted job.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{jobId: string}} target
 */
export async function describeJob(recruiter, target) {
  const zpData = await recruiter.call('jobEdit', { query: { encJobId: target.jobId } })
  return zpData
}

/**
 * Search the candidate pool. Filter codes pass through unchanged — the model
 * reads them from prior results (job describes its filters); unknown values
 * are the platform's to reject.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{query?: string, city?: string, jobId?: string, experience?: string, degree?: string, age?: string, schoolLevel?: string, activeness?: string, source?: string, salary?: string, select?: string, page?: number}} [filter]
 */
export async function searchCandidates(recruiter, filter = {}) {
  if (!filter.query && !filter.jobId) {
    throw new BossError('args', '候选人搜索需要 query 关键词或 jobId 之一。')
  }
  // boss-agent-cli's recruiter search shape: source=4 means candidate-pool
  // search, city=-2 means all cities, and filterParams carries the newer
  // multi-filter payload alongside scalar fields for compatible servers.
  const query = {
    keywords: filter.query ?? '',
    city: filter.city ?? '-2',
    page: filter.page ?? 1,
    source: filter.source ?? 4,
  }
  if (filter.jobId !== undefined) query.jobId = filter.jobId
  const filterParams = {}
  for (const key of ['experience', 'degree', 'age', 'schoolLevel', 'activeness', 'salary', 'select']) {
    if (filter[key] !== undefined && filter[key] !== '') {
      query[key] = filter[key]
      filterParams[key] = filter[key]
    }
  }
  if (Object.keys(filterParams).length > 0) query.filterParams = JSON.stringify(filterParams)
  const zpData = await recruiter.call('searchGeeks', { query })
  const rows = firstArray(zpData, ['geekList', 'result', 'list'])
  const hasMore = typeof zpData?.hasMore === 'boolean' ? zpData.hasMore : 'unknown'
  return { candidates: rows, page: filter.page ?? 1, hasMore, hint: '翻页时请原样携带全部筛选条件，保证第 2 页与第 1 页同结果集。' }
}

/**
 * Read the compact candidate card used by the recruiter chat workspace. It
 * is separate from viewResume because the card is available before a resume
 * has been shared.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{geekId: string, jobId?: string, securityId?: string}} target
 */
export async function describeCandidate(recruiter, target) {
  if (!target.geekId) throw new BossError('args', '读取候选人资料需要 geekId。')
  return recruiter.call('geekInfo', {
    query: {
      geekId: target.geekId,
      encryptGeekId: target.geekId,
      ...(target.jobId ? { jobId: target.jobId, encryptJobId: target.jobId } : {}),
      ...(target.securityId ? { securityId: target.securityId } : {}),
    },
  })
}

/**
 * Switch one posted job online or offline. The HR workbench can show this
 * exact intent before the shared tools/pre-execute ask gate allows it.
 * @param {import('../client.js').BossClient} recruiter
 * @param {{jobId: string, online: boolean}} target
 */
export async function setJobOnline(recruiter, target) {
  if (!target.jobId) throw new BossError('args', '切换职位状态需要 jobId。')
  const endpoint = target.online ? 'jobOnline' : 'jobOffline'
  const zpData = await recruiter.call(endpoint, {
    form: { jobId: target.jobId, encryptJobId: target.jobId },
  })
  return { changed: true, online: target.online, jobId: target.jobId, data: zpData }
}

/**
 * @param {Record<string, any>} row
 */
function toJob(row) {
  if (!row || typeof row !== 'object') return null
  const id = row.encryptJobId ?? row.encryptId ?? row.jobId
  if (id === undefined || id === null) return null
  return {
    jobId: String(id),
    jobName: row.jobName ?? '',
    status: row.jobStatus === 0 || row.online === true ? 'online' : 'offline',
    raw: row,
  }
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
