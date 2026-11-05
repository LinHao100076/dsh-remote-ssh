/**
 * Forward-rule shape, shared by the store (load-time migration) and the manager
 * (create/update).
 *
 * There are three kinds, and they differ in *which end listens*:
 *
 * | kind      | 监听端 | 目标端             | OpenSSH 等价       |
 * | --------- | ------ | ------------------ | ------------------ |
 * | `local`   | 本机   | 远端 host:port     | `ssh -L`           |
 * | `dynamic` | 本机   | 每次连接再决定     | `ssh -D`（SOCKS5） |
 * | `remote`  | 远端   | 本机 host:port     | `ssh -R`           |
 *
 * That table is the reason a rule keeps its two endpoints as `listen` and
 * `target` instead of `localPort`/`remotePort`: with three kinds, "local" and
 * "remote" no longer name a fixed role — for `-R` the local port is the *target*
 * and the remote port is the *listener*. Naming the roles instead of the sides
 * removes the ambiguity instead of documenting it.
 * @module dsh-remote-ssh/forward/rule
 */
import { nextId } from '../util.js'

/** The kinds a rule may have. */
export const KIND = { local: 'local', dynamic: 'dynamic', remote: 'remote' }

/** Listen addresses that keep a tunnel on its own machine. */
export const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost'])

/** Addresses that cover every interface on their side. */
const WILDCARDS = new Set(['0.0.0.0', '::', '[::]', ''])

/** Trimmed string or empty. */
function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}/** A port as an integer, or 0 when absent/unparsable (migration never throws). */
function port(value) {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 0
}

/** Which side of the connection a rule's listening socket lives on. */
export function listenSide(kind) {
  return kind === KIND.remote ? 'remote' : 'local'
}

/**
 * Coerce a stored or submitted rule into the canonical shape.
 *
 * Deliberately does *not* validate: a stored row with a missing port must still
 * load (the panel then shows it as broken and the user can fix it), while a
 * submitted row is validated by the manager before it is saved. Legacy rows
 * written by 0.5.x and earlier carry `localPort`/`remoteHost`/`remotePort` and
 * no `kind`; they were all `-L`, so that is the default.
 * @param {object} raw - stored or submitted rule.
 * @returns {object} canonical rule.
 */
export function normalizeRule(raw = {}) {
  const kind = raw.kind === KIND.dynamic || raw.kind === KIND.remote ? raw.kind : KIND.local
  const listen = raw.listen ?? { host: raw.bind, port: raw.localPort }
  const target = raw.target ?? { host: raw.remoteHost, port: raw.remotePort }
  const dynamic = kind === KIND.dynamic
  return {
    id: str(raw.id) || nextId('fwd'),
    kind,
    listen: { host: str(listen.host) || '127.0.0.1', port: port(listen.port) },
    // A dynamic rule has no fixed destination; whatever the SOCKS client asks
    // for is the target, resolved on the remote side.
    target: dynamic ? { host: '', port: 0 } : { host: str(target.host) || '127.0.0.1', port: port(target.port) },
    autoStart: raw.autoStart !== false,
    note: str(raw.note) || undefined,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  }
}

/**
 * Whether two listening sockets can never coexist.
 *
 * A wildcard address covers every interface on its side, so `0.0.0.0:8080`
 * clashes with `127.0.0.1:8080` even though the strings differ. Port 0 means
 * "not filled in yet" and never clashes.
 * @param {{host: string, port: number}} a - first socket.
 * @param {{host: string, port: number}} b - second socket.
 * @returns {boolean} true when both cannot listen at once.
 */
export function sameSocket(a, b) {
  if (a.port === 0 || b.port === 0 || a.port !== b.port) return false
  return a.host === b.host || WILDCARDS.has(a.host) || WILDCARDS.has(b.host)
}

/**
 * Whether two rules listen on the same machine.
 *
 * A local `-L` rule and a remote `-R` rule can both use port 8080: one binds it
 * here, the other on the server. Rules on different hosts never collide either,
 * even when both are `-R` on the same port — those are different servers.
 * @param {object} a - canonical rule.
 * @param {object} b - canonical rule.
 * @param {string} [hostA] - owning host of `a`.
 * @param {string} [hostB] - owning host of `b`.
 * @returns {boolean} true when the two can collide.
 */
export function sameSocketSpace(a, b, hostA, hostB) {
  if (listenSide(a.kind) !== listenSide(b.kind)) return false
  if (listenSide(a.kind) === 'remote' && hostA !== hostB) return false
  return sameSocket(a.listen, b.listen)
}

/** One-line summary used in errors: `127.0.0.1:6379 → 10.0.0.4:5432`. */
export function describeRule(rule) {
  const head = `${rule.listen.host}:${rule.listen.port}`
  if (rule.kind === KIND.dynamic) return `${head} → SOCKS5`
  return `${head} → ${rule.target.host}:${rule.target.port}`
}
