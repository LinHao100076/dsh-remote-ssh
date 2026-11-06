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
import ssh2 from 'ssh2'
import { findSshHost, parseJumpChain } from './config.js'
import { hopAuth, normalizeAuth, planPrompts, secretOf, withSecrets } from './auth.js'
import { RemoteError, classify } from './errors.js'
import { call, nextId, shq } from '../util.js'

// `ssh2` is CommonJS; the default import is the only portable form under ESM.
const { Client } = ssh2

// Re-exported here because every other module imports its errors from the pool
// (`api.js`, `forward/manager.js`, `remote/files.js`); moving the class into its
// own module must not move those import paths.
export { RemoteError }

/**
 * Failures that mean "this hop would not let me in", as opposed to "this hop
 * is unreachable". The first group is retagged as `jump-auth-failed` so the
 * panel can offer "改用密码" and name the hop; the second keeps its own code
 * (`timeout`, `refused`, `dns-failed`) and only gains the hop number.
 */
const AUTH_FAILURES = ['auth-failed', 'bad-password', 'no-agent', 'key-unreadable', 'key-invalid']

/** SHA256 fingerprint in the shape OpenSSH prints (`SHA256:base64`). */
function fingerprintOf(key) {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
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
   * @type {Map<string, {password?: string, passphrase?: string,
   *   hopPasswords?: string[], hopPassphrases?: string[]}>}
   */
  #secrets = new Map()
  /**
   * Hops whose single hidden prompt was filled with the password and rejected.
   *
   * `planPrompts` may guess when a server asks exactly one hidden question
   * without naming it (`Contraseña:`, `パスワード:`) — the alternative is asking
   * for a password we already hold. One guess per hop is enough: ssh2 will not
   * resubmit the same method inside one handshake, so repeating the guess on the
   * next attempt would only burn another `MaxAuthTries` on the same wrong answer.
   * @type {Set<string>}
   */
  #guessed = new Set()
  /**
   * The one interactive prompt currently waiting for a person, if any.
   *
   * At most one: ssh2 answers within a single handshake, and two open dialogs
   * could not be told apart by the panel. `challenge()` / `answerAuth()` are the
   * only public doors to it.
   * @type {{id: string, hostId: string, resolve: Function, reject: Function, timer: object}|undefined}
   */
  #challenge
  /**
   * @param {object} options - pool options.
   * @param {(event: object) => void} [options.onEvent] - status change sink (UI/push).
   * @param {(hostId: string, fingerprint: string) => void} [options.onFingerprint] - persist a TOFU fingerprint.
   * @param {(hostId: string, fingerprint: string, hop: number, hops: object[]) => void} [options.onJumpFingerprint] -
   *   same, for one jump hop: `hop` is its index, `hops` the whole chain to write
   *   back (a chain read from ssh-config has no row of its own to pin to).
   * @param {number} [options.authTimeoutMs] - how long a prompt waits for input.
   */
  constructor({ onEvent, onFingerprint, onJumpFingerprint, authTimeoutMs } = {}) {
    this.onEvent = onEvent ?? (() => {})
    this.onFingerprint = onFingerprint ?? (() => {})
    this.onJumpFingerprint = onJumpFingerprint ?? (() => {})
    this.authTimeoutMs = Number.isFinite(authTimeoutMs) ? authTimeoutMs : 120000
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
   * Resolve one host row (or jump hop) into ssh2 connection options, following
   * one level of ssh-config defaults for anything the row left blank.
   *
   * The credential half lives in `auth.js`, because the jump hop needs exactly
   * the same rules against a *different* auth object — and because "the target's
   * password must never be tried on the bastion" is a decision worth having in
   * one place instead of implied by a `??` in the middle of this method.
   *
   * @param {object} host - stored row (or a jump pseudo-row with `fingerprint`).
   * @param {object} auth - `{type, keyPath, password?, passphrase?}`.
   * @param {{label?: string, requirePassword?: boolean}} [hop] - error wording and
   *   whether a missing password is a configuration error.
   */
  #options(host, auth, { label = '目标机', requirePassword = true } = {}) {
    const config = host.alias === undefined ? undefined : findSshHost(host.alias)
    const address = host.host ?? config?.host ?? host.alias
    if (typeof address !== 'string' || address === '') {
      throw new RemoteError('bad-host', `${label}：缺少主机地址`, 400)
    }
    const options = {
      host: address,
      port: Number(host.port ?? config?.port ?? 22),
      username: host.user ?? config?.user ?? process.env.USER ?? process.env.USERNAME,
      readyTimeout: 20000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 3,
      hostVerifier: (key) => this.#verifyHost(host, key),
      ...hopAuth(auth, { config, label, requirePassword }),
    }
    if (typeof options.username !== 'string' || options.username === '') {
      throw new RemoteError('bad-user', `${label}：缺少登录用户名`, 400)
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
    return host.fingerprint === fingerprint
  }

  /**
   * The ordered hops of a jump chain; an empty array means "dial the target".
   *
   * Three shapes collapse into one here:
   *
   * - `jump.hops[]` — how a chain is stored;
   * - `jump.{host,port,user,auth}` — the single-hop shape 0.6.1 wrote, still
   *   readable so an upgrade does not disconnect anybody;
   * - `proxyJump` (or `~/.ssh/config`'s `ProxyJump a,b`) — a string, expanded by
   *   `parseJumpChain` so each hop's own `Host` stanza supplies its port/user.
   *
   * A hop with no `auth` (or `auth.type === 'inherit'`) inherits the target's
   * **method and key path, never the password**: handing a bastion the target's
   * password is how `MaxAuthTries` gets burned on the wrong machine. `declared`
   * records which of the two happened, so a chain that came from
   * `~/.ssh/config` can be written back with the inheritance explicit instead
   * of materialising the target's key path onto a bastion.
   *
   * @returns {Array<{host: string, port: number, user?: string, auth: object,
   *   fingerprint?: string, declared: boolean}>}
   */
  #chainOf(host) {
    const stored = host.jump
    const rows = Array.isArray(stored?.hops)
      ? stored.hops
      : (typeof stored?.host === 'string' && stored.host !== '' ? [stored] : [])
    if (rows.length > 0) {
      // A legacy `jumpAuth` was one credential for the one hop that existed then.
      const legacy = rows.length === 1 ? secretOf(host.jumpAuth) : {}
      return rows.map((row) => this.#hopOf(host, row, legacy))
    }
    const spec = host.proxyJump ?? findSshHost(host.alias)?.proxyJump
    if (typeof spec !== 'string' || spec === '') return []
    return parseJumpChain(spec).map((row) => this.#hopOf(host, row, {}))
  }

  /** One hop, with ssh-config defaults and the inherit rule applied. */
  #hopOf(host, row, legacySecret) {
    const address = typeof row?.host === 'string' ? row.host.trim() : ''
    if (address === '') throw new RemoteError('jump-bad-host', '跳板缺少主机地址', 400)
    const config = findSshHost(address)
    const declared = row.auth !== undefined && row.auth !== null && row.auth.type !== 'inherit'
    const auth = declared
      ? withSecrets(row.auth)
      : { type: host.auth?.type ?? 'agent', keyPath: host.auth?.keyPath, ...legacySecret }
    return {
      host: config?.host ?? address,
      port: Number(row.port ?? config?.port ?? 22),
      user: row.user ?? config?.user ?? host.user,
      auth,
      fingerprint: row.fingerprint,
      declared,
    }
  }

  /** Wrap a hop-less failure so the message says which hop it happened on. */
  #hopError(failure, number, hop) {
    return new RemoteError(
      failure.code,
      `第 ${number} 跳 ${hop.host}:${hop.port}：${failure.message}`,
      failure.status,
      { ...failure.details, hop: number, host: hop.host, port: hop.port },
    )
  }

  /**
   * TOFU per hop: pinned on `hops[i].fingerprint`, not on a shared field.
   *
   * First contact writes the **whole chain** back, not just this hop. That is
   * what lets a chain read from `~/.ssh/config` converge into editable hops —
   * a string can never carry a fingerprint, so without this the bastion of a
   * `ProxyJump` host would be re-trusted on every connect.
   */
  #verifyHop(host, index, hop, hops, key) {
    const fingerprint = fingerprintOf(key)
    if (hop.fingerprint !== undefined && hop.fingerprint !== '') return hop.fingerprint === fingerprint
    this.onJumpFingerprint(host.id, fingerprint, index, hops.map((item, at) => ({
      host: item.host,
      port: item.port,
      user: item.user,
      auth: item.declared ? normalizeAuth(item.auth) : { type: 'inherit' },
      fingerprint: at === index ? fingerprint : item.fingerprint,
    })))
    return true
  }

  /**
   * Dial the chain and hand back a stream that reaches the target.
   *
   * Every hop is a `direct-tcpip` channel through the *previous* hop, and the
   * last one opens the channel to the target:
   *
   *   hop0 ──forwardOut(hop1)──▶ hop1 ──forwardOut(target)──▶ target
   *
   * The destination must be the **next hop**, not the target: pointing the
   * first hop at `options.host` makes it dial the machine it cannot reach —
   * the entire reason the chain exists — and the connect then times out on the
   * one link that was working.
   *
   * @returns {Promise<{stream: object, count: number, dispose: () => void}|undefined>}
   */
  async #openWithJump(host, options, interactive) {
    const hops = this.#chainOf(host)
    if (hops.length === 0) return undefined
    const clients = []
    // Inside out: the last hop carries the target channel, so closing it first
    // is what releases the stream the outer hops are still piping.
    const dispose = () => {
      for (const client of [...clients].reverse()) client.end()
    }
    let stream
    try {
      for (const [index, hop] of hops.entries()) {
        const label = hops.length === 1 ? '跳板' : `第 ${index + 1} 跳`
        const config = findSshHost(hop.host)
        const hopOptions = {
          host: hop.host,
          port: hop.port,
          username: hop.user ?? process.env.USER ?? process.env.USERNAME,
          readyTimeout: 20000,
          keepaliveInterval: 15000,
          keepaliveCountMax: 3,
          hostVerifier: (key) => this.#verifyHop(host, index, hop, hops, key),
          ...hopAuth(hop.auth, { config, label, requirePassword: false }),
        }
        if (typeof hopOptions.username !== 'string' || hopOptions.username === '') {
          throw new RemoteError('bad-user', `${label}：缺少登录用户名`, 400)
        }
        if (stream !== undefined) hopOptions.sock = stream
        const client = new Client()
        clients.push(client)
        this.#attachAuth(host, client, {
          hop: index + 1,
          label,
          host: hopOptions.host,
          port: hopOptions.port,
          user: hopOptions.username,
          password: hop.auth?.password,
          interactive,
        })
        const number = index + 1
        const where = `${hopOptions.username}@${hop.host}:${hop.port}`
        await new Promise((resolve, reject) => {
          client.once('ready', resolve)
          client.once('error', (error) => reject(client.__authError ?? classify(error)))
          client.connect(hopOptions)
        }).catch((error) => {
          this.#noteGuess(client, error)
          const failure = classify(error)
          // A bare "Permission denied" from a hop that is not the one on screen
          // is the least useful message in this plugin: name the hop, and keep a
          // `cause` so the UI can still offer "改用密码".
          if (AUTH_FAILURES.includes(failure.code)) {
            throw new RemoteError(
              'jump-auth-failed',
              `${label} ${where} 认证失败：${failure.message}`,
              401,
              { hop: number, host: hop.host, port: hop.port, user: hop.user, cause: failure.code },
            )
          }
          throw this.#hopError(failure, number, hop)
        })
        // Post-handshake drops are the pool's business, not the caller's.
        client.on('error', () => {})
        const nextHop = hops[index + 1]
        const next = nextHop ?? { host: options.host, port: options.port }
        const target = nextHop === undefined ? '目标机' : `第 ${number + 1} 跳`
        stream = await call(client, 'forwardOut', '127.0.0.1', 0, next.host, next.port).catch((error) => {
          throw new RemoteError(
            'jump-forward-failed',
            `${label} ${where} 无法开通到 ${next.host}:${next.port}（${target}）的通道：${error.message}`,
            502,
            { hop: number, host: hop.host, port: hop.port, to: { host: next.host, port: next.port } },
          )
        })
      }
    } catch (error) {
      dispose()
      throw error
    }
    return { stream, count: hops.length, dispose }
  }

  /**
   * Ensure a live client for one host, connecting when needed.
   * @param {object} host - stored host row (`{id, host, port, user, auth, alias, fingerprint}`).
   * @param {{interactive?: boolean}} [options] - `interactive` allows a prompt to
   *   be put on screen when the server asks for something we do not hold (a TOTP
   *   code, or a bastion password). Only the connect gate sets it: a background
   *   heal has nobody to ask, and must fail with `needs-credential` instead of
   *   sitting on a dialog nobody sees.
   * @returns {Promise<Client>} a ready client.
   */
  async ensure(host, { interactive = false } = {}) {
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
    const resolved = this.#withSecret(host)
    const options = this.#options(resolved, resolved.auth)
    const pending = this.#connect(host, resolved, options, { interactive })
    this.#records.set(host.id, { hostId: host.id, status: 'connecting', client: undefined, pending })
    this.#setStatus(host.id, 'connecting')
    return pending
  }

  /**
   * Host row with the in-memory secret merged in: a re-connect after a network
   * drop arrives without the password (the row never stores one), so the
   * remembered credential fills the gap. Nothing here touches the state file.
   *
   * Jump secrets are indexed by hop (`hopPasswords[0]` is the first bastion), so
   * one map can hold a whole chain without the target's password ever landing on
   * a bastion. `jumpPassword` / `jumpPassphrase` are the single-hop names 0.6.1
   * wrote and are read as hop 0.
   */
  #withSecret(host) {
    const remembered = this.#secrets.get(host.id)
    if (remembered === undefined) return host
    const auth = { ...(host.auth ?? { type: 'agent' }) }
    if (remembered.password !== undefined) auth.password = remembered.password
    if (remembered.passphrase !== undefined) auth.passphrase = remembered.passphrase
    if (host.jump === undefined) return { ...host, auth }
    const rows = Array.isArray(host.jump.hops) ? host.jump.hops : [host.jump]
    const passwords = remembered.hopPasswords ?? []
    const passphrases = remembered.hopPassphrases ?? []
    const hops = rows.map((row, index) => {
      const password = passwords[index] ?? (index === 0 ? remembered.jumpPassword : undefined)
      const passphrase = passphrases[index] ?? (index === 0 ? remembered.jumpPassphrase : undefined)
      if (password === undefined && passphrase === undefined) return row
      return {
        ...row,
        auth: {
          ...(row.auth ?? {}),
          ...(password === undefined ? {} : { password }),
          ...(passphrase === undefined ? {} : { passphrase }),
        },
      }
    })
    return { ...host, auth, jump: { hops } }
  }

  /**
   * Wire the server's interactive questions onto the panel.
   *
   * ssh2 asks for these *inside* `connect()`, so the only way to answer is to
   * leave the handshake open and reply when a person has typed. Everything the
   * password can cover is answered here without a dialog; only the leftovers
   * (an OTP code, a bastion password we never stored) become a challenge.
   */
  #attachAuth(host, client, hop) {
    client.on('keyboard-interactive', (name, instructions, _lang, prompts, finish) => {
      const reply = (answers) => {
        try {
          finish(answers)
        } catch {
          // The channel died while we were asking (timeout, cancel, network).
          // ssh2 throws from `finish` in that case and there is nothing to do.
        }
      }
      // First ask for a hop may fill the password into an unnamed hidden prompt;
      // once that guess has been rejected, the next attempt asks instead of
      // repeating it (ssh2 never retries a method inside one handshake, so the
      // retry is necessarily a new connection).
      const guessKey = `${host.id}#${hop.hop}`
      const mayGuess = !this.#guessed.has(guessKey)
      const { answers, ask } = planPrompts(prompts, mayGuess ? hop.password : undefined)
      if (ask.length === 0) {
        if (mayGuess && answers.some((answer) => answer !== '')) client.__guessed = guessKey
        reply(answers)
        return
      }
      void this.#askAuth(host, hop, { name, instructions, prompts: ask })
        .then((typed) => {
          ask.forEach((slot, index) => { answers[slot.index] = typed[index] ?? '' })
          reply(answers)
        })
        .catch((error) => {
          // Let the handshake fail on its own terms, then report the real reason
          // instead of the generic "all methods failed" ssh2 produces.
          client.__authError = error
          reply(answers)
        })
    })
  }

  /**
   * Remember that this hop's one allowed guess was wrong, so the next attempt
   * asks a person instead of trying the same password again.
   */
  #noteGuess(client, error) {
    if (client.__guessed === undefined) return
    const failure = error instanceof RemoteError ? error : classify(error)
    if (failure.code === 'auth-failed' || failure.code === 'jump-auth-failed') {
      this.#guessed.add(client.__guessed)
    }
  }

  /**
   * Put a prompt on screen and wait for it.
   * @returns {Promise<string[]>} one answer per prompt, in order.
   */
  #askAuth(host, hop, { name, instructions, prompts }) {
    if (hop.interactive !== true) {
      const asked = prompts.map((item) => item.prompt.trim()).filter(Boolean).join(' / ') || '密码'
      return Promise.reject(new RemoteError(
        'needs-credential',
        `${hop.label}需要交互式认证（${asked}），但这次连接是后台发起的，没有可以输入的界面；请回到面板手动连接一次`,
        401,
        { hop: hop.hop, host: hop.host, port: hop.port, user: hop.user, prompts },
      ))
    }
    if (this.#challenge !== undefined) {
      return Promise.reject(new RemoteError('auth-busy', '还有一个待输入的认证请求，请先完成它', 409))
    }
    const id = nextId('auth')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#challenge?.id !== id) return
        this.#challenge = undefined
        reject(new RemoteError('auth-timeout', '认证输入超时（120 秒），已放弃这次连接', 504, { hop: hop.hop }))
      }, this.authTimeoutMs)
      timer.unref?.()
      this.#challenge = {
        id,
        hostId: host.id,
        hop: hop.hop,
        hopLabel: hop.label,
        host: hop.host,
        port: hop.port,
        user: hop.user,
        name,
        instructions,
        prompts,
        resolve,
        reject,
        timer,
        expiresAt: Date.now() + this.authTimeoutMs,
      }
    })
  }

  /**
   * The prompt waiting for input, or `undefined`.
   *
   * Returned without any secret: the panel renders these boxes itself, and the
   * password it already typed is still in its own state.
   * @param {string} [hostId] - only report a prompt belonging to this host.
   */
  challenge(hostId) {
    const pending = this.#challenge
    if (pending === undefined) return undefined
    if (typeof hostId === 'string' && hostId !== '' && pending.hostId !== hostId) return undefined
    return {
      id: pending.id,
      hostId: pending.hostId,
      hop: pending.hop,
      hopLabel: pending.hopLabel,
      host: pending.host,
      port: pending.port,
      user: pending.user,
      name: pending.name,
      instructions: pending.instructions,
      prompts: pending.prompts.map(({ prompt, echo }) => ({ prompt, echo })),
      expiresAt: pending.expiresAt,
    }
  }

  /**
   * Answer the pending prompt, which lets the waiting handshake continue.
   * @param {string} id - the challenge id the panel was shown.
   * @param {string[]} answers - one per prompt, in the shown order.
   */
  answerAuth(id, answers) {
    const pending = this.#challenge
    if (pending === undefined || pending.id !== id) {
      throw new RemoteError('challenge-stale', '这条认证请求已经失效，请重新连接', 409)
    }
    clearTimeout(pending.timer)
    this.#challenge = undefined
    const list = Array.isArray(answers) ? answers.map((value) => String(value ?? '')) : []
    pending.resolve(list)
    return { ok: true }
  }

  /** Drop the pending prompt (disconnect, teardown, or a failed attempt). */
  #cancelChallenge(hostId) {
    const pending = this.#challenge
    if (pending === undefined) return
    if (hostId !== undefined && pending.hostId !== hostId) return
    clearTimeout(pending.timer)
    this.#challenge = undefined
    pending.reject(new RemoteError('auth-cancelled', '连接已取消', 499))
  }

  async #connect(host, resolved, options, { interactive }) {
    const client = new Client()
    const record = () => this.#records.get(host.id)
    try {
      const jump = await this.#openWithJump(resolved, options, interactive)
      if (jump !== undefined) {
        options.sock = jump.stream
        client.__jump = jump
      }
      this.#attachAuth(host, client, {
        hop: (jump?.count ?? 0) + 1,
        label: '目标机',
        host: options.host,
        port: options.port,
        user: options.username,
        password: resolved.auth?.password,
        interactive,
      })
      await new Promise((resolve, reject) => {
        client.once('ready', resolve)
        client.once('error', (error) => reject(client.__authError ?? classify(error)))
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
      if (client.__guessed !== undefined) this.#guessed.delete(client.__guessed)
      this.#remember(host.id, resolved)
      // Reverse forwards must be re-requested on every fresh connection — the
      // server dropped those ports when the previous one closed. Awaited so the
      // caller never observes a "connected" host whose `-R` rules are not
      // actually reachable yet; failures are recorded per entry, not thrown.
      await this.#rearmReverse(host.id, client)
      return client
    } catch (error) {
      client.__jump?.dispose?.()
      this.#noteGuess(client, error)
      this.#cancelChallenge(host.id)
      this.#records.set(host.id, { hostId: host.id, status: 'error', error: error.message })
      this.onEvent({ hostId: host.id, status: 'error', error: error.message })
      throw error instanceof RemoteError ? error : classify(error)
    }
  }

  /**
   * Keep the credentials of a successful connection in memory (never on disk).
   *
   * Only the *declared* credentials are remembered: a password typed into a
   * prompt is not, because a keyboard-interactive reply has no label saying
   * which prompt was the password and which was the OTP. Storing the OTP would
   * be worse than useless 30 seconds later.
   */
  #remember(hostId, resolved) {
    const secret = secretOf(resolved.auth)
    const hopPasswords = []
    const hopPassphrases = []
    let hopped = false
    for (const hop of this.#chainOf(resolved)) {
      const hopSecret = secretOf(hop.auth)
      hopPasswords.push(hopSecret.password)
      hopPassphrases.push(hopSecret.passphrase)
      if (hopSecret.password !== undefined || hopSecret.passphrase !== undefined) hopped = true
    }
    if (hopped) {
      secret.hopPasswords = hopPasswords
      secret.hopPassphrases = hopPassphrases
    }
    if (Object.keys(secret).length === 0) this.#secrets.delete(hostId)
    else this.#secrets.set(hostId, secret)
  }

  /** Drop a client and forget its credentials (an explicit disconnect). */
  close(hostId) {
    const record = this.#records.get(hostId)
    this.#cancelChallenge(hostId)
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
    this.#cancelChallenge()
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
