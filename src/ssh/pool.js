/**
 * SSH connection pool.
 *
 * One `ssh2.Client` per host id, multiplexing every consumer: the file API
 * (SFTP), the terminal WebSockets (shell/exec channels), the agent tools
 * (exec) and the `ssh -L` port forwards (direct-tcpip channels). Connections
 * are opened lazily — `ensure()` connects on demand — so a
 * host that was disconnected or never touched costs nothing until it is used,
 * and a dropped connection heals on the next request instead of requiring a
 * manual reconnect.
 *
 * Authentication material never leaves this process: a passphrase or password
 * arrives with the connect request, is used for that `Client`, and is never
 * written to the state file.
 * @module dsh-remote-ssh/ssh/pool
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ssh2 from 'ssh2'
import { findSshHost } from './config.js'
import { expandHome } from './paths.js'
import { call, shq } from '../util.js'

// `ssh2` is CommonJS; the default import is the only portable form under ESM.
const { Client } = ssh2

/** Error with a stable machine-readable code for the JSON API. */
export class RemoteError extends Error {
  constructor(code, message, status = 400, details) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/** SHA256 fingerprint in the shape OpenSSH prints (`SHA256:base64`). */
function fingerprintOf(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/** `SSH_AUTH_SOCK`, or the Windows OpenSSH named pipe when unset. */
function agentSocket() {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent'
  return undefined
}

/** Map an ssh2 failure to a user-facing code the UI can branch on. */
function classify(error) {
  const message = String(error?.message ?? error)
  if (/All configured authentication methods failed/i.test(message)) {
    return new RemoteError('auth-failed', '认证失败：密钥/密码被拒绝，或密钥未加入远端 authorized_keys', 401)
  }
  if (/Host denied|host key verification failed|Host key verification/i.test(message)) {
    return new RemoteError('host-key-changed', '主机指纹与首次记录不一致，已中止连接', 409)
  }
  if (/Timed out while waiting for handshake|ETIMEDOUT|timeout/i.test(message)) {
    return new RemoteError('timeout', '连接超时：检查主机地址、端口与网络可达性', 504)
  }
  if (/ENOTFOUND|getaddrinfo/i.test(message)) {
    return new RemoteError('dns-failed', '主机名无法解析', 400)
  }
  if (/ECONNREFUSED/i.test(message)) {
    return new RemoteError('refused', '连接被拒绝：端口未监听或被防火墙拦截', 502)
  }
  if (/Cannot parse privateKey|bad passphrase|Encrypted private OpenSSH key/i.test(message)) {
    return new RemoteError('key-invalid', '私钥无法解析：检查路径、格式或 passphrase', 400)
  }
  return new RemoteError('ssh-error', message, 502)
}

export class SshPool {
  /** @type {Map<string, object>} */
  #records = new Map()
  /**
   * Reverse (`ssh -R`) forward registrations, per host, keyed `bindHost:bindPort`.
   *
   * They live here rather than in the forward manager because the listening
   * socket is on the *server* and dies with the SSH connection: only the pool
   * knows when a new client is ready, so only the pool can re-request the port.
   * A manager-owned registration would be silently stale after every reconnect.
   * @type {Map<string, Map<string, {bindHost: string, bindPort: number, granted?: number, client?: object, onConnection: Function}>>}
   */
  #reverse = new Map()
  /**
   * Credentials held in memory per host, never on disk.
   *
   * They exist so a *background* consumer can heal a dropped connection on its
   * own: a listening port-forward's next inbound socket, or a retried upload,
   * has no UI to re-ask for a password. Cleared as soon as a disconnect is
   * explicit (`close()`) or the plugin unloads.
   * @type {Map<string, {password?: string, passphrase?: string}>}
   */
  #secrets = new Map()
  /**
   * @param {object} options - pool options.
   * @param {(event: object) => void} [options.onEvent] - status change sink (UI/push).
   * @param {(hostId: string, fingerprint: string) => void} [options.onFingerprint] - persist a TOFU fingerprint.
   */
  constructor({ onEvent, onFingerprint } = {}) {
    this.onEvent = onEvent ?? (() => {})
    this.onFingerprint = onFingerprint ?? (() => {})
  }

  /** Snapshot of every known connection state. */
  statuses() {
    const result = {}
    for (const [hostId, record] of this.#records) {
      result[hostId] = { status: record.status, error: record.error, since: record.since, tmux: record.tmux }
    }
    return result
  }

  /** One connection state, `disconnected` when unknown. */
  status(hostId) {
    return this.#records.get(hostId)?.status ?? 'disconnected'
  }

  #setStatus(hostId, status, patch = {}) {
    const record = this.#records.get(hostId) ?? { hostId, status: 'disconnected' }
    record.status = status
    record.error = patch.error
    record.since = Date.now()
    if (patch.tmux !== undefined) record.tmux = patch.tmux
    this.#records.set(hostId, record)
    this.onEvent({ hostId, status, error: patch.error })
  }

  /**
   * Resolve a stored host row into ssh2 connection options, following one level
   * of ssh-config defaults for anything the row left blank.
   */
  #options(host) {
    const config = host.alias === undefined ? undefined : findSshHost(host.alias)
    const address = host.host ?? config?.host ?? host.alias
    if (typeof address !== 'string' || address === '') {
      throw new RemoteError('bad-host', '缺少主机地址', 400)
    }
    const auth = host.auth ?? { type: 'agent' }
    const options = {
      host: address,
      port: Number(host.port ?? config?.port ?? 22),
      username: host.user ?? config?.user ?? process.env.USER ?? process.env.USERNAME,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: (key) => this.#verifyHost(host, key),
    }
    if (typeof options.username !== 'string' || options.username === '') {
      throw new RemoteError('bad-user', '缺少登录用户名', 400)
    }
    if (auth.type === 'key') {
      const keyPath = expandHome(auth.keyPath ?? config?.identityFile)
      if (typeof keyPath !== 'string' || keyPath === '') {
        throw new RemoteError('bad-key', '请指定私钥文件', 400)
      }
      try {
        options.privateKey = readFileSync(keyPath)
      } catch (error) {
        throw new RemoteError('key-unreadable', `无法读取私钥 ${keyPath}：${error.message}`, 400)
      }
      if (typeof auth.passphrase === 'string' && auth.passphrase !== '') options.passphrase = auth.passphrase
    } else if (auth.type === 'password') {
      if (typeof auth.password !== 'string' || auth.password === '') {
        throw new RemoteError('bad-password', '请输入密码', 400)
      }
      options.password = auth.password
    } else {
      const agent = agentSocket()
      if (agent === undefined) throw new RemoteError('no-agent', '未找到 ssh-agent，请改用密钥文件认证', 400)
      options.agent = agent
    }
    return options
  }

