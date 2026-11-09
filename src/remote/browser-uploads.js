import { randomUUID } from 'node:crypto'
import { ApiError } from '../wire.js'
import { call } from '../util.js'
import { renameRemote } from './publish.js'

export const UPLOAD_CHUNK_BYTES = 256 * 1024

/** Bounded browser requests write a private SFTP sibling, never the destination. */
export class BrowserUploads {
  entries = new Map()
  disposed = false

  constructor(pool, { ttlMs = 15 * 60 * 1000 } = {}) {
    this.pool = pool
    this.ttlMs = ttlMs
    this.timer = setInterval(() => { void this.expire() }, Math.min(ttlMs, 60000))
    this.timer.unref?.()
  }

  async begin(host, sessionId, path, size) {
    if (this.disposed) throw new ApiError('upload-closed', '上传服务已停止', 503)
    if (!Number.isSafeInteger(size) || size < 0) throw new ApiError('bad-size', '文件大小无效')
    if (this.entries.size >= 8) throw new ApiError('upload-busy', '同时上传任务过多', 429)
    const uploadId = randomUUID()
    const entry = { hostId: host.id, sessionId, path, size, offset: 0, touched: Date.now(), busy: true }
    this.entries.set(uploadId, entry)
    try {
      entry.sftp = await this.pool.sftp(host)
      entry.tmp = `${path}.dsh-tmp-${uploadId}`
      entry.handle = await call(entry.sftp, 'open', entry.tmp, 'wx', { mode: 0o644 })
      entry.created = true
      if (this.disposed) throw new ApiError('upload-closed', '上传服务已停止', 503)
      return { uploadId, chunkBytes: UPLOAD_CHUNK_BYTES }
    } catch (error) {
      await this.cleanup(uploadId, entry)
      throw error
    } finally { entry.busy = false }
  }

  async operate(hostId, sessionId, uploadId, task) {
    const entry = this.entries.get(uploadId)
    if (!entry || entry.hostId !== hostId || entry.sessionId !== sessionId) {
      throw new ApiError('upload-not-found', '上传任务不存在或已过期', 404)
    }
    if (entry.busy) throw new ApiError('upload-busy', '上传请求正在处理中', 409)
    entry.busy = true
    entry.touched = Date.now()
    try { return await task(entry) }
    catch (error) { await this.cleanup(uploadId, entry); throw error }
    finally {
      entry.busy = false
      entry.touched = Date.now()
      if (this.disposed) await this.cleanup(uploadId, entry)
    }
  }

  chunk(hostId, sessionId, uploadId, offset, data) {
    return this.operate(hostId, sessionId, uploadId, async (entry) => {
      if (offset !== entry.offset) throw new ApiError('upload-offset', '上传分块顺序不正确', 409)
      if (typeof data !== 'string' || data.length === 0 || data.length > Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4
        || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
        throw new ApiError('bad-chunk', '上传分块无效或过大')
      }
      const buffer = Buffer.from(data, 'base64')
      if (buffer.toString('base64') !== data || buffer.length > UPLOAD_CHUNK_BYTES || entry.offset + buffer.length > entry.size) {
        throw new ApiError('bad-chunk', '上传分块超过文件大小')
      }
      await call(entry.sftp, 'write', entry.handle, buffer, 0, buffer.length, entry.offset)
      entry.offset += buffer.length
      return { offset: entry.offset }
    })
  }

  finish(hostId, sessionId, uploadId) {
    return this.operate(hostId, sessionId, uploadId, async (entry) => {
      if (entry.offset !== entry.size) throw new ApiError('upload-incomplete', '文件未完整接收', 409)
      await call(entry.sftp, 'close', entry.handle)
      entry.handle = undefined
      const attrs = await call(entry.sftp, 'stat', entry.tmp)
      if (attrs.size !== entry.size || this.disposed) throw new ApiError('upload-incomplete', '上传已中止或文件大小不符', 409)
      await renameRemote(entry.sftp, entry.tmp, entry.path)
      this.entries.delete(uploadId)
      return { path: entry.path, size: entry.size }
    })
  }

  abort(hostId, sessionId, uploadId) {
    return this.operate(hostId, sessionId, uploadId, async (entry) => {
      await this.cleanup(uploadId, entry)
      return { aborted: true }
    })
  }

  async cleanup(uploadId, entry) {
    this.entries.delete(uploadId)
    if (entry.handle !== undefined) {
      await call(entry.sftp, 'close', entry.handle).catch(() => {})
      entry.handle = undefined
    }
    if (entry.created) await call(entry.sftp, 'unlink', entry.tmp).catch(() => {})
  }

  async expire() {
    await Promise.all([...this.entries].filter(([, e]) => !e.busy && Date.now() - e.touched >= this.ttlMs)
      .map(([id, entry]) => this.cleanup(id, entry)))
  }

  async dispose() {
    this.disposed = true
    clearInterval(this.timer)
    await Promise.all([...this.entries].filter(([, e]) => !e.busy).map(([id, entry]) => this.cleanup(id, entry)))
  }
}
