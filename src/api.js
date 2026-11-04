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
 * Build the dispatch table.
 *
 * `version` is passed in rather than read off `ctx`: a real cordis context is a
 * proxy that throws `cannot get property "x" without inject` for anything not
 * listed in the plugin's `inject`, which a plain-object test context hides.
 */
export function buildApi({ ctx, store, pool, files, transfer, engine, forward, version = '0.0.0' }) {
  /** Stored host row, or a transient one built from a draft. */
  function hostOf(payload, { allowDraft = false } = {}) {
    if (allowDraft && payload.draft !== undefined && payload.draft !== null) {
      const draft = payload.draft
      const row = {
        id: typeof draft.id === 'string' && draft.id !== '' ? draft.id : nextId('draft'),
        name: draft.name ?? draft.host ?? 'draft',
        host: draft.host,
        port: Number(draft.port ?? 22),
        user: draft.user,
        alias: draft.alias,
        proxyJump: draft.proxyJump,
        fingerprint: draft.fingerprint,
        auth: { ...(draft.auth ?? { type: 'agent' }), ...(payload.auth ?? {}) },
      }
      return row
    }
    const hostId = requireString(payload, 'hostId')
    const stored = store.host(hostId)
    if (stored === undefined) throw new ApiError('host-missing', '主机不存在，请先保存连接', 404)
    // Passwords and passphrases arrive per request and never touch the store.
    return payload.auth === undefined ? stored : { ...stored, auth: { ...stored.auth, ...payload.auth } }
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
      const row = {
        id: typeof host.id === 'string' && host.id !== '' ? host.id : nextId('host'),
        name: typeof host.name === 'string' && host.name !== '' ? host.name : address,
        host: address,
        port: Number(host.port ?? 22),
        user,
        alias: typeof host.alias === 'string' ? host.alias : undefined,
        proxyJump: typeof host.proxyJump === 'string' && host.proxyJump !== '' ? host.proxyJump : undefined,
        fingerprint: typeof host.fingerprint === 'string' ? host.fingerprint : undefined,
        auth: {
          type: ['agent', 'key', 'password'].includes(host.auth?.type) ? host.auth.type : 'agent',
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
      await store.upsertHost(row)
      const existing = store.host(row.id)
      if (existing !== undefined) {
        // The row changed, so the tunnel may point at a different server: close
        // the listeners before the connection they ride on is dropped.
        await forward.stopHost(row.id)
        pool.close(existing.id)
      }
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
      await pool.ensure(host)
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

    'hosts.disconnect': async (payload) => {
      const hostId = requireString(payload, 'hostId')
      await forward.stopHost(hostId)
      pool.close(hostId)
      files.forget(hostId)
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
