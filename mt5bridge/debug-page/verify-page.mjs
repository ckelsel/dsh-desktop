// CDP 端到端验证：headless Chrome 打开调试页，8s 后取连接状态/capabilities/事件流
// 用法：先起 chrome --headless=new --remote-debugging-port=19222 --user-data-dir=<tmp>，再 node verify-page.mjs
import WebSocket from 'ws';

const t0 = Date.now();
const log = (...a) => console.log(`[${Date.now() - t0}ms]`, ...a);

const list = await (await fetch('http://127.0.0.1:19222/json')).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.log('FAIL: no debuggable page'); process.exit(1); }
log('target:', page.url);

const cdp = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
let msgId = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  cdp.send(JSON.stringify({ id, method, params }));
});
cdp.on('message', d => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
});
await new Promise(r => cdp.on('open', r));

await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:18999/' });
log('navigated, waiting 8s for auto-connect + hello + capabilities...');
await new Promise(r => setTimeout(r, 8000));

const { result, exceptionDetails } = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    status: document.querySelector('#status').textContent,
    hello: document.querySelector('#hello').textContent,
    methodCount: document.querySelector('#methodCount').textContent,
    eventRows: document.querySelectorAll('#events .row').length,
    firstEvents: [...document.querySelectorAll('#events .row')].slice(0, 3).map(r => r.textContent),
    acct: document.querySelector('#acct').textContent.slice(0, 120),
  })`,
  returnByValue: true,
});
if (exceptionDetails) { console.log('FAIL: eval threw', JSON.stringify(exceptionDetails)); process.exit(1); }
const state = JSON.parse(result.value);
console.log(JSON.stringify(state, null, 2));

const ok = state.status === '已连接' && parseInt(state.methodCount, 10) >= 20 && state.acct.includes('115496317');
console.log(ok ? 'PASS: 页面自动连接 + capabilities 加载 + 事件流渲染' : 'FAIL');
cdp.close();
process.exit(ok ? 0 : 1);
