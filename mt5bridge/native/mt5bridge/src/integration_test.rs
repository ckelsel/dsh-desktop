//! 集成测试（串行阶段，共享 OnceLock runtime，禁止并行）：
//! A. 进程内链路：on_client_text → queue → peek/poll → on_mql_reply（网关指向不可达端口）
//! B. 端到端：mini 网关（TcpListener + NDJSON 行协议）← DLL(client) 拨号 → hello(token)/请求/回包往返
//! C. 终端内 MARKET/SERVICE 组件路由（进程内）
//! D. 断线重连：会话断开 → 退避重连 → hello + 组件清单重放 + resync_required

use serde_json::{json, Value};
use std::io::BufReader;
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, Instant};

/// env 指向不可达端口（connect 立即失败，connect_loop 进入退避，不打扰进程内测试）。
const UNREACHABLE_PORT: &str = "1";

fn wait_status(target: i32, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while crate::runtime::current_status() != target {
        assert!(Instant::now() < deadline, "status never reached {target}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

// —— mini 网关辅助：NDJSON 行读写（复用生产代码） ——

fn gateway_accept(listener: &TcpListener) -> (BufReader<TcpStream>, TcpStream) {
    let (stream, _) = listener.accept().expect("gateway accept");
    stream.set_nodelay(true).unwrap();
    (BufReader::new(stream.try_clone().unwrap()), stream)
}

fn read_text(reader: &mut BufReader<TcpStream>) -> String {
    crate::ndjson::read_message(reader).expect("read line")
}

/// 读行直到出现 method 匹配的消息（跳过其他帧），带超时。
fn read_until_method(reader: &mut BufReader<TcpStream>, method: &str) -> Value {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        assert!(Instant::now() < deadline, "timeout waiting for {method}");
        let v: Value = serde_json::from_str(&read_text(reader)).unwrap_or_default();
        if v["method"].as_str() == Some(method) {
            return v;
        }
    }
}

/// 收集连接上的全部事件帧（直到读到 resync_required 或超时），返回帧列表。
fn collect_events(reader: &mut BufReader<TcpStream>) -> Vec<Value> {
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut out = Vec::new();
    loop {
        assert!(Instant::now() < deadline, "timeout collecting events");
        let v = serde_json::from_str::<Value>(&read_text(reader)).unwrap_or_default();
        let method = v["method"].as_str().unwrap_or("").to_owned();
        out.push(v.clone());
        if method == "event.resync_required" {
            return out;
        }
    }
}

#[test]
fn bridge_integration_serial_phases() {
    // ── 阶段 A：进程内链路（无网关） ──
    std::env::set_var("MT5_BRIDGE_GATEWAY_HOST", "127.0.0.1");
    std::env::set_var("MT5_BRIDGE_GATEWAY_PORT", UNREACHABLE_PORT);
    let handle = crate::runtime::register_component(0, "test-terminal", "service");
    assert!(handle > 0);
    let rt = crate::runtime::runtime_if_initialized().expect("runtime");

    let request = json!({"jsonrpc":"2.0","id":"smoke-1","method":"account.get","params":{}}).to_string();
    crate::router::on_client_text(&rt, 999, &request);
    let size = crate::runtime::component_peek_size(handle);
    assert!(size > 0, "phase A peek got {size}");
    let (_, message) = crate::runtime::component_poll(handle, size);
    let message = message.expect("phase A poll");
    let inbound: Value = serde_json::from_str(&message).unwrap();
    let rid = inbound["id"].as_u64().expect("id rewritten to rid");
    let reply = json!({"jsonrpc":"2.0","id":rid,"result":{"login":115496317}}).to_string();
    assert_eq!(crate::router::on_mql_reply(&rt, &reply), 0);
    assert_eq!(crate::runtime::component_peek_size(handle), 0);
    crate::runtime::unregister_component(handle);
    std::thread::sleep(Duration::from_millis(100)); // 让退避中的 connect 线程退出
    println!("phase A ok");

    // ── 阶段 B：端到端（DLL 拨号连 mini 网关，ini 驱动含 token） ──
    // ini：临时目录 <base>\MQL5\Libraries\mt5bridge.ini（gateway_host/port/token）
    let base = std::env::temp_dir().join(format!("mt5bridge-e2e-{}", std::process::id()));
    let lib = base.join("MQL5").join("Libraries");
    std::fs::create_dir_all(&lib).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").expect("gateway bind");
    let gateway_port = listener.local_addr().unwrap().port();
    std::fs::write(
        lib.join("mt5bridge.ini"),
        format!("gateway_host=127.0.0.1\ngateway_port={gateway_port}\ntoken=sekret\n"),
    )
    .unwrap();
    std::env::remove_var("MT5_BRIDGE_GATEWAY_PORT"); // ini 生效
    std::env::remove_var("MT5_BRIDGE_GATEWAY_HOST");

    let terminal_dir = base.to_str().unwrap().to_owned();
    let handle2 = crate::runtime::register_component(0, &terminal_dir, "service");
    assert!(handle2 > 0);
    let (mut g_reader, mut g_writer) = gateway_accept(&listener);
    wait_status(2, Duration::from_secs(2));

    // hello（首行，带 token；网关侧校验）
    let hello = read_until_method(&mut g_reader, "bridge.hello");
    assert_eq!(hello["params"]["terminal_id"].as_str(), Some(terminal_dir.as_str()));
    assert_eq!(hello["params"]["role"].as_str(), Some("SERVICE"));
    assert_eq!(hello["params"]["token"].as_str(), Some("sekret"), "hello 必须携带 ini token");
    // 会话建立即重放组件清单 + resync_required，消费掉再进入请求断言
    let _ = collect_events(&mut g_reader);

    // 网关发请求 → 组件队列 → 模拟 MQL 回包 → 网关收到 id 还原后的帧
    crate::ndjson::write_message(&mut g_writer, &request).unwrap();
    let rt2 = crate::runtime::runtime_if_initialized().expect("runtime2");
    let mut arrived = String::new();
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        let size = crate::runtime::component_peek_size(handle2);
        if size > 0 {
            let (_, message) = crate::runtime::component_poll(handle2, size);
            arrived = message.expect("phase B poll");
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(!arrived.is_empty(), "request never reached component queue");
    let inbound2: Value = serde_json::from_str(&arrived).unwrap();
    let rid2 = inbound2["id"].as_u64().expect("e2e rid rewrite");
    let reply2 = json!({"jsonrpc":"2.0","id":rid2,"result":{"balance":100000.0}}).to_string();
    assert_eq!(crate::router::on_mql_reply(&rt2, &reply2), 0);
    let out = read_text(&mut g_reader);
    let out_v: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(out_v["id"].as_str(), Some("smoke-1"), "id not restored: {out}");
    assert!(out_v["result"]["balance"].is_number());
    println!("phase B ok — dial-out NDJSON roundtrip works (token carried in hello)");

    // ── 阶段 D：断线重连（组件注册表保留 + 清单重放 + resync_required） ──
    use std::net::Shutdown;
    let _ = g_writer.shutdown(Shutdown::Both); // 显式断开
    drop(g_writer);
    drop(g_reader);
    wait_status(1, Duration::from_secs(3)); // 会话结束 → STARTING（重连中）
    let (mut g2_reader, mut g2_writer) = gateway_accept(&listener);
    wait_status(2, Duration::from_secs(4)); // 退避 1s 后重连
    let hello2 = read_until_method(&mut g2_reader, "bridge.hello");
    assert_eq!(hello2["params"]["terminal_id"].as_str(), Some(terminal_dir.as_str()));
    let events = collect_events(&mut g2_reader);
    let registered: Vec<&Value> = events
        .iter()
        .filter(|v| v["method"] == "event.component" && v["params"]["type"] == "registered")
        .collect();
    assert_eq!(registered.len(), 1, "组件清单重放一次（当前仅 service 组件）: {events:?}");
    assert!(events.iter().any(|v| v["method"] == "event.resync_required"), "重连必须广播 resync_required");
    // 应用层心跳：网关 system.ping → DLL system.pong
    crate::ndjson::write_message(&mut g2_writer, r#"{"jsonrpc":"2.0","method":"system.ping"}"#).unwrap();
    let pong = read_until_method(&mut g2_reader, "system.pong");
    assert!(pong["params"]["time_ms"].is_u64(), "pong 带时间戳: {pong}");
    // 重连后请求链路仍通
    crate::ndjson::write_message(&mut g2_writer, &request).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        assert!(Instant::now() < deadline, "post-reconnect request stalled");
        if crate::runtime::component_peek_size(handle2) > 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    println!("phase D ok — reconnect replays components, resync_required, pong");

    crate::runtime::unregister_component(handle2);
    let _ = std::fs::remove_dir_all(&base);

    // ── 阶段 C：终端内组件路由（进程内，网关不可达） ──
    std::env::set_var("MT5_BRIDGE_GATEWAY_HOST", "127.0.0.1");
    std::env::set_var("MT5_BRIDGE_GATEWAY_PORT", UNREACHABLE_PORT);
    let handle_s = crate::runtime::register_component(0, "test-terminal", "service");
    let handle_m = crate::runtime::register_component(2, "test-terminal", "EURUSD");
    let rt3 = crate::runtime::runtime_if_initialized().expect("runtime3");

    // market.book 应进 MARKET 组件队列
    crate::router::on_client_text(&rt3, 999, r#"{"jsonrpc":"2.0","id":"m1","method":"market.book","params":{"symbol":"EURUSD"}}"#);
    let size_m = crate::runtime::component_peek_size(handle_m);
    assert!(size_m > 0, "market.book should reach MARKET component, peek={size_m}");
    let (_, mmsg) = crate::runtime::component_poll(handle_m, size_m);
    assert!(mmsg.unwrap().contains("market.book"));

    // 普通请求仍进 SERVICE 组件（EA 组件不得抢占）
    crate::router::on_client_text(&rt3, 999, r#"{"jsonrpc":"2.0","id":"m2","method":"account.get","params":{}}"#);
    assert!(crate::runtime::component_peek_size(handle_s) > 0, "account.get should reach SERVICE component");
    assert_eq!(crate::runtime::component_peek_size(handle_m), 0, "MARKET queue must stay empty");

    // 无匹配品种的 market 请求 → MARKET_NOT_FOUND 错误（回连接，不入队）
    crate::router::on_client_text(&rt3, 999, r#"{"jsonrpc":"2.0","id":"m3","method":"market.book","params":{"symbol":"GBPUSD"}}"#);
    assert_eq!(crate::runtime::component_peek_size(handle_m), 0);

    crate::runtime::unregister_component(handle_m);
    crate::runtime::unregister_component(handle_s);
    println!("phase C ok — in-terminal MARKET routing works");
}

/// 背压机制（纯队列级，不依赖 TCP 时序）：
/// RELIABLE 有界溢出 → 断开（Close 终止项 + dead 静默丢弃）；CONFLATED 同 key 覆盖。
#[test]
fn conn_queue_backpressure() {
    use crate::queue::{ConnQueue, OutItem};

    let q = ConnQueue::new(8);
    for i in 0..8 {
        assert!(q.push_reliable(format!("m{i}")), "cap 内应全部入队");
    }
    assert!(!q.push_reliable("overflow".into()), "第 9 条应触发溢出断开");
    assert!(q.is_dead());
    let mut saw_close = false;
    while let Some(item) = q.pop_wait(Duration::from_millis(10)) {
        if matches!(item, OutItem::Close) {
            saw_close = true;
        }
    }
    assert!(saw_close, "溢出后必须排入 Close 终止项");
    assert!(q.push_reliable("after-dead".into()), "dead 后静默丢弃不报错");

    let q2 = ConnQueue::new(8);
    q2.push_conflated("event.market.tick|EURUSD", "tick-1".to_owned());
    q2.push_conflated("event.market.tick|EURUSD", "tick-2".to_owned());
    q2.push_conflated("event.market.tick|GBPUSD", "tick-gbp".to_owned());
    q2.mark_dead(); // pop_wait 是死等语义：标记 dead 使排空循环可终止（不清空已入队项）
    let texts: Vec<String> = std::iter::from_fn(|| match q2.pop_wait(Duration::from_millis(10)) {
        Some(OutItem::Text { text, .. }) => Some(text),
        _ => None,
    })
    .collect();
    assert_eq!(texts.len(), 2, "同 key 覆盖后应只剩 2 条");
    assert!(texts.contains(&"tick-2".to_owned()) && !texts.contains(&"tick-1".to_owned()), "EURUSD 应只剩最新值");
}

/// ini 配置解析。
#[test]
fn ini_parsing() {
    let base = std::env::temp_dir().join(format!("mt5bridge-ini-test-{}", std::process::id()));
    let lib = base.join("MQL5").join("Libraries");
    std::fs::create_dir_all(&lib).unwrap();
    std::fs::write(
        lib.join("mt5bridge.ini"),
        "; comment\ngateway_host=0.0.0.0\ngateway_port=19999\ntoken=sekret\nignored_key=1\n# another\n",
    )
    .unwrap();
    let ini = crate::runtime::load_ini(base.to_str().unwrap());
    assert_eq!(ini.gateway_host.as_deref(), Some("0.0.0.0"));
    assert_eq!(ini.gateway_port, Some(19999));
    assert_eq!(ini.token.as_deref(), Some("sekret"));
    let _ = std::fs::remove_dir_all(&base);

    // 不存在的目录 → 全默认
    let empty = crate::runtime::load_ini("Z:/definitely/not/here");
    assert!(empty.gateway_host.is_none() && empty.gateway_port.is_none() && empty.token.is_none());
}
