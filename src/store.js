/**
 * Plugin state on disk: configured hosts, per-session path mappings, and the
 * sync baseline (the last known state of both ends for each file).
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

const EMPTY = { version: 1, hosts: [], mappings: {}, baselines: {} }

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

  /** Debounced, serialized, atomic write. */
  touch() {
    clearTimeout(this.#timer)
    this.#timer = setTimeout(() => { void this.flush() }, 250)
  }

  /** Write now (plugin unload, or after an awaited mutation in a test). */
  async flush() {
    clearTimeout(this.#timer)
    const body = JSON.stringify(this.#state, null, 2)
    this.#writing = this.#writing.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, this.path)
    }).catch(() => {})
    return this.#writing
  }
}
