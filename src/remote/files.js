/**
 * SFTP file operations for one remote host.
 *
 * Every mutation lands through a temp sibling + rename so a remote process
 * never observes a half-written file (OpenSSH atomic rename is preferred;
 * failures never unlink an existing destination). Reads are bounded and
 * binary-detected here rather than in the UI, so the client only ever receives
 * text it can render.
 * @module dsh-remote-ssh/remote/files
 */
import { RemoteError } from '../ssh/pool.js'
import { randomUUID } from 'node:crypto'
import { renameRemote } from './publish.js'
import { call, dirnameRemote, joinRemote, looksBinary } from '../util.js'

const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** Map an sftp failure onto a product error code. */
function sftpError(error, path) {
  const code = error?.code
  if (code === 2 || /No such file/i.test(String(error?.message))) {
    return new RemoteError('not-found', `远端不存在：${path}`, 404)
  }
  if (code === 3 || /Permission denied/i.test(String(error?.message))) {
    return new RemoteError('denied', `远端权限不足：${path}`, 403)
  }
  return new RemoteError('sftp-error', `${path}：${error?.message ?? error}`, 502)
}

/** Entry type from a POSIX mode word. */
function typeOf(mode) {
  const kind = mode & S_IFMT
  if (kind === S_IFDIR) return 'dir'
  if (kind === S_IFLNK) return 'link'
  return 'file'
}

export class RemoteFiles {
  /** @type {Map<string, string>} */
  #homes = new Map()
  /** @type {Map<string, object>} */
  #infos = new Map()

  constructor(pool) {
    this.pool = pool
  }

  /** Remote `$HOME` for a host, resolved once per connection. */
  async home(host) {
    const cached = this.#homes.get(host.id)
    if (cached !== undefined) return cached
    const { stdout } = await this.pool.exec(host, 'printf %s "$HOME"', { timeoutMs: 8000 })
    const home = stdout.trim() === '' ? '/' : stdout.trim()
    this.#homes.set(host.id, home)
    return home
  }

