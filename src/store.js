/**
 * Plugin state on disk: configured hosts, per-session path mappings, the sync
 * baseline (the last known state of both ends for each file), and the port
 * forward rules per host.
 *
 * Hosts never carry a password or passphrase — the UI sends those with the
 * connect request and they live only in the pooling `Client`. What is stored is
 * the key path, the auth kind, and the pinned host-key fingerprint.
 * @module dsh-remote-ssh/store
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { expandHome } from './ssh/paths.js'
import { normalizeRule } from './forward/rule.js'

const EMPTY = { version: 1, hosts: [], mappings: {}, baselines: {}, forwards: {} }

/**
 * Bring stored rules up to the current shape.
 *
 * 0.5.x and earlier wrote `{localPort, remoteHost, remotePort, bind}` with no
 * `kind`; every one of those was a `-L` rule, which is exactly what
 * `normalizeRule` assumes when `kind` is absent. Rewriting on load (rather than
 * at every read) means the file converges to one shape on the next save instead
 * of carrying a translation layer forever.
 */
function migrateForwards(forwards) {
  const result = {}
  for (const [hostId, rules] of Object.entries(forwards)) {
    if (!Array.isArray(rules)) continue
    const migrated = rules.map((rule) => normalizeRule(rule))
    if (migrated.length > 0) result[hostId] = migrated
  }
  return result
}

export class Store {
  #state = structuredClone(EMPTY)
  #timer
  #writing = Promise.resolve()

  constructor(path) {
    this.path = path === undefined || path === ''
      ? join(homedir(), '.dsh', 'storages', 'dsh-remote-ssh', 'state.json')
      : expandHome(path)
  }

  /** Read the file; a missing or corrupt file starts from an empty state. */
  async load() {
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      this.#state = {
        version: 1,
        hosts: Array.isArray(parsed.hosts) ? parsed.hosts : [],
        mappings: parsed.mappings ?? {},
        baselines: parsed.baselines ?? {},
        forwards: migrateForwards(parsed.forwards ?? {}),
      }
    } catch {
      this.#state = structuredClone(EMPTY)
    }
    return this
  }

  get state() { return this.#state }

  /** All configured hosts, newest first. */
  hosts() { return [...this.#state.hosts] }

  /** One host by id. */
  host(hostId) { return this.#state.hosts.find((host) => host.id === hostId) }

  /** Insert or replace a host row. */
  async upsertHost(row) {
    const index = this.#state.hosts.findIndex((host) => host.id === row.id)
    if (index === -1) this.#state.hosts.push(row)
    else this.#state.hosts[index] = { ...this.#state.hosts[index], ...row }
    this.touch()
    return row
  }

  /** Remove a host and every mapping that pointed at it. */
  async deleteHost(hostId) {
    this.#state.hosts = this.#state.hosts.filter((host) => host.id !== hostId)
    for (const [sessionId, mappings] of Object.entries(this.#state.mappings)) {
      this.#state.mappings[sessionId] = mappings.filter((mapping) => mapping.hostId !== hostId)
    }
    delete this.#state.forwards[hostId]
    this.touch()
  }

  /** Mappings for one session. */
  mappings(sessionId) {
    return this.#state.mappings[sessionId] ?? []
  }

  /** Replace the mapping list for one session. */
  async setMappings(sessionId, mappings) {
    this.#state.mappings[sessionId] = mappings
    this.touch()
  }

  /** Baseline rows for one session, keyed `mappingId:relPath`. */
  baselines(sessionId) {
    this.#state.baselines[sessionId] ??= {}
    return this.#state.baselines[sessionId]
  }

  /** Record the last known state of one file on both ends. */
  setBaseline(sessionId, key, value) {
    this.baselines(sessionId)[key] = value
    this.touch()
  }

  /** Drop a baseline (file deleted or mapping removed). */
  dropBaseline(sessionId, key) {
    delete this.baselines(sessionId)[key]
    this.touch()
  }

  /* ── port forwards ─────────────────────────────────────────────────── */

  /** Forward rules configured for one host. */
  forwards(hostId) {
    return this.#state.forwards[hostId] ?? []
  }

  /** Every rule across hosts, each tagged with its `hostId`. */
  allForwards() {
    return Object.entries(this.#state.forwards)
      .flatMap(([hostId, rules]) => rules.map((rule) => ({ ...rule, hostId })))
  }

  /** Replace the rule list for one host (an empty list removes the entry). */
  async setForwards(hostId, rules) {
    if (rules.length === 0) delete this.#state.forwards[hostId]
    else this.#state.forwards[hostId] = rules
    this.touch()
  }

  /** Debounced, serialized, atomic write. */
  touch() {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => { void this.flush().catch(() => {}) }, 250)
  }

  /** Write now (plugin unload, or after an awaited mutation in a test). */
  async flush() {
    clearTimeout(this.#timer)
    const body = JSON.stringify(this.#state, null, 2)
    const writing = this.#writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, this.path)
    })
    // Keep the queue recoverable, but do not report a failed write as success.
    this.#writing = writing.catch((error) => {
      console.error('[dsh-remote-ssh] 状态保存失败：', error.message)
    })
    return writing
  }
}
