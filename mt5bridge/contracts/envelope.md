# Envelope 规格

JSON-RPC 2.0，UTF-8 文本帧。扩展字段仅两个：

| 字段 | 位置 | 说明 |
|---|---|---|
| `seq` | 事件顶层 | DLL 按连接注入，单调递增；断档 → `system.resync` |
| `target` | 请求（可选） | `SERVICE` / `MARKET`；省略时 DLL 按端口推断（18850=SERVICE，18851=MARKET） |

字段约束：

```text
请求：id（string|number，必填）、method（string，必填）、params（object，可省）
响应：id 回显 + result | error 二选一
事件：无 id；method 以 event. 开头
id 的 rid 改写：DLL 将入站 id 替换为内部整型 rid，回包还原。
               MQL5 侧只做回显，不感知 rid。
ticket 类大整数（order/deal/position）：一律字符串传输（避免 JS 精度丢失）。
时间：time_msc = epoch 毫秒（UTC）；MqlRates.time 秒级需 ×1000 由编码层完成；
      history 查询入参统一 epoch ms UTC。
```

示例与四条消息流见 `docs/MESSAGE_FLOW.md`。
