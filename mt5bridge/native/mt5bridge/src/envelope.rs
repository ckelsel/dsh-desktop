//! JSON-RPC envelope。DLL 只解析 id/method 外壳，绝不解析业务 params。

use serde_json::Value;

pub(crate) mod codes {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const QUEUE_FULL: i32 = -32000;
    pub const SERVICE_NOT_READY: i32 = -32001;
    pub const MARKET_NOT_FOUND: i32 = -32002;
    pub const REQUEST_TIMEOUT: i32 = -32003;
    pub const INTERNAL: i32 = -32004;
    pub const BAD_ENVELOPE: i32 = -32006;
    pub const AMBIGUOUS_TARGET: i32 = -32007;
}

pub(crate) fn parse(text: &str) -> Result<Value, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if !v.is_object() {
        return Err("envelope is not an object".to_owned());
    }
    Ok(v)
}

pub(crate) fn is_request(v: &Value) -> bool {
    v.get("id").is_some() && v.get("method").is_some() && v.get("result").is_none() && v.get("error").is_none()
}

pub(crate) fn error_text(id: &Value, code: i32, name: &str, message: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message, "data": { "name": name } }
    })
    .to_string()
}

pub(crate) fn notification(method: &str, params: Value) -> String {
    serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params }).to_string()
}