  /** TOFU host key check: pin the first fingerprint, refuse a later change. */
  #verifyHost(host, key) {
    const fingerprint = fingerprintOf(key)
    if (host.fingerprint === undefined || host.fingerprint === '') {
      this.onFingerprint(host.id, fingerprint)
      return true
    }
    if (host.fingerprint === fingerprint) return true
    return false
  }

  /** Connect through a `ProxyJump` chain, at most two hops. */
  async #openWithJump(host, options, depth) {
    if (depth > 2) throw new RemoteError('jump-too-deep', 'ProxyJump 嵌套过深', 400)
    const jumpSpec = host.proxyJump ?? findSshHost(host.alias)?.proxyJump
    if (typeof jumpSpec !== 'string' || jumpSpec === '') return undefined
    const jump = jumpSpec.includes('@') ? jumpSpec.slice(jumpSpec.indexOf('@') + 1) : jumpSpec
    const jumpUser = jumpSpec.includes('@') ? jumpSpec.slice(0, jumpSpec.indexOf('@')) : undefined
    const jumpHost = {
      id: `jump:${jump}`,
      alias: jump,
      host: jump,
      user: jumpUser ?? host.user,
      port: 22,
      auth: host.jumpAuth ?? host.auth,
      fingerprint: host.jumpFingerprint,
    }
    const bastion = new Client()
    const bastionOptions = this.#options(jumpHost)
    await new Promise((resolve, reject) => {
      bastion.once('ready', resolve)
      bastion.once('error', (error) => reject(classify(error)))
      bastion.connect(bastionOptions)
    }).catch((error) => { throw error })
    const stream = await call(bastion, 'forwardOut', '127.0.0.1', 0, options.host, options.port)
    return { stream, dispose: () => bastion.end() }
  }

  /**
   * Ensure a live client for one host, connecting when needed.
   * @param {object} host - stored host row (`{id, host, port, user, auth, alias, fingerprint}`).
   * @returns {Promise<Client>} a ready client.
   */
  async ensure(host) {
    const existing = this.#records.get(host.id)
    if (existing?.status === 'connected' && existing.client !== undefined) return existing.client
    if (existing?.status === 'connecting' && existing.pending !== undefined) return existing.pending
    // Build the options *before* the record is claimed. A missing password, an
    // unreadable key or an absent ssh-agent is a configuration error, not a
    // failed attempt, and issue #5 was exactly this class of error getting
    // cached: `#options` used to throw inside `#connect` but *before* its
    // try/catch, so the rejection never marked the record while `ensure` had
    // already written `connecting` + that dead promise. Every later attempt —
    // password on the wire and all — was answered by replaying the rejection
    // ("请输入密码"), and the status bar sat on 连接中 forever.
    const options = this.#options(this.#withSecret(host))
    const pending = this.#connect(host, options)
    this.#records.set(host.id, { hostId: host.id, status: 'connecting', client: undefined, pending })
    this.#setStatus(host.id, 'connecting')
    return pending
  }

  /**
   * Host row with the in-memory secret merged in: a re-connect after a network
   * drop arrives without the password (the row never stores one), so the
   * remembered credential fills the gap. Nothing here touches the state file.
   */
  #withSecret(host) {
    const remembered = this.#secrets.get(host.id)
    if (remembered === undefined) return host
    return { ...host, auth: { ...(host.auth ?? { type: 'agent' }), ...remembered } }
  }

  async #connect(host, options) {
    const client = new Client()
    const record = () => this.#records.get(host.id)
    try {
      const jump = await this.#openWithJump(host, options, 0).catch((error) => { throw error })
      if (jump !== undefined) {
        options.sock = jump.stream
        client.__jump = jump
      }
      await new Promise((resolve, reject) => {
        client.once('ready', resolve)
        client.once('error', (error) => reject(classify(error)))
        client.connect(options)
      })
      client.on('error', (error) => {
        const current = record()
        if (current?.status === 'connected') this.#setStatus(host.id, 'error', { error: classify(error).message })
      })
      client.on('close', () => {
        const current = record()
        if (current === undefined || current.client !== client) return
        current.sftp?.end?.()
        this.#records.set(host.id, { hostId: host.id, status: 'disconnected', client: undefined })
        this.onEvent({ hostId: host.id, status: 'disconnected' })
      })
      // Inbound channels for `ssh -R` arrive on the client, not on a stream we
      // own, so the dispatch has to be installed per connection. It is installed
      // before the status flips to `connected`, so a forwarded connection racing
      // the handshake cannot land on a client with no listener.
      this.#attachInbound(host.id, client)
      const current = record()
      if (current !== undefined) {
        current.client = client
        current.status = 'connected'
        current.error = undefined
        current.since = Date.now()
      } else {
        this.#records.set(host.id, { hostId: host.id, status: 'connected', client, since: Date.now() })
      }
      this.onEvent({ hostId: host.id, status: 'connected' })
      this.#remember(host.id, options)
      // Reverse forwards must be re-requested on every fresh connection — the
      // server dropped those ports when the previous one closed. Awaited so the
      // caller never observes a "connected" host whose `-R` rules are not
      // actually reachable yet; failures are recorded per entry, not thrown.
      await this.#rearmReverse(host.id, client)
      return client
    } catch (error) {
      client.__jump?.dispose?.()
      this.#records.set(host.id, { hostId: host.id, status: 'error', error: error.message })
      this.onEvent({ hostId: host.id, status: 'error', error: error.message })
      throw error instanceof RemoteError ? error : classify(error)
    }
  }

  /** Keep the credentials of a successful connection in memory (never on disk). */
  #remember(hostId, options) {
    const secret = {}
    if (typeof options.password === 'string' && options.password !== '') secret.password = options.password
    if (typeof options.passphrase === 'string' && options.passphrase !== '') secret.passphrase = options.passphrase
    if (Object.keys(secret).length === 0) this.#secrets.delete(hostId)
    else this.#secrets.set(hostId, secret)
  }

  /** Drop a client and forget its credentials (an explicit disconnect). */
  close(hostId) {
    const record = this.#records.get(hostId)
    this.#secrets.delete(hostId)
    // Registrations die with the connection they belonged to; keeping them would
    // silently re-open server ports on the next connect without the user asking.
    this.#reverse.delete(hostId)
    if (record === undefined) return
    record.sftp?.end?.()
    record.client?.__jump?.dispose?.()
    record.client?.end()
    this.#records.set(hostId, { hostId, status: 'disconnected' })
    this.onEvent({ hostId, status: 'disconnected' })
  }

  /** Cached SFTP session for a host (re-opened after a reconnect). */
  async sftp(host) {
    const client = await this.ensure(host)
    const record = this.#records.get(host.id)
    if (record?.sftp !== undefined && record.sftpClient === client) return record.sftp
    const session = await new Promise((resolve, reject) => {
      client.sftp((error, sftp) => (error ? reject(classify(error)) : resolve(sftp)))
    })
    session.on?.('close', () => {
      const current = this.#records.get(host.id)
      if (current !== undefined) { current.sftp = undefined; current.sftpClient = undefined }
    })
    record.sftp = session
    record.sftpClient = client
    return session
  }

  /**
   * Run one command and collect its output.
   * @param {object} host - stored host row.
   * @param {string} command - shell command (already quoted where needed).
   * @param {{timeoutMs?: number, cwd?: string, maxBytes?: number}} [options] - execution bounds.
   * @returns {Promise<{stdout: string, stderr: string, code: number|null, truncated: boolean}>} result.
   */
  async exec(host, command, { timeoutMs = 20000, cwd, maxBytes = 4 * 1024 * 1024 } = {}) {
    const client = await this.ensure(host)
    const full = cwd === undefined ? command : `cd ${shq(cwd)} && ${command}`
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new RemoteError('exec-timeout', `远程命令超时（${timeoutMs}ms）：${command.slice(0, 120)}`, 504))
      }, timeoutMs)
      client.exec(full, (error, stream) => {
        if (error) {
          clearTimeout(timer)
          if (!settled) { settled = true; reject(classify(error)) }
          return
        }
        const out = []
        const err = []
        let outBytes = 0
        let truncated = false
        stream.on('data', (chunk) => {
          outBytes += chunk.length
          if (outBytes > maxBytes) { truncated = true; return }
          out.push(chunk)
        })
        stream.stderr.on('data', (chunk) => {
          if (err.length < 200) err.push(chunk)
        })
        stream.on('close', (code) => {
          clearTimeout(timer)
          if (settled) return
          settled = true
          resolve({
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: Buffer.concat(err).toString('utf8'),
            code: typeof code === 'number' ? code : null,
            truncated,
          })
        })
        stream.on('error', (streamError) => {
          clearTimeout(timer)
          if (!settled) { settled = true; reject(classify(streamError)) }
        })
      })
    })
  }

  /**
   * Open an interactive channel with a real PTY.
   * @param {object} host - stored host row.
   * @param {{command?: string, term?: string, cols?: number, rows?: number}} options - channel shape.
   * @returns {Promise<import('ssh2').ClientChannel>} the live channel.
   */
  async channel(host, { command, term = 'xterm-256color', cols = 100, rows = 30 } = {}) {
    const client = await this.ensure(host)
    const pty = { term, cols, rows }
    return new Promise((resolve, reject) => {
      const onChannel = (error, channel) => {
        if (error) reject(classify(error))
        else resolve(channel)
      }
      if (typeof command === 'string' && command !== '') client.exec(command, { pty }, onChannel)
      else client.shell({ term, cols, rows }, onChannel)
    })
  }

  /**
   * Open a `direct-tcpip` channel to `dstHost:dstPort` — the tunnel end of an
   * `ssh -L`. The source address is only used by the server for logging, so a
   * loopback placeholder is enough and avoids leaking the client's LAN address.
   *
   * `ensure()` runs first, which is what makes a listening tunnel self-healing:
   * after the connection drops, the next inbound socket reconnects here instead
   * of failing for as long as the listener lives.
   * @param {object} host - stored host row.
   * @param {string} dstHost - target host, resolved from the remote side.
   * @param {number} dstPort - target port.
   * @returns {Promise<import('stream').Duplex>} the channel stream.
   */
  async forward(host, dstHost, dstPort) {
    const client = await this.ensure(host)
    return new Promise((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, dstHost, dstPort, (error, stream) => {
        if (error) {
          // A refused target means the *remote* service is down, not the SSH
          // connection, so this must not be reported as a transport failure.
          // OpenSSH answers every failed `connect()` with a bare channel-open
          // failure (no reason string), which is why that message is listed too:
          // "refused" and "unreachable" are indistinguishable at this level, and
          // both mean the same thing to whoever is looking at the tunnel.
          reject(/ECONNREFUSED|connect failed|Channel open failure/i.test(String(error.message))
            ? new RemoteError('target-refused', `远端 ${dstHost}:${dstPort} 拒绝连接：服务未监听，或服务器无法访问该地址`, 502)
            : classify(error))
          return
        }
        resolve(stream)
      })
    })
  }

  /** Close every connection (plugin unload). */
  dispose() {
    for (const hostId of [...this.#records.keys()]) this.close(hostId)
    this.#records.clear()
    this.#secrets.clear()
    this.#reverse.clear()
  }

  /* ── reverse forwarding (`ssh -R`) ────────────────────────────────────── */

  /**
   * Ask the server to listen on `bindHost:bindPort` and route inbound
   * connections here. Idempotent: a rule already granted on the current client
   * only swaps its handler, so re-running `startAll` after a reconnect does not
   * stack duplicate requests (the second would be refused as in-use).
   * @param {object} host - stored host row.
   * @param {string} bindHost - address to bind *on the server*.
   * @param {number} bindPort - port to bind on the server.
   * @param {(stream: import('stream').Duplex, details: object) => void} onConnection - inbound sink.
   * @returns {Promise<number>} the granted port (differs from `bindPort` only when it was 0).
   */
  async requestRemoteForward(host, bindHost, bindPort, onConnection) {
    const client = await this.ensure(host)
    const registry = this.#reverse.get(host.id) ?? new Map()
    this.#reverse.set(host.id, registry)
    const key = `${bindHost}:${bindPort}`
    const existing = registry.get(key)
    if (existing !== undefined && existing.client === client && existing.granted !== undefined) {
      existing.onConnection = onConnection
      existing.error = undefined
      return existing.granted
    }
    const entry = existing ?? { bindHost, bindPort }
    entry.client = client
    entry.onConnection = onConnection
    entry.error = undefined
    entry.granted = undefined
    registry.set(key, entry)
    try {
      const granted = await call(client, 'forwardIn', bindHost, bindPort)
      entry.granted = typeof granted === 'number' && granted > 0 ? granted : bindPort
      return entry.granted
    } catch (error) {
      entry.error = error?.message ?? String(error)
      throw new RemoteError(
        'remote-forward-denied',
        `服务器不允许监听 ${bindHost}:${bindPort}：${entry.error}。sshd 需要允许 AllowTcpForwarding，绑定非回环地址还需要 GatewayPorts`,
        502,
      )
    }
  }

  /** Stop asking the server to listen, and forget the registration. */
  async releaseRemoteForward(host, bindHost, bindPort) {
    const registry = this.#reverse.get(host.id)
    if (registry === undefined) return
    const key = `${bindHost}:${bindPort}`
    const entry = registry.get(key)
    if (entry === undefined) return
    registry.delete(key)
    if (registry.size === 0) this.#reverse.delete(host.id)
    const client = this.#records.get(host.id)?.client
    if (client === undefined || entry.granted === undefined) return
    await call(client, 'unforwardIn', bindHost, entry.granted).catch(() => {})
  }

  /**
   * Live state of one reverse registration, for the panel.
   * @param {string} hostId - owning host.
   * @param {string} bindHost - bound address.
   * @param {number} bindPort - requested port.
   * @returns {{granted?: number, error?: string, held: boolean}|undefined} state, or
   *   `undefined` when unregistered. `held` is false once the client that owned
   *   the granted port is gone: the server-side listener died with it.
   */
  remoteForwardState(hostId, bindHost, bindPort) {
    const entry = this.#reverse.get(hostId)?.get(`${bindHost}:${bindPort}`)
    if (entry === undefined) return undefined
    return {
      granted: entry.granted,
      error: entry.error,
      held: entry.client !== undefined && entry.client === this.#records.get(hostId)?.client && entry.granted !== undefined,
    }
  }

  /**
   * Route one inbound `forwarded-tcpip` channel to its rule.
   *
   * Matching is by destination port alone: the server cannot have two forwards
   * on one port, and when the bind address is a wildcard the reported `destIP`
   * is whichever interface the peer reached — not something the rule named.
   */
  #attachInbound(hostId, client) {
    client.on('tcp connection', (details, accept, reject) => {
      const registry = this.#reverse.get(hostId)
      const entry = registry === undefined
        ? undefined
        : [...registry.values()].find((item) => item.granted === details.destPort && item.client === client)
      if (entry === undefined || entry.onConnection === undefined) {
        reject()
        return
      }
      let stream
      try {
        stream = accept()
      } catch {
        reject()
        return
      }
      entry.onConnection(stream, details)
    })
  }

  /**
   * Re-request every reverse forward for a fresh client.
   *
   * The listening sockets are on the server and were destroyed with the previous
   * connection, so a rule that says "listening" is a lie until this runs. A
   * failure here (port taken by someone else in the meantime) is recorded on the
   * entry rather than thrown: it must not turn a working connection into a
   * failed one, and the panel polls `remoteForwardState` to show it.
   */
  async #rearmReverse(hostId, client) {
    const registry = this.#reverse.get(hostId)
    if (registry === undefined) return
    for (const entry of registry.values()) {
      entry.client = client
      entry.granted = undefined
      entry.error = undefined
      try {
        const granted = await call(client, 'forwardIn', entry.bindHost, entry.bindPort)
        entry.granted = typeof granted === 'number' && granted > 0 ? granted : entry.bindPort
      } catch (error) {
        entry.error = error?.message ?? String(error)
      }
    }
  }
}
