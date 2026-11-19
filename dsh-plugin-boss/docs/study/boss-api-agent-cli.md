# boss-agent-cli 逆向调研（v3.4.78）

> 源：`reference/boss-agent-cli`（Python/click，包 src/boss_agent_cli/）。与 boss-api.md（boss-cli）互补，冲突处以此篇较新（2026-10 真机抓包对齐）。

## 1. 结构

- **api/**：BossClient（求职者）、recruiter_client（招聘者）、`boss.yaml`/`recruiter.yaml` 端点规格（method/effect(read|write)/replay_safe/referer 元数据驱动重试语义）、BrowserSession（CDP 接管 Chrome 或 patchright，页面内 fetch 发请求）、throttle、request_budget（SQLite 跨进程预算互斥）、zhipin_errors（风控码分类）、cdp_risk_lock（风控即停锁）
- **auth/**：AuthManager 三级降级、token_store（Fernet 加密 session.enc，machine-id 绑定）、page_identity（抓页面 XHR 的 token/zp_token）
- **commands/**（~40 个）、**automation/**（招聘者自动回复流水线）、**mcp_server**（subprocess 包装 CLI，79 个工具）、crawler、wizard
- 输出信封 `{ok, schema_version, command, data, pagination, error, hints}`

## 2. 认证（三级降级，auth/manager.py:156-232）

1. 本地浏览器 cookie 提取（browser_cookie3，主 cookie=wt2，getUserInfo.json 验活）
2. CDP 扫码：`http://127.0.0.1:9222/json/version` 探测 → 跨 context 复用已有 wt2 → 开 `/web/user/` 扫码 1s 轮询
3. patchright 有头扫码兜底（监听 loginConfirm/dispatcher 响应 + 轮询 wt2）

另有 `boss login --curl-file`（Copy as cURL 导入，必须有 wt2）。
**纯 httpx 扫码登录已删除**（CHANGELOG.md:948：拿不到页面 JS 生成的 `__zp_stoken__`）。

**凭据字段**（browser.py:507）：`cookies`（全量，主=wt2）、`stoken`、`user_agent`、`token`、`zp_token`（页面身份头，从登录页 `/wapi/` XHR 监听抓取，"页面生成、会话期稳定、Python 无法重算只能重放"，page_identity.py:21-28）。

**stoken 处理**：无本地生成算法。GET 自动加进 query（httpx_helpers.py:123-129）；code 37 → force_refresh（CDP 开首页 2s 重读）。**CDP 模式下 httpx 禁止携带浏览器凭据**（并发复用同 stoken 会被判异常，_base_client.py:283-303）。

**存储**：`<data_dir>/auth/session.enc`（Fernet, PBKDF2-SHA256(machine-id), 480000 iter）+ salt + refresh.lock。账号指纹 SHA-256(wt2)[:16]。

## 3. 求职者侧接口（与 boss-cli 差异处加粗）

| 端点 | 规格 | 备注 |
|---|---|---|
| **搜索** | **POST** `/wapi/zpgeek/search/joblist.json`；表单全字段：`page,pageSize(15),city,query,expectInfo,multiSubway,multiBusinessDistrict,position,jobType,salary,experience,degree,industry,scale,stage,scene=1,encryptExpectId`（缺省发空串）；Referer `/web/geek/jobs` | boss-cli 用 GET 精简参数——实测以 POST 为准；支持 raw_params 覆盖 |
| 推荐 | GET `/wapi/zpgeek/pc/recommend/job/list.json?page=` | boss-cli 用新版 geekGetJob |
| 详情 | GET `/wapi/zpgeek/job/detail.json?encryptJobId=`（**非 securityId**） | 两参考不同，需实测两者 |
| **打招呼** | **POST** `/wapi/zpgeek/friend/add.json`，form `securityId, jobId, greeting`（默认招呼语） | boss-cli 是 GET `securityId,lid`——需实测 |
| 投递 | 同 friend/add.json（立即沟通链路），form `securityId, jobId[, lid]` | |
| 卡片 | GET `/wapi/zpgeek/job/card.json?securityId=&lid=` | |
| 用户信息 | GET `/wapi/zpuser/wap/getUserInfo.json` | 凭据探针 |
| 已投递 | GET `/wapi/zprelation/resume/geekDeliverList?page=`（zpData.list[]） | |
| 收藏 | GET `/wapi/zprelation/interaction/geekGetJob?page=&tag=4&isActive=true` | |
| 好友列表 | GET `/wapi/zprelation/friend/getGeekFriendList.json?page=` | |
| **聊天记录** | GET `/wapi/zpchat/geek/historyMsg?gid=&securityId=&page=&c=&src=0` | geek 侧也能读消息 |
| 换联系方式 | POST `/wapi/zpchat/exchange/request`，form `type(1手机/2微信), securityId, uniqueId, name` | |
| 面试/历史/简历 | 同 boss-cli | |

筛选码表（boss.yaml:178-386）：city 44 城、salary 402-407、exp 101-108、degree 202-209、scale 301-306、industry 100001+、stage 801-808、jobType 1901-03。

## 4. 招聘者侧（要点）

- 首次开聊 POST `/wapi/zpjob/chat/start`（form: gid,suid,jid,expectId,lid,greet,from,securityId,customGreetingGuide=-1）
- 搜候选人 GET `/wapi/zpitem/web/boss/search/geeks.json`（city=-2 全国、experience "-3,-3"、source=4、filterParams JSON）
- 在线简历 `/wapi/zpjob/view/geek/info/v2`（带 wasm `challenge`，旧接口半下线）
- 发消息前 POST `/wapi/zpchat/session/bossEnter`

## 5. batch-greet 编排（commands/greet.py:247-577）

- 筛选→搜索→`deduplicate_job_result` + SQLite `greet_records`（主键 account+job_id+security_id，account=wt2 指纹）
- dry-run 输出可复跑命令；`--count` 硬上限 10
- 单条失败重试 1 次（sleep 1-2s）；成功后 `batch_greet_delay` 默认 [2.0,5.0]s
- **停止条件（立即停批不重试）**：风控码 31/32/35/36/37、ACTION_UNCONFIRMED/UNKNOWN（结果未知禁止重放）、RATE_LIMITED/GREET_LIMIT、预算耗尽、本地记账写失败
- `watch` 命令：保存搜索条件增量监控，`watch_hits` 按 account:job_id 去重
- apply 单条幂等（apply_records 去重 + ALREADY_APPLIED 错误码）

## 6. 反爬（2026 现状，比 boss-cli 严格得多）

- **Headers**：Chrome 156 真机抓包；`traceid` 每请求随机 `F-`+24 位 [0-9a-z]（httpx_helpers.py:71-85）；`token`/`zp_token` 重放；**强制 HTTP/2**；Accept-Encoding 含 br/zstd
- **GET 一律追加 `__zp_stoken__` query**
- **throttle 默认 (30,60)s 高斯**（实测依据："15s 间隔第 3 次 search 命中 code 37，90s 通过"，config.py:9-13）；5% 概率 +2-5s；突发惩罚 15s≥3 次 +1.2-2.8s、45s≥6 次 +4-7s
- **RequestBudget**：SQLite 跨进程互斥，默认 `request_max_per_minute:20`，429/Retry-After 冷却上限 60min
- **风控码**：31(IP)/32(账号)/35/36(风险)/37(按文案二分 token 过期 vs 环境风险)；403.html/verify.html/security.html 安全页识别；命中写 `cdp_risk_lock.json`，**所有通道本地拒发直到用户显式 `boss clean --risk-lock`**
- **高风险操作（search/greet/apply/job_card）走浏览器通道**：页面内 `fetch(credentials:'include')`，由页面 JS 自己维护 stoken（browser_client.py:151-229），单次不重试
- 代理统一供 httpx+Chromium，WebRTC 泄漏防护参数

## 7. MCP 工具粒度参考（79 个，1:1 映射 CLI）

核心集：boss_status/doctor/config/clean；boss_search/recommend/detail/show/export/history/cities；boss_greet/apply/batch_greet(limit≤10+dry_run)/exchange/mark；boss_chat/chatmsg/chat_summary/pipeline/follow_up/digest/interviews/me；boss_watch_*/preset_*/shortlist_*/stats；hr_* 招聘者组。**hr_greet 等写操作内置 `yes` 批准位，SERVER_INSTRUCTIONS 禁止 Agent 自行推断**——工具级人工确认范式。

