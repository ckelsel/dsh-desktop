# 协议契约（唯一源头）

本目录是 MT5 Bridge 的协议唯一源头。代码必须与这里一致；
新增能力 = 先改这里，再动代码。

- registry.yaml — method/event → target → handler → MT5 API → 请求响应字段
- errors.yaml — 三层错误码全表
- envelope.md — 报文外壳（JSON-RPC 2.0 + seq）

## 分层规则

```text
SDK ⇄ DLL     ：WSS + JSON-RPC（本目录定义）
DLL ⇄ MQL5    ：Bridge_Poll/Reply/Emit 传同一 JSON 字节（envelope 不变，id 被 rid 改写）
MQL5 内部     ：MQL5 结构体（MqlTick/MqlRates/MqlTradeRequest...），
                JSON 编解码只存在于 mql5/Include/Bridge/Rpc/
```
