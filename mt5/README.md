# DshBridge（MT5 EA）

DshBridge 把 MetaTrader 5 终端接到 DSH Desktop。

- **阶段 1（当前）**：桌面端行情页显示 MT5 的连接状态、账户和资金。
- **之后的阶段**：品种、行情、持仓、历史，然后是交易。

协议见 [PROTOCOL.md](PROTOCOL.md)。

## 工作方式

- **连接方向**：EA 是 TCP 客户端，由它主动连接桌面端，因为 MQL5 的 socket 不能监听。桌面端在主进程里监听，默认端口 19500。
- **数据来源**：MT5 是唯一的来源。桌面端只显示 EA 报告的状态，不做乐观更新。
- **数量**：一个桌面端同时只接一个账户。EA 只挂在一个图表上，挂哪个图表都可以。

```
MQL5/
  Experts/DshBridge.mq5          EA 入口：参数、连接文件、定时器
  Include/DshBridge/Json.mqh     JSON 解析和生成
  Include/DshBridge/Transport.mqh  TCP 连接，按行收发 UTF-8
  Include/DshBridge/Protocol.mqh   协议信封
  Include/DshBridge/Account.mqh    system.status 和 account.snapshot
  Include/DshBridge/Bridge.mqh     会话：握手、应答、心跳、推送变化、重连
```

源码只用 ASCII 字符，换行是 CRLF。

## 安装

1. **找到数据目录**：在 MT5 里点「文件 → 打开数据文件夹」。
2. **复制文件**：
   - `MQL5/Experts/DshBridge.mq5` 复制到数据目录的 `MQL5\Experts\`。
   - `MQL5/Include/DshBridge/` 整个目录复制到数据目录的 `MQL5\Include\DshBridge\`。
3. **编译**：在 MetaEditor 里打开 `DshBridge.mq5`，按 F7。也可以用命令行，在 PowerShell 里运行：

   ```powershell
   $p = Start-Process -FilePath "<MT5 安装目录>\metaeditor64.exe" -Wait -PassThru -ArgumentList @(
     '/compile:"<数据目录>\MQL5\Experts\DshBridge.mq5"', "/log:`"$env:TEMP\dshbridge.log`"")
   Get-Content "$env:TEMP\dshbridge.log" -Encoding Unicode | Select-Object -Last 1
   ```

   - **结果**：最后一行应是 `0 errors, 0 warnings`。日志是 UTF-16 编码。退出码 1 表示编译成功。
   - **路径**：路径里有空格时要加引号。
   - **更新已挂的 EA**：命令行编译不会通知正在运行的终端，图表上的 EA 仍是旧版本。要先把它从图表移除，再重新挂上。
4. **允许 EA 连接桌面端**：打开「工具 → 选项 → EA 交易」，勾选「允许 WebRequest 的 URL 列表」，把桌面端的地址加进去，例如 `10.0.0.9`。桌面端和 MT5 在同一台电脑上时，加入 `127.0.0.1`。
5. **配置桌面端**：打开桌面端「设置」里的「MT5 连接」。
   - 打开「启用 MT5 连接」。默认就是开的。
   - MT5 在另一台电脑上时：打开「允许局域网连接」，再在「允许连接的 EA 地址」里填 MT5 电脑的 IP，例如 `10.0.0.13`。
   - 复制「EA 令牌」。
6. **把连接信息交给 EA**，两种方式任选一种：
   - **EA 参数**：`DesktopHost`、`DesktopPort`、`Token`。
   - **连接文件**：`MQL5\Files\DshBridge\connection.txt`，参数留空时读取它。`#` 开头的行是注释。

     ```
     host=10.0.0.9
     port=19500
     token=<设置页里复制的令牌>
     ```

   - **优先级**：参数优先于文件。两边都没填时，EA 连接 `127.0.0.1:19500`。
   - **何时生效**：EA 只在启动时读取连接文件。改了文件之后，要把 EA 从图表移除再重新挂上。
7. **挂上 EA**：在「导航器 → EA 交易」里，把 DshBridge 拖到任意一个图表上。

几秒之内，桌面端行情页底部的连接标签会变成「已连接」，账户 Tab 显示的账户和资金应与 MT5「交易」窗口一致。

**算法交易权限**：工具栏的「算法交易」按钮，和 EA 属性里的「允许算法交易」，到阶段 3 下单时才必须打开。阶段 1 只读取数据，不需要它们。这两项的状态会显示在桌面端的连接详情里。

## 运行状态

EA 在图表左上角显示当前状态：

| 显示 | 含义 |
|---|---|
| `Connecting...` | 正在连接桌面端。 |
| `Connected; authenticating...` | 已连上，正在用令牌验证。 |
| `Connected: account … on …` | 已连接，正在推送账户。 |
| `Disconnected: …` 或其他文字 | 失败原因，见下面的排错表。 |

- **日志**：「工具箱 → 专家」日志里，同一种失败只记一次；之后每次连接成功也会记一条。
- **重连**：连接失败后，EA 依次隔 1、2、4、8 秒重试，之后每 10 秒一次。令牌错误或桌面端忙时，每 30 秒重试一次。
- **同步**：桌面端重启、EA 重启或网络恢复后，EA 自动重连，桌面端重新同步。

## 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `The terminal does not allow this address …` | 错误 4014：桌面端地址不在 WebRequest 列表里。 | 按安装第 4 步添加。 |
| `Cannot connect to …, error 5272` | 连不上桌面端：桌面端没在运行、端口不对、没开局域网连接，或者被防火墙拦截。 | 查看设置页「MT5 连接」里显示的监听地址。 |
| `Disconnected: auth_failed: …` | 令牌不对。 | 重新复制令牌。设置页「重新生成」之后，旧令牌立即失效。 |
| `Disconnected: busy: …` | 另一个账户的 EA 已经连着桌面端。 | 先移除那个 EA。 |
| `No token: …` | 参数和连接文件里都没有令牌。 | 按安装第 6 步填写。 |
| 设置页显示「最近拒绝 … 来源地址不在允许列表中」 | EA 所在电脑的 IP 不在白名单里。 | 把这个 IP 加进「允许连接的 EA 地址」。 |
| 不能在策略测试器里运行 | 测试器里没有网络功能。 | 只在实时图表上运行。 |

## 安全

- **明文连接**：连接没有加密，所以只在可信的局域网里打开「允许局域网连接」。实盘交易之前会加上 TLS。
- **令牌**：令牌保存在桌面端用户目录下的 `mt5-bridge.json` 里，只有当前用户能读，不写进偏好设置。
- **实盘账户**：默认不允许交易。
