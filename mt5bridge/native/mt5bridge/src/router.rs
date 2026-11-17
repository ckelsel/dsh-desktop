//! 请求/响应/事件三向路由：rid 登记还原、入站分发、出站扇出。

use crate::envelope::{self, codes};
use crate::runtime::{now_unix_ms, Runtime};
use crate::session::Pending;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub(crate) const REQUEST_TTL: Duration = Duration::from_secs(30);

/// MARKET 方法集合（与 contracts/registry.yaml 的 target: MARKET 一致）。
/// 单端口模型下按 method 路由到 EA 组件，其余全部进 SERVICE 组件。
const MARKET_METHODS: [&str; 1] = ["market.book"];

/// 这些方法也进 EA，但不挑 symbol：无图表上下文的 Service 读不到历史库（6320 实测
/// CopyRates 全 4401、SERIES_SYNCHRONIZED=0），任何 EA 都能读任意品种/周期。
/// Service 启动时会保活一张"读取图"，保证这里总有组件可挑。
const MARKET_ANY_METHODS: [&str; 2] = ["market.bars", "market.ticks"];

/// WS 客户端文本 → 请求入站（或忽略客户端通知）。
pub(crate) fn on_client_text(rt: &Arc<Runtime>, conn_id: u64, text: &str) {
    let v = match envelope::parse(text) {
        Ok(v) => v,
        Err(_) => {
            reply_error(rt, conn_id, &Value::Null, codes::PARSE_ERROR, "PARSE_ERROR", "invalid JSON");
            return;
        }
    };
    if !envelope::is_request(&v) {
        // 通知：网关心跳 system.ping → 回 system.pong；其余通知未定义，忽略
        if v.get("method").and_then(Value::as_str) == Some("system.ping") {
            if let Some(conn) = rt.conn(conn_id) {
                conn.queue.push_reliable(envelope::notification("system.pong", json!({ "time_ms": now_unix_ms() })));
            }
        }
        return;
    }
    forward_request(rt, conn_id, v);
}

fn reply_error(rt: &Arc<Runtime>, conn_id: u64, id: &Value, code: i32, name: &str, message: &str) {
    if let Some(conn) = rt.conn(conn_id) {
        conn.queue.push_reliable(envelope::error_text(id, code, name, message));
    }
}

fn forward_request(rt: &Arc<Runtime>, conn_id: u64, mut v: Value) {
    let orig_id = v.get("id").cloned().unwrap_or(Value::Null);
    let rid = rt.next_rid();
    rt.pending
        .lock()
        .unwrap()
        .insert(rid, Pending { conn: conn_id, id: orig_id.clone(), deadline: Instant::now() + REQUEST_TTL });
    v["id"] = json!(rid);
    let text = v.to_string();

    let method = v.get("method").and_then(Value::as_str).unwrap_or("");
    let outcome = if MARKET_METHODS.contains(&method) {
        rt.push_market_selector(&v, &text)
    } else if MARKET_ANY_METHODS.contains(&method) {
        rt.push_market_any(&text)
    } else {
        rt.push_service(&text)
    };
    if let Err((code, name, message)) = outcome {
        rt.pending.lock().unwrap().remove(&rid);
        reply_error(rt, conn_id, &orig_id, code, name, message);
    }
}

/// MQL Bridge_Reply：回包按 rid 还原原始 id 后推给所属连接。
/// 迟到（超时已清理 / 组件重启）的回包按 rid 查无 → 丢弃。
pub(crate) fn on_mql_reply(rt: &Arc<Runtime>, text: &str) -> i32 {
    let v = match envelope::parse(text) {
        Ok(v) => v,
        Err(_) => return -1,
    };
    let rid = match v.get("id").and_then(Value::as_u64) {
        Some(r) => r,
        None => return -1,
    };
    let pending = match rt.pending.lock().unwrap().remove(&rid) {
        Some(p) => p,
        None => return 0, // 迟到回包：静默丢弃
    };
    let mut out = v;
    out["id"] = pending.id;
    if let Some(conn) = rt.conn(pending.conn) {
        conn.queue.push_reliable(out.to_string());
    }
    0
}

/// MQL Bridge_Emit：事件扇出到本 Runtime 全部连接，每连接注入独立单调 seq。
/// conflated=true 时按 "method|symbol[|period]" 覆盖旧值；bar 类事件带 period —— 同一 symbol
/// 订阅多个周期时按周期各自覆盖，否则互相顶掉丢 bar。
pub(crate) fn on_mql_emit(rt: &Arc<Runtime>, text: &str, conflated: bool) -> i32 {
    let v = match envelope::parse(text) {
        Ok(v) => v,
        Err(_) => return -1,
    };
    let method = match v.get("method").and_then(Value::as_str) {
        Some(m) => m.to_owned(),
        None => return -1,
    };
    if !method.starts_with("event.") {
        return -1;
    }
    let conflate_key: Option<String> = if conflated {
        let params = v.get("params");
        let symbol = params
            .and_then(|p| p.get("symbol"))
            .and_then(Value::as_str)
            .or_else(|| v.get("symbol").and_then(Value::as_str))
            .unwrap_or("");
        match params
            .and_then(|p| p.get("period"))
            .and_then(Value::as_str)
        {
            Some(period) => Some(format!("{method}|{symbol}|{period}")),
            None => Some(format!("{method}|{symbol}")),
        }
    } else {
        None
    };
    for conn in rt.conns() {
        let mut copy = v.clone();
        let seq = conn.next_seq.fetch_add(1, Ordering::Relaxed) + 1;
        copy["seq"] = json!(seq);
        match &conflate_key {
            Some(key) => conn.queue.push_conflated(key, copy.to_string()),
            None => {
                conn.queue.push_reliable(copy.to_string());
            }
        }
    }
    0
}

/// MARKET EA 注册/注销时向连接广播组件事件。
pub(crate) fn broadcast_component(rt: &Arc<Runtime>, kind: &str, component_id: &str, symbol: &str) {
    let text = envelope::notification(
        "event.component",
        json!({ "type": kind, "component_id": component_id, "symbol": symbol }),
    );
    for conn in rt.conns() {
        conn.queue.push_reliable(text.clone());
    }
}
