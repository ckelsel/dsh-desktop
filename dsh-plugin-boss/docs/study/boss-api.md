# BOSS 直聘 HTTP 接口清单（源：reference/boss-cli 逆向参考）

> 来源：jackwener/boss-cli（Python CLI，逆向 API）。本清单用于 Node/TS 重写参考。
> 仓库根：`reference/boss-cli`（下文 `<R>`）。所有接口同源 `https://www.zhipin.com`（`<R>\boss_cli\constants.py:11`）。
> 统一走 `_request()`（`<R>\boss_cli\client.py:252-315`），响应信封 `{code, message, zpData}`，code==0 返回 `zpData`（`client.py:216-248`）。

## 一、认证（Cookie 从哪来）

**关键 Cookie**：`REQUIRED_COOKIES = {"__zp_stoken__", "wt2", "wbg", "zp_at"}`（`constants.py:96`）。`bst` cookie 提升为请求头 `zp_token`（`client.py:183-185`）。

**核心事实：`__zp_stoken__` 由浏览器端 JS 生成，纯 HTTP 拿不到**（`auth.py:114-117, 888-899`）。
→ 我们的方案：Electron webview 人工登录后收割 cookie（替代 boss-cli 的 Camoufox headless 方案）。

boss-cli 的 cookie 渠道（优先级，`auth.py:965-988`）：
1. 凭证文件 `~/.config/boss-cli/credential.json`（TTL 7 天，过期自动刷新）
2. 环境变量 `BOSS_COOKIES`（`k=v; k=v` 格式）
3. 浏览器提取：CDP（`BOSS_CDP_URL`，loopback，`Network.getAllCookies`）/ browser_cookie3（chrome/firefox/edge/brave 等）/ 子进程兜底
4. QR 扫码登录（见下）

**QR 登录流程**（`auth.py:909-960`）：

| 步骤 | 端点 | method | 参数 | 响应要点 |
|---|---|---|---|---|
| 1 会话 | `/wapi/zppassport/captcha/randkey` | POST | 无 | `zpData: {qrId, randKey, secretKey}`（constants.py:19） |
| 2 二维码图 | `/wapi/zpweixin/qrcode/getqrcode` | GET | `content=<qrId>` | PNG（constants.py:20） |
| 3 等扫码 | `/wapi/zppassport/qrcode/scan` | GET | `uuid=<qrId>` | 长轮询 35s；`scaned: bool`；最多 6 次（constants.py:21） |
| 4 等确认 | `/wapi/zppasspassport/qrcode/scanLogin` | GET | `qrId=<qrId>` | 长轮询 35s；**必须查 body `login:true`，HTTP 200 ≠ 确认**（constants.py:22） |
| 5 领 Cookie | `/wapi/zppassport/qrcode/dispatcher` | GET | `qrId=<qrId>&pk=header-login` | Set-Cookie 发 wt2/wbg/zp_at；再 GET `/` warmup（constants.py:23） |

**token 补全**：无 `__zp_stoken__` HTTP 生成端点。boss-cli 用 Camoufox headless 开首页等 3s 收割（`browser_login.py:80-163`）——我们用 webview 人工登录替代。`code=37`（stoken 过期）→ `SessionExpiredError`（`exceptions.py:16-23`），命令层自动重提 cookie 重试一次（`commands/_common.py:41-58`）。

## 二、求职者（geek）端接口（全部 GET）

| 端点 | 参数 | 响应要点 | file:line |
|---|---|---|---|
| 搜索 `/wapi/zpgeek/search/joblist.json` | `query, city, page, pageSize`(15), 可选 `experience, degree, salary, industry, scale, stage, jobType` | `jobList[], hasMore` | constants.py:26；client.py:335-370 |
| 推荐 `/wapi/zprelation/interaction/geekGetJob` | `page, tag=5, isActive=true` | 新版 `cardList[]`（CLI 归一化为 jobList）；旧 `/wapi/zpgeek/pc/recommend/job/list.json` 已弃用 | constants.py:42；client.py:372-397 |
| 职位卡片 `/wapi/zpgeek/job/card.json` | `securityId, lid` | 摘要 | constants.py:27；client.py:399-401 |
| 职位详情 `/wapi/zpgeek/job/detail.json` | `securityId[, lid]` | `jobInfo{jobName,salaryDesc,experienceName,degreeName,locationName,skills[],postDescription}`, `bossInfo{name,title}`, `brandComInfo{brandName,industryName,scaleName,stageName}` | constants.py:28；client.py:403-408 |
| 浏览历史 `/wapi/zpgeek/history/joblist.json` | `page` | `jobList[], hasMore` | constants.py:29 |
| 用户信息 `/wapi/zpuser/wap/getUserInfo.json` | 无 | userId/name/avatar | constants.py:32 |
| 简历基本信息 `/wapi/zpgeek/resume/baseinfo/query.json` | 无 | name/age/degreeCategory | constants.py:33 |
| 求职期望 `/wapi/zpgeek/resume/expect/query.json` | 无 | 期望职位/薪资/城市 | constants.py:34 |
| 已投递 `/wapi/zprelation/resume/geekDeliverList` | `page` | `cardList[], totalCount`；card: `jobInfo{jobName,salaryDesc}, brandInfo{brandName}, deliverStatusDesc, updateTimeDesc` | constants.py:36；解析 personal.py:27-57 |
| 面试数据 `/wapi/zpinterview/geek/interview/data.json` | 无 | `interviewList[]: jobName, brandName, interviewTime, address, statusDesc` | constants.py:37 |
| 聊天列表 `/wapi/zprelation/friend/getGeekFriendList.json` | 无 | `friendList[]: name, brandName, jobName, lastMsg` | constants.py:40 |
| **打招呼/投递 `/wapi/zpgeek/friend/add.json`** | `securityId[, lid]` | 成功即建立会话 | constants.py:41；client.py:446-451 |

