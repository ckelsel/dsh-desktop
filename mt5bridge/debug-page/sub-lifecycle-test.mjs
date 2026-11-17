// 订阅生命周期（不依赖行情活跃）：subscribe → event.component(registered)（挂图+EA）
// → subscriptions refs=1 → unsubscribe → unregistered（拆图）→ 订阅表空
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:18860');
const t0 = Date.now();
const log = (...a) => console.log(`[${Date.now() - t0}ms]`, ...a);
const timer = setTimeout(() => { console.log('FAIL: TIMEOUT'); process.exit(1); }, 30000);
const rpc = (id, method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

let registered = false, unregistered = false, subscribed = false, listed = false, closed = false;

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method) {
    if (msg.method === 'event.component') {
      const { type, symbol } = msg.params || {};
      log('[component]', type, symbol, 'terminal=' + (msg.params.terminal_id || '').slice(-8));
      if (type === 'registered' && symbol === 'EURUSD') registered = true;
      if (type === 'unregistered' && symbol === 'EURUSD') unregistered = true;
    }
    return;
  }
  log('<<', msg.id, JSON.stringify(msg.result || msg.error).slice(0, 120));
  if (msg.id === 's1') {
    if (msg.error) return finish(false, 'subscribe: ' + JSON.stringify(msg.error));
    subscribed = true;
    const wait = setInterval(() => {
      if (registered) { clearInterval(wait); rpc('s2', 'market.subscriptions', {}); }
    }, 200);
    setTimeout(() => { if (!registered) finish(false, '10s 内无 event.component(registered)'); }, 10000);
  } else if (msg.id === 's2') {
    const subs = (msg.result && msg.result.subscriptions) || [];
    if (subs.length !== 1 || subs[0].refs !== 1) return finish(false, 'subscriptions 应恰好 1 条 refs=1: ' + JSON.stringify(subs));
    listed = true;
    rpc('s3', 'market.unsubscribe', { symbol: 'EURUSD', period: 'M1' });
  } else if (msg.id === 's3') {
    if (msg.error) return finish(false, 'unsubscribe: ' + JSON.stringify(msg.error));
    const wait = setInterval(() => {
      if (unregistered) {
        clearInterval(wait);
        rpc('s4', 'market.subscriptions', {});
      }
    }, 200);
    setTimeout(() => { if (!unregistered) finish(false, '5s 内无 event.component(unregistered)'); }, 5000);
  } else if (msg.id === 's4') {
    closed = ((msg.result && msg.result.subscriptions) || []).length === 0;
    finish(subscribed && listed && closed, `sub=${subscribed} refs=1=${listed} 拆图=${closed}`);
  }
});

function finish(ok, why) {
  console.log(ok ? 'PASS: 订阅→挂图EA→registered→refs=1→unsubscribe→拆图unregistered→表空' : 'FAIL: ' + why);
  clearTimeout(timer);
  try { ws.close(); } catch {}
  process.exit(ok ? 0 : 1);
}

ws.on('open', () => setTimeout(() => rpc('s1', 'market.subscribe', { symbol: 'EURUSD', period: 'M1' }), 300));
