/**
 * File transfer between the local workspace and a remote host.
 *
 * `fastPut`/`fastGet` stream in chunks with a small concurrency window, so a
 * 200 MB artifact never lands in this process's heap. Tree transfers walk with
 * a shared include/exclude predicate (`sync/mapping.js`) and create remote
 * directories on demand, so an upload after a local `mkdir` needs no manual
 * step. Progress is reported per file and in aggregate for the queue UI.
 * @module dsh-remote-ssh/remote/transfer
 */
import { createReadStream } from 'node:fs'
import { mkdir, opendir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { RemoteError } from '../ssh/pool.js'
import { call, dirnameRemote, formatBytes, joinRemote } from '../util.js'

/** Directory/file walk over the local root, filtered by the mapping matcher. */
async function* walkLocal(root, matcher, rel = '') {
  let handle
  try {
    handle = await opendir(rel === '' ? root : join(root, rel))
  } catch {
    return
  }
  for await (const entry of handle) {
    const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
    if (!matcher(childRel)) continue
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

  /** Stream one local file to a remote path, creating its directory first. */
  async uploadFile(host, localPath, remotePath, { mode, concurrency = 4 } = {}) {
    const sftp = await this.pool.sftp(host)
    const local = await stat(localPath)
    if (!local.isFile()) throw new RemoteError('not-a-file', `${localPath} 不是文件`, 400)
    await this.files.mkdir(host, dirnameRemote(remotePath)).catch(() => {})
    const tmp = `${remotePath}.dsh-tmp-${Date.now().toString(36)}`
    try {
      await new Promise((resolve, reject) => {
        sftp.fastPut(localPath, tmp, { concurrency, chunkSize: 32768 }, (error) => {
          if (error) reject(new RemoteError('upload-failed', `上传失败 ${remotePath}：${error.message}`, 502))
          else resolve()
        })
      })
      try {
        await call(sftp, 'rename', tmp, remotePath)
      } catch {
        await call(sftp, 'unlink', remotePath).catch(() => {})
        await call(sftp, 'rename', tmp, remotePath)
      }
      const bits = mode ?? ((local.mode & 0o111) !== 0 ? 0o755 : 0o644)
      await call(sftp, 'chmod', remotePath, bits).catch(() => {})
    } catch (error) {
      await call(sftp, 'unlink', tmp).catch(() => {})
      throw error
    }
    const remote = await this.files.stat(host, remotePath)
    return { path: remotePath, size: local.size, mtimeMs: remote?.mtimeMs ?? Date.now(), mode: remote?.mode }
  }

  /** Stream one remote file into a local path. */
  async downloadFile(host, remotePath, localPath) {
    const sftp = await this.pool.sftp(host)
    const remote = await this.files.stat(host, remotePath)
    if (remote === undefined) throw new RemoteError('not-found', `远端不存在：${remotePath}`, 404)
    if (remote.type === 'dir') throw new RemoteError('is-dir', `${remotePath} 是目录，请用 downloadTree`, 400)
    await mkdir(dirname(localPath), { recursive: true })
    await new Promise((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, { concurrency: 4, chunkSize: 32768 }, (error) => {
        if (error) reject(new RemoteError('download-failed', `下载失败 ${remotePath}：${error.message}`, 502))
        else resolve()
      })
    })
    const local = await stat(localPath).catch(() => undefined)
    return { path: localPath, size: local?.size ?? remote.size, mtimeMs: local?.mtimeMs ?? Date.now() }
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

  /** One-line transfer summary for tool output. */
  static summarize(result) {
    const head = `${result.files} 个文件 · ${formatBytes(result.bytes)}`
    if (result.failed.length === 0) return head
    return `${head}（${result.failed.length} 个失败，首个：${result.failed[0].rel} — ${result.failed[0].message}）`
  }
}

/** Re-exported for callers that stream a single local file without a tree walk. */
export { createReadStream }
