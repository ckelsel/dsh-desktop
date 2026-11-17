// 网关单测：模拟终端（裸 TCP + NDJSON，扮 DLL）+ 模拟 SDK（ws 连 SDK 面）全链路。
// 覆盖：token 拒绝 / hello 建会话 / SDK hello=终端清单 / RPC 往返（gid 还原）/
//       market.book 终端路由 / 无终端错误 / 事件扇出注入 terminal_id / 终端断开广播。
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import WebSocket from 'ws';

const TERM_PORT = 28850, SDK_PORT = 28860, TOKEN = 'test-tok';
const t0 = Date.now();
const log = (...a) => console.log(`[${Date.now() - t0}ms]`, ...a);
let failures = 0;
const check = (ok, name) => {
  console.log(ok ? `  PASS ${name}` : `  FAIL ${name}`);
  if (!ok) failures++;
};
const finish = () => {
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
  gateway.kill();
  process.exit(failures === 0 ? 0 : 1);
};
const timer = setTimeout(() => { console.log('TIMEOUT'); gateway.kill(); process.exit(1); }, 30000);

const gateway = spawn(process.execPath, ['gateway.mjs'], {
  env: { ...process.env, MT5_GATEWAY_TERMINAL_PORT: String(TERM_PORT), MT5_GATEWAY_CLIENT_PORT: String(SDK_PORT), MT5_GATEWAY_TOKEN: TOKEN },
  stdio: ['ignore', 'pipe', 'inherit'],
});
gateway.stdout.on('data', () => {}); // 吞掉网关日志（调试时改 console.log）
await new Promise(r => setTimeout(r, 600)); // 等监听

// —— 终端模拟：裸 TCP 行协议 ——
function makeTerminal() {
  const sock = connect(TERM_PORT, '127.0.0.1');
  const state = { sock, msgs: [], waiters: [] };
  let buf = '';
  sock.on('data', chunk => {
    buf += chunk.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      state.msgs.push(msg);
      state.waiters = state.waiters.filter(w => !w(msg));
    }
  });
  state.send = frame => sock.write(JSON.stringify(frame) + '\n');
  state.wait = pred => new Promise(r => {
    const found = state.msgs.find(pred);
    if (found) return r(found);
    state.waiters.push(msg => (pred(msg) ? (r(msg), true) : false));
  });
  return state;
}

// ① token 不匹配 → AUTH_FAILED 行 + 断开
{
  const bad = makeTerminal();
  await new Promise(r => bad.sock.on('connect', r));
  bad.send({ jsonrpc: '2.0', method: 'bridge.hello', params: { terminal_id: 'bad-term', role: 'SERVICE', version: '0.4.0', token: 'wrong' } });
  const rejected = await Promise.race([
    bad.wait(m => m.error?.message?.includes('AUTH_FAILED')).then(() => true),
    new Promise(r => setTimeout(() => r('timeout'), 3000)),
  ]);
  check(rejected === true, 'terminal face rejects wrong token (AUTH_FAILED)');
  bad.sock.destroy();
}

// ② SDK 先连入（terminal 后连，验证 connected 广播链路）
const sdk = new WebSocket(`ws://127.0.0.1:${SDK_PORT}`);
await new Promise((r, j) => { sdk.on('open', r); sdk.on('error', j); });
const sdkMsgs = [];
sdk.on('message', d => sdkMsgs.push(JSON.parse(d.toString())));
const waitSdk = pred => new Promise(r => {
  const wait = setInterval(() => {
    const m = sdkMsgs.find(pred);
    if (m) { clearInterval(wait); r(m); }
  }, 50);
  setTimeout(() => { clearInterval(wait); r(null); }, 3000);
});
const sdkHello = await waitSdk(m => m.method === 'bridge.hello');
check(sdkHello?.params?.role === 'GATEWAY', 'sdk hello role=GATEWAY');

// ③ 模拟终端连入（正确 token），发 hello + 组件注册
const term = makeTerminal();
await new Promise(r => term.sock.on('connect', r));
term.send({ jsonrpc: '2.0', method: 'bridge.hello', params: { terminal_id: 'term-A', role: 'SERVICE', version: '0.4.0', token: TOKEN } });
term.send({ jsonrpc: '2.0', method: 'event.component', params: { type: 'registered', component_id: '7', symbol: 'EURUSD' } });

// ④ terminal connected 事件 + component 事件注入 terminal_id
check(Boolean(await waitSdk(m => m.method === 'event.terminal' && m.params?.type === 'connected' && m.params?.terminal_id === 'term-A')), 'event.terminal connected fanned out');
const comp = await waitSdk(m => m.method === 'event.component' && m.params?.type === 'registered');
check(comp?.params?.terminal_id === 'term-A' && comp?.params?.component_id === '7', 'event.component carries terminal_id');

// ⑤ SDK RPC：account.get → 终端收到（gid），终端回包 → SDK 拿回原 id
sdk.send(JSON.stringify({ jsonrpc: '2.0', id: 'sdk-1', method: 'account.get', params: {} }));
const seen = await term.wait(m => m.method === 'account.get');
check(seen && seen.id.startsWith('g'), 'terminal received request with gateway id');
term.send({ jsonrpc: '2.0', id: seen.id, result: { login: 42 } });
const answer = await waitSdk(m => m.id === 'sdk-1');
check(answer?.result?.login === 42, 'sdk got reply with original id restored');

// ⑥ market.book 按 symbol 路由：第二个终端只有 GBPUSD MARKET 组件
const termB = makeTerminal();
await new Promise(r => termB.sock.on('connect', r));
termB.send({ jsonrpc: '2.0', method: 'bridge.hello', params: { terminal_id: 'term-B', role: 'MARKET', version: '0.4.0', token: TOKEN } });
termB.send({ jsonrpc: '2.0', method: 'event.component', params: { type: 'registered', component_id: '9', symbol: 'GBPUSD' } });
await new Promise(r => setTimeout(r, 300));
sdk.send(JSON.stringify({ jsonrpc: '2.0', id: 'sdk-2', method: 'market.book', params: { symbol: 'GBPUSD' } }));
const routed = await Promise.race([
  termB.wait(m => m.method === 'market.book').then(() => 'B'),
  term.wait(m => m.method === 'market.book').then(() => 'A'),
  new Promise(r => setTimeout(() => r(null), 3000)),
]);
check(routed === 'B', 'market.book routed to terminal with matching MARKET component');

// ⑦ 无匹配 → MARKET_NOT_FOUND
sdk.send(JSON.stringify({ jsonrpc: '2.0', id: 'sdk-3', method: 'market.book', params: { symbol: 'XXXUSD' } }));
const nf = await waitSdk(m => m.id === 'sdk-3');
check(nf?.error?.code === -32002, 'unmatched symbol returns MARKET_NOT_FOUND');

// ⑧ terminal_id 指定路由 + 路由键不出终端 + 终端断开广播
sdk.send(JSON.stringify({ jsonrpc: '2.0', id: 'sdk-4', method: 'account.get', params: { terminal_id: 'term-B' } }));
const toB = await termB.wait(m => m.method === 'account.get');
check(Boolean(toB && !('terminal_id' in toB.params)), 'terminal_id routes request and is stripped from params');
termB.sock.destroy();
check(Boolean(await waitSdk(m => m.method === 'event.terminal' && m.params?.type === 'disconnected' && m.params?.terminal_id === 'term-B')), 'terminal disconnect broadcast to sdk');

clearTimeout(timer);
finish();
