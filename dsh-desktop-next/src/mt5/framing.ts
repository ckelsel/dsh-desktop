/**
 * Newline-delimited JSON framing of the MT5 bridge. Bytes are collected until a newline, so a
 * frame or a UTF-8 character split across TCP reads decodes once complete. A frame longer than the
 * limit is a protocol error: the caller closes the connection instead of buffering without bound.
 */
import { MT5_MAX_LINE_BYTES } from './protocol.ts'

const NEWLINE = 0x0a

export class Mt5FrameTooLargeError extends Error {
  constructor(limit: number) {
    super(`MT5 bridge frame exceeds ${String(limit)} bytes`)
    this.name = 'Mt5FrameTooLargeError'
  }
}

/** Splits a byte stream into lines. */
export class Mt5LineDecoder {
  private parts: Buffer[] = []
  private size = 0

  constructor(private readonly limit: number = MT5_MAX_LINE_BYTES) {}

  /**
   * Add received bytes.
   * @returns the lines completed by these bytes, without their line ending; empty lines are skipped.
   * @throws Mt5FrameTooLargeError when a line grows past the limit.
   */
  push(chunk: Buffer): string[] {
    const lines: string[] = []
    let start = 0
    for (let newline = chunk.indexOf(NEWLINE, start); newline >= 0; newline = chunk.indexOf(NEWLINE, start)) {
      const tail = chunk.subarray(start, newline)
      if (this.size + tail.length > this.limit) throw new Mt5FrameTooLargeError(this.limit)
      const bytes = this.parts.length === 0 ? tail : Buffer.concat([...this.parts, tail], this.size + tail.length)
      this.parts = []
      this.size = 0
      start = newline + 1
      const line = bytes.toString('utf8')
      const text = line.endsWith('\r') ? line.slice(0, -1) : line
      if (text.trim().length > 0) lines.push(text)
    }
    if (start < chunk.length) {
      const rest = chunk.subarray(start)
      if (this.size + rest.length > this.limit) throw new Mt5FrameTooLargeError(this.limit)
      // Own the bytes: the caller may reuse its buffer.
      this.parts.push(Buffer.from(rest))
      this.size += rest.length
    }
    return lines
  }

  /** Bytes waiting for their newline. */
  get pending(): number {
    return this.size
  }
}

/** Encode one frame as a line. */
export function encodeLine(frame: object): Buffer {
  return Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8')
}