## 8. 配置

`~/.boss-agent/config.json`：request_delay:[30,60]、request_max_per_minute:20、batch_greet_delay:[2.0,5.0]、browser_source:auto、operating_mode:assisted、automation{human_review_threshold:0.65, auto_execute_threshold:0.82, max_actions_per_run:50, max_consecutive_errors:3, tabs:["新招待","未读"], max_per_tab:20}。SQLite `cache/boss_agent.db`：saved_searches/watch_hits/greet_records/apply_records/shortlist_records/search_cache/job_desc_cache。

## 9. 对 dsh-plugin-boss 的直接启示

1. **通道策略**：低风险读（detail/recommend/me）走 Node httpx 重放；高风险写（search/greet/apply）可走"webview 内 fetch 代发"（页面 JS 维护 stoken，零维护成本）——与用户"业务走 Node HTTP"的原则需要在实现时权衡：webview 代发仍是 Node 编排、只是传输在 webview。
2. **风控即停 + 本地熔断锁 + 结果未知禁止重放**——投递工具必须内置。
3. **SQLite 去重账本（account+job_id+security_id）+ dry-run + 批上限**——投递工具安全范式。
4. throttle 至少 30-60s 起步（2026 实测），远比 boss-cli 的 1s 保守。
5. 两参考冲突处（搜索 GET vs POST、greet GET vs POST、detail securityId vs encryptJobId）需在真机实测后定稿，实现时做成可配置。
