/**
 * File transfer between the local workspace and a remote host.
 *
 * Transfers are chunked by hand rather than handed to `fastPut`/`fastGet`, for
 * one reason: **an interrupted transfer has to be resumable**. Both directions
 * write into a sibling part file and only rename it into place at the end, so
 * the part file's size *is* the resume point — no journal, no metadata that can
 * disagree with reality, and a half-written file never appears under the real
 * name. Chunks are written in order for the same reason: a concurrent writer
 * would leave holes, and `size` would then overstate what is actually on disk.
 *
 * Tree transfers walk with a shared include/exclude predicate
 * (`sync/mapping.js`) and create remote directories on demand. Progress is
 * reported per chunk so a 200 MB artifact shows a moving bar instead of a
 * frozen one.
 * @module dsh-remote-ssh/remote/transfer
 */
import { createReadStream } from 'node:fs'
import { mkdir, open as openLocal, opendir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RemoteError } from '../ssh/pool.js'
import { call, dirnameRemote, formatBytes, joinRemote } from '../util.js'
import { renameRemote } from './publish.js'

/** Chunk size for chunked transfers; large enough to keep round trips rare. */
const CHUNK = 1024 * 1024
/** Suffix shared by every part file, so a tree walk can recognise its own litter. */
const PART_MARK = '.dsh-part-'

/** Whether a path is a leftover part file from a transfer. */
export function isPartPath(path) {
  return String(path).includes(PART_MARK)
}

/** Promise wrapper for `sftp.open`. */
function openHandle(sftp, path, flags) {
  return new Promise((resolve, reject) => {
    sftp.open(path, flags, (error, handle) => (error ? reject(error) : resolve(handle)))
  })
}

/** Promise wrapper for `sftp.close` (never rejects: it runs in `finally`). */
function closeHandle(sftp, handle) {
  return new Promise((resolve) => { sftp.close(handle, () => resolve()) })
}

/** Promise wrapper for `sftp.read`. */
function readHandle(sftp, handle, buffer, length, position) {
  return new Promise((resolve, reject) => {
    sftp.read(handle, buffer, 0, length, position, (error, bytesRead) => {
      if (error) reject(error)
      else resolve(bytesRead)
    })
  })
}

/** Promise wrapper for `sftp.write`. */
function writeHandle(sftp, handle, buffer, length, position) {
  return new Promise((resolve, reject) => {
    sftp.write(handle, buffer, 0, length, position, (error) => (error ? reject(error) : resolve()))
  })
}

/** Directory/file walk over the local root, filtered by the mapping matcher. */
async function* walkLocal(root, matcher, rel = '') {
  let handle
  try {
    handle = await opendir(rel === '' ? root : join(root, rel))
  } catch (error) {
    throw new RemoteError('walk-failed', `无法读取本地目录：${root}：${error.message}`, 400)
  }
  for await (const entry of handle) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (!matcher(childRel, entry.isDirectory())) continue
    if (entry.isDirectory()) yield* walkLocal(root, matcher, childRel)
    else if (entry.isFile()) yield childRel
  }
}

