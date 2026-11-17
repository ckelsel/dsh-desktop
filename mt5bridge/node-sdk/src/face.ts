// 终端面：裸 TCP + NDJSON 的服务端，等 MT5 里的 DLL 拨入。协议与 gateway/gateway.mjs
// 的终端面逐行对齐（MT5 侧零改动）：
//   认证   DLL 连上发 bridge.hello（token 不匹配即拒）
//   请求   {jsonrpc,id,method,params} 行 → 终端回 {id,result} 或 {id,error:{code,message}}
//   事件   {jsonrpc,method:'event.*',seq?,params} 行（seq 为终端会话内序号，DLL 注入）
//   心跳   本面 15s 发 system.ping，30s 无任何入站销毁连接
import { createServer, type Server, type Socket } from 'node:net'
import { EventEmitter } from 'node:events'

const MAX_LINE = 8 * 1024 * 1024
const PING_MS = 15_000
const IDLE_MS = 30_000

/** 一个已认证的 MT5 会话（一台终端）。 */
export class TerminalSession {
  terminalId: string | null = null
  role = ''
  version = ''
  /** component_id → symbol（market 组件注册表；market.book 路由依据） */
  readonly components = new Map<string, string>()

  constructor(readonly sock: Socket) {}

  send(frame: object): void {
    if (!this.sock.destroyed) this.sock.write(JSON.stringify(frame) + '\n')
  }
}

export interface TerminalFaceEvents {
  /** hello 认证通过（同 terminal_id 重连时先对旧会话发 gone）。 */
  session: [session: TerminalSession]
  gone: [session: TerminalSession, reason: string]
  /** RPC 回包：{id, result} 或 {id, error}。 */
  response: [msg: { id?: string | number; result?: unknown; error?: { code: number; message: string } }]
  /** 终端事件行（event.*，含 component 与 resync_required；seq 在顶层）。 */
  event: [session: TerminalSession, msg: { method: string; seq?: number; params: Record<string, unknown> }]
}

export class TerminalFace extends EventEmitter<TerminalFaceEvents> {
  private server: Server | null = null
  private readonly sessions = new Map<string, TerminalSession>()
  private readonly sockets = new Set<Socket>()
  private pingTimer: NodeJS.Timeout | null = null
  private connSeq = 0
  /** 实际监听端口（opts.port=0 时为随机端口，测试用）。 */
  port = 0

  constructor(
    private readonly token: string,
    private readonly log: (event: string, fields?: Record<string, unknown>) => void,
  ) {
    super()
  }

  listen(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer(sock => this.onConnection(sock))
      this.server.on('error', reject)
      this.server.listen(port, host, () => {
        const address = this.server!.address()
        this.port = typeof address === 'object' && address !== null ? address.port : port
        this.pingTimer = setInterval(() => this.ping(), PING_MS)
        this.pingTimer.unref()
        resolve()
      })
    })
  }

  stop(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer)
    this.pingTimer = null
    for (const session of this.sessions.values()) {
      this.emit('gone', session, 'stopped')
      session.sock.destroy()
    }
    this.sessions.clear()
    for (const sock of this.sockets) sock.destroy()
    this.sockets.clear()
    this.server?.close()
    this.server = null
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id)
  }

  all(): TerminalSession[] {
    return [...this.sessions.values()]
  }

  private onConnection(sock: Socket): void {
    sock.setNoDelay(true)
    this.sockets.add(sock)
    const connId = ++this.connSeq
    const session = new TerminalSession(sock)
    let authenticated = false
    let idleTimer: NodeJS.Timeout | null = null
    let buf = ''
    const touch = () => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => drop('idle timeout'), IDLE_MS)
      idleTimer.unref()
    }
    const drop = (reason: string) => {
      if (idleTimer !== null) clearTimeout(idleTimer)
      idleTimer = null
      this.sockets.delete(sock)
      if (!sock.destroyed) sock.destroy()
      if (authenticated && session.terminalId !== null) {
        this.sessions.delete(session.terminalId)
        this.emit('gone', session, reason)
      }
      this.log('face.connection-closed', { connId, reason })
    }

    sock.on('data', chunk => {
      touch() // 任意入站都续命（心跳/ping 同样算活着）
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const text = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (text !== '') this.handleLine(session, text, () => { authenticated = true })
      }
      if (buf.length > MAX_LINE) drop('line too long')
    })
    sock.on('close', () => drop('closed'))
    sock.on('error', () => drop('error'))
    touch()
    this.log('face.connection-accepted', { connId })
  }

  private handleLine(session: TerminalSession, text: string, markAuthenticated: () => void): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(text) as Record<string, unknown>
    } catch {
      return
    }
    if (typeof msg.method === 'string') {
      if (msg.method === 'system.ping' || msg.method === 'system.pong') return
      if (msg.method === 'bridge.hello') {
        const params = (msg.params ?? {}) as Record<string, unknown>
        if (this.token !== '' && params.token !== this.token) {
          session.send({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'AUTH_FAILED: token mismatch' } })
          setTimeout(() => session.sock.destroy(), 200)
          this.log('face.hello-rejected', {})
          return
        }
        const id = typeof params.terminal_id === 'string' && params.terminal_id !== '' ? params.terminal_id : `anon-${session.sock.remotePort}`
        const previous = this.sessions.get(id)
        if (previous !== undefined && previous !== session) {
          this.emit('gone', previous, 'replaced')
          previous.sock.destroy()
        }
        session.terminalId = id
        session.role = typeof params.role === 'string' ? params.role : 'SERVICE'
        session.version = typeof params.version === 'string' ? params.version : ''
        this.sessions.set(id, session)
        markAuthenticated()
        this.emit('session', session)
        this.log('face.hello', { id, role: session.role, version: session.version })
        return
      }
      // 未认证连接只认 hello
      if (session.terminalId === null) return
      if (msg.method === 'event.component') {
        const { type, component_id, symbol } = (msg.params ?? {}) as { type?: string; component_id?: string; symbol?: string }
        if (type === 'registered' && component_id !== undefined) session.components.set(component_id, symbol ?? '')
        else if (type === 'unregistered' && component_id !== undefined) session.components.delete(component_id)
        return
      }
      if (msg.method.startsWith('event.')) {
        this.emit('event', session, msg as unknown as { method: string; seq?: number; params: Record<string, unknown> })
        return
      }
      this.log('face.unknown-notification', { method: msg.method })
      return
    }
    if (session.terminalId === null) return
    this.emit('response', msg as { id?: string | number; result?: unknown; error?: { code: number; message: string } })
  }

  private ping(): void {
    for (const session of this.sessions.values()) {
      session.send({ jsonrpc: '2.0', method: 'system.ping', params: { time_ms: Date.now() } })
    }
  }
}
