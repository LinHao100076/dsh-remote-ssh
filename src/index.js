/**
 * dsh-remote-ssh host half.
 *
 * Owns the SSH transport, the file API, the terminal bridge, the sync engine,
 * and the agent tools. The client half (see `./client`) only renders; every
 * byte that touches a server passes through here.
 *
 * Routes:
 * - `POST /remote/api/<method>` — JSON API (see `api.js` for the method table).
 * - `WS   /remote/ws/term`      — interactive PTY.
 *
 * Both delegate admission to the host Connection service, exactly like the
 * built-in `/api` gateway: a same-origin page still has to be logged in.
 * @module dsh-remote-ssh
 */
import { WebSocketServer } from 'ws'
import { Store } from './store.js'
import { SshPool } from './ssh/pool.js'
import { RemoteFiles } from './remote/files.js'
import { RemoteSearch } from './remote/search.js'
import { Transfer } from './remote/transfer.js'
import { SyncEngine } from './sync/engine.js'
import { ForwardManager } from './forward/manager.js'
import { buildApi, sessionCwd, toWireError } from './api.js'
import { readJsonBody, writeError, writeOk, writeJson } from './wire.js'
import { attachTerminal } from './ws/term.js'
import { describeMapping } from './sync/mapping.js'
import { formatBytes } from './util.js'

export const name = 'dsh-remote-ssh'

/**
 * Re-exported so the transports can be exercised through the *published* bundle
 * (`lib/server.mjs`) as well as through source: the bundle inlines `ssh2` and
 * `ws`, and a real handshake / a real frame is the only honest proof that the
 * inlined copies still work. Issue #4 was a bundled-`ws` crash that no test
 * could see because nothing ever pushed a frame through the bundle.
 */
export { SshPool, WebSocketServer }

/** Routes, sessions and remote terminals need these services before mounting. */
export const inject = ['webServer', 'sessions']

const VERSION = '0.4.0'

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {{storePath?: string}} [config] - optional state file override (tests).
 * @returns {Promise<void>} resolves once routes are registered.
 */
