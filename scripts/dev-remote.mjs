/**
 * A throwaway SSH server for trying the plugin without a real remote.
 *
 * `exec` runs through the local `sh`, so the commands the host half builds
 * (`rg …`, `grep -rInZ …`, `printf %s "$HOME"`) are exercised for real —
 * quoting bugs, missing flags and pipeline trimming all show up here instead of
 * on someone's server. SFTP is read-only and maps `/x/y` to `<root>/x/y`, which
 * is all the browser and the search-result jump need.
 *
 * Usage:
 *   node scripts/dev-remote.mjs [root] [port]
 *   node scripts/dev-remote.mjs ./tmp-project 2202
 *
 * Then add a host `127.0.0.1:2202` with any user and any password.
 */
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import ssh2 from 'ssh2'

// `ssh2` is CommonJS and its package exports only the root, so the server class
// comes off the default import and the SFTP constants are spelled out here
// rather than reaching into `ssh2/lib/protocol/SFTP.js` (not an exported path).
const { Server } = ssh2
const STATUS_CODE = { OK: 0, EOF: 1, NO_SUCH_FILE: 2, PERMISSION_DENIED: 3, FAILURE: 4 }
const OPEN_MODE = { READ: 0x1, WRITE: 0x2, APPEND: 0x4, CREAT: 0x8, TRUNC: 0x10, EXCL: 0x20 }
const ROOT = path.resolve(process.argv[2] ?? process.cwd())
const PORT = Number(process.argv[3] ?? 2202)
const HOST = '127.0.0.1'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

/**
 * Translate a remote path into a real one.
 *
 * The shell and SFTP must agree on the path space, otherwise `grep` searches a
 * different tree than the file browser shows. On Windows the shell here is Git
 * Bash, which spells `C://x` as `/c/x`, so that form is accepted verbatim and
 * everything else is resolved as a plain path. Access stays confined to ROOT.
 */
function resolvePath(remote) {
  const raw = String(remote ?? '')
  if (raw === '' || raw === '/' || raw === '.') return ROOT
  const msys = process.platform === 'win32' ? /^\/([A-Za-z])\/(.*)$/.exec(raw) : null
  const local = path.resolve(msys === null ? raw : `${msys[1].toUpperCase()}:/${msys[2]}`)
  if (local !== ROOT && !local.startsWith(ROOT + path.sep)) {
    throw Object.assign(new Error('outside root'), { code: 'eperm' })
  }
  return local
}

/** POSIX attributes for one local path. */
function attrsOf(local) {
  const stat = fs.statSync(local)
  return {
    mode: stat.mode,
    uid: stat.uid ?? 1000,
    gid: stat.gid ?? 1000,
    size: stat.size,
    atime: Math.floor(stat.atimeMs / 1000),
    mtime: Math.floor(stat.mtimeMs / 1000),
  }
}

/** Directory listing in the shape ssh2 expects (`filename` + `longname` + attrs). */
function listDir(local) {
  return fs.readdirSync(local, { withFileTypes: true }).map((entry) => {
    const full = path.join(local, entry.name)
    let attrs
    try {
      attrs = attrsOf(full)
    } catch {
      attrs = { mode: 0o100644, uid: 1000, gid: 1000, size: 0, atime: 0, mtime: 0 }
    }
    return { filename: entry.name, longname: `${entry.name}`, attrs }
  })
}

/** Map SFTP open flags onto `fs.open` mode strings. */
function flagsOf(flags) {
  if (flags & OPEN_MODE.WRITE) return flags & OPEN_MODE.APPEND ? 'a' : 'r+'
  return 'r'
}

