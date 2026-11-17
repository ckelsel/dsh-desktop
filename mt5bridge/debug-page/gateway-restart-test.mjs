// 网关重启自愈（SDK 视角）：连着 SDK 面监听 → 网关被外部杀死 → SDK ws 断开重试 →
// 网关重启、DLL 自动重连 → 终端恢复信号（重连后 hello.terminals 快照非空，或收到
// event.terminal(connected)）→ 主动 RPC 探活通 = 恢复。
// 事件与快照两路都必须认：网关重启后 DLL 广播与 SDK 重连存在竞态——DLL hello 先入
// 网关事件循环则事件广播先于 sdkConns.add（快照路径兜底）；SDK 先连入则快照时终端
// 尚未注册（事件路径兜底）。SDK 实现应同样以 hello 建基线、事件补增量，两路皆触发重同步。
// 用法：node gateway-restart-test.mjs   （杀/重启网关由外部编排）
import WebSocket from 'ws';

const t0 = Date.now();
const log = (...a) => console.log(`[${Date.now() - t0}ms]`, ...a);
const timer = setTimeout(() => { console.log('FAIL: TIMEOUT'); process.exit(1); }, 120000);

const marks = { sawOutage: false, terminalBack: false, rpcOk: false };

function watch() {
  const ws = new WebSocket('ws://127.0.0.1:18860');
  // 终端恢复信号：重连后的 hello.terminals 快照非空（DLL 先重连），或收到
  // event.terminal(connected)（SDK 先连入）。两种时序都会出现，任一路径即探活。
  const terminalBack = (via) => {
    if (marks.terminalBack || !marks.sawOutage) return;
    marks.terminalBack = true;
    log('terminal back via', via, '— probing RPC…');
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'r1', method: 'account.get', params: {} }));
  };
  // error 之后必然紧跟 close：两条都触发会指数派生连接（曾 4s 窗口爆出 1 万条 ws）。
  // 每个实例只派生一次重连。
  let retried = false;
  const reconnect = () => {
    if (retried || marks.rpcOk) return;
    retried = true;
    marks.sawOutage = true;
    setTimeout(watch, 300); // 网关重启窗口内重试连
  };
  ws.on('error', (e) => { log('sdk error:', e.message); reconnect(); });
  ws.on('close', reconnect);
  ws.on('open', () => log('sdk connected'));
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString());
    if (m.method) {
      if (m.method === 'event.terminal' && m.params?.type === 'connected') terminalBack('event.terminal');
      if (m.method === 'event.resync_required') log('[event] resync_required (informational)');
      // 快照基线：重连后的 hello 已带终端 = 终端已恢复
      if (m.method === 'bridge.hello' && (m.params?.terminals || []).length > 0) terminalBack('hello snapshot');
      return;
    }
    if (m.id === 'r1' && m.result?.login) {
      marks.rpcOk = true;
      log('rpc ok, login=' + m.result.login);
      const need = { sawOutage: marks.sawOutage, terminalBack: marks.terminalBack, rpcOk: marks.rpcOk };
      const ok = Object.values(need).every(Boolean);
      console.log(ok ? 'PASS: 网关重启 → SDK 断线重连 → 终端恢复（快照/事件）→ RPC 探活通'
                     : 'FAIL: ' + JSON.stringify(need));
      clearTimeout(timer);
      try { ws.close(); } catch {}
      process.exit(ok ? 0 : 1);
    }
  });
}

// 先确认当前连接正常（等外部杀网关）
const probe = new WebSocket('ws://127.0.0.1:18860');
probe.on('open', () => { log('baseline connected, waiting for gateway kill…'); probe.close(); watch(); });
probe.on('error', () => { log('gateway not up yet'); setTimeout(() => process.exit(1), 100); });
