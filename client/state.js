/**
 * Client-side plumbing: the JSON API client, small external stores, hooks, and
 * path/format helpers.
 *
 * Routes resolve against the page's own base, so a reverse-proxy prefix survives
 * (a leading-slash URL would pin requests to the origin root). better-sidebar
 * offers `hostRouteUrl` and is preferred when it is there; the fallback below is
 * what keeps the plugin working in a profile that runs without it — the native
 * right sidebar needs no third-party service.
 *
 * WebSockets take the *transport* base instead when the page is not served over
 * `http(s)`: the desktop shell runs the page at `dsh-app://app/`, a scheme that
 * cannot carry `ws:` (its host is the literal string `app`, which no DNS lookup
 * resolves). `__DSH_TRANSPORT__.streamBaseUrl` is the Host's real origin and is
 * the only base the socket can use there.
 * @module dsh-remote-ssh/client/state
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

/** Placeholder origin for non-DOM evaluation (tests, SSR); never requested. */
const PLACEHOLDER_ORIGIN = 'http://dsh.internal/'

/** The page's own base, with or without a reverse-proxy directory prefix. */
function pageBase() {
  const base = typeof document !== 'undefined' ? document.baseURI : undefined
  return typeof base === 'string' && base !== '' ? base : PLACEHOLDER_ORIGIN
}

/** Force a trailing slash: DSH serves the GUI from a directory, never a file. */
function directoryBase(base) {
  const url = new URL(base === '' ? PLACEHOLDER_ORIGIN : base, PLACEHOLDER_ORIGIN)
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url.toString()
}

/** The base a WebSocket can be built from; see the module comment. */
function socketBase() {
  const page = pageBase()
  if (/^https?:/i.test(page)) return page
  const injected = globalThis.__DSH_TRANSPORT__?.streamBaseUrl
  return typeof injected === 'string' && injected !== '' ? injected : page
}

/**
 * Read better-sidebar's service without disturbing cordis.
 *
 * A client context is a proxy that THROWS on a service it was not injected with
 * (`cannot get property "betterSidebar" without inject`), so a plain property
 * read turns "the plugin is not installed" — the case this plugin now supports —
 * into a render error. `ctx.get` is the safe accessor and returns `undefined`.
 * @param {object} ctx - client context.
 * @returns {object|undefined} the service when it is there.
 */
export function hostService(ctx) {
  if (ctx === undefined || ctx === null) return undefined
  if (typeof ctx.get === 'function') return ctx.get('betterSidebar')
  try {
    return ctx.betterSidebar
  } catch {
    return undefined
  }
}

/** Resolve a plugin route against the host's transport base. */
export function routeUrl(ctx, path) {
  const service = hostService(ctx)
  if (typeof service?.hostRouteUrl === 'function') return service.hostRouteUrl(path)
  return new URL(String(path).replace(/^\/+/, ''), directoryBase(pageBase())).toString()
}

/** Resolve a plugin route as a WebSocket URL with query parameters. */
export function wsUrl(ctx, path, params = {}) {
  const url = new URL(String(path).replace(/^\/+/, ''), directoryBase(socketBase()))
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
  }
  return url.toString()
}

/**
 * Call one `/remote/api` method.
 * @param {object} ctx - client context (for route resolution).
 * @param {string} method - dispatch key, e.g. `fs.list`.
 * @param {object} [payload] - request body.
 * @param {{signal?: AbortSignal}} [options] - cancellation.
 * @returns {Promise<any>} the unwrapped value.
 */
