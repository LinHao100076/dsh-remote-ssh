/**
 * Small helpers shared by both halves of dsh-remote-ssh.
 *
 * Everything here is dependency-free so the host half keeps a single runtime
 * dependency (`ssh2` for the transport) and the client half can inline the
 * same rules for optimistic UI without importing host code.
 * @module dsh-remote-ssh/util
 */

/** POSIX single-quote a string so it can be embedded in a remote shell command. */
export function shq(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

/** Promise wrapper over a node-style callback method (`obj[m](...args, cb)`). */
export function call(obj, method, ...args) {
  return new Promise((resolve, reject) => {
    obj[method](...args, (error, value) => (error ? reject(error) : resolve(value)))
  })
}

/** Resolve with `value` after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

let counter = 0
/** Monotonic short id, unique inside one process (no crypto cost). */
export function nextId(prefix = 'id') {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`
}

/** Join a POSIX remote path without collapsing the root. */
export function joinRemote(base, name) {
  if (base === '' || base === '/') return `/${name}`.replace(/\/+/g, '/')
  return `${base.replace(/\/+$/, '')}/${name}`
}

/** Parent of a POSIX path, `'/'` for the root. */
export function dirnameRemote(path) {
  const clean = String(path).replace(/\/+$/, '')
  if (clean === '' || clean === '/') return '/'
  const index = clean.lastIndexOf('/')
  return index <= 0 ? '/' : clean.slice(0, index)
}

/** Normalize slashes for the local side (keeps a Windows drive root intact). */
export function toLocalPath(path) {
  return String(path).replaceAll('\\', '/')
}

/** Whether a byte buffer looks like binary content (NUL in the first 8 KiB). */
export function looksBinary(buffer) {
  const end = Math.min(buffer.length, 8192)
  for (let index = 0; index < end; index += 1) {
    if (buffer[index] === 0) return true
  }
  return false
}

/** Human readable byte count used in API payloads and tool output. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** Trailing-edge debounce keyed by caller-managed string keys. */
export class Debouncer {
  #timers = new Map()
  constructor(ms) { this.ms = ms }
  push(key, run) {
    const existing = this.#timers.get(key)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.#timers.delete(key)
      run()
    }, this.ms)
    this.#timers.set(key, timer)
  }
  drop(key) {
    const existing = this.#timers.get(key)
    if (existing !== undefined) clearTimeout(existing)
    this.#timers.delete(key)
  }
  dispose() {
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
  }
}
