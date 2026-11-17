//! Runtime：每个终端进程一份（P9：DLL=client，裸 TCP + NDJSON 连网关）。
//! 连接线程向网关（gateway_host:gateway_port，ini 配置）发起连接并断线重连；
//! 组件模型 / rid 关联 / 队列分级与传输无关，全部沿用。
//! 线程：连接线程（connect + 会话读写）+ 每会话写线程 + 定时器线程。全部 std。

use crate::envelope::{self, codes};
use crate::ndjson;
use crate::queue::{ConnQueue, OutItem};
use crate::router;
use crate::session::{ConnHandle, Pending};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::BufReader;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

pub(crate) const ROLE_SERVICE: i32 = 0;
pub(crate) const ROLE_CONTROL: i32 = 1; // 预留：V1 不存在 ControlEA
pub(crate) const ROLE_MARKET: i32 = 2;

pub(crate) const STATUS_STOPPED: i32 = 0;
pub(crate) const STATUS_STARTING: i32 = 1;
pub(crate) const STATUS_SERVING: i32 = 2;

pub(crate) const DEFAULT_GATEWAY_HOST: &str = "127.0.0.1";
pub(crate) const DEFAULT_GATEWAY_PORT: u16 = 18850;
pub(crate) const SERVICE_INBOUND_CAP: usize = 1024;
pub(crate) const MARKET_INBOUND_CAP: usize = 256;
pub(crate) const OUTBOUND_CAP: usize = 512;
/// 组件失活阈值：超过该时长无任何 Poll 视为宿主 MQL 程序已死（被杀且未 Unregister）。
pub(crate) const COMPONENT_STALE_MS: u128 = 300_000;

type BridgeError = (i32, &'static str, &'static str);

pub(crate) struct Component {
    pub(crate) handle: i64,
    pub(crate) role: i32,
    pub(crate) symbol: String,
    pub(crate) queue: Mutex<VecDeque<String>>,
    pub(crate) cap: usize,
    /// 最近一次 PeekSize/Poll 的 unix 毫秒（失活清理依据）。
    pub(crate) last_poll_ms: AtomicU64,
}

pub(crate) struct Runtime {
    pub(crate) role: i32,
    pub(crate) host: String,
    pub(crate) port: u16,
    /// 非空则握手必须带匹配的 ?token=（ini 配置）。
    pub(crate) token: String,
    pub(crate) terminal_id: Mutex<String>,
    pub(crate) components: Mutex<HashMap<i64, Arc<Component>>>,
    pub(crate) next_handle: AtomicI64,
    pub(crate) sessions: Mutex<HashMap<u64, Arc<ConnHandle>>>,
    pub(crate) next_conn: AtomicU64,
    pub(crate) pending: Mutex<HashMap<u64, Pending>>,
    pub(crate) next_rid: AtomicU64,
    pub(crate) status: AtomicI32,
    pub(crate) last_error: Mutex<String>,
    pub(crate) stopping: AtomicBool,
    /// 常驻工作线程（connect/timer）。最后一个组件注销时必须先 join 完再返回：
    /// 宿主在 Unregister 返回后即可能 FreeLibrary，线程跑在已卸载的代码段上会带走整个终端。
    pub(crate) workers: Mutex<Vec<(thread::ThreadId, thread::JoinHandle<()>)>>,
}

static RUNTIME: OnceLock<Mutex<Option<Arc<Runtime>>>> = OnceLock::new();

/// DLL 侧落盘诊断（MQL Print 不可见时的最后观测手段）。追加写 %TEMP%\mt5bridge-dll.log。
pub(crate) fn diag(line: &str) {
    use std::io::Write;
    let path = std::env::temp_dir().join("mt5bridge-dll.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "{:?} pid={} tid={:?} {}",
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0),
            std::process::id(),
            std::thread::current().id(),
            line);
    }
}

fn slot() -> &'static Mutex<Option<Arc<Runtime>>> {
    RUNTIME.get_or_init(|| Mutex::new(None))
}

/// 锁中毒（持锁线程被宿主强杀）时接管内部值继续服务，绝不 panic —— DLL 里 panic 会带走整个终端。
fn slot_lock() -> std::sync::MutexGuard<'static, Option<Arc<Runtime>>> {
    match slot().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

