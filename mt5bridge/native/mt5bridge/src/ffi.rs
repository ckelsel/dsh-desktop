//! MQL5 #import ABI。所有导出函数绝不阻塞、绝不调用 MT5 API。

use crate::router;
use crate::runtime;
use std::ptr;

unsafe fn copy_output(pointer: *mut u8, capacity: i32, data: &[u8]) -> i32 {
    if capacity < 0 || (capacity > 0 && pointer.is_null()) {
        return -1;
    }
    if data.len() > capacity as usize {
        return -(data.len() as i32);
    }
    if !data.is_empty() {
        ptr::copy_nonoverlapping(data.as_ptr(), pointer, data.len());
    }
    data.len() as i32
}

unsafe fn mql5_string(pointer: *const u16) -> String {
    if pointer.is_null() {
        return String::new();
    }
    let mut length = 0;
    while *pointer.add(length) != 0 && length < 4096 {
        length += 1;
    }
    String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length))
}

#[no_mangle]
pub extern "system" fn Bridge_Version(buffer: *mut u8, capacity: i32) -> i32 {
    unsafe { copy_output(buffer, capacity, b"mt5bridge/0.2.0") }
}

/// role: 0=SERVICE 2=MARKET（组件属性；单端口模型下不决定端口）；instance_key：MARKET 用品种名。
#[no_mangle]
pub extern "system" fn Bridge_Register(role: i32, terminal_id: *const u16, instance_key: *const u16) -> i64 {
    let terminal = unsafe { mql5_string(terminal_id) };
    let key = unsafe { mql5_string(instance_key) };
    runtime::register_component(role, &terminal, &key)
}

#[no_mangle]
pub extern "system" fn Bridge_Unregister(handle: i64) -> i32 {
    runtime::unregister_component(handle)
}

#[no_mangle]
pub extern "system" fn Bridge_PeekSize(handle: i64) -> i32 {
    runtime::component_peek_size(handle)
}

/// 取一条入站消息；缓冲不足返回 -(所需字节)，MQL 加大缓冲重试。
#[no_mangle]
pub extern "system" fn Bridge_Poll(handle: i64, buffer: *mut u8, capacity: i32) -> i32 {
    if capacity < 0 || (capacity > 0 && buffer.is_null()) {
        return -1;
    }
    let (result, message) = runtime::component_poll(handle, capacity);
    match message {
        Some(message) => unsafe { copy_output(buffer, capacity, message.as_bytes()) },
        None => result,
    }
}

/// 回包（含 rid 回显）。只入连接出站队列，永不阻塞。
#[no_mangle]
pub extern "system" fn Bridge_Reply(_handle: i64, buffer: *const u8, length: i32) -> i32 {
    if length < 0 || (length > 0 && buffer.is_null()) {
        return -1;
    }
    let bytes = unsafe { std::slice::from_raw_parts(buffer, length as usize) };
    let rt = match runtime::runtime_if_initialized() {
        Some(rt) => rt,
        None => return -2,
    };
    let text = String::from_utf8_lossy(bytes);
    router::on_mql_reply(&rt, &text)
}

/// 事件扇出。queue_class: 0=RELIABLE 1=CONFLATED(同 symbol 覆盖)。
#[no_mangle]
pub extern "system" fn Bridge_Emit(_handle: i64, buffer: *const u8, length: i32, queue_class: i32) -> i32 {
    if length < 0 || (length > 0 && buffer.is_null()) {
        return -1;
    }
    let bytes = unsafe { std::slice::from_raw_parts(buffer, length as usize) };
    let rt = match runtime::runtime_if_initialized() {
        Some(rt) => rt,
        None => return -2,
    };
    let conflated = queue_class == 1;
    let text = String::from_utf8_lossy(bytes);
    router::on_mql_emit(&rt, &text, conflated)
}

#[no_mangle]
pub extern "system" fn Bridge_Status() -> i32 {
    runtime::current_status()
}

#[no_mangle]
pub extern "system" fn Bridge_LastError(buffer: *mut u8, capacity: i32) -> i32 {
    let message = runtime::last_error();
    unsafe { copy_output(buffer, capacity, message.as_bytes()) }
}