**jobList 项字段**（index_cache.py:35-47）：`securityId, jobName, brandName, salaryDesc, cityName, areaDistrict, businessDistrict, jobExperience, jobDegree, skills[], lid`。`securityId`+`lid` 是 detail/card/greet 的关键参数。

**筛选码表**（constants.py）：薪资 401-408（:149-158）、经验 101-108（:161-169）、学历 202-209（:172-181）、行业（:184-210）、规模 301-306（:213-221）、阶段 801-808（:224-234）、职位类型 1901-1903（:237-241）。

**注意**：geek 侧**没有**发消息/上传附件简历端点。批量打招呼 1.5s 间隔在 `commands/social.py:166-168`。

## 三、招聘者（recruiter）端接口（多数 POST form）

| 端点 | method | 参数 | file:line |
|---|---|---|---|
| 在招职位 `/wapi/zpjob/job/chatted/jobList` | GET | 无 | constants.py:51 |
| 候选人列表 `/wapi/zprelation/friend/filterByLabel` | POST(form) | `labelId, page[, encJobId, sort]` | constants.py:47 |
| 候选人详情 `/wapi/zprelation/friend/getBossFriendListV2.json` | POST(form) | `friendIds="id1,id2"`（逗号串） | constants.py:48 |
| 最近消息 `/wapi/zpchat/boss/userLastMsg` | POST(form) | `friendIds, src=0` | constants.py:49 |
| 聊天记录 `/wapi/zpchat/boss/historyMsg` | GET | `gid, c, src=0[, maxMsgId]` | constants.py:50 |
| 搜索候选人 `/wapi/zpitem/web/boss/search/geek/info` | GET | `query, city, page[, encryptJobId, experience, degree, salary]`；Referer `/web/chat/search` | constants.py:60 |
| 候选人简历 `/wapi/zpjob/view/geek/info` | GET | `encryptGeekId, encryptJobId[, securityId]` | constants.py:61 |
| 发消息 `/wapi/zpchat/fastReply/sendReplyMsg` | POST(form) | `gid, content` | constants.py:62 |
| boss 加好友 `/wapi/zprelation/friend/bossAddFriend` | — | 定义未用；README 注明被 stoken 反爬拦截 | constants.py:63 |
| 交换请求 `/wapi/zpchat/exchange/request` | POST(form) | `type(1手机2微信3简历), uid, jobId, gid` | constants.py:68 |
| 约面试 `/wapi/zpinterview/boss/interview/invite` | POST(**JSON**) | `encryptGeekId, encryptJobId, securityId[, address, startTime, description]` | constants.py:70 |
| 进入会话 `/wapi/zpchat/session/bossEnter` | POST(form) | `geekId, expectId, jobId, securityId`；**发消息前必须调用** | constants.py:72 |

## 四、请求伪装要点

**Headers**（constants.py:75-93，Chrome 145 / macOS 固定 UA）：
```
User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36
sec-ch-ua: "Chromium";v="145","Not(A:Brand";v="99","Google Chrome";v="145"
sec-ch-ua-mobile: ?0 / sec-ch-ua-platform: "macOS"
Sec-Fetch-Dest: empty / Sec-Fetch-Mode: cors / Sec-Fetch-Site: same-origin
Accept: application/json, text/plain, */*
Accept-Language: zh-CN,zh;q=0.9,en;q=0.8
Origin: https://www.zhipin.com / Referer: https://www.zhipin.com/
```

**每请求追加**（client.py:178-214）：`X-Requested-With: XMLHttpRequest`；`zp_token: <bst>`（存在时）；按端点覆写 Referer——search→`/web/geek/job?query=`；recommend→`/web/geek/recommend`；card/detail→`/web/geek/job`；history→`/web/geek/history`；friendList/add→`/web/geek/chat`；boss search geek→`/web/chat/search`；其余 boss→`/web/chat/index`。

**Cookie 组织**：整包 dict 注入 + Set-Cookie 自动 merge（client.py:92-102, 172-176）。**无 URL 签名/加密参数**，安全全靠 `__zp_stoken__` + UA/Referer。

**防封/限速**（client.py:63-168）：
- 间隔 1.0s + 高斯抖动(mean .3 σ.15)；5% 概率额外停 2-5s
- 突发惩罚：15s 内 ≥3 次 → +1.2-2.8s；45s 内 ≥6 次 → +4-7s
- 429/5xx 指数退避 ≤3 次；code=9（限频）→ 冷却 min(60, 10×2^(n-1))s 并基础延迟翻倍
- HTML 响应（登录重定向探测）与 404 反爬拦截处理（client.py:286-300）
- UA 全程固定单一身份

## 五、城市代码表

`constants.py:99-146` `CITY_CODES`（全国=100010000、北京=101010100、上海=101020100、广州=101280100、深圳=101280600 等 ~45 个）。解析 `resolve_city`/`list_cities`（client.py:648-657）。

## 六、错误码语义

`0` 成功；`9` 限频；`17/19` 参数错；`37` stoken 过期；`121/122` 安全系统拦截（需浏览器验证）。

## 七、Node/TS 重写要点

- geek 侧全 GET+query；recruiter POST 多为 form-encoded，约面试是 JSON body
- `friendIds` 是逗号串非数组
- QR 长轮询 35s 读超时；scanLogin 必查 body `login` 字段
- 凭证探针：`search_jobs(query="Python", city="100010000", page=1, page_size=1)` + `get_recommend_jobs(page=1)`（auth.py:1023-1038）
- sourceType 映射：1=搜索 2=推荐 3=打招呼 5=主动沟通（recruiter.py:488）
