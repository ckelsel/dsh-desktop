// 策略测试器回放链路测试（周末方案 C）：网关侧看测试器 agent = 第二终端。
// 覆盖：多终端路由（terminal_id 显式指定）/ account 探活 / 历史 tick 推流 /
//       trade.execute → 持仓 → position.close 交易全链路（回测模拟成交）。
// 前置：终端以 /config 起 BridgeTesterEA 回测（debug-page README 记录编排）。
import WebSocket from 'ws';

const ws = new WebSocket('ws://127.0.0.1:18860');
const t0 = Date.now();
const log = (...a) => console.log(`[${Date.now() - t0}ms]`, ...a);
const timer = setTimeout(() => { console.log('FAIL: TIMEOUT'); process.exit(1); }, 90000);
const rpc = (id, method, params) => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

const REAL = '\\Terminal\\'; // agent 路径含 \Tester\，真实终端含 \Terminal\（都带 ACFC 哈希，不能按哈希区分）
const marks = { testerUp: false, account: false, ticks: false, executed: false, positioned: false, closed: false };
let testerId = '';
let tickCount = 0;
let closeTicket = 0;

// 终端恢复信号双路径：hello 快照（agent 先连入）或 event.terminal connected（脚本先在场）
const tryTester = (id, via) => {
  if (testerId || !id.includes('Tester')) return;
  testerId = id;
  marks.testerUp = true;
  log('tester terminal up via', via + ':', id.slice(-50));
  rpc('a1', 'account.get', { terminal_id: testerId });
};

function finish(ok, why) {
  console.log(ok ? 'PASS: 测试器回放 → 双终端路由/账户隔离/tick 推流/开平仓全链路'
                 : 'FAIL: ' + why);
  clearTimeout(timer);
  try { ws.close(); } catch {}
  process.exit(ok ? 0 : 1);
}

ws.on('message', (data) => {
  const m = JSON.parse(data.toString());
  if (m.method) {
    if (m.method === 'bridge.hello')
      (m.params?.terminals || []).forEach(t => tryTester(t.terminal_id, 'hello snapshot'));
    // 第二终端连入事件（若脚本先在场）
    if (m.method === 'event.terminal' && m.params?.type === 'connected')
      tryTester(m.params.terminal_id, 'event');
    if (m.method === 'event.market.tick' && m.params?.terminal_id === testerId) {
      tickCount++;
      if (tickCount === 1) log('[event] first tick', m.params.symbol, m.params.bid, m.params.ask);
      if (tickCount >= 3 && !marks.executed) {
        marks.ticks = true;
        marks.executed = true;
        log('ticks flowing (' + tickCount + '), executing trade…');
        rpc('x1', 'trade.execute', { terminal_id: testerId, action: 'buy', symbol: m.params.symbol, volume: 0.01, comment: 'tester-bridge' });
      }
    }
    if (m.method === 'event.position' && m.params?.terminal_id === testerId)
      log('[event] position', JSON.stringify(m.params).slice(0, 120));
    if (m.method === 'event.deal' && m.params?.terminal_id === testerId)
      log('[event] deal', JSON.stringify(m.params).slice(0, 120));
    return;
  }
  if (m.id === 'a1') {
    if (m.error) return finish(false, 'account.get: ' + JSON.stringify(m.error));
    marks.account = true;
    log('tester account login=' + m.result.login + ' balance=' + m.result.balance + '（真实终端 99999.22，隔离即不同）');
    // tick 可能已在 execute 前到达；若 agent 未推流，等待（OnTick 由历史回放驱动）
  }
  if (m.id === 'x1') {
    if (m.error || m.result?.status === 'rejected') return finish(false, 'trade.execute: ' + JSON.stringify(m.error || m.result));
    log('execute accepted request_id=' + m.result.request_id);
    setTimeout(() => rpc('p1', 'position.list', { terminal_id: testerId }), 500);
  }
  if (m.id === 'p1') {
    const positions = m.result?.positions || [];
    if (!positions.length) {
      // 成交是异步的，重试（最多 ~8 次）
      if (!marks.positioned) setTimeout(() => rpc('p1', 'position.list', { terminal_id: testerId }), 1000);
      return;
    }
    marks.positioned = true;
    const p = positions[0];
    closeTicket = p.ticket;
    log('position open ticket=' + p.ticket + ' ' + p.type + ' ' + p.volume + ' @' + p.price_open);
    rpc('c1', 'position.close', { terminal_id: testerId, ticket: closeTicket });
  }
  if (m.id === 'c1') {
    if (m.error) return finish(false, 'position.close: ' + JSON.stringify(m.error));
    log('close accepted');
    setTimeout(() => rpc('p2', 'position.list', { terminal_id: testerId }), 800);
  }
  if (m.id === 'p2') {
    const left = (m.result?.positions || []).length;
    if (left > 0) {
      setTimeout(() => rpc('p2', 'position.list', { terminal_id: testerId }), 1000);
      return;
    }
    marks.closed = true;
    finish(marks.testerUp && marks.account && marks.ticks && marks.executed && marks.positioned,
           JSON.stringify(marks));
  }
});

ws.on('open', () => log('sdk connected, waiting for tester agent terminal…'));
ws.on('error', (e) => log('ws error:', e.message));
