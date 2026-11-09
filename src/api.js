/**
 * JSON API surface for the plugin (`POST /remote/api/<method>`).
 *
 * Every method is conversation-scoped by `sessionId`; the host resolution rule
 * is: an explicit `hostId` wins, otherwise the session's first enabled mapping
 * decides. A `draft` host is accepted by `hosts.connect` / `hosts.info` so the
 * settings form can test a connection before saving it.
 * @module dsh-remote-ssh/api
 */
import { readSshConfig } from './ssh/config.js'
import { AUTH_TYPES, normalizeAuth } from './ssh/auth.js'
import { RemoteError } from './ssh/pool.js'
import { ApiError, requireAbsolutePath, requireString } from './wire.js'
import { nextId } from './util.js'

/** Resolve the session's working directory through the host services. */
export function sessionCwd(ctx, sessionId, fallback) {
  try {
    const session = ctx.sessions?.get?.(sessionId)
    const workdir = ctx.get?.('workingDirectory')
    const resolved = workdir?.get?.(session) ?? session?.header?.cwd
    if (typeof resolved === 'string' && resolved !== '') return resolved
  } catch {
    // Unknown session ids are normal in a fresh window; fall through.
  }
  return typeof fallback === 'string' && fallback !== '' ? fallback : process.cwd()
}

/**
 * Stable id for an unsaved draft connection.
 *
 * The settings pane tests a connection before it has a real id. A random id per
 * request leaves one live ssh2 client (and one status entry) behind per click;
 * borrowing the *selected* host's id is worse — a brand-new host then writes
 * into the connection slot of the host you are already using. A key derived from
 * the target gives retries a single connection and cannot collide with a stored
 * `host-…` id.
 */
function draftKey(draft) {
  const user = typeof draft.user === 'string' ? draft.user : ''
  const host = typeof draft.host === 'string' ? draft.host : ''
  const port = Number(draft.port ?? 22)
  return `draft:${user}@${host}:${Number.isFinite(port) ? port : 22}`
}

/** How many bastions a chain may have. Past this, the design is the problem. */
const MAX_HOPS = 5

/** One persisted jump hop. Throws with the hop number, which is what the UI shows. */
function hopRow(raw, index) {
  const at = `第 ${index + 1} 跳`
  const host = typeof raw?.host === 'string' ? raw.host.trim() : ''
  if (host === '') throw new ApiError('jump-bad-host', `${at}缺少主机地址`, 400)
  const port = Number(raw.port ?? 22)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ApiError('bad-port', `${at}的端口必须是 1-65535`, 400)
  }
  const user = typeof raw.user === 'string' && raw.user.trim() !== '' ? raw.user.trim() : undefined
  const declared = raw.auth === undefined || raw.auth === null ? { type: 'inherit' } : raw.auth
  const auth = declared.type === 'inherit' ? { type: 'inherit' } : normalizeAuth(declared)
  if (auth.type === 'key' && auth.keyPath === undefined) {
    throw new ApiError('missing-key', `${at}的密钥认证需要指定私钥路径`, 400)
  }
  const fingerprint = typeof raw.fingerprint === 'string' && raw.fingerprint !== '' ? raw.fingerprint : undefined
  return { host, port, user, auth, fingerprint }
}

/**
 * The persisted jump chain, or `undefined` when the host is dialled directly.
 *
 * Order is traffic order (`hops[0]` connects first) and is the only thing that
 * distinguishes "a → b" from "b → a". A single `{host, …}` object is accepted as
 * one hop so a row written by 0.6.1 keeps working without a migration pass.
 */
function jumpRow(raw) {
  if (raw === undefined || raw === null) return undefined
  const list = Array.isArray(raw.hops)
    ? raw.hops
    : (typeof raw.host === 'string' ? [raw] : [])
  if (list.length === 0) return undefined
  if (list.length > MAX_HOPS) {
    throw new ApiError('too-many-hops', `跳板最多 ${MAX_HOPS} 跳`, 400)
  }
  return { hops: list.map((hop, index) => hopRow(hop, index)) }
}

/** Browser forms can predate TOFU pinning; omitted pins must survive edits/reordering. */
function inheritJumpPins(jump, previous) {
  if (jump === undefined) return undefined
  const pinned = jumpRow(previous)?.hops ?? []
  return { hops: jump.hops.map((hop) => ({
    ...hop,
    fingerprint: hop.fingerprint ?? pinned.find((old) => old.host === hop.host && old.port === hop.port)?.fingerprint,
  })) }
}