pub(crate) fn runtime_if_initialized() -> Option<Arc<Runtime>> {
    slot_lock().as_ref().map(Arc::clone)
}

fn set_error(rt: &Runtime, message: impl Into<String>) {
    if let Ok(mut last) = rt.last_error.lock() {
        *last = message.into();
    }
}

/// mt5bridge.ini（<terminal_data>\MQL5\Libraries\）：gateway_host / gateway_port / token。
/// 缺省 127.0.0.1:18850 无 token；环境变量优先于 ini（测试用）。
#[derive(Default)]
pub(crate) struct Ini {
    pub(crate) gateway_host: Option<String>,
    pub(crate) gateway_port: Option<u16>,
    pub(crate) token: Option<String>,
}

pub(crate) fn load_ini(terminal_id: &str) -> Ini {
    let path = std::path::Path::new(terminal_id).join("MQL5").join("Libraries").join("mt5bridge.ini");
    let mut ini = Ini::default();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return ini;
    };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        let value = value.trim();
        match key.trim() {
            "gateway_host" => ini.gateway_host = Some(value.to_owned()),
            "gateway_port" => ini.gateway_port = value.parse().ok(),
            "token" if !value.is_empty() => ini.token = Some(value.to_owned()),
            _ => {}
        }
    }
    ini
}

pub(crate) fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn register_component(role: i32, terminal_id: &str, instance_key: &str) -> i64 {
    diag(&format!("register role={role} key={instance_key}"));
    let rt = ensure_runtime(role, terminal_id);
    if !terminal_id.is_empty() {
        if let Ok(mut current) = rt.terminal_id.lock() {
            *current = terminal_id.to_owned();
        }
    }
    let handle = rt.next_handle.fetch_add(1, Ordering::Relaxed) + 1;
    let cap = if role == ROLE_MARKET { MARKET_INBOUND_CAP } else { SERVICE_INBOUND_CAP };
    let component = Arc::new(Component {
        handle,
        role,
        symbol: instance_key.to_owned(),
        queue: Mutex::new(VecDeque::new()),
        cap,
        last_poll_ms: AtomicU64::new(now_unix_ms()),
    });
    rt.components.lock().unwrap().insert(handle, Arc::clone(&component));
    diag(&format!("registered handle={handle} port={} status={}", rt.port, rt.status.load(Ordering::Acquire)));
    router::broadcast_component(&rt, "registered", &handle.to_string(), instance_key);
    handle
}

pub(crate) fn unregister_component(handle: i64) -> i32 {
    let rt = match runtime_if_initialized() {
        Some(rt) => rt,
        None => return 0,
    };
    let removed = rt.components.lock().unwrap().remove(&handle);
    if let Some(component) = &removed {
        router::broadcast_component(&rt, "unregistered", &handle.to_string(), &component.symbol);
    }
    let empty = rt.components.lock().unwrap().is_empty();
    if empty {
        shutdown_runtime(&rt, /* join_timer */ true);
    }
    0
}

/// 最后一个组件离场后的整体关停：断连接、清全局槽，并 join 工作线程。
/// `join_timer=false` 供 timer 线程自调用（它无法 join 自己，随后立即 return）。
fn shutdown_runtime(rt: &Arc<Runtime>, join_timer: bool) {
    rt.stopping.store(true, Ordering::Release);
    rt.status.store(STATUS_STOPPED, Ordering::Release);
    for conn in rt.conns() {
        conn.force_shutdown();
    }
    let workers: Vec<(thread::ThreadId, thread::JoinHandle<()>)> =
        std::mem::take(&mut *rt.workers.lock().unwrap());
    let self_id = thread::current().id();
    for (worker_id, worker) in workers {
        if !join_timer && worker_id == self_id {
            continue; // timer 自调用路径：自己即将 return，无需（也不能）join
        }
        let _ = worker.join();
    }
    if let Ok(mut current) = slot().lock() {
        if current.as_ref().is_some_and(|active| Arc::ptr_eq(active, rt)) {
            *current = None;
        }
    }
}

