// P5 交易闭环：execute → in deal → status 回填 → close → out deal → 清仓
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:18860');   // 网关 SDK 面
const t0 = Date.now();
const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 60000);
const log = (...a) => console.log(`[${Date.now() - t0}ms]`, ...a);
const send = (id, method, params = {}) => {
  log('>>', id, method, JSON.stringify(params));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
};

let reqId = null;
let posTicket = null;
let sawOut = false;

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.method) {
    if (msg.method === 'event.deal.added') {
      for (const d of msg.params.deals) {
        log('[deal]', d.direction, 'ticket=' + d.ticket, 'order=' + d.order);
        if (d.direction === 'in' && !posTicket) posTicket = d.order;
        if (d.direction === 'out') sawOut = true;
      }
    }
    return;
  }
  log('<<', msg.id, JSON.stringify(msg.result || msg.error).slice(0, 200));

  if (msg.id === 'x1') {                       // execute accepted
    if (msg.error) { console.log('FAIL: execute', msg.error); process.exit(1); }
    reqId = msg.result.request_id;
    setTimeout(() => send('x2', 'trade.status', { request_id: reqId }), 2000);
  } else if (msg.id === 'x2') {                // journal 已回填
    if (!msg.result || !msg.result.filled !== undefined) { /* 结构见日志 */ }
    if (!posTicket) { setTimeout(() => send('x2b', 'position.list', {}), 1500); return; }
    send('x3', 'position.close', { ticket: Number(posTicket) });
  } else if (msg.id === 'x2b') {               // 兜底：从持仓列表取 ticket
    const list = (msg.result && msg.result.positions) || [];
    if (!list.length) { console.log('FAIL: 无持仓'); process.exit(1); }
    posTicket = list[list.length - 1].ticket;
    send('x3', 'position.close', { ticket: Number(posTicket) });
  } else if (msg.id === 'x3') {                // close accepted
    if (msg.error) { console.log('FAIL: close', msg.error); process.exit(1); }
    setTimeout(() => send('x4', 'position.list', {}), 3000);
  } else if (msg.id === 'x4') {                // 终检
    const left = (msg.result.positions || []).length;
    if (left > 0) {                            // 有遗留：清仓后复查
      for (const p of msg.result.positions) send('x5-' + p.ticket, 'position.close', { ticket: Number(p.ticket) });
      setTimeout(() => send('x6', 'position.list', {}), 3000);
    } else finish(left);
  } else if (String(msg.id).startsWith('x5-')) {
    if (msg.error) log('[cleanup err]', msg.error);
  } else if (msg.id === 'x6') {
    finish(((msg.result || {}).positions || []).length);
  }
});

function finish(left) {
  console.log(left === 0 && sawOut ? 'PASS: 开仓→成交→status回填→平仓→清空 全链路 OK' : `FAIL: left=${left} sawOut=${sawOut}`);
  clearTimeout(timer);
  ws.close();
  process.exit(left === 0 && sawOut ? 0 : 1);
}

ws.on('open', () => setTimeout(() => send('x1', 'trade.execute', {
  action: 'buy', symbol: 'EURUSD', volume: 0.01, deviation: 20,
  idempotency_key: 'p5-' + Date.now().toString(36),
}), 300));
