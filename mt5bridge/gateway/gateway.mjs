// MT5Bridge 网关（P9）：终端面（裸 TCP + NDJSON）+ SDK 面（WebSocket）双监听。
//
//   MT5 (DLL=client) ──连──▶ 终端面 :18850（hello 带 token，行协议 JSON\n）
//   SDK / 调试页     ──连──▶ SDK 面 :18860（ws 库；hello = GATEWAY + 终端清单）
//
// 终端面消费者只有自家 DLL，无浏览器——裸 TCP + NDJSON 免掉 WS 握手/掩码/分片，
// Node 侧直接 net.createServer，抓包可读。SDK 面保持 WS（调试页/多语言客户端生态）。
//
// 路由：params.terminal_id 优先；market.book → 有匹配 symbol MARKET 组件的终端；
//       其余 → 有 SERVICE 组件的终端。事件扇出注入 terminal_id；seq 为终端会话内序号（透传）。
// 心跳：终端面应用层 system.ping（15s）/ 30s 无入站销毁（DLL 回 system.pong）。
//
// 配置：同目录 gateway.ini（terminal_port / client_port / token），env 优先：
//   MT5_GATEWAY_TERMINAL_PORT / MT5_GATEWAY_CLIENT_PORT / MT5_GATEWAY_TOKEN
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';

// 与 native router.rs 的 MARKET_METHODS / contracts/registry.yaml target: MARKET 一致
const MARKET_METHODS = new Set(['market.book']);
// 1:1 回放的 agent 里 OnTimer 抽干节奏被视觉流挤到数秒以上，请求在 30s 内可能回不来；
// 环境变量可放宽（BRIDGE_REQUEST_TTL_MS），默认维持 30s 契约。
const REQUEST_TTL_MS = Number(process.env.BRIDGE_REQUEST_TTL_MS ?? 30_000);
const TERMINAL_IDLE_MS = 30_000;

function loadIni() {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'gateway.ini');
  const ini = {};
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith(';') || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq > 0) ini[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
  } catch { /* 无 ini = 全默认 */ }
  return {
    terminalPort: Number(process.env.MT5_GATEWAY_TERMINAL_PORT ?? ini.terminal_port ?? 18850),
    clientPort: Number(process.env.MT5_GATEWAY_CLIENT_PORT ?? ini.client_port ?? 18860),
    token: process.env.MT5_GATEWAY_TOKEN ?? ini.token ?? '',
  };
}

const log = (...a) => console.log(`[gw ${new Date().toISOString().slice(11, 23)}]`, ...a);

// ── 终端会话表 ────────────────────────────────────────────────
// terminal_id → { sock, role, components: Map(component_id → {symbol}) }
const terminals = new Map();

function terminalSnapshot() {
  return [...terminals.values()].map(t => ({
    terminal_id: t.terminal_id, role: t.role,
    components: [...t.components.entries()].map(([component_id, c]) => ({ component_id, symbol: c.symbol })),
  }));
}

// ── SDK 面（WS，ws 库） ────────────────────────────────────────
const sdkConns = new Set();
let nextGid = 0;
// gid → { sdk, sdkId, timer }
const pending = new Map();

function sdkSend(sdk, frame) { if (sdk.readyState === WebSocket.OPEN) sdk.send(JSON.stringify(frame)); }
function sdkError(sdk, id, code, message) { sdkSend(sdk, { jsonrpc: '2.0', id, error: { code, message } }); }

function pickTerminal(method, params) {
  const wanted = params?.terminal_id;
  if (wanted) {
    const t = terminals.get(wanted);
    if (!t || t.sock.destroyed) return { err: [-32010, 'TERMINAL_NOT_FOUND', `terminal ${wanted} is not connected`] };
    return { terminal: t };
  }
  if (MARKET_METHODS.has(method)) {
    const symbol = params?.symbol;
    for (const t of terminals.values()) {
      for (const c of t.components.values()) if (c.symbol === symbol) return { terminal: t };
    }
    return { err: [-32002, 'MARKET_NOT_FOUND', `no terminal serves ${symbol}`] };
  }
  const service = [...terminals.values()].find(t => t.role === 'SERVICE');
  if (!service) return { err: [-32001, 'SERVICE_NOT_READY', 'no terminal with a SERVICE component'] };
  return { terminal: service };
}

function onSdkText(sdk, text) {
  let msg;
  try { msg = JSON.parse(text); } catch { return sdkError(sdk, null, -32700, 'PARSE_ERROR'); }
  if (typeof msg.method !== 'string') return; // SDK 通知未定义，忽略
  const { err, terminal } = pickTerminal(msg.method, msg.params);
  if (err) return sdkError(sdk, msg.id ?? null, err[0], `${err[1]}: ${err[2]}`);
  const gid = `g${++nextGid}`;
  const timer = setTimeout(() => {
    if (pending.delete(gid)) sdkError(sdk, msg.id ?? null, -32003, 'REQUEST_TIMEOUT: gateway-to-terminal timed out');
  }, REQUEST_TTL_MS);
  pending.set(gid, { sdk, sdkId: msg.id ?? null, timer });
  const params = { ...msg.params };
  delete params.terminal_id; // 路由键不出终端
  terminal.sock.write(JSON.stringify({ jsonrpc: '2.0', id: gid, method: msg.method, params }) + '\n');
}

