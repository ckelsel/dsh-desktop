// P5 行情通道（单端口）：subscribe → event.component(ready) → tick 流 → book → unsubscribe
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:18860');   // 网关 SDK 面
const t0 = Date.now();
const log = (...a) => console.log(`[${Date.now() - t0}ms]`, ...a);
const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 60000);
const rpc = (id, method, params) => { log('>>', id, method); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); };
const finish = (ok, why) => {
  console.log(ok ? 'PASS: subscribe→tick流→book→unsubscribe 全链路 OK' : 'FAIL: ' + why);
  clearTimeout(timer);
  try { ws.close(); } catch {}
  process.exit(ok ? 0 : 1);
};

let ready = false, ticks = 0, bookEvents = 0, unregistered = false;

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method) {
    if (msg.method === 'event.market.tick') { ticks++; return; }
    if (msg.method === 'event.market.book') { bookEvents++; return; }
    if (msg.method === 'event.component') {
      log('[component]', JSON.stringify(msg.params));
      if (msg.params.type === 'registered' && msg.params.symbol === 'EURUSD') ready = true;
      if (msg.params.type === 'unregistered' && msg.params.symbol === 'EURUSD') unregistered = true;
    }
    return;
  }
  log('<<', msg.id, JSON.stringify(msg.result || msg.error).slice(0, 160));

  if (msg.id === 's1') {                                    // subscribe
    if (msg.error || !msg.result.subscription_id) return finish(false, 'subscribe: ' + JSON.stringify(msg.error));
    // 就绪信号：冷启动等 event.component(registered)；热订阅（refs>1，EA 已在跑）等首个 tick
    const waitReady = setInterval(() => {
      if (!ready && !ticks) return;
      clearInterval(waitReady);
      log('EA 组件就绪，收 tick 流 4s...');
      setTimeout(() => {
        if (ticks < 3) return finish(false, `tick 太少: ${ticks}`);   // 晚间 demo tick ~1.3s/个，阈值放宽
        rpc('b1', 'market.book', { symbol: 'EURUSD' });     // 同端口按 symbol 路由到 EA
        rpc('s2', 'market.subscriptions', {});
      }, 4000);
    }, 200);
    setTimeout(() => { if (!ready && !ticks) finish(false, '10s 内无 registered 事件也无 tick'); }, 10000);
  } else if (msg.id === 'b1') {                             // book 响应
    const entries = msg.result && msg.result.entries;
    if (msg.error || !Array.isArray(entries) || entries.length === 0)
      return finish(false, 'market.book: ' + JSON.stringify(msg.error || 'empty'));
    log('[book]', entries.length, '档');
    bookOk = true;
    if (subsOk) rpc('s3', 'market.unsubscribe', { symbol: 'EURUSD', period: 'M1' });
  } else if (msg.id === 's2') {
    const subs = (msg.result && msg.result.subscriptions) || [];
    if (subs.length !== 1) return finish(false, 'subscriptions 应为 1: ' + subs.length);
    subsOk = true;
    if (bookOk) rpc('s3', 'market.unsubscribe', { symbol: 'EURUSD', period: 'M1' });
  } else if (msg.id === 's3') {                             // unsubscribe
    if (msg.error) return finish(false, 'unsubscribe: ' + JSON.stringify(msg.error));
    const waitGone = setInterval(() => {
      if (!unregistered) return;
      clearInterval(waitGone);
      const tick_before = ticks;
      setTimeout(() => {
        finish(ticks === tick_before, `unsubscribe 后仍在推 tick (${ticks - tick_before})`);
      }, 2000);
    }, 200);
    setTimeout(() => { if (!unregistered) finish(false, '未收到 event.component(unregistered)'); }, 5000);
  }
});

let bookOk = false, subsOk = false;

ws.on('open', () => setTimeout(() => rpc('s1', 'market.subscribe', { symbol: 'EURUSD', period: 'M1' }), 300));