export async function apply(ctx, config = {}) {
  const store = new Store(config?.storePath)
  const ready = store.load()

  const pool = new SshPool({
    onFingerprint: (hostId, fingerprint) => {
      const host = store.host(hostId)
      if (host !== undefined && host.fingerprint !== fingerprint) {
        void store.upsertHost({ id: hostId, fingerprint })
      }
    },
  })
  const files = new RemoteFiles(pool)
  const transfer = new Transfer(pool, files)
  const engine = new SyncEngine({ pool, files, transfer, store })
  const forward = new ForwardManager({ store, pool })
  const search = new RemoteSearch(pool)

  const api = buildApi({ ctx, store, pool, files, transfer, engine, forward, search, version: VERSION })

  /** Same admission gate as the built-in `/api` gateway. */
  const admitted = (req) => {
    const connection = ctx.get?.('connection')
    if (connection?.requestRejection === undefined) return true
    try {
      return connection.requestRejection(req) === undefined
    } catch {
      return true
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/remote/api',
    handler: async (req, res) => {
      if (!admitted(req)) {
        writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'POST only' } })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const prefix = '/remote/api/'
      const method = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : undefined
      if (method === undefined || method === '' || method.includes('/')) {
        writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'unknown api method' } })
        return
      }
      try {
        await ready
        const payload = await readJsonBody(req)
        const handler = Object.hasOwn(api, method) ? api[method] : undefined
        if (typeof handler !== 'function') {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown api method ${method}` } })
          return
        }
        const value = await handler(payload)
        writeOk(res, value)
      } catch (error) {
        writeError(res, toWireError(error))
      }
    },
  }), 'dsh-remote-ssh: /remote/api')

  const terminalWss = new WebSocketServer({ noServer: true })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: '/remote/ws/term',
    handler: (req, socket, head) => {
      if (!admitted(req)) {
        socket.destroy()
        return
      }
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        const url = new URL(req.url ?? '/', 'http://dsh.internal')
        void ready.then(() => attachTerminal({ ws, url, store, pool, files }))
      })
    },
  }), 'dsh-remote-ssh: terminal websocket')

  ctx.effect(() => () => {
    for (const client of terminalWss.clients) client.terminate()
    terminalWss.close()
    void forward.dispose()
    void engine.dispose()
    pool.dispose()
    void store.flush()
  }, 'dsh-remote-ssh: teardown')

  await registerTools(ctx, { store, pool, files, transfer, engine })
}

/**
 * Register the agent-facing tools. A deployment without the tools service keeps
 * the whole plugin usable — the tools are an accelerator, not the product.
 */
async function registerTools(ctx, deps) {
  const tools = ctx.get?.('tools')
  if (tools?.register === undefined) return
  const defineTool = await loadDefineTool()

  /** Host resolution shared by the tools: explicit id, else the only host. */
  const pickHost = (hostId) => {
    const hosts = deps.store.hosts()
    if (typeof hostId === 'string' && hostId !== '') {
      const host = hosts.find((item) => item.id === hostId || item.name === hostId)
      if (host === undefined) throw new Error(`没有名为 ${hostId} 的主机。已配置：${hosts.map((h) => h.name).join('、') || '无'}`)
      return host
    }
    if (hosts.length === 1) return hosts[0]
    if (hosts.length === 0) throw new Error('还没有配置任何远程主机，请先在侧边栏「远程」里添加连接')
    throw new Error(`配置了多个主机，请用 hostId 指定：${hosts.map((h) => `${h.name}(${h.id})`).join('、')}`)
  }

  /** First mapping of a session, or the only mapping in the profile. */
  const pickMapping = (sessionId) => {
    if (typeof sessionId === 'string' && sessionId !== '') {
      const mapping = deps.engine.primaryMapping(sessionId)
      if (mapping !== undefined) return mapping
    }
    const all = Object.values(deps.store.state.mappings).flat()
    if (all.length === 1) return all[0]
    if (all.length === 0) throw new Error('还没有配置路径映射')
    throw new Error(`存在多个映射（${all.map((m) => `${m.localRoot} → ${m.remoteRoot}`).join('；')}），请指定 sessionId`)
  }

  tools.register(defineTool({
    name: 'ssh_exec',
    description: 'Run a shell command on a configured remote SSH host and return stdout/stderr/exit code. Use it for remote builds, tests, logs and service checks. The working directory defaults to the mapped remote root.',
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command to run on the remote host.' },
      hostId: { type: 'string', description: 'Configured host id or name. Omit when only one host exists.' },
      cwd: { type: 'string', description: 'Absolute remote working directory. Omit to use the mapped remote root.' },
      timeoutMs: { type: 'number', description: 'Command timeout in milliseconds. Defaults to 120000.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const host = pickHost(args?.hostId)
      const timeoutMs = typeof args?.timeoutMs === 'number' ? args.timeoutMs : 120000
      let cwd = typeof args?.cwd === 'string' ? args.cwd : undefined
      if (cwd === undefined) {
        try {
          cwd = pickMapping(exec?.sessionId ?? args?.sessionId)?.remoteRoot
        } catch {
          cwd = undefined
        }
      }
      const result = await deps.pool.exec(host, String(args?.command ?? ''), { timeoutMs, cwd })
      const parts = []
      if (result.stdout !== '') parts.push(result.stdout.trimEnd())
      if (result.stderr !== '') parts.push(`[stderr]\n${result.stderr.trimEnd()}`)
      parts.push(`[exit ${result.code ?? 'signal'}]${result.truncated ? ' [output truncated]' : ''}`)
      return { text: parts.join('\n'), exitCode: result.code, host: host.name, cwd: cwd ?? '(login shell)' }
    },
  }))

  tools.register(defineTool({
    name: 'ssh_sync',
    description: 'Synchronize the local workspace with the mapped remote directory. Under the default push-only policy edits upload automatically, so use action "flush" to wait for the queue before running remote commands; "pushAll" mirrors every non-ignored file; "pull" downloads one path.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'One of: flush | pushAll | pull | status.',
      },
      sessionId: { type: 'string', description: 'Conversation id whose mapping to use. Omit when only one mapping exists.' },
      mappingId: { type: 'string', description: 'Target mapping id when the session has several.' },
      rel: { type: 'string', description: 'Mapping-relative path for action "pull".' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const mapping = pickMapping(exec?.sessionId ?? args?.sessionId)
      const sessionId = exec?.sessionId ?? args?.sessionId ?? mapping.sessionId ?? 'default'
      const action = String(args?.action ?? 'status')
      if (action === 'flush') {
        const state = await deps.engine.flush(sessionId)
        const pending = state.queue.filter((task) => task.state === 'queued' || task.state === 'uploading').length
        return {
          text: `同步完成：已上传 ${state.stats.uploaded} 个文件 · ${formatBytes(state.stats.bytes)}，待处理 ${pending}，冲突 ${state.conflicts.length}`,
          stats: state.stats,
          conflicts: state.conflicts.length,
        }
      }
      if (action === 'pushAll') {
        const mappingId = typeof args?.mappingId === 'string' ? args.mappingId : mapping.id
        const result = await deps.engine.pushAll(sessionId, mappingId)
        return {
          text: `全量推送 ${mapping.localRoot} → ${mapping.remoteRoot}：${result.files} 个文件 · ${formatBytes(result.bytes)}${result.failed.length > 0 ? `，${result.failed.length} 个失败` : ''}`,
          failed: result.failed.slice(0, 10),
        }
      }
      if (action === 'pull') {
        const rel = String(args?.rel ?? '')
        if (rel === '') throw new Error('action "pull" 需要 rel（映射内相对路径）')
        const mappingId = typeof args?.mappingId === 'string' ? args.mappingId : mapping.id
        const result = await deps.engine.pull(sessionId, mappingId, rel)
        return { text: `已下载 ${rel}（${formatBytes(result.size)}）到本地`, result }
      }
      const state = deps.engine.list(sessionId)
      return {
        text: [
          `映射 ${state.mappings.length} 个，待上传 ${state.queue.filter((t) => t.state === 'queued' || t.state === 'uploading').length}，冲突 ${state.conflicts.length}`,
          ...state.mappings.map((item) => `· ${describeMapping(item).localRoot} ⇄ ${item.remoteRoot} [${describeMapping(item).directionLabel}/${item.policy}]`),
        ].join('\n'),
        state,
      }
    },
  }))

  tools.register(defineTool({
    name: 'ssh_hosts',
    description: 'List the remote SSH hosts configured in this DSH profile, with their status and the session mappings that point at them.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute() {
      const hosts = deps.store.hosts()
      const statuses = deps.pool.statuses()
      const lines = hosts.map((host) => {
        const status = statuses[host.id]?.status ?? 'disconnected'
        return `· ${host.name} — ${host.user}@${host.host}:${host.port} [${status}]`
      })
      return { text: hosts.length === 0 ? '还没有配置远程主机' : lines.join('\n'), hosts, statuses }
    },
  }))
}

/** `defineTool` is a typing helper; a missing package must not break the plugin. */
async function loadDefineTool() {
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    if (typeof mod.defineTool === 'function') return mod.defineTool
  } catch {
    // Standalone install without the harness peer package: identity is enough.
  }
  return (definition) => definition
}

/** Exposed for the settings UI: the plugin version shown in the footer. */
export const version = VERSION

export { sessionCwd }