/** Per-hop secrets from one request payload, merged onto the stored chain. */
function jumpWithSecrets(jump, secrets, index) {
  const row = jump.hops[index]
  const passwords = Array.isArray(secrets.jumpPasswords) ? secrets.jumpPasswords : []
  const passphrases = Array.isArray(secrets.jumpPassphrases) ? secrets.jumpPassphrases : []
  // `jumpPassword` is the 0.6.1 name and can only have meant the first hop.
  const password = typeof passwords[index] === 'string' && passwords[index] !== ''
    ? passwords[index]
    : (index === 0 && typeof secrets.jumpPassword === 'string' && secrets.jumpPassword !== ''
      ? secrets.jumpPassword
      : undefined)
  const passphrase = typeof passphrases[index] === 'string' && passphrases[index] !== ''
    ? passphrases[index]
    : (index === 0 && typeof secrets.jumpPassphrase === 'string' && secrets.jumpPassphrase !== ''
      ? secrets.jumpPassphrase
      : undefined)
  if (password === undefined && passphrase === undefined) return row
  return {
    ...row,
    auth: {
      ...(row.auth ?? {}),
      ...(password === undefined ? {} : { password }),
      ...(passphrase === undefined ? {} : { passphrase }),
    },
  }
}

/**
 * Build the dispatch table.
 *
 * `version` is passed in rather than read off `ctx`: a real cordis context is a
 * proxy that throws `cannot get property "x" without inject` for anything not
 * listed in the plugin's `inject`, which a plain-object test context hides.
 */
