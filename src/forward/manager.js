/**
 * Port forwarding — the three shapes OpenSSH offers, in one rule list.
 *
 * | kind      | 监听 | 目标             | OpenSSH |
 * | --------- | ---- | ---------------- | ------- |
 * | `local`   | 本机 | 远端 host:port   | `-L`    |
 * | `dynamic` | 本机 | 每连接再定       | `-D`    |
 * | `remote`  | 远端 | 本机 host:port   | `-R`    |
 *
 * The SSH side is always a channel borrowed from the pool, so every tunnel rides
 * the host's single authenticated connection. What differs is who listens:
 * `-L`/`-D` own a `net.Server` here, `-R` asks the *server* to listen and
 * receives inbound channels through `pool.requestRemoteForward`.
 *
 * Three decisions worth stating:
 *
 * - **Least exposure by default.** A rule binds loopback; binding a public
 *   interface is possible but reported back as `exposed` so the panel can warn.
 *   Forwarding a database port onto `0.0.0.0` is how laptops end up on scan lists.
 * - **Listeners outlive the connection.** The pool reconnects lazily on the next
 *   channel request, so a local listener is not torn down when SSH drops; only an
 *   explicit stop, disconnect or host change does that. A *remote* listener is
 *   the exception the pool handles: the port is on the server, so it is
 *   re-requested on reconnect instead of being claimed to still exist.
 * - **A failed dial is not a failed rule — for `-D`.** A `-L`/`-R` rule has one
 *   target the user configured, so its failure is about *their* rule and belongs
 *   in the panel. A SOCKS proxy fans out to whatever each client asks for, so one
 *   unreachable target says nothing about the proxy; the refusal goes back as a
 *   SOCKS reply code and the rule stays healthy.
 * @module dsh-remote-ssh/forward/manager
 */
import { createServer, connect as netConnect } from 'node:net'
import { RemoteError } from '../ssh/pool.js'
import { nextId } from '../util.js'
import { KIND, LOOPBACK, describeRule, listenSide, normalizeRule, sameSocketSpace } from './rule.js'
import { REPLY, readSocksRequest, replyBuffer, replyForError } from './socks5.js'

/** Trimmed string or empty. */
function text(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Validate a TCP port and return it as an integer. */
function portValue(value, label) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new RemoteError('bad-port', `${label}必须是 1-65535 的整数`, 400)
  }
  return parsed
}

/** Human message for a thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Port label for each side of each kind — the error must name the right end. */
function portLabel(kind, side) {
  if (side === 'listen') {
    if (kind === KIND.dynamic) return 'SOCKS5 端口'
    return kind === KIND.remote ? '远端端口（服务器上监听）' : '本地端口'
  }
  return kind === KIND.remote ? '本机端口（转发目标）' : '远端端口'
}

/**
 * Map a `net.Server.listen` failure to a code the UI can branch on.
 *
 * `EADDRINUSE` is by far the most common — usually the user's own dev server on
 * the same port — and it must say so, because the fix (pick another port) is not
 * obvious from a raw listen error.
 */
function listenError(error, rule) {
  const where = `${rule.listen.host}:${rule.listen.port}`
  if (error?.code === 'EADDRINUSE') {
    return new RemoteError('port-in-use', `端口 ${where} 已被占用，换一个端口再试`, 409)
  }
  if (error?.code === 'EACCES') {
    return new RemoteError('port-denied', `没有权限监听端口 ${rule.listen.port}（1024 以下需要管理员）`, 403)
  }
  if (error?.code === 'EADDRNOTAVAIL' || error?.code === 'ENOTFOUND') {
    return new RemoteError('bad-bind', `无法绑定到 ${rule.listen.host}：本机没有这个地址`, 400)
  }
  return new RemoteError('listen-failed', `监听 ${where} 失败：${messageOf(error)}`, 500)
}

export class ForwardManager {
  /**
   * Live listeners (or remote registrations), keyed by rule id.
   * @type {Map<string, object>}
   */
  #live = new Map()

  /**
   * Last failure per rule, so a rule that could not start still explains itself
   * in the panel (a stopped listener has no record in `#live`).
   * @type {Map<string, string>}
   */
  #failed = new Map()

  /**
   * @param {object} options - dependencies.
   * @param {object} options.store - state store.
   * @param {import('../ssh/pool.js').SshPool} options.pool - SSH pool.
   */
  constructor({ store, pool }) {
    this.store = store
    this.pool = pool
  }

