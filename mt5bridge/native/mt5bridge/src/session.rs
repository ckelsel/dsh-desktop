//! 连接会话与 pending（rid → conn + 原始 id + deadline）。

use crate::queue::ConnQueue;
use serde_json::Value;
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use std::time::Instant;

pub(crate) struct ConnHandle {
    pub(crate) id: u64,
    pub(crate) queue: Arc<ConnQueue>,
    pub(crate) next_seq: AtomicU64,
    pub(crate) remote: String,
    /// 存一份 stream 克隆，Runtime 停止时能 shutdown 解除读线程阻塞。
    pub(crate) shutdown_stream: Mutex<Option<TcpStream>>,
}

impl ConnHandle {
    pub(crate) fn force_shutdown(&self) {
        self.queue.mark_dead();
        if let Ok(mut slot) = self.shutdown_stream.lock() {
            if let Some(stream) = slot.take() {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
    }
}

pub(crate) struct Pending {
    pub(crate) conn: u64,
    pub(crate) id: Value,
    pub(crate) deadline: Instant,
}