fn ensure_runtime(role: i32, terminal_id: &str) -> Arc<Runtime> {
    let mut current = slot_lock();
    if let Some(rt) = current.as_ref() {
        if !rt.stopping.load(Ordering::Acquire) {
            return Arc::clone(rt);
        }
    }
    let ini = load_ini(terminal_id);
    let host = std::env::var("MT5_BRIDGE_GATEWAY_HOST").ok().or(ini.gateway_host).unwrap_or_else(|| DEFAULT_GATEWAY_HOST.to_owned());
    // 网关端口优先级：环境变量（测试）> ini > 默认 18850
    let port = std::env::var("MT5_BRIDGE_GATEWAY_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .or(ini.gateway_port)
        .unwrap_or(DEFAULT_GATEWAY_PORT);
    let token = ini.token.unwrap_or_default();
    diag(&format!("ensure_runtime create role={role} gateway={host}:{port} token={}", if token.is_empty() { "off" } else { "on" }));
    let rt = Arc::new(Runtime {
        role,
        host,
        port,
        token,
        terminal_id: Mutex::new(terminal_id.to_owned()),
        components: Mutex::new(HashMap::new()),
        next_handle: AtomicI64::new(0),
        sessions: Mutex::new(HashMap::new()),
        next_conn: AtomicU64::new(0),
        pending: Mutex::new(HashMap::new()),
        next_rid: AtomicU64::new(0),
        status: AtomicI32::new(STATUS_STARTING),
        last_error: Mutex::new(String::new()),
        stopping: AtomicBool::new(false),
        workers: Mutex::new(Vec::new()),
    });
    *current = Some(Arc::clone(&rt));
    drop(current);

    let connect_rt = Arc::clone(&rt);
    let connect = thread::Builder::new()
        .name("mt5bridge-connect".to_owned())
        .spawn(move || connect_loop(connect_rt))
        .expect("spawn connect thread");
    let timer_rt = Arc::clone(&rt);
    let timer = thread::Builder::new()
        .name("mt5bridge-timer".to_owned())
        .spawn(move || timer_loop(timer_rt))
        .expect("spawn timer thread");
    if let Ok(mut workers) = rt.workers.lock() {
        workers.push((connect.thread().id(), connect));
        workers.push((timer.thread().id(), timer));
    }
    rt
}

impl Runtime {
    pub(crate) fn next_rid(&self) -> u64 {
        self.next_rid.fetch_add(1, Ordering::Relaxed) + 1
    }

    pub(crate) fn conns(&self) -> Vec<Arc<ConnHandle>> {
        self.sessions.lock().map(|s| s.values().map(Arc::clone).collect()).unwrap_or_default()
    }

    pub(crate) fn conn(&self, id: u64) -> Option<Arc<ConnHandle>> {
        self.sessions.lock().ok().and_then(|s| s.get(&id).map(Arc::clone))
    }

    pub(crate) fn terminal_id(&self) -> String {
        self.terminal_id.lock().map(|t| t.clone()).unwrap_or_default()
    }

    /// SERVICE 请求进入唯一的 SERVICE 组件队列（role 精确匹配，EA 组件不抢）。
    pub(crate) fn push_service(&self, text: &str) -> Result<(), BridgeError> {
        let components = self.components.lock().unwrap();
        let component = match components.values().find(|c| c.role == ROLE_SERVICE) {
            Some(c) => Arc::clone(c),
            None => return Err((codes::SERVICE_NOT_READY, "SERVICE_NOT_READY", "service component not registered")),
        };
        drop(components);
        let mut queue = component.queue.lock().unwrap();
        if queue.len() >= component.cap {
            return Err((codes::QUEUE_FULL, "QUEUE_FULL", "service inbound queue is full"));
        }
        queue.push_back(text.to_owned());
        Ok(())
    }

    /// MARKET 请求（如 market.book）按 params.symbol / component_id 路由到 EA 组件。
    pub(crate) fn push_market_selector(&self, v: &Value, text: &str) -> Result<(), BridgeError> {
        let params = v.get("params");
        let selector = |name: &str| params.and_then(|p| p.get(name)).or_else(|| v.get(name));
        let symbol = selector("symbol").and_then(Value::as_str).map(str::to_owned);
        let component_id = selector("component_id").and_then(|x| {
            x.as_str()
                .map(str::to_owned)
                .or_else(|| x.as_i64().map(|n| n.to_string()))
        });
        let components = self.components.lock().unwrap();
        let matched: Vec<Arc<Component>> = components
            .values()
            .filter(|c| c.role == ROLE_MARKET)
            .filter(|c| {
                if let Some(want) = &component_id {
                    if c.handle.to_string() != *want {
                        return false;
                    }
                }
                if let Some(want) = &symbol {
                    if c.symbol != *want {
                        return false;
                    }
                }
                true
            })
            .map(Arc::clone)
            .collect();
        drop(components);
        let target = match matched.len() {
            0 => return Err((codes::MARKET_NOT_FOUND, "MARKET_NOT_FOUND", "no market component for symbol")),
            1 => matched.into_iter().next().unwrap(),
            _ => return Err((codes::AMBIGUOUS_TARGET, "AMBIGUOUS_TARGET", "selector required: multiple market components")),
        };
        let mut queue = target.queue.lock().unwrap();
        if queue.len() >= target.cap {
            return Err((codes::QUEUE_FULL, "QUEUE_FULL", "market inbound queue is full"));
        }
        queue.push_back(text.to_owned());
        Ok(())
    }

    /// 历史类 MARKET 请求（market.bars/ticks）：任意 EA 都能读任意序列（Service 无图表
    /// 上下文读不到历史库），挑队列最短的组件，平票取最小 handle（先注册者=常驻读取图）。
    pub(crate) fn push_market_any(&self, text: &str) -> Result<(), BridgeError> {
        let components = self.components.lock().unwrap();
        let mut best: Option<(usize, i64, Arc<Component>)> = None; // (queue_len, handle, comp)
        for c in components.values() {
            if c.role != ROLE_MARKET {
                continue;
            }
            let len = c.queue.lock().unwrap().len();
            let better = match &best {
                None => true,
                Some((best_len, best_handle, _)) => len < *best_len || (len == *best_len && c.handle < *best_handle),
            };
            if better {
                best = Some((len, c.handle, Arc::clone(c)));
            }
        }
        let (_, _, target) = match best {
            Some(t) => t,
            None => return Err((codes::MARKET_NOT_FOUND, "MARKET_NOT_FOUND", "no market component registered")),
        };
        drop(components);
        let mut queue = target.queue.lock().unwrap();
        if queue.len() >= target.cap {
            return Err((codes::QUEUE_FULL, "QUEUE_FULL", "market inbound queue is full"));
        }
        queue.push_back(text.to_owned());
        Ok(())
    }
}

/// 连接线程：向网关发起握手并维持会话；断线后指数退避重连（网关可后启动）。
fn connect_loop(rt: Arc<Runtime>) {
    let host = rt.host.clone();
    let port = rt.port;
    diag(&format!("connect_loop start gateway={host}:{port}"));
    let mut backoff_ms: u64 = 1_000;
    loop {
        if rt.stopping.load(Ordering::Acquire) {
            return;
        }
        match TcpStream::connect((host.as_str(), port)) {
            Ok(stream) => {
                diag(&format!("gateway tcp connected {host}:{port}"));
                serve_gateway(&rt, stream);
                if rt.stopping.load(Ordering::Acquire) {
                    return;
                }
                // 会话结束：组件注册表保留（宿主 MQL 程序还活着），退避后重连
                rt.status.store(STATUS_STARTING, Ordering::Release);
                set_error(&rt, "gateway session ended; reconnecting");
                backoff_ms = 1_000;
            }
            Err(error) => {
                if rt.status.load(Ordering::Acquire) != STATUS_STARTING {
                    rt.status.store(STATUS_STARTING, Ordering::Release);
                }
                set_error(&rt, format!("connect {host}:{port}: {error}"));
            }
        }
        // 退避分片睡眠：stopping 置位后最多 1s 内退出
        let mut waited = 0u64;
        while waited < backoff_ms {
            if rt.stopping.load(Ordering::Acquire) {
                return;
            }
            thread::sleep(Duration::from_millis(1_000.min(backoff_ms - waited)));
            waited += 1_000;
        }
        backoff_ms = (backoff_ms * 2).min(15_000);
    }
}

/// 单次网关会话：NDJSON 读写 → hello(token) + 组件清单重放 + resync_required → 读写循环。
fn serve_gateway(rt: &Arc<Runtime>, stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    // 半开检测：timer 15s 发 system.ping（网关回 system.pong），连续 30s 无任何入站 = 链路已死
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut reader = match stream.try_clone() {
        Ok(s) => BufReader::new(s),
        Err(_) => return,
    };
    rt.status.store(STATUS_SERVING, Ordering::Release);
    set_error(rt, "");
    diag("gateway session established");

    let conn = Arc::new(ConnHandle {
        id: rt.next_conn.fetch_add(1, Ordering::Relaxed) + 1,
        queue: ConnQueue::new(OUTBOUND_CAP),
        next_seq: AtomicU64::new(0),
        remote: format!("{}:{}", rt.host, rt.port),
        shutdown_stream: Mutex::new(stream.try_clone().ok()),
    });
    rt.sessions.lock().unwrap().insert(conn.id, Arc::clone(&conn));

    // DLL→网关 hello：网关据此建立终端会话；token 非空时由网关校验（不匹配断开）
    let hello = envelope::notification(
        "bridge.hello",
        json!({
            // 单终端内角色按当前注册的组件动态报告（SERVICE 优先）
            "role": if rt.components.lock().map(|c| c.values().any(|x| x.role == ROLE_SERVICE)).unwrap_or(false) { "SERVICE" } else { "MARKET" },
            "terminal_id": rt.terminal_id(),
            "version": env!("CARGO_PKG_VERSION"),
            "gateway_port": rt.port,
            "token": rt.token,
        }),
    );
    conn.queue.push_reliable(hello);

    // 组件清单重放：断线期间 Register 的广播丢失，网关需要完整重建路由状态
    let snapshot: Vec<Arc<Component>> = rt.components.lock().map(|c| c.values().map(Arc::clone).collect()).unwrap_or_default();
    for component in &snapshot {
        router::broadcast_component(rt, "registered", &component.handle.to_string(), &component.symbol);
    }
    // 事件流可能已断档：SDK 依赖该信号触发 system.resync 重建快照
    conn.queue.push_reliable(envelope::notification(
        "event.resync_required",
        json!({ "reason": "gateway_reconnect" }),
    ));

    let writer_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(_) => {
            conn.force_shutdown();
            rt.sessions.lock().unwrap().remove(&conn.id);
            return;
        }
    };
    let writer_conn = Arc::clone(&conn);
    let writer = thread::Builder::new()
        .name("mt5bridge-writer".to_owned())
        .spawn(move || writer_loop(writer_stream, writer_conn))
        .ok();

    let mut reader = reader;
    loop {
        if rt.stopping.load(Ordering::Acquire) || conn.queue.is_dead() {
            break;
        }
        match ndjson::read_message(&mut reader) {
            Ok(text) => router::on_client_text(rt, conn.id, &text),
            Err(_) => break,
        }
    }

    conn.queue.mark_dead();
    rt.sessions.lock().unwrap().remove(&conn.id);
    rt.pending.lock().unwrap().retain(|_, p| p.conn != conn.id);
    if let Some(handle) = writer {
        if !conn.queue.is_dead() {
            conn.queue.mark_dead();
        }
        let _ = handle.join();
    }
    diag("gateway session closed");
}