  /** Resolve a stored host or fail with the code the UI matches on. */
  #host(hostId) {
    const host = this.store.host(hostId)
    if (host === undefined) throw new RemoteError('host-missing', '主机不存在，请先保存连接', 404)
    return host
  }

  /** The rule row, or a 404. */
  #rule(hostId, ruleId) {
    const rule = this.store.forwards(hostId).find((item) => item.id === ruleId)
    if (rule === undefined) throw new RemoteError('rule-missing', '转发规则不存在', 404)
    return normalizeRule(rule)
  }

  /** Wire shape: stored fields plus live tunnel state. */
  #describe(rule, hostId) {
    const live = this.#live.get(rule.id)
    const failure = this.#failed.get(rule.id)
    const listenText = `${rule.listen.host}:${rule.listen.port}`
    const targetText = rule.kind === KIND.dynamic ? 'SOCKS5' : `${rule.target.host}:${rule.target.port}`

    let state = live?.state ?? (failure === undefined ? 'stopped' : 'error')
    let error = live?.error ?? failure

    // A remote listener lives on the server and dies with the connection. The
    // rule still reads `listening` locally, so the pool's registration is the
    // only witness that the port actually exists right now.
    if (rule.kind === KIND.remote && live !== undefined) {
      const remote = this.pool.remoteForwardState(hostId, rule.listen.host, rule.listen.port)
      if (remote?.error !== undefined) {
        state = 'error'
        error = remote.error
      } else if (remote === undefined || remote.held === false) {
        state = 'error'
        error = 'SSH 连接已断开，服务器上的端口暂时不存在（重连后自动恢复）'
      }
    }

    return {
      ...rule,
      state,
      error,
      kindLabel: rule.kind,
      // `link` / `to` are the two ends rendered for display. The structured
      // `listen` / `target` objects pass through untouched: a single name cannot
      // be both the address and the string to show, and shadowing the object here
      // is exactly the bug this comment is standing in front of.
      link: listenText,
      to: targetText,
      listenSide: listenSide(rule.kind),
      granted: live?.granted,
      exposed: !LOOPBACK.has(rule.listen.host) && rule.listen.host !== '',
      connections: live?.connections.size ?? 0,
      bytes: live?.bytes ?? 0,
      since: live?.since,
    }
  }

  /** One host's rules. */
  #hostView(hostId) {
    const host = this.store.host(hostId)
    return {
      hostId,
      hostName: host?.name ?? '(主机已删除)',
      status: this.pool.status(hostId),
      rules: this.store.forwards(hostId).map((rule) => this.#describe(normalizeRule(rule), hostId)),
    }
  }

  /**
   * Rules grouped by host.
   * @param {string} [hostId] - restrict to one host; omitted lists every host
   *   that has at least one rule.
   * @returns {Array<object>} one entry per host.
   */
  list(hostId) {
    if (typeof hostId === 'string' && hostId !== '') return [this.#hostView(hostId)]
    return Object.keys(this.store.state.forwards).map((id) => this.#hostView(id))
  }

  /**
   * Create or update a rule. A running rule is restarted so the new settings take
   * effect at once; a restart failure is recorded on the rule rather than thrown,
   * because the save itself succeeded and the panel needs to show both facts.
   * @param {string} hostId - owning host.
   * @param {object} input - `{id?, kind?, listen?, target?, autoStart?, note?}`; the
   *   0.5.x shape `{localPort, remoteHost, remotePort, bind}` is still accepted.
   * @returns {Promise<object>} the host view.
   */
  async save(hostId, input = {}) {
    this.#host(hostId)
    const id = text(input.id) || nextId('fwd')
    const previous = this.store.forwards(hostId).find((rule) => rule.id === id)
    const rule = normalizeRule({ ...input, id, createdAt: previous?.createdAt })
    rule.listen.port = portValue(rule.listen.port, portLabel(rule.kind, 'listen'))
    if (rule.kind !== KIND.dynamic) {
      rule.target.port = portValue(rule.target.port, portLabel(rule.kind, 'target'))
      if (rule.target.host === '') {
        throw new RemoteError('bad-target', rule.kind === KIND.remote ? '请填写本机目标地址' : '请填写远端目标地址', 400)
      }
    }

    // Two rules on the same socket can never both listen; catching it here names
    // the conflicting rule instead of failing later with EADDRINUSE. Rules that
    // listen on different machines (a `-L` here, a `-R` there) never clash.
    const clash = this.store.allForwards().find((other) => (
      other.id !== id && sameSocketSpace(normalizeRule(other), rule, other.hostId, hostId)
    ))
    if (clash !== undefined) {
      const where = listenSide(rule.kind) === 'remote' ? '服务器上' : '本机'
      throw new RemoteError(
        'duplicate-port',
        `${where}端口 ${rule.listen.port} 已被另一条规则（${describeRule(normalizeRule(clash))}）占用`,
        409,
      )
    }

    await this.store.setForwards(hostId, [...this.store.forwards(hostId).filter((item) => item.id !== id), rule])

    if (this.#live.has(id)) {
      await this.stop(hostId, id)
      if (rule.autoStart !== false) await this.start(hostId, id).catch(() => {})
    }
    return this.#hostView(hostId)
  }

  /**
   * Start one rule.
   * @param {string} hostId - owning host.
   * @param {string} ruleId - rule to start.
   * @returns {Promise<object>} the host view.
   */
  async start(hostId, ruleId) {
    const host = this.#host(hostId)
    const rule = this.#rule(hostId, ruleId)
    if (this.#live.get(ruleId)?.state === 'listening') return this.#hostView(hostId)
    if (rule.kind === KIND.remote) return this.#startRemote(host, rule, hostId)
    return this.#startLocal(host, rule, hostId)
  }

  /** `-L` and `-D`: a listener on this machine. */
  async #startLocal(host, rule, hostId) {
    const server = createServer()
    const record = {
      hostId,
      rule,
      server,
      state: 'starting',
      connections: new Set(),
      bytes: 0,
      since: Date.now(),
    }
    this.#live.set(rule.id, record)
    server.on('connection', (socket) => {
      if (rule.kind === KIND.dynamic) void this.#serveSocks(host, record, socket)
      else void this.#bridge(host, record, socket)
    })

    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => reject(listenError(error, rule))
        server.once('error', failed)
        server.listen({ port: rule.listen.port, host: rule.listen.host, exclusive: true }, () => {
          server.removeListener('error', failed)
          resolve()
        })
      })
    } catch (error) {
      this.#live.delete(rule.id)
      this.#failed.set(rule.id, messageOf(error))
      throw error
    }

    // After listen succeeds, later errors are recorded rather than thrown: a
    // socket-level failure must not take the whole plugin down.
    server.on('error', (error) => { record.error = messageOf(error) })
    record.state = 'listening'
    this.#failed.delete(rule.id)
    return this.#hostView(hostId)
  }

  /** `-R`: the *server* listens, and inbound channels arrive through the pool. */
  async #startRemote(host, rule, hostId) {
    const record = {
      hostId,
      rule,
      server: undefined,
      state: 'starting',
      connections: new Set(),
      bytes: 0,
      since: Date.now(),
    }
    this.#live.set(rule.id, record)
    try {
      record.granted = await this.pool.requestRemoteForward(
        host,
        rule.listen.host,
        rule.listen.port,
        (stream) => { this.#acceptRemote(record, stream) },
      )
    } catch (error) {
      this.#live.delete(rule.id)
      this.#failed.set(rule.id, messageOf(error))
      throw error
    }
    record.state = 'listening'
    this.#failed.delete(rule.id)
    return this.#hostView(hostId)
  }

  /** Stop one rule and close every socket it was serving. */
  async stop(hostId, ruleId) {
    this.#failed.delete(ruleId)
    const live = this.#live.get(ruleId)
    if (live === undefined) return this.#hostView(hostId)
    this.#live.delete(ruleId)
    for (const socket of live.connections) socket.destroy()
    live.connections.clear()
    if (live.server !== undefined) {
      live.server.closeAllConnections?.()
      await new Promise((resolve) => live.server.close(() => resolve()))
    }
    if (live.rule.kind === KIND.remote) {
      const host = this.store.host(hostId)
      if (host !== undefined) {
        await this.pool.releaseRemoteForward(host, live.rule.listen.host, live.rule.listen.port).catch(() => {})
      }
    }
    return this.#hostView(hostId)
  }

  /**
   * Start every `autoStart` rule of a host. Called after `hosts.connect`, so a
   * failed rule (port taken, remote service down) must not abort the rest.
   * @returns {Promise<object>} the host view.
   */
  async startAll(hostId) {
    for (const rule of this.store.forwards(hostId)) {
      if (rule.autoStart === false) continue
      await this.start(hostId, rule.id).catch(() => {})
    }
    return this.#hostView(hostId)
  }

  /** Stop every rule of a host, leaving the stored rules in place. */
  async stopAll(hostId) {
    for (const rule of this.store.forwards(hostId)) {
      await this.stop(hostId, rule.id).catch(() => {})
    }
    return this.#hostView(hostId)
  }

  /** Stop the live tunnels of one host (explicit disconnect / host change). */
  async stopHost(hostId) {
    for (const [ruleId, live] of [...this.#live]) {
      if (live.hostId !== hostId) continue
      await this.stop(hostId, ruleId).catch(() => {})
    }
    for (const rule of this.store.forwards(hostId)) this.#failed.delete(rule.id)
  }

  /** Delete a rule (stopping it first). */
  async remove(hostId, ruleId) {
    await this.stop(hostId, ruleId).catch(() => {})
    await this.store.setForwards(hostId, this.store.forwards(hostId).filter((rule) => rule.id !== ruleId))
    return this.#hostView(hostId)
  }

  /** Close every listener (plugin unload). */
  async dispose() {
    for (const [ruleId, live] of [...this.#live]) {
      this.#live.delete(ruleId)
      for (const socket of live.connections) socket.destroy()
      live.connections.clear()
      if (live.server !== undefined) {
        live.server.closeAllConnections?.()
        await new Promise((resolve) => live.server.close(() => resolve())).catch(() => {})
      }
    }
    this.#failed.clear()
  }

  /**
   * Serve one `-L` inbound socket: open the SSH channel, then pipe both ways.
   *
   * Bytes are counted in both directions for the panel's traffic readout, and a
   * failed channel closes the socket immediately — a tunnel that cannot reach its
   * target must look like a refused connection, not hang.
   */
  async #bridge(host, record, socket) {
    socket.on('error', () => {})
    let channel
    try {
      channel = await this.pool.forward(host, record.rule.target.host, record.rule.target.port)
    } catch (error) {
      record.error = messageOf(error)
      this.#failed.set(record.rule.id, record.error)
      socket.destroy()
      return
    }
    record.error = undefined
    this.#failed.delete(record.rule.id)
    this.#wire(record, socket, channel)
  }

  /**
   * Serve one `-D` inbound socket: SOCKS5 handshake, then dial whatever it asked
   * for.
   *
   * The reply is written only after the channel is open, so the client gets the
   * real outcome. Neither a malformed handshake nor a refused target is recorded
   * on the rule: a port scanner is not a broken tunnel, and one dead target says
   * nothing about a proxy that serves every target the client names.
   */
  async #serveSocks(host, record, socket) {
    socket.on('error', () => {})
    record.connections.add(socket)
    socket.on('close', () => record.connections.delete(socket))

    let request
    try {
      request = await readSocksRequest(socket)
    } catch {
      socket.destroy()
      return
    }

    let channel
    try {
      channel = await this.pool.forward(host, request.host, request.port)
    } catch (error) {
      socket.end(replyBuffer(replyForError(error)))
      return
    }

    socket.write(replyBuffer(REPLY.ok))
    // The client may have pipelined its first payload behind the request; those
    // bytes were consumed by the handshake parser and have to be replayed.
    if (request.rest.length > 0) channel.write(request.rest)
    this.#wire(record, socket, channel)
  }

  /**
   * Accept one `-R` inbound channel: dial the local target and pipe.
   *
   * A refused local target closes the channel, which is how the remote peer
   * learns the service is down — the same shape a refused `-L` has.
   */
  #acceptRemote(record, stream) {
    stream.on('error', () => {})
    const socket = netConnect({ host: record.rule.target.host, port: record.rule.target.port })
    socket.on('error', (error) => {
      record.error = messageOf(error)
      this.#failed.set(record.rule.id, record.error)
      try { stream.close() } catch { /* already gone */ }
    })
    socket.on('connect', () => {
      record.error = undefined
      this.#failed.delete(record.rule.id)
      this.#wire(record, socket, stream)
    })
  }

  /** Pipe a socket and its SSH channel together, counting bytes both ways. */
  #wire(record, socket, stream) {
    record.connections.add(socket)
    socket.on('close', () => record.connections.delete(socket))
    socket.on('data', (chunk) => { record.bytes += chunk.length })
    stream.on('data', (chunk) => { record.bytes += chunk.length })
    stream.on('error', (error) => { record.error = messageOf(error) })
    stream.on('close', () => socket.destroy())
    socket.on('close', () => { try { stream.close() } catch { /* already gone */ } })
    socket.pipe(stream)
    stream.pipe(socket)
  }
}
