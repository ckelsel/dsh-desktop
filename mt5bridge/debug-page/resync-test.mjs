// P7 断档恢复：seq 单调性 + system.resync 全量重推 + 重连后 seq 重置
import WebSocket from 'ws';

const t0 = Date.now();
const log = (...a) => console.log(`[${Date.now() - t0}ms]`, ...a);
const timer = setTimeout(() => { console.log('TIMEOUT'); process.exit(1); }, 60000);
let seq_max = 0, seq_ok = true, resync_required = false, account_resync = false, pos_snapshot = false;
let reqId = null, posTicket = null, sawOut = false;

function connect(onOpen) {
  const ws = new WebSocket('ws://127.0.0.1:18860');   // 网关 SDK 面
  ws.on('message', (data) => handle(ws, data));
  ws.on('open', () => setTimeout(() => onOpen(ws), 200));
  return ws;
}

async function handle(ws, data) {
  const msg = JSON.parse(data.toString());
  if (msg.method) {
    if (msg.method === 'bridge.hello') return;
    if (msg.seq !== undefined) {
      if (msg.seq <= seq_max && seq_max > 0 && !reconnected) seq_ok = false;
      seq_max = msg.seq;
    }
    if (msg.method === 'event.resync_required') { resync_required = true; log('[event] resync_required'); }
    if (msg.method === 'event.account.changed' && msg.params.changed_fields?.includes('login')) { account_resync = true; log('[event] account 全字段重推'); }
    if (msg.method === 'event.position.changed' && msg.params.kind === 'snapshot') { pos_snapshot = true; log('[event] position snapshot', (msg.params.entries || []).length, '条'); }
    if (msg.method === 'event.position.changed' && msg.params.kind === 'added') {
      const e = msg.params.entries?.[0];
      if (e) { posTicket = e.ticket; log('[event] position added', e.ticket); }
    }
    if (msg.method === 'event.deal.added' && msg.params.deals?.some(d => d.direction === 'out')) sawOut = true;
    return;
  }
  log('<<', msg.id, JSON.stringify(msg.result || msg.error).slice(0, 120));
  if (msg.id === 'r1') { reqId = msg.result.request_id; setTimeout(() => ws.send(jrpc('r2', 'system.resync', {})), 500); }
  else if (msg.id === 'r2') {
    // 等 resync 快照事件到齐，且持仓就绪（事件 ticket 或列表兜底）
    const tryClose = (attempt) => {
      if (posTicket) { ws.send(jrpc('r3', 'position.close', { ticket: Number(posTicket) })); return; }
      if (attempt < 8) {
        ws.send(jrpc(`r2b-${attempt}`, 'position.list', {}));
        setTimeout(() => tryClose(attempt + 1), 1000);
      } else done('持仓始终未出现');
    };
    setTimeout(() => {
      if (!resync_required || !account_resync) return done('resync 事件不全');
      tryClose(0);
    }, 1500);
  }
  else if (String(msg.id).startsWith('r2b-')) {
    const list = (msg.result && msg.result.positions) || [];
    if (list.length && !posTicket) { posTicket = list[list.length - 1].ticket; log('[list] 持仓兜底', posTicket); }
  }
  else if (msg.id === 'r3') {
    if (msg.error) return done('position.close: ' + JSON.stringify(msg.error));
    setTimeout(() => ws.send(jrpc('r4', 'position.list', {})), 3000);
  }
  else if (msg.id === 'r4') {
    const left = (msg.result.positions || []).length;
    if (left > 0) return done(`平仓后仍剩 ${left} 仓`);
    reconnect();
  }
}

let reconnected = false;
function reconnect() {
  reconnected = true;
  const ws2 = new WebSocket('ws://127.0.0.1:18860');   // 网关 SDK 面
  ws2.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.method && m.seq !== undefined) {
      // P9：seq 是终端会话内序号（DLL↔网关），SDK 重连不重置——断言延续不回退
      firstSeq = firstSeq ?? m.seq;
    }
  });
  ws2.on('open', () => setTimeout(() => {
    done(null, { seq_ok, firstSeq });
  }, 2500));
}

let firstSeq = null;
function done(why, info) {
  if (why) { console.log('FAIL:', why); process.exit(1); }
  const ok = seq_ok && firstSeq !== null && firstSeq >= seq_max;   // 延续（跳号=断档期事件丢失，正常）
  console.log(ok ? `PASS: seq单调=${seq_ok} resync全量重推 OK 平仓OK SDK重连seq延续(first=${firstSeq}>=${seq_max})`
                 : `FAIL: seq单调=${seq_ok} SDK重连first=${firstSeq} < ${seq_max}`);
  clearTimeout(timer);
  try { ws.send(jrpc('unsub', 'market.unsubscribe', { symbol: 'EURUSD', period: 'M1' })); } catch {}
  setTimeout(() => process.exit(ok ? 0 : 1), 500);
}

const jrpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

// 先订阅让事件流起来（tick 事件产生 seq），再开仓 → resync → 平仓 → 重连
const ws = connect(() => {
  ws.send(jrpc('sub', 'market.subscribe', { symbol: 'EURUSD', period: 'M1' }));
  setTimeout(() => ws.send(jrpc('r1', 'trade.execute', {
    action: 'buy', symbol: 'EURUSD', volume: 0.01, deviation: 20,
    idempotency_key: 'p7-' + Date.now().toString(36),
  })), 2500);
});
