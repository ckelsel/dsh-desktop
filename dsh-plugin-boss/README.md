# dsh-plugin-boss

BOSS 直聘插件 for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。

**范式**：业务层保持无页面逻辑，所有招聘查询、聊天、简历、交换和约面试能力走 Node 侧 HTTP 接口。内嵌 webview（仅桌面版）只保留登录、人工过人机验证和会话采集；不用 Puppeteer/Playwright/无头浏览器；不用 MCP；只用 DSH 原生 `defineTool` + `ctx.webServer`。

## 状态

- M1 插件骨架（双半体：Host 工具面 + Client 登录面板）✅
- M2 手动导入会话 + 候选人侧只读工具（status/me/search/detail）✅
- M3 桌面 webview 登录 + cookie 收割
- M4 候选人侧推荐流/已投递/聊天 + 工具面 ✅
- M5 候选人侧打招呼/投递（`tools/pre-execute` ask 门禁 + 去重账本 + dry-run）✅
- HR-1 招聘者职位、候选人、收件箱、最近消息、聊天记录、简历读取 ✅
- HR-2 招聘者打招呼、回复、发送职位、请求/接受简历、联系方式交换、约面试 ✅（全走 Node HTTP）
- HR-3 当前只维护基础接口适配；候选人流程、自动化和工作台编排后续单独设计

调研笔记见 `docs/study/`（接口清单、DSH 插件体系、桌面壳能力、生态速记）。

## 工具

| 工具 | 说明 |
|---|---|
| `boss_status` | 会话状态（来源/年龄/缺失 cookie/风控锁） |
| `boss_login` | 手动导入会话：cookie 头或 "Copy as cURL" |
| `boss_logout` | 忘记会话 |
| `boss_risk_unlock` | 风控即停后的显式解锁（需 confirmed=true） |
| `boss_me` | 用户信息（会话探活探针） |
| `boss_search` | 职位搜索（城市/薪资/经验/学历/规模/阶段/类型筛选，中文自动映射码表） |
| `boss_detail` | 职位详情（securityId 或 encryptJobId） |
| `boss_hr_whoami` | 探测当前 BOSS 会话是招聘端还是求职端 |
| `boss_hr_jobs` | 招聘职位列表和单个职位详情 |
| `boss_hr_candidates` | 招聘者候选人池搜索 |
| `boss_hr_candidate` | 读取单个候选人卡片 |
| `boss_hr_chat` | 招聘收件箱会话列表 |
| `boss_hr_last_messages` | 按会话 id 读取最近消息摘要 |
| `boss_hr_chatmsg` | 招聘聊天记录及游标翻页 |
| `boss_hr_view_resume` / `boss_hr_download_resume` | 查看和受限下载候选人简历 |
| `boss_hr_greet` / `boss_hr_reply` | 首次打招呼和会话回复 |
| `boss_hr_send_location` | 发送职位地点卡 |
| `boss_hr_request_resume` / `boss_hr_accept_resume` | 请求和接受候选人简历 |
| `boss_hr_exchange` / `boss_hr_interview` | 交换联系方式和发起面试邀请 |
| `boss_hr_job_online` / `boss_hr_job_offline` | 上线或下线招聘职位 |

招聘端写操作统一经过 `tools/pre-execute` 人工审批；`dry_run=true` 只生成请求预览，不访问平台。平台写请求禁止自动重试，网络结果未知时要求先人工核对。

## 本地开发

前置：Node ≥22.5 运行插件本体；宿主 `dsh` CLI 需 Node ≥24.9（本机已装 `H:\Program Files\nvm\v24.9.0`）。

```sh
npm install

# Host 半边快速加载（overlay）：
./dev.sh --patch ./scratch/cordis.yml --profile web --no-open
# 注意：--patch 是启动器 flag，必须放在最前。

# 正式安装（client 半边进模块图的路径）：
./dev.sh plugin --profile web add H:/Users/10240/dsh-plugin-boss
```

数据目录默认 `<DSH_HOME>/dsh-plugin-boss`（credential.json、risk-lock.json）。

## 安全设计

- 请求节流默认读 30-60s / 写 60-120s 高斯（2026 实测：15s 间隔连发 3 次 search 即触发 code 37），突发惩罚 + 限频冷却阶梯 + 5% 随机阅读停顿。
- 平台风控码（31/32/35/36/37 环境类、121/122）命中即写本地风控锁，全通道拒发，仅 `boss_risk_unlock` 显式解锁。
- 打招呼/投递将默认 dry-run、SQLite/JSON 去重账本（account+job_id+security_id）、批上限、结果未知禁止重放。

## 许可

MIT
