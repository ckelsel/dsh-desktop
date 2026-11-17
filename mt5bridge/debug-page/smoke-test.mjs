// V2 冒烟测试：WSS 握手 → bridge.hello → account.get → market.quote
import WebSocket from 'ws';

const url = process.argv[2] || 'ws://127.0.0.1:18860';   // 网关 SDK 面
const ws = new WebSocket(url);
const t0 = Date.now();
let hello = null;

const timer = setTimeout(() => { console.log('TIMEOUT: no hello in 5s'); process.exit(1); }, 5000);

ws.on('open', () => console.log(`[open] ${Date.now() - t0}ms`));
ws.on('error', (e) => { console.log('[error]', e.message); process.exit(1); });
ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method === 'bridge.hello') {
    hello = msg;
    console.log('[hello]', JSON.stringify(msg.params));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'smoke-1', method: 'account.get', params: {} }));
  } else if (msg.id === 'smoke-1') {
    console.log('[account.get]', Date.now() - t0 + 'ms', JSON.stringify(msg.result || msg.error));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'smoke-2', method: 'market.quote', params: { symbol: 'EURUSD' } }));
  } else if (msg.id === 'smoke-2') {
    console.log('[market.quote]', JSON.stringify(msg.result || msg.error));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'smoke-3', method: 'system.capabilities', params: {} }));
  } else if (msg.id === 'smoke-3') {
    const caps = msg.result || {};
    console.log('[capabilities] service_methods=' + (caps.service_methods || []).length, 'events=' + (caps.events || []).length);
    clearTimeout(timer);
    ws.close();
    process.exit(0);
  } else if (msg.method) {
    console.log('[event]', msg.method, 'seq=' + msg.seq);
  }
});
