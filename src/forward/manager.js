/**
 * Local port forwarding — the host side of `ssh -L`.
 *
 * A rule is `本地端口 → 远端 host:port`. This module owns the listening
 * `net.Server`s; the SSH side is a `direct-tcpip` channel borrowed from the
 * pool, so every tunnel rides the host's single authenticated connection.
 *
 * Two decisions worth stating:
 *
 * - **Least exposure by default.** A rule binds `127.0.0.1`; binding a public
 *   interface is possible but reported back as `exposed` so the panel can warn.
 *   Forwarding a database port onto `0.0.0.0` is how laptops end up on scan lists.
 * - **Listeners outlive the connection.** The pool reconnects lazily on the next
 *   channel request, so a listener is not torn down when SSH drops; only an
 *   explicit stop, disconnect or host change does that.
 * @module dsh-remote-ssh/forward/manager
 */
import { createServer } from 'node:net'
import { RemoteError } from '../ssh/pool.js'
import { nextId } from '../util.js'

/** Addresses that keep the tunnel on this machine. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

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

/**
 * Map a `net.Server.listen` failure to a code the UI can branch on.
 *
 * `EADDRINUSE` is by far the most common — usually the user's own dev server on
 * the same port — and it must say so, because the fix (pick another local port)
 * is not obvious from a raw listen error.
 */
function listenError(error, rule) {
  if (error?.code === 'EADDRINUSE') {
    return new RemoteError('port-in-use', `本地端口 ${rule.localPort} 已被占用，换一个本地端口再试`, 409)
  }
  if (error?.code === 'EACCES') {
    return new RemoteError('port-denied', `没有权限监听端口 ${rule.localPort}（1024 以下需要管理员）`, 403)
  }
  if (error?.code === 'EADDRNOTAVAIL' || error?.code === 'ENOTFOUND') {
    return new RemoteError('bad-bind', `无法绑定到 ${rule.bind}：本机没有这个地址`, 400)
  }
  return new RemoteError('listen-failed', `监听 ${rule.bind}:${rule.localPort} 失败：${messageOf(error)}`, 500)
}

export class ForwardManager {
  /**
   * Live listeners, keyed by rule id.
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
    return rule
  }

  /** Wire shape: stored fields plus live tunnel state. */
  #describe(rule) {
    const live = this.#live.get(rule.id)
    const failure = this.#failed.get(rule.id)
    return {
      ...rule,
      state: live?.state ?? (failure === undefined ? 'stopped' : 'error'),
      error: live?.error ?? failure,
      local: `${rule.bind}:${rule.localPort}`,
      target: `${rule.remoteHost}:${rule.remotePort}`,
      exposed: !LOOPBACK.has(rule.bind),
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
      rules: this.store.forwards(hostId).map((rule) => this.#describe(rule)),
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
   * @param {object} input - `{id?, localPort, remoteHost?, remotePort, bind?, autoStart?, note?}`.
   * @returns {Promise<object>} the host view.
   */
  async save(hostId, input = {}) {
    this.#host(hostId)
    const localPort = portValue(input.localPort, '本地端口')
    const remotePort = portValue(input.remotePort, '远端端口')
    const remoteHost = text(input.remoteHost) || '127.0.0.1'
    const bind = text(input.bind) || '127.0.0.1'
    const id = text(input.id) || nextId('fwd')

    // Two rules on the same local socket can never both listen; catching it here
    // names the conflicting rule instead of failing later with EADDRINUSE.
    const clash = this.store.allForwards().find((rule) => (
      rule.id !== id && rule.bind === bind && rule.localPort === localPort
    ))
    if (clash !== undefined) {
      throw new RemoteError('duplicate-port', `本地端口 ${localPort} 已被另一条规则（${clash.remoteHost}:${clash.remotePort}）占用`, 409)
    }

    const previous = this.store.forwards(hostId).find((rule) => rule.id === id)
    const rule = {
      id,
      localPort,
      remoteHost,
      remotePort,
      bind,
      autoStart: input.autoStart !== false,
      note: text(input.note) || undefined,
      createdAt: previous?.createdAt ?? Date.now(),
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

    const record = {
      hostId,
      rule,
      server: createServer(),
      state: 'starting',
      connections: new Set(),
      bytes: 0,
      since: Date.now(),
    }
    this.#live.set(ruleId, record)
    record.server.on('connection', (socket) => { void this.#bridge(host, rule, record, socket) })

    try {
      await new Promise((resolve, reject) => {
        const failed = (error) => reject(listenError(error, rule))
        record.server.once('error', failed)
        record.server.listen({ port: rule.localPort, host: rule.bind, exclusive: true }, () => {
          record.server.removeListener('error', failed)
          resolve()
        })
      })
    } catch (error) {
      this.#live.delete(ruleId)
      this.#failed.set(ruleId, messageOf(error))
      throw error
    }

    // After listen succeeds, later errors are recorded rather than thrown: a
    // socket-level failure must not take the whole plugin down.
    record.server.on('error', (error) => { record.error = messageOf(error) })
    record.state = 'listening'
    this.#failed.delete(ruleId)
    return this.#hostView(hostId)
  }

  /** Stop one rule and close every socket it was serving. */
  async stop(hostId, ruleId) {
    this.#failed.delete(ruleId)
    const live = this.#live.get(ruleId)
    if (live !== undefined) {
      this.#live.delete(ruleId)
      for (const socket of live.connections) socket.destroy()
      live.connections.clear()
      live.server.closeAllConnections?.()
      await new Promise((resolve) => live.server.close(() => resolve()))
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
      live.server.closeAllConnections?.()
      await new Promise((resolve) => live.server.close(() => resolve())).catch(() => {})
    }
    this.#failed.clear()
  }

  /**
   * Serve one inbound socket: open the SSH channel, then pipe both ways.
   *
   * Bytes are counted in both directions for the panel's traffic readout, and a
   * failed channel closes the socket immediately — a tunnel that cannot reach
   * its target must look like a refused connection, not hang.
   */
  async #bridge(host, rule, record, socket) {
    record.connections.add(socket)
    socket.on('close', () => record.connections.delete(socket))
    socket.on('error', () => {})

    let channel
    try {
      channel = await this.pool.forward(host, rule.remoteHost, rule.remotePort)
    } catch (error) {
      record.error = messageOf(error)
      this.#failed.set(rule.id, record.error)
      socket.destroy()
      return
    }

    record.error = undefined
    this.#failed.delete(rule.id)
    socket.on('data', (chunk) => { record.bytes += chunk.length })
    channel.on('data', (chunk) => { record.bytes += chunk.length })
    channel.on('error', (error) => { record.error = messageOf(error) })
    channel.on('close', () => socket.destroy())
    socket.on('close', () => { try { channel.close() } catch { /* already gone */ } })

    socket.pipe(channel)
    channel.pipe(socket)
  }
}