/** A read-only SFTP subsystem rooted at ROOT. */
function attachSftp(sftp) {
  const handles = new Map()
  let counter = 0
  const fail = (reqid, error) => {
    const missing = error?.code === 'ENOENT'
    sftp.status(reqid, missing ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE)
  }
  // The handle we hand back is our own id; `sftp.handle` must be answered with
  // the *request* id, not the handle value, or the client waits forever.
  const open = (reqid, value) => {
    counter += 1
    handles.set(counter, value)
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32BE(counter, 0)
    sftp.handle(reqid, buffer)
  }
  const get = (handle) => handles.get(handle.readUInt32BE(0))

  sftp.on('REALPATH', (reqid, remote) => {
    try {
      const clean = path.posix.normalize(`/${String(remote).replace(/^\/+/, '')}`)
      sftp.name(reqid, [{ filename: clean, longname: clean, attrs: attrsOf(resolvePath(remote)) }])
    } catch {
      sftp.name(reqid, [{ filename: '/', longname: '/', attrs: {} }])
    }
  })

  sftp.on('STAT', (reqid, remote) => {
    try {
      sftp.attrs(reqid, attrsOf(resolvePath(remote)))
    } catch (error) { fail(reqid, error) }
  })

  sftp.on('LSTAT', (reqid, remote) => {
    try {
      sftp.attrs(reqid, attrsOf(resolvePath(remote)))
    } catch (error) { fail(reqid, error) }
  })

  sftp.on('FSTAT', (reqid, handle) => {
    try {
      const entry = get(handle)
      sftp.attrs(reqid, attrsOf(entry.local))
    } catch (error) { fail(reqid, error) }
  })

  sftp.on('OPENDIR', (reqid, remote) => {
    try {
      const local = resolvePath(remote)
      open(reqid, { kind: 'dir', entries: listDir(local) })
    } catch (error) { fail(reqid, error) }
  })

  sftp.on('READDIR', (reqid, handle) => {
    const entry = get(handle)
    if (entry === undefined || entry.kind !== 'dir') {
      sftp.status(reqid, STATUS_CODE.FAILURE)
      return
    }
    // The whole listing goes in one packet; the next call reports EOF, which is
    // how ssh2's client knows the directory ended.
    if (entry.done === true) {
      sftp.status(reqid, STATUS_CODE.EOF)
      return
    }
    entry.done = true
    sftp.name(reqid, entry.entries)
  })

  sftp.on('OPEN', (reqid, remote, flags) => {
    try {
      const local = resolvePath(remote)
      const fd = fs.openSync(local, flagsOf(flags))
      open(reqid, { kind: 'file', local, fd })
    } catch (error) { fail(reqid, error) }
  })

  sftp.on('READ', (reqid, handle, offset, length) => {
    const entry = get(handle)
    if (entry === undefined || entry.kind !== 'file') {
      sftp.status(reqid, STATUS_CODE.FAILURE)
      return
    }
    const buffer = Buffer.alloc(length)
    const read = fs.readSync(entry.fd, buffer, 0, length, offset)
    if (read === 0) sftp.status(reqid, STATUS_CODE.EOF)
    else sftp.data(reqid, buffer.subarray(0, read))
  })

  sftp.on('CLOSE', (reqid, handle) => {
    const entry = get(handle)
    if (entry?.fd !== undefined) {
      try { fs.closeSync(entry.fd) } catch { /* already gone */ }
    }
    handles.delete(handle.readUInt32BE(0))
    sftp.status(reqid, STATUS_CODE.OK)
  })

  sftp.on('WRITE', (reqid) => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED))
  sftp.on('MKDIR', (reqid) => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED))
  sftp.on('REMOVE', (reqid) => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED))
  sftp.on('RMDIR', (reqid) => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED))
  sftp.on('RENAME', (reqid) => sftp.status(reqid, STATUS_CODE.PERMISSION_DENIED))
  sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
}

const server = new Server({ hostKeys: [privateKey] }, (client) => {
  client.on('error', () => {})
  client.on('authentication', (auth) => {
    // Any credentials work: this is a sandbox, not a service.
    if (auth.method === 'password' || auth.method === 'keyboard-interactive') auth.accept()
    else auth.reject(['password', 'keyboard-interactive'])
  })
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty?.())
      session.on('window-change', (acceptWindow) => acceptWindow?.())
      session.on('env', (acceptEnv) => acceptEnv?.())

      session.on('exec', (acceptExec, rejectExec, info) => {
        const stream = acceptExec()
        const child = spawn('sh', ['-c', info.command], {
          cwd: ROOT,
          env: { ...process.env, HOME: ROOT, SHELL: '/bin/sh' },
        })
        // Write manually instead of `pipe`: piping would `end()` the channel the
        // moment stdout closes, and an `exit()` afterwards lands on a dead
        // channel. One explicit exit + end keeps the protocol clean across
        // repeated execs on the same connection.
        child.stdout.on('data', (chunk) => stream.write(chunk))
        child.stderr.on('data', (chunk) => stream.stderr.write(chunk))
        child.on('close', (code) => {
          stream.exit(code ?? 0)
          stream.end()
        })
        stream.on('close', () => child.kill())
      })

      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        const child = spawn('sh', [], {
          cwd: ROOT,
          env: { ...process.env, HOME: ROOT, SHELL: '/bin/sh', TERM: 'xterm-256color' },
        })
        child.stdout.pipe(stream)
        child.stderr.pipe(stream.stderr)
        stream.pipe(child.stdin)
        child.on('close', (code) => {
          stream.exit(code ?? 0)
          stream.end()
        })
        stream.on('close', () => child.kill())
      })

      session.on('sftp', (acceptSftp) => attachSftp(acceptSftp()))
    })
  })
})

server.listen(PORT, HOST, () => {
  console.log(`dev-remote: ssh://${HOST}:${PORT}  root=${ROOT}  (any user, any password)`)
})

const shutdown = () => server.close(() => process.exit(0))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
