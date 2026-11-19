/**
 * Endpoint table and filter code maps.
 *
 * Sources: reference/boss-cli and reference/boss-agent-cli (both reverse
 * engineered). The two references disagree on three points — search method
 * (GET vs POST full form), greet method (GET `securityId,lid` vs POST
 * `securityId,jobId,greeting`), and the detail key (`securityId` vs
 * `encryptJobId`). Disagreements are config-selectable and default to the
 * newer boss-agent-cli capture (2026-10).
 */

export const BASE_URL = 'https://www.zhipin.com'

/**
 * @typedef {Object} EndpointSpec
 * @property {string} path
 * @property {'get' | 'post'} method
 * @property {string} referer
 * @property {'read' | 'write'} effect write effects are throttled harder and never auto-retried
 * @property {'form' | 'json'} [body] POST encoding; defaults to form
 */

/** @type {Record<string, EndpointSpec>} */
export const ENDPOINTS = Object.freeze({
  userInfo: { path: '/wapi/zpuser/wap/getUserInfo.json', method: 'get', referer: '/web/geek/job', effect: 'read' },
  search: { path: '/wapi/zpgeek/search/joblist.json', method: 'post', referer: '/web/geek/jobs', effect: 'read' },
  recommend: { path: '/wapi/zpgeek/pc/recommend/job/list.json', method: 'get', referer: '/web/geek/recommend', effect: 'read' },
  jobCard: { path: '/wapi/zpgeek/job/card.json', method: 'get', referer: '/web/geek/job', effect: 'read' },
  jobDetail: { path: '/wapi/zpgeek/job/detail.json', method: 'get', referer: '/web/geek/job', effect: 'read' },
  friendAdd: { path: '/wapi/zpgeek/friend/add.json', method: 'post', referer: '/web/geek/job', effect: 'write' },
  deliverList: { path: '/wapi/zprelation/resume/geekDeliverList', method: 'get', referer: '/web/geek/apply', effect: 'read' },
  favoriteList: { path: '/wapi/zprelation/interaction/geekGetJob', method: 'get', referer: '/web/geek/collect', effect: 'read' },
  interviewData: { path: '/wapi/zpinterview/geek/interview/data.json', method: 'get', referer: '/web/geek/apply', effect: 'read' },
  friendList: { path: '/wapi/zprelation/friend/getGeekFriendList.json', method: 'get', referer: '/web/geek/chat', effect: 'read' },
  chatHistory: { path: '/wapi/zpchat/geek/historyMsg', method: 'get', referer: '/web/geek/chat', effect: 'read' },
  resumeBase: { path: '/wapi/zpgeek/resume/baseinfo/query.json', method: 'get', referer: '/web/geek/resume', effect: 'read' },
  resumeExpect: { path: '/wapi/zpgeek/resume/expect/query.json', method: 'get', referer: '/web/geek/resume', effect: 'read' },
})

/**
 * Recruiter-side endpoints. Separate table because the referer base and the
 * session role differ from the candidate surface; the client, throttle, risk
 * lock and session substrate are shared.
 * @type {Record<string, EndpointSpec>}
 */
export const RECRUITER_ENDPOINTS = Object.freeze({
  /** Conversation list by label/job filter (the recruiter inbox). */
  conversationsByLabel: { path: '/wapi/zprelation/friend/filterByLabel', method: 'post', referer: '/web/chat/index', effect: 'read' },
  /** Resolve friend ids to full contact records. */
  friendDetail: { path: '/wapi/zprelation/friend/getBossFriendListV2.json', method: 'post', referer: '/web/chat/index', effect: 'read' },
  /** Last-message summaries, batched per call. */
  lastMessages: { path: '/wapi/zpchat/boss/userLastMsg', method: 'post', referer: '/web/chat/index', effect: 'read' },
  /** Cursor-paged chat history with one candidate. */
  bossChatHistory: { path: '/wapi/zpchat/boss/historyMsg', method: 'get', referer: '/web/chat/index', effect: 'read' },
  /** Presence handshake before messaging (idempotent navigation primitive). */
  bossEnter: { path: '/wapi/zpchat/session/bossEnter', method: 'post', referer: '/web/chat/index', effect: 'read' },
  /** Recommended candidates for one posted job, with first-contact params. */
  recommendGeeks: { path: '/wapi/zpjob/rec/geek/list', method: 'get', referer: '/web/frame/recommend/', effect: 'read' },
  /** First greeting that opens a conversation with a candidate. */
  startChat: { path: '/wapi/zpjob/chat/start', method: 'post', referer: '/web/chat/index', effect: 'write' },
  /** Share a job location card into a conversation. */
  sendJobLocation: { path: '/wapi/zpchat/message/sendJobLocation', method: 'post', referer: '/web/chat/index', effect: 'write' },
  /** Free-text message inside an existing recruiter conversation. */
  sendReply: { path: '/wapi/zpchat/fastReply/sendReplyMsg', method: 'post', referer: '/web/chat/index', effect: 'write' },
  /** Request a resume or contact exchange from a candidate. */
  exchangeRequest: { path: '/wapi/zpchat/exchange/request', method: 'post', referer: '/web/chat/index', effect: 'write' },
  /** Candidate-pool search for the recruiter. */
  searchGeeks: { path: '/wapi/zpitem/web/boss/search/geeks.json', method: 'get', referer: '/web/chat/search', effect: 'read' },
  /** Candidate card inside an open conversation. */
  geekInfo: { path: '/wapi/zpjob/chat/geek/info', method: 'get', referer: '/web/chat/index', effect: 'read' },
  /** Online resume view for a candidate. */
  viewGeek: { path: '/wapi/zpjob/view/geek/info', method: 'get', referer: '/web/chat/index', effect: 'read' },
  /** The recruiter's posted jobs. */
  jobList: { path: '/wapi/zpjob/job/data/list', method: 'get', referer: '/web/boss/job', effect: 'read' },
  /** Full JD of one posted job. */
  jobEdit: { path: '/wapi/zpjob/job/edit', method: 'get', referer: '/web/boss/job/edit', effect: 'read' },
  /** Jobs visible in the recruiter's chat workspace (boss-agent-cli endpoint). */
  jobChattedList: { path: '/wapi/zpjob/job/chatted/jobList', method: 'get', referer: '/web/chat/index', effect: 'read' },
  /** Job online/offline flips. */
  jobOnline: { path: '/wapi/zpjob/job/online', method: 'post', referer: '/web/boss/job', effect: 'write' },
  jobOffline: { path: '/wapi/zpjob/job/offline', method: 'post', referer: '/web/boss/job', effect: 'write' },
  /** Preview check before downloading a shared resume. */
  resumePreviewCheck: { path: '/wapi/zpgeek/resume/boss/preview/check.json', method: 'get', referer: '/web/chat/index', effect: 'read' },
  /** Finalize accepting a candidate-shared resume. */
  exchangeAccept: { path: '/wapi/zpchat/exchange/accept', method: 'post', referer: '/web/chat/index', effect: 'write' },
  /** Send an interview invitation; the recruiter API expects JSON, not form data. */
  interviewInvite: { path: '/wapi/zpinterview/boss/interview/invite', method: 'post', body: 'json', referer: '/web/chat/index', effect: 'write' },
  /** Newer resume endpoint; it may require a browser-generated challenge. */
  viewGeekV2: { path: '/wapi/zpjob/view/geek/info/v2', method: 'get', referer: '/web/chat/index', effect: 'read' },
})

