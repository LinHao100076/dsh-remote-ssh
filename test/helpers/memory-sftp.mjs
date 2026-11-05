/**
 * In-memory SFTP double, shaped like ssh2's client.
 *
 * Both the file layer and the transfer layer are exercised against this: it
 * implements the callback API the plugin actually calls, including the
 * handle-based `open`/`read`/`write`/`close` path that chunked transfers use.
 * Keeping it in one place means a change to the protocol surface shows up in
 * both suites at once.
 */

/** @param {string|Buffer} content - file body. */
function toBuffer(content) {
  return Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8')
}

export class MemorySftp {
  constructor() {
    this.entries = new Map()
    this.dirs = new Set(['/'])
    this.handles = new Map()
    this.nextHandle = 1
    this.closedHandles = 0
  }

  put(path, content, mtime = Math.floor(Date.now() / 1000)) {
    this.entries.set(path, { buffer: toBuffer(content), mtime, mode: 0o100644 })
  }

  mkdirs(...paths) {
    for (const path of paths) this.dirs.add(path)
  }

  #fail(cb, code = 2) {
    const error = new Error(code === 2 ? 'No such file' : 'Failure')
    error.code = code
    cb(error)
  }

  #slot(handle) {
    const id = Buffer.isBuffer(handle) ? handle.readUInt32BE(0) : handle
    return { id, slot: this.handles.get(id) }
  }

  readdir(path, cb) {
    if (!this.dirs.has(path) && ![...this.entries.keys()].some((key) => key.startsWith(`${path}/`))) {
      this.#fail(cb)
      return
    }
    const seen = new Set()
    const rows = []
    for (const key of [...this.entries.keys(), ...this.dirs]) {
      if (!key.startsWith(`${path}/`)) continue
      const rest = key.slice(path.length + 1)
      if (rest === '' || rest.includes('/')) continue
      if (seen.has(rest)) continue
      seen.add(rest)
      const full = `${path}/${rest}`
      const file = this.entries.get(full)
      rows.push({
        filename: rest,
        attrs: file
          ? { mode: file.mode, size: file.buffer.length, mtime: file.mtime }
          : { mode: 0o040755, size: 0, mtime: 1700000000 },
      })
    }
    cb(undefined, rows)
  }

  stat(path, cb) {
    const file = this.entries.get(path)
    if (file !== undefined) {
      cb(undefined, { mode: file.mode, size: file.buffer.length, mtime: file.mtime })
      return
    }
    if (this.dirs.has(path)) {
      cb(undefined, { mode: 0o040755, size: 0, mtime: 1700000000 })
      return
    }
    this.#fail(cb)
  }

  readFile(path, cb) {
    const file = this.entries.get(path)
    if (file === undefined) { this.#fail(cb); return }
    cb(undefined, file.buffer)
  }

  writeFile(path, data, options, cb) {
    if (typeof options === 'function') { cb = options; options = {} }
    this.entries.set(path, {
      buffer: toBuffer(data),
      mtime: Math.floor(Date.now() / 1000),
      mode: (options?.mode ?? 0o644) | 0o100000,
    })
    cb(undefined)
  }

  rename(from, to, cb) {
    const file = this.entries.get(from)
    if (file === undefined) { this.#fail(cb); return }
    this.entries.delete(from)
    this.entries.set(to, file)
    cb(undefined)
  }

  unlink(path, cb) {
    if (!this.entries.has(path)) { this.#fail(cb); return }
    this.entries.delete(path)
    cb(undefined)
  }

  mkdir(path, options, cb) {
    if (typeof options === 'function') { cb = options }
    if (this.dirs.has(path)) {
      const error = new Error('Failure'); error.code = 4
      cb(error)
      return
    }
    this.dirs.add(path)
    cb(undefined)
  }

  rmdir(path, cb) {
    this.dirs.delete(path)
    cb(undefined)
  }

  chmod(path, mode, cb) { cb(undefined) }

  /* ── handle-based IO, used by chunked transfers ─────────────────────── */

  open(path, flags, cb) {
    const truncate = flags === 'w' || flags === 'w+'
    let file = this.entries.get(path)
    if (truncate) {
      this.entries.set(path, { buffer: Buffer.alloc(0), mtime: Math.floor(Date.now() / 1000), mode: 0o100644 })
      file = this.entries.get(path)
    } else if (file === undefined) {
      this.#fail(cb)
      return
    }
    const id = this.nextHandle
    this.nextHandle += 1
    this.handles.set(id, { path })
    const handle = Buffer.alloc(4)
    handle.writeUInt32BE(id, 0)
    cb(undefined, handle)
  }

  read(handle, buffer, offset, length, position, cb) {
    const { slot } = this.#slot(handle)
    const file = slot === undefined ? undefined : this.entries.get(slot.path)
    if (file === undefined) { this.#fail(cb); return }
    const slice = file.buffer.subarray(position, position + length)
    slice.copy(buffer, offset)
    cb(undefined, slice.length, buffer)
  }

  write(handle, buffer, offset, length, position, cb) {
    const { slot } = this.#slot(handle)
    const file = slot === undefined ? undefined : this.entries.get(slot.path)
    if (file === undefined) { this.#fail(cb); return }
    const needed = position + length
    if (file.buffer.length < needed) {
      const grown = Buffer.alloc(needed)
      file.buffer.copy(grown)
      file.buffer = grown
    }
    buffer.copy(file.buffer, position, offset, offset + length)
    cb(undefined)
  }

  close(handle, cb) {
    const { id } = this.#slot(handle)
    this.handles.delete(id)
    this.closedHandles += 1
    cb(undefined)
  }
}