export async function api(ctx, method, payload = {}, { signal } = {}) {
  const response = await fetch(routeUrl(ctx, `remote/api/${method}`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  const body = await response.json().catch(() => undefined)
  if (body === undefined) throw Object.assign(new Error(`HTTP ${response.status}`), { code: 'http' })
  if (body.ok !== true) {
    const error = new Error(body.error?.message ?? '请求失败')
    error.code = body.error?.code ?? 'unknown'
    error.details = body.error?.details
    throw error
  }
  return body.value
}

/** Minimal external store (no dependency, works with useSyncExternalStore). */
export function createStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    get: () => value,
    set: (next) => {
      value = typeof next === 'function' ? next(value) : next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/** Subscribe a component to a store. */
export function useStore(store) {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/** Hosts + live connection status, shared by every tab. */
export const hostStore = createStore({ hosts: [], statuses: {}, loaded: false })

/** Refresh the host list (cheap; called on mount and after mutations). */
export async function refreshHosts(ctx) {
  const value = await api(ctx, 'hosts.list')
  hostStore.set({ hosts: value.hosts ?? [], statuses: value.statuses ?? {}, loaded: true })
  return value
}

/** Reload only the statuses (polled while a tab is visible). */
export async function refreshStatuses(ctx) {
  const value = await api(ctx, 'hosts.status')
  hostStore.set((current) => ({ ...current, statuses: value.statuses ?? {} }))
}

/** Poll `run` while `active`, immediately and then every `ms`. */
export function usePolling(active, ms, run) {
  const saved = useRef(run)
  saved.current = run
  useEffect(() => {
    if (!active) return undefined
    let stopped = false
    const tick = async () => {
      if (stopped) return
      try {
        await saved.current()
      } catch {
        // Polling failures are surfaced by the caller's own state, not here.
      }
    }
    void tick()
    const timer = setInterval(tick, ms)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [active, ms])
}

/** Async action runner with busy + error state. */
export function useAction() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(undefined)
  const run = useCallback(async (fn) => {
    setBusy(true)
    setError(undefined)
    try {
      return await fn()
    } catch (failure) {
      setError(failure.message ?? String(failure))
      return undefined
    } finally {
      setBusy(false)
    }
  }, [])
  return { busy, error, run, setError }
}

/* ── paths + formatting ──────────────────────────────────────────────── */

/** POSIX join that preserves the remote root. */
export function joinRemote(base, name) {
  if (base === '' || base === '/') return `/${name}`.replace(/\/+/g, '/')
  return `${base.replace(/\/+$/, '')}/${name}`
}

/** POSIX dirname. */
export function dirnameRemote(path) {
  const clean = String(path ?? '').replace(/\/+$/, '')
  if (clean === '' || clean === '/') return '/'
  const cut = clean.lastIndexOf('/')
  return cut <= 0 ? '/' : clean.slice(0, cut)
}

/** POSIX basename. */
export function basenameRemote(path) {
  const clean = String(path ?? '').replace(/\/+$/, '')
  if (clean === '') return '/'
  const cut = clean.lastIndexOf('/')
  return cut === -1 ? clean : clean.slice(cut + 1)
}

/** Byte count for UI rows. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** Short relative time ("12s", "3m", "now"). */
export function sinceLabel(timestamp) {
  if (!timestamp) return ''
  const ms = Date.now() - timestamp
  if (ms < 1500) return '刚刚'
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`
  return new Date(timestamp).toLocaleTimeString()
}

/** Join a local root and a mapping-relative POSIX path for the local side. */
export function joinLocal(root, rel) {
  if (rel === '') return root
  return `${String(root).replace(/[\\/]+$/, '')}/${rel}`
}

/** Read a File as base64 (no data: prefix) for the upload method. */
export function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma === -1 ? result : result.slice(comma + 1))
    }
    reader.readAsDataURL(file)
  })
}

/* ── secrets (memory only) ───────────────────────────────────────────── */

/**
 * Per-session credential cache. Keyed by host id; entries are forgotten when the
 * page reloads, because a password or key passphrase must never be persisted.
 */
export const secretStore = new Map()

/**
 * Connect a saved host, attaching any credential typed in this session.
 * @param {object} ctx - client context.
 * @param {object} host - stored host row.
 * @param {{password?: string, passphrase?: string}} [override] - just-typed secrets.
 * @returns {Promise<object>} `{hostId, status, info}`.
 */
export async function connectHost(ctx, host, override = {}) {
  const cached = secretStore.get(host.id) ?? {}
  const auth = {}
  if (host.auth?.type === 'password') auth.password = override.password ?? cached.password
  if (host.auth?.type === 'key') auth.passphrase = override.passphrase ?? cached.passphrase
  return api(ctx, 'hosts.connect', { hostId: host.id, auth })
}
