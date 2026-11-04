/**
 * The sync engine: watch the local mapping roots, queue uploads, refuse to
 * clobber a remote edit, and keep a baseline of both ends.
 *
 * Design decisions that matter:
 * - **Local is the truth.** A watcher-driven upload overwrites the remote file
 *   only when there is no evidence that the remote moved since our last known
 *   state. Evidence of remote drift (`mtime` newer than baseline) plus a local
 *   change turns into a conflict instead of a write.
 * - **Deletes never propagate.** `unlink` is recorded, not mirrored; deleting a
 *   file locally will not delete it on a server.
 * - **One upload at a time per session.** Interactive edits are single files;
 *   serializing keeps SFTP request interleaving out of the failure modes. Bulk
 *   traffic goes through `pushAll`, which parallelizes inside `Transfer`.
 * @module dsh-remote-ssh/sync/engine
 */
import { stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import chokidar from 'chokidar'
import { createMatcher, normalizeMapping } from './mapping.js'
import { Debouncer, joinRemote, nextId, sleep, toLocalPath } from '../util.js'

const CONFLICT_SLACK_MS = 2000
const MAX_TASKS = 120

/** Mapping-relative POSIX path for a local absolute path, `''` for the root. */
function relOf(root, absolute) {
  return toLocalPath(relative(root, absolute)).replace(/^\/+/, '')
}

export class SyncEngine {
  /** @type {Map<string, object>} */
  #sessions = new Map()
  #debounce = new Debouncer(260)

  constructor({ pool, files, transfer, store, onEvent }) {
    this.pool = pool
    this.files = files
    this.transfer = transfer
    this.store = store
    this.onEvent = onEvent ?? (() => {})
  }

  #session(sessionId) {
    const existing = this.#sessions.get(sessionId)
    if (existing !== undefined) return existing
    const mappings = this.store.mappings(sessionId).map((mapping) => ({ ...mapping }))
    const session = {
      id: sessionId,
      mappings,
      matchers: new Map(mappings.map((mapping) => [mapping.id, createMatcher(mapping)])),
      watchers: new Map(),
      queue: new Map(),
      conflicts: new Map(),
      draining: false,
      stats: { uploaded: 0, failed: 0, conflicts: 0, bytes: 0, lastAt: 0, skipped: 0 },
    }
    this.#sessions.set(sessionId, session)
    return session
  }

  /** Public view of one session's sync state. */
  list(sessionId) {
    const session = this.#session(sessionId)
    return {
      mappings: session.mappings.map((mapping) => ({
        ...mapping,
        watching: session.watchers.has(mapping.id),
        pending: [...session.queue.values()]
          .filter((task) => task.mappingId === mapping.id && (task.state === 'queued' || task.state === 'uploading')).length,
        conflicts: [...session.conflicts.values()].filter((item) => item.mappingId === mapping.id).length,
      })),
      queue: this.#queueView(session),
      conflicts: [...session.conflicts.values()].sort((a, b) => b.detectedAt - a.detectedAt),
      stats: session.stats,
    }
  }

  #queueView(session) {
    const items = [...session.queue.values()]
    return items.slice(-40).map((task) => ({
      id: task.id,
      mappingId: task.mappingId,
      rel: task.rel,
      state: task.state,
      size: task.size,
      error: task.error,
      note: task.note,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
    }))
  }

  /** Validate, persist, and (re)start watching one mapping. */
  async save(sessionId, input, sessionCwd) {
    const session = this.#session(sessionId)
    const mapping = normalizeMapping(input, sessionCwd)
    if (mapping.hostId === '') throw new Error('请选择主机')
    const index = session.mappings.findIndex((item) => item.id === mapping.id)
    if (index === -1) session.mappings.push(mapping)
    else session.mappings[index] = mapping
    session.matchers.set(mapping.id, createMatcher(mapping))
    await this.store.setMappings(sessionId, session.mappings.map(stripRuntime))
    await this.#restart(sessionId, mapping)
    return this.list(sessionId)
  }

  /** Remove a mapping, its watcher, and its baselines. */
  async remove(sessionId, mappingId) {
    const session = this.#session(sessionId)
    session.watchers.get(mappingId)?.close?.()
    session.watchers.delete(mappingId)
    session.mappings = session.mappings.filter((mapping) => mapping.id !== mappingId)
    session.matchers.delete(mappingId)
    for (const key of Object.keys(this.store.baselines(sessionId))) {
      if (key.startsWith(`${mappingId}:`)) this.store.dropBaseline(sessionId, key)
    }
    for (const [key, task] of session.queue) {
      if (task.mappingId === mappingId) session.queue.delete(key)
    }
    await this.store.setMappings(sessionId, session.mappings.map(stripRuntime))
    return this.list(sessionId)
  }

  /** Start every auto-syncable mapping of a session (idempotent). */
  async start(sessionId) {
    const session = this.#session(sessionId)
    for (const mapping of session.mappings) await this.#restart(sessionId, mapping)
    return this.list(sessionId)
  }

  async #restart(sessionId, mapping) {
    const session = this.#session(sessionId)
    const existing = session.watchers.get(mapping.id)
    if (existing !== undefined) { await existing.close(); session.watchers.delete(mapping.id) }
    if (mapping.enabled === false || mapping.policy === 'off' || mapping.direction === 'pull') return
    const matcher = session.matchers.get(mapping.id) ?? createMatcher(mapping)
    session.matchers.set(mapping.id, matcher)
    try {
      const watcher = chokidar.watch(mapping.localRoot, {
        ignoreInitial: true,
        persistent: true,
        followSymlinks: false,
        ignored: (candidate) => {
          const rel = relOf(mapping.localRoot, candidate)
          if (rel === '' || rel === '.') return false
          if (rel.split('/').includes('.git')) return true
          return !matcher(rel)
        },
        awaitWriteFinish: { stabilityThreshold: 180, pollInterval: 40 },
      })
      watcher.on('add', (path) => this.#schedule(sessionId, mapping, path))
      watcher.on('change', (path) => this.#schedule(sessionId, mapping, path))
      watcher.on('unlink', (path) => this.#onUnlink(sessionId, mapping, path))
      watcher.on('error', (error) => this.onEvent({ type: 'watch-error', sessionId, mappingId: mapping.id, message: String(error?.message ?? error) }))
      session.watchers.set(mapping.id, watcher)
    } catch (error) {
      this.onEvent({ type: 'watch-error', sessionId, mappingId: mapping.id, message: String(error?.message ?? error) })
    }
  }

  #schedule(sessionId, mapping, absolute) {
    const rel = relOf(mapping.localRoot, absolute)
    if (rel === '') return
    this.#debounce.push(`${mapping.id}:${rel}`, () => {
      this.#enqueue(sessionId, mapping, rel, join(mapping.localRoot, rel))
    })
  }

  #onUnlink(sessionId, mapping, absolute) {
    const rel = relOf(mapping.localRoot, absolute)
    if (rel === '') return
    const key = `${mapping.id}:${rel}`
    this.store.dropBaseline(sessionId, key)
    const session = this.#session(sessionId)
    session.queue.delete(key)
    this.onEvent({ type: 'local-removed', sessionId, mappingId: mapping.id, rel })
  }

  #enqueue(sessionId, mapping, rel, localPath) {
    const session = this.#session(sessionId)
    const key = `${mapping.id}:${rel}`
    const previous = session.queue.get(key)
    if (previous?.state === 'uploading') {
      previous.requeue = true
      return
    }
    const task = {
      id: nextId('task'),
      mappingId: mapping.id,
      hostId: mapping.hostId,
      rel,
      localPath,
      remotePath: joinRemote(mapping.remoteRoot, rel),
      state: 'queued',
      attempts: previous?.attempts ?? 0,
      size: 0,
      startedAt: 0,
      finishedAt: 0,
    }
    session.queue.set(key, task)
    this.#prune(session)
    void this.#drain(sessionId)
  }

  #prune(session) {
    if (session.queue.size <= MAX_TASKS) return
    for (const [key, task] of session.queue) {
      if (session.queue.size <= MAX_TASKS) break
      if (task.state === 'done' || task.state === 'error' || task.state === 'conflict') session.queue.delete(key)
    }
  }

  async #drain(sessionId) {
    const session = this.#session(sessionId)
    if (session.draining) return
    session.draining = true
    try {
      for (;;) {
        const next = [...session.queue.values()].find((task) => task.state === 'queued')
        if (next === undefined) break
        next.state = 'uploading'
        next.startedAt = Date.now()
        await this.#run(sessionId, next)
      }
    } finally {
      session.draining = false
    }
  }

  async #run(sessionId, task) {
    const session = this.#session(sessionId)
    const mapping = session.mappings.find((item) => item.id === task.mappingId)
    const host = this.store.host(task.hostId)
    if (mapping === undefined || host === undefined) {
      task.state = 'error'
      task.error = '映射或主机已被删除'
      return
    }
    try {
      const local = await stat(task.localPath).catch(() => undefined)
      if (local === undefined || !local.isFile()) {
        task.state = 'done'
        task.note = '本地已删除'
        return
      }
      const key = `${task.mappingId}:${task.rel}`
      const baseline = this.store.baselines(sessionId)[key]
      const remote = await this.files.stat(host, task.remotePath)
      const remoteDrifted = remote !== undefined && baseline !== undefined
        && Math.abs(remote.mtimeMs - baseline.remoteMtimeMs) > CONFLICT_SLACK_MS
      if (remoteDrifted) {
        const localChanged = Math.abs(local.mtimeMs - baseline.localMtimeMs) > CONFLICT_SLACK_MS
          || local.size !== baseline.size
        if (!localChanged) {
          task.state = 'done'
          task.note = '远端较新，已跳过'
          session.stats.skipped += 1
          return
        }
        this.#raiseConflict(session, task, mapping, local, remote)
        return
      }
      const info = await this.transfer.uploadFile(host, task.localPath, task.remotePath)
      task.state = 'done'
      task.size = info.size
      task.finishedAt = Date.now()
      this.store.setBaseline(sessionId, key, {
        localMtimeMs: local.mtimeMs,
        remoteMtimeMs: info.mtimeMs,
        size: info.size,
      })
      session.stats.uploaded += 1
      session.stats.bytes += info.size
      session.stats.lastAt = Date.now()
    } catch (error) {
      task.attempts += 1
      task.error = String(error?.message ?? error)
      if (task.attempts < 2) {
        task.state = 'queued'
        await sleep(600)
      } else {
        task.state = 'error'
        task.finishedAt = Date.now()
        session.stats.failed += 1
      }
    }
  }

  #raiseConflict(session, task, mapping, local, remote) {
    const key = `${task.mappingId}:${task.rel}`
    task.state = 'conflict'
    task.finishedAt = Date.now()
    session.conflicts.set(key, {
      key,
      mappingId: mapping.id,
      hostId: mapping.hostId,
      rel: task.rel,
      localPath: task.localPath,
      remotePath: task.remotePath,
      localMtimeMs: local.mtimeMs,
      localSize: local.size,
      remoteMtimeMs: remote.mtimeMs,
      remoteSize: remote.size,
      detectedAt: Date.now(),
    })
    session.stats.conflicts += 1
    this.onEvent({ type: 'conflict', sessionId: session.id, key })
  }

  /** Resolve one conflict: keep local (force upload), take remote, or drop it. */
  async resolve(sessionId, key, choice) {
    const session = this.#session(sessionId)
    const conflict = session.conflicts.get(key)
    if (conflict === undefined) throw new Error('冲突不存在或已处理')
    const host = this.store.host(conflict.hostId)
    if (host === undefined) throw new Error('主机已被删除')
    if (choice === 'local') {
      const info = await this.transfer.uploadFile(host, conflict.localPath, conflict.remotePath)
      const local = await stat(conflict.localPath).catch(() => undefined)
      this.store.setBaseline(sessionId, key, {
        localMtimeMs: local?.mtimeMs ?? Date.now(),
        remoteMtimeMs: info.mtimeMs,
        size: info.size,
      })
      session.stats.uploaded += 1
    } else if (choice === 'remote') {
      const mapping = session.mappings.find((item) => item.id === conflict.mappingId)
      if (mapping === undefined) throw new Error('映射已被删除')
      const info = await this.transfer.downloadFile(host, conflict.remotePath, conflict.localPath)
      this.store.setBaseline(sessionId, key, {
        localMtimeMs: info.mtimeMs,
        remoteMtimeMs: conflict.remoteMtimeMs,
        size: info.size,
      })
    }
    session.conflicts.delete(key)
    return this.list(sessionId)
  }

  /** Push every file of one mapping (initial mirror or "sync now"). */
  async pushAll(sessionId, mappingId, { onProgress } = {}) {
    const session = this.#session(sessionId)
    const mapping = session.mappings.find((item) => item.id === mappingId)
    if (mapping === undefined) throw new Error('映射不存在')
    const host = this.store.host(mapping.hostId)
    if (host === undefined) throw new Error('主机已被删除')
    const matcher = session.matchers.get(mapping.id) ?? createMatcher(mapping)
    const result = await this.transfer.uploadTree(host, mapping.localRoot, mapping.remoteRoot, { matcher, onProgress })
    for (const item of result.items ?? []) {
      this.store.setBaseline(sessionId, `${mapping.id}:${item.rel}`, {
        localMtimeMs: item.localMtimeMs,
        remoteMtimeMs: item.mtimeMs,
        size: item.size,
      })
    }
    session.stats.uploaded += result.files
    session.stats.bytes += result.bytes
    session.stats.lastAt = Date.now()
    return result
  }

  /** Pull one file from the remote mapping into the local workspace. */
  async pull(sessionId, mappingId, rel) {
    const session = this.#session(sessionId)
    const mapping = session.mappings.find((item) => item.id === mappingId)
    if (mapping === undefined) throw new Error('映射不存在')
    const host = this.store.host(mapping.hostId)
    if (host === undefined) throw new Error('主机已被删除')
    const clean = relPosix(rel)
    if (clean === '') throw new Error('缺少文件路径')
    const info = await this.transfer.downloadFile(
      host,
      joinRemote(mapping.remoteRoot, clean),
      join(mapping.localRoot, clean),
    )
    this.store.setBaseline(sessionId, `${mappingId}:${clean}`, {
      localMtimeMs: info.mtimeMs,
      remoteMtimeMs: info.mtimeMs,
      size: info.size,
    })
    return { rel: clean, size: info.size, mtimeMs: info.mtimeMs }
  }

  /** Wait until the queue drains (used by the tool and by tests). */
  async flush(sessionId, { timeoutMs = 30000 } = {}) {
    const session = this.#session(sessionId)
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const busy = [...session.queue.values()].some((task) => task.state === 'queued' || task.state === 'uploading')
      if (!busy) return this.list(sessionId)
      if (Date.now() > deadline) throw new Error('同步队列在超时前未完成')
      await sleep(120)
    }
  }

  /** First mapping of a session (host resolution for tools). */
  primaryMapping(sessionId) {
    return this.#session(sessionId).mappings.find((mapping) => mapping.enabled !== false)
  }

  /** Close every watcher (plugin unload). */
  async dispose() {
    this.#debounce.dispose()
    for (const session of this.#sessions.values()) {
      for (const watcher of session.watchers.values()) await watcher.close().catch(() => {})
      session.watchers.clear()
    }
    this.#sessions.clear()
  }
}

/** Persistable shape: drop fields the engine added at runtime. */
function stripRuntime(mapping) {
  return { ...mapping }
}

/** POSIX-normalize a relative path fragment from `path.relative`. */
function relPosix(fragment) {
  return toLocalPath(fragment).replace(/^\.\//, '').replace(/^\/+/, '')
}