export function buildApi({ ctx, store, pool, files, transfer, uploads, engine, forward, search, version = '0.0.0' }) {
  /** Stored host row, or a transient one built from a draft. */
  function hostOf(payload, { allowDraft = false } = {}) {
    // Passwords and passphrases arrive per request and never touch the store.
    // The jump hop's secrets ride in the same object under their own names, so
    // one `auth` payload can carry both hops without them ever crossing over.
    const secrets = payload.auth ?? {}
    const plain = { ...secrets }
    delete plain.jumpPassword
    delete plain.jumpPassphrase
    delete plain.jumpPasswords
    delete plain.jumpPassphrases
    const withSecrets = (host) => {
      const auth = { ...(host.auth ?? { type: 'agent' }), ...plain }
      if (host.jump === undefined) return { ...host, auth }
      const jump = jumpRow(host.jump)
      if (jump === undefined) return { ...host, auth }
      return {
        ...host,
        auth,
        jump: { hops: jump.hops.map((_, index) => jumpWithSecrets(jump, secrets, index)) },
      }
    }
    if (allowDraft && payload.draft !== undefined && payload.draft !== null) {
      const draft = payload.draft
      // A draft that carries a real id is an edit of that host: it must keep the
      // host key pinned on first contact, otherwise "测试连接" on an edited host
      // would silently re-pin a *changed* key and the protection would be gone.
      const edited = typeof draft.id === 'string' && draft.id !== '' ? store.host(draft.id) : undefined
      return withSecrets({
        id: typeof draft.id === 'string' && draft.id !== '' ? draft.id : draftKey(draft),
        name: draft.name ?? draft.host ?? 'draft',
        host: draft.host,
        port: Number(draft.port ?? 22),
        user: draft.user,
        alias: draft.alias,
        proxyJump: draft.proxyJump,
        jump: inheritJumpPins(jumpRow(draft.jump), edited?.jump),
        fingerprint: draft.fingerprint ?? edited?.fingerprint,
        auth: draft.auth ?? { type: 'agent' },
      })
    }
    const hostId = requireString(payload, 'hostId')
    const stored = store.host(hostId)
    if (stored === undefined) throw new ApiError('host-missing', '主机不存在，请先保存连接', 404)
    return withSecrets(stored)
  }

  /** Host for a session-scoped operation: explicit id, else the primary mapping. */
  function hostForSession(payload) {
    if (typeof payload.hostId === 'string' && payload.hostId !== '') return hostOf(payload)
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
    const mapping = sessionId === '' ? undefined : engine.primaryMapping(sessionId)
    if (mapping === undefined) throw new ApiError('no-mapping', '当前会话还没有远程映射，请先新建一个', 400)
    const stored = store.host(mapping.hostId)
    if (stored === undefined) throw new ApiError('host-missing', '映射指向的主机已被删除', 404)
    return stored
  }

  function sessionIdOf(payload) {
    return typeof payload.sessionId === 'string' && payload.sessionId !== ''
      ? payload.sessionId
      : 'default'
  }

  const api = {
    /* ── hosts ─────────────────────────────────────────────────────── */

    'hosts.list': async () => ({
      hosts: store.hosts(),
      statuses: pool.statuses(),
    }),

    'hosts.sshConfig': async () => ({ hosts: readSshConfig() }),

    'hosts.save': async (payload) => {
      const host = payload.host ?? payload
      const address = requireString(host, 'host')
      const user = requireString(host, 'user')
      const previous = typeof host.id === 'string' ? store.host(host.id) : undefined
      const row = {
        id: typeof host.id === 'string' && host.id !== '' ? host.id : nextId('host'),
        name: typeof host.name === 'string' && host.name !== '' ? host.name : address,
        host: address,
        port: Number(host.port ?? 22),
        user,
        alias: typeof host.alias === 'string' ? host.alias : undefined,
        proxyJump: typeof host.proxyJump === 'string' && host.proxyJump !== '' ? host.proxyJump : undefined,
        jump: jumpRow(host.jump),
        fingerprint: typeof host.fingerprint === 'string' ? host.fingerprint : previous?.fingerprint,
        auth: {
          type: AUTH_TYPES.includes(host.auth?.type) ? host.auth.type : 'agent',
          keyPath: typeof host.auth?.keyPath === 'string' ? host.auth.keyPath : undefined,
        },
        lastUsedAt: Date.now(),
      }
      if (host.auth?.type === 'key' && row.auth.keyPath === undefined) {
        throw new ApiError('missing-key', '密钥认证需要指定私钥路径', 400)
      }
      if (!Number.isInteger(row.port) || row.port <= 0 || row.port > 65535) {
        throw new ApiError('bad-port', '端口必须是 1-65535', 400)
      }
      row.jump = inheritJumpPins(row.jump, previous?.jump)
      await store.upsertHost(row)
      files.forget?.(row.id)
      search?.forget?.(row.id)
      const existing = store.host(row.id)
      if (existing !== undefined) {
        // The row changed, so the tunnel may point at a different server: close
        // the listeners before the connection they ride on is dropped.
        await forward.stopHost(row.id)
        pool.close(existing.id)
      }
      // A "测试连接" made before saving holds a connection under the draft key;
      // the saved row gets its own, so drop the probe instead of leaving both up.
      pool.close(draftKey(row))
      return { host: store.host(row.id), hosts: store.hosts() }
    },

    'hosts.delete': async (payload) => {
      const hostId = requireString(payload, 'hostId')
      await forward.stopHost(hostId)
      pool.close(hostId)
      await store.deleteHost(hostId)
      return { hosts: store.hosts() }
    },

    'hosts.connect': async (payload) => {
      const host = hostOf(payload, { allowDraft: true })
      // `interactive` is what separates "a person clicked 连接" from "a listener
      // needs its socket back": only the first may stop and ask for a code. The
      // second must fail with `needs-credential` rather than hang on a prompt
      // nobody is looking at.
      await pool.ensure(host, { interactive: true })
      const info = await files.info(host)
      if (payload.persistLastUsed === true) {
        await store.upsertHost({ id: host.id, lastUsedAt: Date.now() })
      }
      // Listeners cannot survive a plugin restart, so autoStart rules follow the
      // connection that just came up. A failing rule is reported per rule, never
      // as a failed connect.
      const forwards = await forward.startAll(host.id)
      return { hostId: host.id, status: 'connected', info, forwards }
    },

    /* ── interactive authentication ────────────────────────────────── */

    /**
     * The prompt the handshake is waiting on, if any.
     *
     * `hosts.connect` stays open while the server wants a code, so the panel
     * polls this instead of the request returning an error and needing a second
     * handshake: one dial, one `MaxAuthTries` budget.
     */
    'auth.challenge': async (payload) => ({
      challenge: pool.challenge(typeof payload.hostId === 'string' ? payload.hostId : undefined) ?? null,
    }),

    'auth.answer': async (payload) => {
      const id = requireString(payload, 'id')
      const answers = Array.isArray(payload.answers) ? payload.answers : []
      return pool.answerAuth(id, answers)
    },

    'hosts.disconnect': async (payload) => {
      const hostId = requireString(payload, 'hostId')
      await forward.stopHost(hostId)
      pool.close(hostId)
      files.forget(hostId)
      search.forget(hostId)
      return { hostId, status: 'disconnected' }
    },

    'hosts.status': async () => ({ statuses: pool.statuses() }),

    'hosts.info': async (payload) => {
      const host = hostOf(payload, { allowDraft: true })
      const info = await files.info(host)
      return { hostId: host.id, info }
    },

    /* ── remote files ──────────────────────────────────────────────── */

    'fs.list': async (payload) => {
      const host = hostForSession(payload)
      const requested = typeof payload.path === 'string' ? payload.path.trim() : ''
      const path = requested === '' ? await files.home(host) : requested
      const [entries, info] = await Promise.all([files.list(host, path), files.info(host).catch(() => undefined)])
      return { path, entries, home: info?.home ?? '/', tmux: info?.tmux ?? false }
    },

    'fs.read': async (payload) => {
      const host = hostForSession(payload)
      const path = requireString(payload, 'path')
      return files.readText(host, path)
    },

    /**
     * Search file contents on the remote host.
     *
     * Deliberately *not* a local grep over downloaded files: a repository that
     * matters is always bigger than the mapping, and `rg` on the far side is
     * both faster and truthful about files the client has never seen.
     */
    'fs.search': async (payload) => {
      const host = hostForSession(payload)
      const requested = typeof payload.path === 'string' ? payload.path.trim() : ''
      const root = requested === '' ? await files.home(host) : requested
      const caseMode = ['smart', 'sensitive', 'insensitive'].includes(payload.case) ? payload.case : 'smart'
      return search.search(host, {
        root,
        query: requireString(payload, 'query'),
        case: caseMode,
        regex: payload.regex === true,
        glob: typeof payload.glob === 'string' ? payload.glob.trim() : '',
        limit: typeof payload.limit === 'number' ? payload.limit : 200,
        timeoutMs: typeof payload.timeoutMs === 'number' ? payload.timeoutMs : 30000,
      })
    },

    'fs.write': async (payload) => {
      const host = hostForSession(payload)
      const path = requireString(payload, 'path')
      const text = typeof payload.text === 'string' ? payload.text : ''
      const result = await files.writeText(host, path, text, {
        expectedMtimeMs: typeof payload.expectedMtimeMs === 'number' ? payload.expectedMtimeMs : undefined,
        mode: typeof payload.mode === 'number' ? payload.mode : undefined,
      })
      return { ...result, path }
    },

    'fs.putBase64': async (payload) => {
      const host = hostForSession(payload)
      const path = requireString(payload, 'path')
      const data = requireString(payload, 'data')
      const buffer = Buffer.from(data, 'base64')
      if (buffer.length > 32 * 1024 * 1024) throw new ApiError('too-large', '单次上传上限 32 MB', 413)
      return files.writeBytes(host, path, buffer, {
        mode: typeof payload.mode === 'number' ? payload.mode : undefined,
      })
    },

    'fs.upload.begin': async (payload) => uploads.begin(
      hostForSession(payload), payload.sessionId ?? 'default', requireString(payload, 'path'), payload.size,
    ),

    'fs.upload.chunk': async (payload) => uploads.chunk(
      hostForSession(payload).id, payload.sessionId ?? 'default', requireString(payload, 'uploadId'), payload.offset, payload.data,
    ),

    'fs.upload.finish': async (payload) => uploads.finish(
      hostForSession(payload).id, payload.sessionId ?? 'default', requireString(payload, 'uploadId'),
    ),

    'fs.upload.abort': async (payload) => uploads.abort(
      hostForSession(payload).id, payload.sessionId ?? 'default', requireString(payload, 'uploadId'),
    ),

    'fs.mkdir': async (payload) => {
      const host = hostForSession(payload)
      const path = requireString(payload, 'path')
      await files.mkdir(host, path)
      return { path }
    },

    'fs.remove': async (payload) => {
      const host = hostForSession(payload)
      const path = requireString(payload, 'path')
      return files.remove(host, path, { recursive: payload.recursive === true })
    },

    'fs.rename': async (payload) => {
      const host = hostForSession(payload)
      return files.rename(host, requireString(payload, 'from'), requireString(payload, 'to'))
    },

    /* ── transfers ─────────────────────────────────────────────────── */

    'transfer.upload': async (payload) => {
      const host = hostForSession(payload)
      const localPath = requireAbsolutePath(payload.localPath, 'localPath')
      const remotePath = requireString(payload, 'remotePath')
      return transfer.uploadFile(host, localPath, remotePath)
    },

    'transfer.download': async (payload) => {
      const host = hostForSession(payload)
      const remotePath = requireString(payload, 'remotePath')
      const localPath = requireAbsolutePath(payload.localPath, 'localPath')
      return transfer.downloadFile(host, remotePath, localPath)
    },

    'transfer.downloadTree': async (payload) => {
      const host = hostForSession(payload)
      const remotePath = requireString(payload, 'remotePath')
      const localPath = requireAbsolutePath(payload.localPath, 'localPath')
      return transfer.downloadTree(host, remotePath, localPath)
    },

    'transfer.cleanParts': async (payload) => {
      const host = hostForSession(payload)
      const root = requireString(payload, 'remoteRoot')
      if (!root.startsWith('/')) throw new ApiError('bad-path', '远端路径必须是绝对路径', 400)
      return transfer.cleanParts(host, root)
    },

    /* ── mapping + sync ────────────────────────────────────────────── */

    'sync.list': async (payload) => {
      const sessionId = sessionIdOf(payload)
      return engine.list(sessionId)
    },

    'sync.save': async (payload) => {
      const sessionId = sessionIdOf(payload)
      const cwd = sessionCwd(ctx, sessionId, payload.cwd)
      return engine.save(sessionId, payload.mapping ?? {}, cwd)
    },

    'sync.remove': async (payload) => {
      const sessionId = sessionIdOf(payload)
      return engine.remove(sessionId, requireString(payload, 'mappingId'))
    },

    'sync.start': async (payload) => {
      const sessionId = sessionIdOf(payload)
      return engine.start(sessionId)
    },

    'sync.flush': async (payload) => {
      const sessionId = sessionIdOf(payload)
      return engine.flush(sessionId)
    },

    'sync.pushAll': async (payload) => {
      const sessionId = sessionIdOf(payload)
      const mappingId = requireString(payload, 'mappingId')
      const result = await engine.pushAll(sessionId, mappingId)
      return {
        files: result.files,
        bytes: result.bytes,
        failed: result.failed,
        state: engine.list(sessionId),
      }
    },

    'sync.pull': async (payload) => {
      const sessionId = sessionIdOf(payload)
      return engine.pull(sessionId, requireString(payload, 'mappingId'), requireString(payload, 'rel'))
    },

    'sync.resolve': async (payload) => {
      const sessionId = sessionIdOf(payload)
      const key = requireString(payload, 'key')
      const choice = ['local', 'remote', 'skip'].includes(payload.choice) ? payload.choice : 'skip'
      return engine.resolve(sessionId, key, choice)
    },

    /* ── port forwarding ─────────────────────────────────────────────── */

    'forward.list': async (payload) => {
      const hostId = typeof payload.hostId === 'string' && payload.hostId !== '' ? payload.hostId : undefined
      return { hosts: forward.list(hostId) }
    },

    'forward.save': async (payload) => {
      const hostId = requireString(payload, 'hostId')
      return forward.save(hostId, payload.rule ?? {})
    },

    'forward.remove': async (payload) => forward.remove(
      requireString(payload, 'hostId'),
      requireString(payload, 'ruleId'),
    ),

    'forward.start': async (payload) => forward.start(
      requireString(payload, 'hostId'),
      requireString(payload, 'ruleId'),
    ),

    'forward.stop': async (payload) => forward.stop(
      requireString(payload, 'hostId'),
      requireString(payload, 'ruleId'),
    ),

    'forward.startAll': async (payload) => forward.startAll(requireString(payload, 'hostId')),

    'forward.stopAll': async (payload) => forward.stopAll(requireString(payload, 'hostId')),

    /* ── misc ──────────────────────────────────────────────────────── */

    'session.cwd': async (payload) => ({ cwd: sessionCwd(ctx, sessionIdOf(payload), payload.cwd) }),

    'system.ping': async () => ({ pong: Date.now(), version }),
  }

  return api
}

/** Normalize a thrown value into something `writeError` can serialize. */
export function toWireError(error) {
  if (error instanceof RemoteError || error instanceof ApiError) return error
  if (error instanceof Error) return new ApiError('internal', error.message, 500)
  return new ApiError('internal', String(error), 500)
}
