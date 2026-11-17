//! 终端↔网关传输：裸 TCP + NDJSON（帧 = 一行 UTF-8 JSON + '\n'）。
//! 终端面消费者只有自家 DLL，无浏览器，WS 的握手/掩码/分片在此纯属负担。
//! 消息上限 8MB（与原 WS 实现一致）；行不完整时继续等。

use std::io::{self, BufRead, BufReader, Write};
use std::net::TcpStream;

const MAX_MESSAGE: usize = 8 * 1024 * 1024;

/// 读一行 JSON（含 '\n'）。EOF / 超长 / 非 UTF-8 均为错误（断开重连）。
pub(crate) fn read_message(reader: &mut BufReader<TcpStream>) -> io::Result<String> {
    let mut line = Vec::with_capacity(512);
    let n = reader.read_until(b'\n', &mut line)?;
    if n == 0 {
        return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "connection closed"));
    }
    if line.len() > MAX_MESSAGE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "message too large"));
    }
    if line.last() == Some(&b'\n') {
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
    }
    String::from_utf8(line).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "invalid utf-8"))
}

/// 写一行 JSON（自动补 '\n'' 并 flush）。
pub(crate) fn write_message<W: Write>(out: &mut W, text: &str) -> io::Result<()> {
    out.write_all(text.as_bytes())?;
    out.write_all(b"\n")?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_line() {
        let mut buf: Vec<u8> = Vec::new();
        write_message(&mut buf, r#"{"a":1}"#).unwrap();
        assert_eq!(buf, b"{\"a\":1}\n");
    }
}
