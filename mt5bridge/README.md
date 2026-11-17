# MT5 Bridge

把 MT5 Terminal 的账户、行情、交易能力，通过 MT5 内部 Service/EA + Rust DLL，
以 **WebSocket + JSON-RPC** 直接暴露给浏览器端 SDK。

```text
浏览器 SDK
    │ WSS + JSON-RPC（全链路唯一业务协议）
    ├── 端口 18850 → mt5bridge.dll → BridgeService   （全部 RPC 请求）
    └── 端口 18851 → mt5bridge.dll → BridgeMarketEA×N（OnTick / 盘口事件流）
```

无中间服务器、无二进制业务协议。所有能力边界均经实机 spike 验证（2026-11-13，MetaQuotes-Demo）。

## 目录

```text
contracts/    协议唯一源头：registry.yaml / envelope.md / errors.yaml
mql5/         BridgeService + BridgeMarketEA + Include/Bridge 全套
native/       mt5bridge.dll（Rust，WebSocket 服务端 + 路由 + 队列）
debug-page/   纯静态 HTML，WSS 直连调试页
docs/         REQUIREMENTS / ARCHITECTURE / MESSAGE_FLOW
```

## 文档

- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — 需求定稿与实测能力矩阵
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 组件、线程模型、全双工无阻塞方案
- [docs/MESSAGE_FLOW.md](docs/MESSAGE_FLOW.md) — 消息流、延迟预算、超时语义
- [contracts/registry.yaml](contracts/registry.yaml) — method → target → handler → MT5 API 全映射