fn writer_loop(mut stream: TcpStream, conn: Arc<ConnHandle>) {
    while let Some(item) = conn.queue.pop_wait(Duration::from_millis(500)) {
        let result = match item {
            OutItem::Text { text, .. } => ndjson::write_message(&mut stream, &text),
            // 应用层心跳：网关回 system.pong（router 注入），SDK 面由网关处理
            OutItem::Ping => ndjson::write_message(&mut stream, &envelope::notification("system.ping", json!({ "time": now_unix_ms() }))),
            OutItem::Close => break,
        };
        if result.is_err() {
            break;
        }
    }
    conn.queue.mark_dead();
}

fn timer_loop(rt: Arc<Runtime>) {
    let mut last_ping = Instant::now();
    loop {
        if rt.stopping.load(Ordering::Acquire) {
            return;
        }
        thread::sleep(Duration::from_millis(500));

        // 组件失活清理：宿主 MQL 程序被杀且未 Unregister 时（实测场景），
        // 其组件永远不再 Poll，队列里的消息成为死信、SERVICE 路由被僵尸占用。
        // 超过 COMPONENT_STALE_MS 无 Poll 一律移除；全部移除后关闭整个 Runtime。
        let now_ms = now_unix_ms() as u128;
        let stale: Vec<(i64, String)> = {
            let mut components = match rt.components.lock() {
                Ok(c) => c,
                Err(_) => return,
            };
            let stale: Vec<(i64, String)> = components
                .iter()
                .filter(|(_, c)| now_ms.saturating_sub(c.last_poll_ms.load(Ordering::Acquire) as u128) > COMPONENT_STALE_MS)
                .map(|(h, c)| (*h, c.symbol.clone()))
                .collect();
            for (h, _) in &stale {
                components.remove(h);
            }
            stale
        };
        for (handle, symbol) in &stale {
            diag(&format!("stale component dropped handle={handle} symbol={symbol}"));
            router::broadcast_component(&rt, "unregistered", &handle.to_string(), symbol);
        }
        if !stale.is_empty() && rt.components.lock().map(|c| c.is_empty()).unwrap_or(false) {
            diag("all components stale — shutting down runtime");
            shutdown_runtime(&rt, /* join_timer */ false); // timer 线程内：不 join 自己
            return;
        }

        // pending 超时：回 REQUEST_TIMEOUT（交易语义：状态未知，勿重发）
        let now = Instant::now();
        let expired: Vec<Pending> = {
            let mut pending = rt.pending.lock().unwrap();
            let due: Vec<u64> = pending
                .iter()
                .filter(|(_, p)| p.deadline <= now)
                .map(|(rid, _)| *rid)
                .collect();
            due.into_iter().filter_map(|rid| pending.remove(&rid)).collect()
        };
        for pending in expired {
            if let Some(conn) = rt.conn(pending.conn) {
                conn.queue.push_reliable(envelope::error_text(
                    &pending.id,
                    codes::REQUEST_TIMEOUT,
                    "REQUEST_TIMEOUT",
                    "request timed out; outcome unknown",
                ));
            }
        }

        // 心跳 ping
        if last_ping.elapsed() >= Duration::from_secs(15) {
            last_ping = Instant::now();
            for conn in rt.conns() {
                conn.queue.push_control(OutItem::Ping);
            }
        }
    }
}

