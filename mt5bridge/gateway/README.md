# MT5Bridge 网关

多终端汇聚点（P9 拓扑）：每台 MT5 的 DLL（TCP client）拨号连入终端面，
SDK / dsh-desktop / debug-page 连 SDK 面。终端面 = **裸 TCP + NDJSON**
（一行 JSON + `\n`，hello 首行带 token）——该段没有浏览器，Node 直接
`net.createServer`，免掉 WS 握手/掩码；SDK 面保持 WS。

```text
npm install
node gateway.mjs            # 终端面 :18850（token），SDK 面 :18860
npm test                    # 10 项单测（模拟终端 + 模拟 SDK 全链路）
```

配置：复制 `gateway.ini.example` 为 `gateway.ini`（terminal_port /
client_port / token），环境变量 `MT5_GATEWAY_TERMINAL_PORT` /
`MT5_GATEWAY_CLIENT_PORT` / `MT5_GATEWAY_TOKEN` 优先。

## dsh-desktop 对接（P9d）

Electron main 进程两种用法：

- **直接内联**：main 起 `gateway.mjs`（child process 或移植代码），
  renderer 经 IPC 消费（老 DshBridge 的 mt5-ipc.ts / preload 模式可整套沿用，
  其节流聚合与 WebContents 生命周期绑定值得保留）
- **独立进程**：dsh main 只作为 SDK 连 `ws://127.0.0.1:18860`

路由：请求默认进有 SERVICE 组件的终端；多终端用 `params.terminal_id` 指定；
`market.book` 自动路由到有匹配 symbol MARKET 组件的终端。事件统一携带
`terminal_id`，`seq` 为终端会话内序号（DLL↔网关），SDK 侧按终端分组检测断档。
