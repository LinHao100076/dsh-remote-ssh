/**
 * A throwaway SSH server for trying the plugin without a real remote.
 *
 * `exec` runs through the local `sh`, so the commands the host half builds
 * (`rg …`, `grep -rInZ …`, `printf %s "$HOME"`) are exercised for real —
 * quoting bugs, missing flags and pipeline trimming all show up here instead of
 * on someone's server. SFTP is read-only and maps `/x/y` to `<root>/x/y`, which
 * is all the browser and the search-result jump need.
 *
 * Forwarding is real too: `direct-tcpip` connects out from here (so `-L` and `-D`
 * land wherever the target really is), and `tcpip-forward` opens a listener on
 * this side (so `-R` sends traffic back to the client). Point a rule at a local
 * echo service and all three shapes can be tried without a server.
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
import { connect as netConnect, createServer as createNetServer } from 'node:net'
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
  // Ancestors of the root stay reachable: a client walking down to the root
  // `mkdir`s each level, and refusing `/home` (or `C://`) would abort that walk
  // even though the directory plainly exists.
  const inside = local === ROOT || local.startsWith(ROOT + path.sep)
  const ancestor = ROOT.startsWith(local + path.sep)
  if (!inside && !ancestor) {
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

/**
 * Map SFTP open flags onto `fs.open` mode strings.
 *
 * Getting this wrong is quiet and confusing: a create-truncate open answered as
 * `r+` fails with ENOENT on a file that is supposed to be created.
 */
function flagsOf(flags) {
  const write = (flags & OPEN_MODE.WRITE) !== 0
  if (!write) return 'r'
  if ((flags & OPEN_MODE.APPEND) !== 0) return 'a'
  if ((flags & (OPEN_MODE.CREAT | OPEN_MODE.TRUNC)) !== 0) return 'w'
  return 'r+'
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

  sftp.on('WRITE', (reqid, handle, offset, data) => {
    const entry = get(handle)
    if (entry === undefined || entry.kind !== 'file') {
      sftp.status(reqid, STATUS_CODE.FAILURE)
      return
    }
    try {
      fs.writeSync(entry.fd, data, 0, data.length, offset)
      sftp.status(reqid, STATUS_CODE.OK)
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE)
    }
  })

  // Failures that mean "it is already there" are reported as FAILURE, not as a
  // permission problem: the client treats a permission error as fatal and an
  // ordinary failure as "fine, it exists".
  sftp.on('MKDIR', (reqid, remote) => {
    try {
      const target = resolvePath(remote)
      // `mkdir C://` fails with EPERM on Windows rather than EEXIST, so existence
      // is checked up front: "already there" must never look like "denied".
      if (fs.existsSync(target)) {
        sftp.status(reqid, STATUS_CODE.FAILURE)
        return
      }
      fs.mkdirSync(target)
      sftp.status(reqid, STATUS_CODE.OK)
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE)
    }
  })

  sftp.on('REMOVE', (reqid, remote) => {
    try {
      fs.unlinkSync(resolvePath(remote))
      sftp.status(reqid, STATUS_CODE.OK)
    } catch { sftp.status(reqid, STATUS_CODE.FAILURE) }
  })

  sftp.on('RMDIR', (reqid, remote) => {
    try {
      fs.rmdirSync(resolvePath(remote))
      sftp.status(reqid, STATUS_CODE.OK)
    } catch { sftp.status(reqid, STATUS_CODE.FAILURE) }
  })

  sftp.on('RENAME', (reqid, from, to) => {
    try {
      const target = resolvePath(to)
      if (fs.existsSync(target)) fs.unlinkSync(target)
      fs.renameSync(resolvePath(from), target)
      sftp.status(reqid, STATUS_CODE.OK)
    } catch { sftp.status(reqid, STATUS_CODE.FAILURE) }
  })

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
    /**
     * Listeners opened on behalf of `ssh -R`, keyed by requested port.
     *
     * They are closed when the connection goes away, exactly like a real sshd
     * drops its forwarded listeners: leaving them would make the second
     * `tcpip-forward` for a port fail as in-use, and the client's reconnect would
     * look broken when it is the server side that leaked.
     */
    const reverseServers = new Map()

    // `-L` and `-D` land here. sshd connects before confirming the channel, so a
    // refused target fails the open — copying that is what lets a SOCKS client
    // see "connection refused" instead of success-then-EOF.
    client.on('tcpip', (accept, reject, info) => {
      const upstream = netConnect({ host: info.destIP, port: info.destPort })
      upstream.once('connect', () => {
        const stream = accept()
        stream.on('error', () => {})
        stream.pipe(upstream).pipe(stream)
      })
      upstream.once('error', () => {
        upstream.destroy()
        reject()
      })
    })

    client.on('request', (accept, reject, name, info) => {
      if (name === 'tcpip-forward') {
        const listener = createNetServer((socket) => {
          socket.on('error', () => {})
          // Argument order is (boundAddr, boundPort, peerAddr, peerPort). The
          // bound pair is what the client matches against its own bookkeeping,
          // so swapping them makes every forwarded channel get rejected.
          client.forwardOut(info.bindAddr, info.bindPort, socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, (error, stream) => {
            if (error) {
              socket.destroy()
              return
            }
            stream.on('error', () => {})
            socket.pipe(stream).pipe(socket)
          })
        })
        listener.once('error', () => { reject?.(); return })
        listener.listen(info.bindPort, info.bindAddr, () => {
          const { port } = listener.address()
          reverseServers.set(info.bindPort, listener)
          console.log(`dev-remote: reverse listener ${info.bindAddr}:${port} → this client`)
          // Port 0 means "pick one for me"; the granted port travels back in the
          // reply, which is the only way the client can learn it.
          if (info.bindPort === 0) accept?.(port)
          else accept?.()
        })
        return
      }
      if (name === 'cancel-tcpip-forward') {
        const listener = reverseServers.get(info.bindPort)
        if (listener === undefined) {
          reject?.()
          return
        }
        reverseServers.delete(info.bindPort)
        listener.close()
        accept?.()
        return
      }
      reject?.()
    })

    client.on('close', () => {
      for (const listener of reverseServers.values()) listener.close()
      reverseServers.clear()
    })

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