/** Run `task` over `items` with a fixed concurrency window, preserving order. */
async function mapLimit(items, limit, task) {
  const results = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

export class Transfer {
  constructor(pool, files) {
    this.pool = pool
    this.files = files
  }

  /**
   * Stream one local file to a remote path, resuming an interrupted attempt.
   *
   * The part file carries the source's size and mtime in its name, so a resumed
   * attempt only ever continues bytes that came from *this* version: if the
   * local file changed, the fingerprint changes and the stale part is ignored
   * instead of being spliced with new bytes. The rename at the end makes the
   * file appear atomically under its real name.
   * @param {object} host - stored host row.
   * @param {string} localPath - absolute local file.
   * @param {string} remotePath - absolute remote target.
   * @param {{mode?: number, chunkSize?: number, onProgress?: Function, signal?: AbortSignal}} [options] - bounds.
   * @returns {Promise<object>} remote state plus how many bytes were resumed.
   */
  async uploadFile(host, localPath, remotePath, { mode, chunkSize = CHUNK, onProgress, signal } = {}) {
    const sftp = await this.pool.sftp(host)
    const local = await stat(localPath)
    if (!local.isFile()) throw new RemoteError('not-a-file', `${localPath} 不是文件`, 400)
    await this.files.mkdir(host, dirnameRemote(remotePath)).catch(() => {})

    const part = `${remotePath}${PART_MARK}${local.size}-${Math.floor(local.mtimeMs)}`
    const existing = await this.files.stat(host, part).catch(() => undefined)
    let offset = 0
    if (existing !== undefined) {
      if (existing.size <= local.size) offset = existing.size
      // A part that is larger than the source can only be a leftover from a
      // different file content; keeping it would truncate the upload.
      else await call(sftp, 'unlink', part).catch(() => {})
    }
    const resumedFrom = offset

    const handle = await openLocal(localPath, 'r')
    let remoteHandle
    try {
      remoteHandle = await openHandle(sftp, part, offset > 0 ? 'r+' : 'w')
      const buffer = Buffer.allocUnsafe(chunkSize)
      while (offset < local.size) {
        if (signal?.aborted === true) throw new RemoteError('aborted', '传输已取消', 499)
        const length = Math.min(chunkSize, local.size - offset)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        if (bytesRead === 0) throw new RemoteError('source-changed', '上传源文件在传输中发生变化', 409)
        await writeHandle(sftp, remoteHandle, buffer, bytesRead, offset)
        offset += bytesRead
        onProgress?.({ transferred: offset, total: local.size, path: remotePath })
      }
      const after = await handle.stat()
      if (after.size !== local.size || after.mtimeMs !== local.mtimeMs) {
        throw new RemoteError('source-changed', '上传源文件在传输中发生变化', 409)
      }
    } catch (error) {
      throw error instanceof RemoteError
        ? error
        : new RemoteError('upload-failed', `上传失败 ${remotePath}：${error.message}`, 502)
    } finally {
      if (remoteHandle !== undefined) await closeHandle(sftp, remoteHandle)
      await handle.close()
    }

    try {
      if (signal?.aborted === true) throw new RemoteError('aborted', '传输已取消', 499)
      await renameRemote(sftp, part, remotePath)
    } catch (error) {
      // The part stays: the next attempt resumes from it instead of starting over.
      if (error instanceof RemoteError) throw error
      throw new RemoteError('upload-failed', `上传失败 ${remotePath}：${error.message}`, 502)
    }
    const bits = mode ?? ((local.mode & 0o111) !== 0 ? 0o755 : 0o644)
    await call(sftp, 'chmod', remotePath, bits).catch(() => {})
    const remote = await this.files.stat(host, remotePath)
    return { path: remotePath, size: local.size, mtimeMs: remote?.mtimeMs ?? Date.now(), mode: remote?.mode, resumedFrom }
  }

  /**
   * Stream one remote file into a local path, resuming an interrupted attempt.
   * @param {object} host - stored host row.
   * @param {string} remotePath - absolute remote source.
   * @param {string} localPath - absolute local target.
   * @param {{chunkSize?: number, onProgress?: Function, signal?: AbortSignal}} [options] - bounds.
   * @returns {Promise<object>} local state plus how many bytes were resumed.
   */
  async downloadFile(host, remotePath, localPath, { chunkSize = CHUNK, onProgress, signal } = {}) {
    const sftp = await this.pool.sftp(host)
    const remote = await this.files.stat(host, remotePath)
    if (remote === undefined) throw new RemoteError('not-found', `远端不存在：${remotePath}`, 404)
    if (remote.type === 'dir') throw new RemoteError('is-dir', `${remotePath} 是目录，请用 downloadTree`, 400)
    await mkdir(dirname(localPath), { recursive: true })

    const part = `${localPath}${PART_MARK}${remote.size}-${Math.floor(remote.mtimeMs)}`
    let offset = 0
    const existing = await stat(part).catch(() => undefined)
    if (existing !== undefined) {
      if (existing.isFile() && existing.size <= remote.size) offset = existing.size
      else await unlink(part).catch(() => {})
    }
    const resumedFrom = offset

    const remoteHandle = await openHandle(sftp, remotePath, 'r')
    let handle
    try {
      handle = await openLocal(part, offset > 0 ? 'r+' : 'w')
      const buffer = Buffer.allocUnsafe(Math.min(chunkSize, Math.max(remote.size, 1)))
      while (offset < remote.size) {
        if (signal?.aborted === true) throw new RemoteError('aborted', '传输已取消', 499)
        const length = Math.min(chunkSize, remote.size - offset)
        const bytesRead = await readHandle(sftp, remoteHandle, buffer, length, offset)
        if (bytesRead === 0) {
          throw new RemoteError('source-changed', '下载源文件在传输中发生变化', 409)
        }
        await handle.write(buffer, 0, bytesRead, offset)
        offset += bytesRead
        onProgress?.({ transferred: offset, total: remote.size, path: remotePath })
      }
      const after = await this.files.stat(host, remotePath)
      if (after === undefined || after.size !== remote.size || after.mtimeMs !== remote.mtimeMs) {
        throw new RemoteError('source-changed', '下载源文件在传输中发生变化', 409)
      }
    } catch (error) {
      throw error instanceof RemoteError
        ? error
        : new RemoteError('download-failed', `下载失败 ${remotePath}：${error.message}`, 502)
    } finally {
      await closeHandle(sftp, remoteHandle)
      await handle?.close()
    }

    if (signal?.aborted === true) throw new RemoteError('aborted', '传输已取消', 499)
    await rename(part, localPath)
    const local = await stat(localPath).catch(() => undefined)
    return { path: localPath, size: local?.size ?? remote.size, mtimeMs: local?.mtimeMs ?? Date.now(), remoteMtimeMs: remote.mtimeMs, resumedFrom }
  }

  /**
   * Upload a local tree under `remoteRoot`, honoring the mapping matcher.
   * @param {object} host - stored host row.
   * @param {string} localRoot - absolute local directory.
   * @param {string} remoteRoot - absolute remote directory.
   * @param {{matcher: Function, onProgress?: Function, concurrency?: number}} options - walk rules.
   * @returns {Promise<{files: number, bytes: number, failed: Array<object>}>} aggregate result.
   */
  async uploadTree(host, localRoot, remoteRoot, { matcher, onProgress, concurrency = 4 } = {}) {
    const relatives = []
    for await (const rel of walkLocal(localRoot, matcher ?? (() => true))) relatives.push(rel)
    let bytes = 0
    let done = 0
    const failed = []
    const items = []
    await mapLimit(relatives, concurrency, async (rel) => {
      const localPath = join(localRoot, rel)
      const remotePath = joinRemote(remoteRoot, rel)
      try {
        const info = await this.uploadFile(host, localPath, remotePath)
        const local = await stat(localPath).catch(() => undefined)
        bytes += info.size
        done += 1
        items.push({ rel, size: info.size, mtimeMs: info.mtimeMs, localMtimeMs: local?.mtimeMs ?? Date.now() })
        onProgress?.({ done, total: relatives.length, rel, bytes, fileBytes: info.size })
      } catch (error) {
        failed.push({ rel, message: error.message })
        onProgress?.({ done, total: relatives.length, rel, bytes, error: error.message })
      }
    })
    return { files: done, bytes, failed, items }
  }

  /**
   * Download a remote tree into a local directory.
   * @param {object} host - stored host row.
   * @param {string} remotePath - absolute remote directory.
   * @param {string} localRoot - absolute local directory.
   * @param {{depth?: number, onProgress?: Function, skip?: (rel: string) => boolean}} options - bounds.
   */
  async downloadTree(host, remotePath, localRoot, { depth = 0, onProgress, skip } = {}) {
    if (depth > 24) throw new RemoteError('too-deep', '目录层级过深', 400)
    const entries = await this.files.list(host, remotePath)
    let bytes = 0
    let done = 0
    const failed = []
    for (const entry of entries) {
      const rel = entry.name
      if (skip?.(rel)) continue
      // A part file is somebody's unfinished transfer, not content.
      if (isPartPath(rel)) continue
      if (entry.type === 'dir') {
        const nested = await this.downloadTree(host, entry.path, join(localRoot, entry.name), {
          depth: depth + 1,
          onProgress,
          skip,
        })
        bytes += nested.bytes
        done += nested.files
        failed.push(...nested.failed)
        continue
      }
      const localPath = join(localRoot, entry.name)
      try {
        const info = await this.downloadFile(host, entry.path, localPath)
        bytes += info.size
        done += 1
        onProgress?.({ done, rel, bytes, fileBytes: info.size })
      } catch (error) {
        failed.push({ rel, message: error.message })
      }
    }
    return { files: done, bytes, failed }
  }

  /**
   * Delete leftover part files under a remote directory.
   *
   * Sweeping happens here rather than on every upload on purpose: an upload
   * would have to `readdir` its target directory to find strangers, and one
   * listing per file turns a 1000-file push into a thousand directory reads. A
   * part only survives an interruption or a source change, so the mess is small
   * and rare — and the user can see the count before deciding.
   * @param {object} host - stored host row.
   * @param {string} remoteRoot - absolute remote directory.
   * @param {{depth?: number}} [options] - recursion guard.
   * @returns {Promise<{removed: number, bytes: number, failed: number}>} what was swept.
   */
  async cleanParts(host, remoteRoot, { depth = 0 } = {}) {
    if (depth > 24) return { removed: 0, bytes: 0, failed: 0 }
    const entries = await this.files.list(host, remoteRoot).catch(() => [])
    let removed = 0
    let bytes = 0
    let failed = 0
    for (const entry of entries) {
      if (entry.type === 'dir') {
        const nested = await this.cleanParts(host, entry.path, { depth: depth + 1 })
        removed += nested.removed
        bytes += nested.bytes
        failed += nested.failed
        continue
      }
      if (!isPartPath(entry.name)) continue
      try {
        await this.files.remove(host, entry.path)
        removed += 1
        bytes += entry.size
      } catch {
        failed += 1
      }
    }
    return { removed, bytes, failed }
  }

  /** One-line transfer summary for tool output. */
  static summarize(result) {
    const head = `${result.files} 个文件 · ${formatBytes(result.bytes)}`
    if (result.failed.length === 0) return head
    return `${head}（${result.failed.length} 个失败，首个：${result.failed[0].rel} — ${result.failed[0].message}）`
  }
}

/** Re-exported for callers that stream a single local file without a tree walk. */
export { createReadStream }
