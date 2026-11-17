// 周末品种扫描：symbol.list 全量 → 逐个 market.quote 看 tick 时间是否新鲜（<10 分钟）。
// 对任何新鲜品种再 subscribe 5s 验证真有推流。目的：找休市日仍活跃的品种（加密/OTC）。
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:18860');
const t0 = Date.now();
const log = (...a) => console.log(`[${Date.now() - t0}ms]`, ...a);
const rpc = (id, method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
const timer = setTimeout(() => { console.log('FAIL: TIMEOUT'); process.exit(1); }, 120000);

let fresh = [];   // tick 距今 < 10 分钟
let seen = 0, total = 0;
const CONCURRENCY = 12;
let inflight = 0;
const all = [];

function pump() {
  while (inflight < CONCURRENCY && all.length) {
    const sym = all.shift();
    inflight++;
    rpc('q:' + sym, 'market.quote', { symbol: sym });
  }
}

ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.method || !String(m.id).startsWith('q:')) return;
  inflight--;
  seen++;
  const sym = m.id.slice(2);
  if (m.result && typeof m.result.time_msc === 'number') {
    const ageMs = Date.now() - m.result.time_msc;
    if (ageMs < 10 * 60_000) { fresh.push({ sym, ageSec: Math.round(ageMs / 1000) }); log('FRESH', sym, 'tick age', Math.round(ageSec / 1000) + 's'); }
  }
  if (seen === total) return verifyFresh();
  pump();
});

function verifyFresh() {
  if (!fresh.length) {
    console.log('PASS-SCAN: 0/' + total + ' 品种活跃（全部休市，确认无周末行情）');
    return finish(0);
  }
  // 对新鲜品种逐一订阅 5s，数真实推流
  const tickCounts = new Map();
  const freshSyms = fresh.map(f => f.sym);
  freshSyms.forEach(s => { rpc('s:' + s, 'market.subscribe', { symbol: s, period: 'M1' }); tickCounts.set(s, 0); });
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.method === 'event.market.tick') {
      const s = m.params?.symbol;
      if (tickCounts.has(s)) tickCounts.set(s, tickCounts.get(s) + 1);
    }
  });
  setTimeout(() => {
    freshSyms.forEach(s => rpc('u:' + s, 'market.unsubscribe', { symbol: s, period: 'M1' }));
    const live = freshSyms.filter(s => tickCounts.get(s) > 0);
    console.log('PASS-SCAN: ' + live.length + ' 个品种有真实推流: ' + (live.join(', ') || '（无）') +
      (fresh.length ? '；快照新鲜但无推流: ' + freshSyms.filter(s => !live.includes(s)).join(', ') : ''));
    finish(live.length);
  }, 5000);
}

function finish(n) {
  clearTimeout(timer);
  try { ws.close(); } catch {}
  process.exit(0); // 扫描本身不以 0/1 判成败，输出为准
}

ws.on('open', () => {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'list', method: 'symbol.list', params: {} }));
  ws.on('message', function onList(data) {
    const m = JSON.parse(data.toString());
    if (m.id !== 'list') return;
    ws.removeListener('message', onList);
    all.push(...(m.result?.symbols || []));
    total = all.length;
    log('symbol.list:', total, '个品种，开始并发报价扫描…');
    pump();
  });
});