  /**
   * One directory listing, directories first then case-insensitive name order.
   * @param {object} host - stored host row.
   * @param {string} path - absolute remote directory.
   * @returns {Promise<Array<object>>} content-free entries.
   */
  async list(host, path) {
    const sftp = await this.pool.sftp(host)
    let entries
    try {
      entries = await call(sftp, 'readdir', path)
    } catch (error) {
      throw sftpError(error, path)
    }
    return entries
      .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
      .map((entry) => {
        const attrs = entry.attrs ?? {}
        const type = typeOf(attrs.mode ?? 0)
        return {
          name: entry.filename,
          path: joinRemote(path, entry.filename),
          type,
          size: attrs.size ?? 0,
          mtimeMs: (attrs.mtime ?? 0) * 1000,
          mode: attrs.mode ?? 0,
          modeText: (attrs.mode ?? 0) & 0o777,
        }
      })
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
        return a.name.localeCompare(b.name, 'en', { numeric: true })
      })
  }

  /** `stat` (follows symlinks); `undefined` when the path is absent. */
  async stat(host, path) {
    const sftp = await this.pool.sftp(host)
    try {
      const attrs = await call(sftp, 'stat', path)
      return {
        path,
        type: typeOf(attrs.mode ?? 0),
        size: attrs.size ?? 0,
        mtimeMs: (attrs.mtime ?? 0) * 1000,
        mode: attrs.mode ?? 0,
      }
    } catch (error) {
      if (sftpError(error, path).code === 'not-found') return undefined
      throw sftpError(error, path)
    }
  }

  /** Read a text file, refusing binaries and oversized payloads explicitly. */
  async readText(host, path, { maxBytes = MAX_TEXT_BYTES } = {}) {
    const sftp = await this.pool.sftp(host)
    const stat = await this.stat(host, path)
    if (stat === undefined) throw new RemoteError('not-found', `远端不存在：${path}`, 404)
    if (stat.type === 'dir') throw new RemoteError('is-dir', `${path} 是目录`, 400)
    if (stat.size > maxBytes) {
      throw new RemoteError('too-large', `文件 ${stat.size} 字节，超过预览上限 ${maxBytes}`, 413, { size: stat.size })
    }
    let buffer
    try {
      buffer = await call(sftp, 'readFile', path)
    } catch (error) {
      throw sftpError(error, path)
    }
    if (looksBinary(buffer)) {
      throw new RemoteError('binary', `${path} 是二进制文件`, 415, { size: stat.size })
    }
    return { text: buffer.toString('utf8'), size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode }
  }

  /**
   * Write text atomically.
   * @param {object} host - stored host row.
   * @param {string} path - target path.
   * @param {string} text - new content.
   * @param {{expectedMtimeMs?: number, mode?: number}} [options] - stale guard and permission bits.
   * @returns {Promise<{mtimeMs: number, size: number}>} the new remote state.
   */
  async writeText(host, path, text, { expectedMtimeMs, mode } = {}) {
    const sftp = await this.pool.sftp(host)
    const current = await this.stat(host, path)
    if (expectedMtimeMs !== undefined && current !== undefined
      && Math.abs(current.mtimeMs - expectedMtimeMs) > 1000) {
      throw new RemoteError('stale', '远端文件已被改动，请先下载或对比', 409, { remoteMtimeMs: current.mtimeMs })
    }
    const buffer = Buffer.from(text, 'utf8')
    const tmp = `${path}.dsh-tmp-${randomUUID()}`
    try {
      await call(sftp, 'writeFile', tmp, buffer, { mode: mode ?? current?.mode ?? 0o644 })
      await renameRemote(sftp, tmp, path)
    } catch (error) {
      await call(sftp, 'unlink', tmp).catch(() => {})
      throw sftpError(error, path)
    }
    const next = await this.stat(host, path)
    return { mtimeMs: next?.mtimeMs ?? Date.now(), size: buffer.length }
  }

  /**
   * Write raw bytes (browser uploads arrive base64-encoded) through the same
   * temp-file + rename path as text writes.
   * @param {object} host - stored host row.
   * @param {string} path - target path.
   * @param {Buffer} buffer - file content.
   * @param {{mode?: number}} [options] - permission bits.
   * @returns {Promise<{path: string, size: number, mtimeMs: number}>} new remote state.
   */
  async writeBytes(host, path, buffer, { mode } = {}) {
    const sftp = await this.pool.sftp(host)
    const tmp = `${path}.dsh-tmp-${randomUUID()}`
    try {
      await call(sftp, 'writeFile', tmp, buffer, { mode: mode ?? 0o644 })
      await renameRemote(sftp, tmp, path)
    } catch (error) {
      await call(sftp, 'unlink', tmp).catch(() => {})
      throw sftpError(error, path)
    }
    const next = await this.stat(host, path)
    return { path, size: buffer.length, mtimeMs: next?.mtimeMs ?? Date.now() }
  }

  /** Create a directory (and missing parents). */
  async mkdir(host, path) {
    const sftp = await this.pool.sftp(host)
    const parts = path.split('/').filter(Boolean)
    let current = path.startsWith('/') ? '' : '.'
    for (const part of parts) {
      current = `${current}/${part}`
      try {
        await call(sftp, 'mkdir', current, { mode: 0o755 })
      } catch (error) {
        const failed = sftpError(error, current)
        if (failed.code === 'denied') throw failed
        // EEXIST / failure on an existing directory is fine.
      }
    }
    return { path }
  }

  /** Remove a file, an empty directory, or (recursive) a whole tree. */
  async remove(host, path, { recursive = false } = {}) {
    const stat = await this.stat(host, path)
    if (stat === undefined) return { removed: false }
    if (stat.type === 'dir') {
      if (recursive) {
        const { code, stderr } = await this.pool.exec(host, `rm -rf -- ${quote(path)}`, { timeoutMs: 60000 })
        if (code !== 0) throw new RemoteError('remove-failed', stderr.trim() || `删除失败：${path}`, 502)
      } else {
        const sftp = await this.pool.sftp(host)
        try {
          await call(sftp, 'rmdir', path)
        } catch (error) {
          throw new RemoteError('not-empty', `目录非空：${path}`, 409)
        }
      }
    } else {
      const sftp = await this.pool.sftp(host)
      try {
        await call(sftp, 'unlink', path)
      } catch (error) {
        throw sftpError(error, path)
      }
    }
    return { removed: true }
  }

  /** Rename or move a path. */
  async rename(host, from, to) {
    const sftp = await this.pool.sftp(host)
    await this.mkdir(host, dirnameRemote(to)).catch(() => {})
    await renameRemote(sftp, from, to)
    return { from, to }
  }

  /** Apply permission bits. */
  async chmod(host, path, mode) {
    const sftp = await this.pool.sftp(host)
    await call(sftp, 'chmod', path, mode)
    return { path, mode }
  }

  /**
   * Remote environment facts used by the UI banner and the terminal decision:
   * kernel, login shell, home, and whether tmux exists.
   */
  async info(host) {
    const cached = this.#infos.get(host.id)
    if (cached !== undefined) return cached
    const { stdout } = await this.pool.exec(
      host,
      'printf "%s\\n" "$(uname -sr)"; printf "%s\\n" "$SHELL"; printf "%s\\n" "$HOME"; command -v tmux || true',
      { timeoutMs: 10000 },
    )
    const [kernel = '', shell = '', home = '', tmuxPath = ''] = stdout.split('\n')
    const info = {
      kernel: kernel.trim(),
      shell: shell.trim(),
      home: home.trim() || '/',
      tmux: tmuxPath.trim() !== '',
      tmuxPath: tmuxPath.trim(),
    }
    this.#infos.set(host.id, info)
    this.#homes.set(host.id, info.home)
    return info
  }

  /** Forget cached facts after a reconnect. */
  forget(hostId) {
    this.#homes.delete(hostId)
    this.#infos.delete(hostId)
  }
}

/** Single-quote for the remote shell (kept local to avoid a util import cycle). */
function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}