function startClientFace(port) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port }, () =>
    log(`sdk face (ws) listening on 127.0.0.1:${port}`));
  wss.on('connection', (ws) => {
    sdkConns.add(ws);
    ws.send(JSON.stringify({
      jsonrpc: '2.0', method: 'bridge.hello',
      params: { role: 'GATEWAY', version: '0.4.0', terminals: terminalSnapshot() },
    }));
    ws.on('message', (data) => onSdkText(ws, data.toString()));
    ws.on('close', () => sdkConns.delete(ws));
    ws.on('error', () => sdkConns.delete(ws));
  });
  return wss;
}

// ── 终端面（裸 TCP + NDJSON） ─────────────────────────────────
function broadcastToSdk(frame) {
  const text = JSON.stringify(frame);
  for (const sdk of sdkConns) if (sdk.readyState === WebSocket.OPEN) sdk.send(text);
}

function dropTerminal(terminal_id, reason) {
  const t = terminals.get(terminal_id);
  if (!t) return;
  terminals.delete(terminal_id);
  if (!t.sock.destroyed) t.sock.destroy();
  broadcastToSdk({ jsonrpc: '2.0', method: 'event.terminal', params: { type: 'disconnected', terminal_id, reason } });
  log(`terminal ${terminal_id} disconnected: ${reason}`);
}

function onTerminalLine(t, line) {
  clearTimeout(t.idleTimer);
  t.idleTimer = setTimeout(() => dropTerminal(t.terminal_id, 'idle timeout'), TERMINAL_IDLE_MS);
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'system.pong' || msg.method === 'system.ping') return; // 心跳，不出网关
  if (msg.method) {
    if (msg.method === 'bridge.hello') {
      if (t.token !== undefined) return; // 已认证过，重复 hello 忽略
      if (cfg.token && msg.params?.token !== cfg.token) {
        t.sock.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'AUTH_FAILED: token mismatch' } }) + '\n');
        setTimeout(() => t.sock.destroy(), 200);
        log('terminal connection rejected: token mismatch');
        return;
      }
      const id = msg.params?.terminal_id || `anon-${t.connId}`;
      if (terminals.has(id) && terminals.get(id).sock !== t.sock) {
        log(`terminal ${id} reconnected; replacing old session`);
        terminals.get(id).sock.destroy();
        terminals.delete(id);
      }
      t.terminal_id = id;
      t.role = msg.params?.role || 'SERVICE';
      t.version = msg.params?.version || '';
      t.token = msg.params?.token || '';
      terminals.set(id, t);
      broadcastToSdk({ jsonrpc: '2.0', method: 'event.terminal', params: { type: 'connected', terminal_id: id, role: t.role } });
      log(`terminal ${id} connected (role=${t.role} v${t.version})`);
      return;
    }
    if (!t.terminal_id) return; // 未认证连接只认 hello
    if (msg.method === 'event.component') {
      const { type, component_id, symbol } = msg.params || {};
      if (type === 'registered') t.components.set(component_id, { symbol });
      else if (type === 'unregistered') t.components.delete(component_id);
    }
    // 全部事件（含 component / resync_required / market.*）扇出到 SDK，注入 terminal_id
    broadcastToSdk({ ...msg, params: { ...msg.params, terminal_id: t.terminal_id } });
    return;
  }
  if (!t.terminal_id) return;
  // 响应：gid 还原 SDK id
  const gid = typeof msg.id === 'string' ? msg.id : String(msg.id);
  const p = pending.get(gid);
  if (!p) return; // 迟到回包丢弃
  pending.delete(gid);
  clearTimeout(p.timer);
  sdkSend(p.sdk, { jsonrpc: '2.0', id: p.sdkId, ...('result' in msg ? { result: msg.result } : { error: msg.error }) });
}

function startTerminalFace(port) {
  let connSeq = 0;
  const server = createServer((sock) => {
    sock.setNoDelay(true);
    const t = { sock, connId: ++connSeq, terminal_id: null, role: '', version: '', components: new Map(), idleTimer: null };
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) onTerminalLine(t, line);
      }
      if (buf.length > 8 * 1024 * 1024) sock.destroy(); // 超长防护
    });
    sock.on('close', () => { clearTimeout(t.idleTimer); if (t.terminal_id) dropTerminal(t.terminal_id, 'closed'); });
    sock.on('error', () => { clearTimeout(t.idleTimer); if (t.terminal_id) dropTerminal(t.terminal_id, 'error'); });
    log(`terminal connection #${t.connId} accepted`);
  });
  server.listen(port, '0.0.0.0', () => log(`terminal face (tcp/ndjson) listening on 0.0.0.0:${port}${cfg.token ? ' (token on)' : ''}`));
  // 应用层心跳：15s ping；空闲销毁由 idleTimer 判定（pong/任意行都会刷新）
  const ping = setInterval(() => {
    const line = JSON.stringify({ jsonrpc: '2.0', method: 'system.ping', params: { time_ms: Date.now() } }) + '\n';
    for (const t of terminals.values()) if (!t.sock.destroyed) t.sock.write(line);
  }, 15_000);
  ping.unref();
  return server;
}

// ── 启动 ──────────────────────────────────────────────────────
const cfg = loadIni();
startTerminalFace(cfg.terminalPort);
startClientFace(cfg.clientPort);
log(`gateway up — terminals: tcp://${cfg.terminalPort} (ndjson${cfg.token ? ', token in hello' : ''}); sdk: ws://127.0.0.1:${cfg.clientPort}`);