/** Search form fields the POST variant expects, with empty-string defaults for omitted filters. */
export const SEARCH_FORM_KEYS = Object.freeze([
  'page', 'pageSize', 'city', 'query', 'expectInfo', 'multiSubway', 'multiBusinessDistrict',
  'position', 'jobType', 'salary', 'experience', 'degree', 'industry', 'scale', 'stage',
  'scene', 'encryptExpectId',
])

/** City name → code. Numeric codes of 6+ digits pass through unvalidated. */
export const CITY_CODES = Object.freeze({
  全国: '100010000', 北京: '101010100', 上海: '101020100', 广州: '101280100', 深圳: '101280600',
  杭州: '101210100', 成都: '101270100', 南京: '101190100', 武汉: '101200100', 西安: '101110100',
  苏州: '101190400', 厦门: '101230200', 长沙: '101250100', 重庆: '101040100', 天津: '101030100',
  合肥: '101220100', 郑州: '101180100', 济南: '101120100', 青岛: '101120200', 大连: '101070200',
  宁波: '101210400', 无锡: '101190200', 佛山: '101280800', 东莞: '101281600', 珠海: '101280700',
  福州: '101230100', 海口: '101310101', 石家庄: '101090100', 太原: '101100100', 沈阳: '101070100',
  长春: '101060100', 哈尔滨: '101050100', 南昌: '101240100', 贵阳: '101260100', 昆明: '101290100',
  南宁: '101300100', 兰州: '101160100', 乌鲁木齐: '101130100', 香港: '109680100',
})

/** @param {string} city Chinese name or raw numeric code */
export function resolveCity(city) {
  if (/^\d{6,}$/.test(city)) return city
  const code = CITY_CODES[city]
  if (code === undefined) {
    throw new Error(`未知城市「${city}」；可传 6 位城市代码，或从以下名称选择：${Object.keys(CITY_CODES).join('、')}`)
  }
  return code
}

/** Named filter tables for search parameters (code values only; names map in tools layer). */
export const FILTER_CODES = Object.freeze({
  salary: { '3K以下': '402', '3-5K': '403', '5-10K': '404', '10-15K': '405', '15-25K': '406', '25K以上': '407' },
  experience: { '在校生': '101', '应届生': '102', '1年以内': '103', '1-3年': '104', '3-5年': '105', '5-10年': '106', '10年以上': '107' },
  degree: { '初中及以下': '202', '中专/中技': '203', '高中': '204', '大专': '205', '本科': '206', '硕士': '207', '博士': '208' },
  scale: { '0-20人': '301', '20-99人': '302', '100-499人': '303', '500-999人': '304', '1000-9999人': '305', '10000人以上': '306' },
  stage: { '未融资': '801', '已上市': '802', '不需要融资': '803', '天使轮': '804', 'A轮': '805', 'B轮': '806', 'C轮及以上': '807' },
  jobType: { 全职: '1901', 兼职: '1902', 校园: '1903' },
})

/**
 * Map one filter group by Chinese name; raw codes pass through.
 * @param {keyof typeof FILTER_CODES} kind
 * @param {string} value
 */
export function resolveFilter(kind, value) {
  const table = FILTER_CODES[kind]
  if (!table) throw new Error(`未知筛选组「${kind}」`)
  if (value in table) return table[value]
  if (/^\d+$/.test(value)) return value
  throw new Error(`「${kind}」不认识「${value}」；可选：${Object.keys(table).join('、')}（或直接传代码）`)
}