pub(crate) fn component_peek_size(handle: i64) -> i32 {
    let rt = match runtime_if_initialized() {
        Some(rt) => rt,
        None => return 0,
    };
    let components = match rt.components.lock() {
        Ok(c) => c,
        Err(_) => return -3,
    };
    match components.get(&handle) {
        Some(component) => {
            component.last_poll_ms.store(now_unix_ms(), Ordering::Release);
            component
                .queue
                .lock()
                .ok()
                .and_then(|q| q.front().map(|m| m.len() as i32))
                .unwrap_or(0)
        }
        None => -2,
    }
}

pub(crate) fn component_poll(handle: i64, capacity: i32) -> (i32, Option<String>) {
    let rt = match runtime_if_initialized() {
        Some(rt) => rt,
        None => return (-2, None),
    };
    let components = match rt.components.lock() {
        Ok(c) => c,
        Err(_) => return (-3, None),
    };
    let component = match components.get(&handle) {
        Some(c) => Arc::clone(c),
        None => return (-2, None),
    };
    drop(components);
    component.last_poll_ms.store(now_unix_ms(), Ordering::Release);
    let mut queue = match component.queue.lock() {
        Ok(q) => q,
        Err(_) => return (-3, None),
    };
    match queue.front() {
        Some(message) => {
            let size = message.len();
            if size > capacity.max(0) as usize {
                return (-(size as i32), None);
            }
            (size as i32, queue.pop_front())
        }
        None => (0, None),
    }
}

pub(crate) fn current_status() -> i32 {
    runtime_if_initialized()
        .map(|rt| rt.status.load(Ordering::Acquire))
        .unwrap_or(STATUS_STOPPED)
}

pub(crate) fn last_error() -> String {
    runtime_if_initialized()
        .and_then(|rt| rt.last_error.lock().ok().map(|e| e.clone()))
        .unwrap_or_default()
}
