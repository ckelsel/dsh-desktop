//! 连接出站队列：分级（RELIABLE 有界溢出断开 / CONFLATED 同 key 覆盖）。
//! FFI 线程只做 O(1) 入队；网络写出由每连接写线程完成。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum OutClass {
    Reliable,
    Conflated,
}

pub(crate) enum OutItem {
    Text { class: OutClass, key: Option<String>, text: String },
    /// 应用层心跳行（system.ping），由写线程展开为 JSON 行。
    Ping,
    Close,
}

pub(crate) struct ConnQueue {
    items: Mutex<VecDeque<OutItem>>,
    cv: Condvar,
    cap: usize,
    dead: AtomicBool,
}

fn is_conflated_with(item: &OutItem, key: &str) -> bool {
    matches!(item, OutItem::Text { class: OutClass::Conflated, key: Some(k), .. } if k == key)
}

impl ConnQueue {
    pub(crate) fn new(cap: usize) -> Arc<Self> {
        Arc::new(Self {
            items: Mutex::new(VecDeque::new()),
            cv: Condvar::new(),
            cap,
            dead: AtomicBool::new(false),
        })
    }

    /// RELIABLE：有界；溢出 = 该慢客户端断开（Close 入队后标记 dead），不影响他人。
    /// 返回 false 表示溢出已触发断开。
    pub(crate) fn push_reliable(&self, text: String) -> bool {
        let mut q = self.items.lock().unwrap();
        if self.dead.load(Ordering::Acquire) {
            return true; // 已断开：静默丢弃
        }
        if q.len() >= self.cap {
            q.push_back(OutItem::Close);
            self.dead.store(true, Ordering::Release);
            self.cv.notify_all();
            return false;
        }
        q.push_back(OutItem::Text { class: OutClass::Reliable, key: None, text });
        self.cv.notify_one();
        true
    }

    /// CONFLATED：同 key 覆盖旧值（tick 天然可丢旧）；永不溢出。
    pub(crate) fn push_conflated(&self, key: &str, text: String) {
        let mut q = self.items.lock().unwrap();
        if self.dead.load(Ordering::Acquire) {
            return;
        }
        let mut i = 0;
        while i < q.len() {
            if is_conflated_with(&q[i], key) {
                q.remove(i);
            } else {
                i += 1;
            }
        }
        if q.len() >= self.cap {
            if let Some(pos) = q.iter().position(|it| matches!(it, OutItem::Text { class: OutClass::Conflated, .. })) {
                q.remove(pos);
            }
        }
        q.push_back(OutItem::Text { class: OutClass::Conflated, key: Some(key.to_owned()), text });
        self.cv.notify_one();
    }

    pub(crate) fn push_control(&self, item: OutItem) {
        let mut q = self.items.lock().unwrap();
        q.push_back(item);
        self.cv.notify_one();
    }

    pub(crate) fn mark_dead(&self) {
        self.dead.store(true, Ordering::Release);
        self.cv.notify_all();
    }

    pub(crate) fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Acquire)
    }

    /// 写线程专用：阻塞取一条；dead 且排空后返回 None 结束线程。
    pub(crate) fn pop_wait(&self, timeout: Duration) -> Option<OutItem> {
        let mut q = self.items.lock().unwrap();
        loop {
            if let Some(item) = q.pop_front() {
                return Some(item);
            }
            if self.dead.load(Ordering::Acquire) {
                return None;
            }
            let (guard, _) = self.cv.wait_timeout(q, timeout).unwrap();
            q = guard;
        }
    }
}
