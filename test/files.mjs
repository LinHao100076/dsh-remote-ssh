/**
 * File-layer test over an in-memory SFTP stub.
 *
 * Exercises the logic this plugin owns — entry typing and ordering, binary and
 * size guards, stale-write detection, temp-file + rename publication, and error
 * codes — without an SSH server. The wire protocol itself is ssh2's job; use
 * `scripts/check-ssh.mjs` against a real host for that.
 *
 * Run: `node test/files.mjs`
 */
import assert from 'node:assert/strict'
import { RemoteFiles } from '../src/remote/files.js'
import { MemorySftp } from './helpers/memory-sftp.mjs'

const sftp = new MemorySftp()
sftp.mkdirs('/srv', '/srv/app')
sftp.put('/srv/app/main.ts', 'export const port = 8080\n')
sftp.put('/srv/app/README.md', '# app\n')
sftp.put('/srv/app/logo.bin', Buffer.from([0, 1, 2, 3]))
const executed = []
const pool = {
  sftp: async () => sftp,
  exec: async (_host, command) => {
    executed.push(command)
    if (command.includes('uname -sr')) {
      return { stdout: 'Linux 6.1.0\n/bin/bash\n/home/u\n/usr/bin/tmux\n', stderr: '', code: 0 }
    }
    return { stdout: '', stderr: '', code: 0 }
  },
}
const files = new RemoteFiles(pool)
const host = { id: 'h1', name: 'test' }

/* listing: directories first, then names, with typed rows */
const entries = await files.list(host, '/srv/app')
assert.deepEqual(entries.map((entry) => entry.name), ['main.ts', 'README.md', 'logo.bin'].sort((a, b) => a.localeCompare(b)))
assert.equal(entries[0].type, 'file')
assert.equal(entries.find((entry) => entry.name === 'main.ts').path, '/srv/app/main.ts')
assert.equal(entries.find((entry) => entry.name === 'main.ts').modeText, 0o644)

/* text read + guards */
const text = await files.readText(host, '/srv/app/main.ts')
assert.match(text.text, /port = 8080/)
await assert.rejects(() => files.readText(host, '/srv/app/logo.bin'), (error) => error.code === 'binary')
await assert.rejects(() => files.readText(host, '/srv/app/missing.ts'), (error) => error.code === 'not-found')
await assert.rejects(
  () => files.readText(host, '/srv/app/main.ts', { maxBytes: 4 }),
  (error) => error.code === 'too-large',
)

/* atomic write: temp file never survives, content and mtime move forward */
const before = await files.stat(host, '/srv/app/main.ts')
const written = await files.writeText(host, '/srv/app/main.ts', 'export const port = 9090\n')
assert.ok(written.mtimeMs >= before.mtimeMs)
assert.equal(sftp.entries.get('/srv/app/main.ts').buffer.toString('utf8'), 'export const port = 9090\n')
assert.equal([...sftp.entries.keys()].some((key) => key.includes('.dsh-tmp-')), false, 'no temp file is left behind')

/* stale guard: an expected mtime that no longer matches is refused */
await assert.rejects(
  () => files.writeText(host, '/srv/app/main.ts', 'x', { expectedMtimeMs: 1 }),
  (error) => error.code === 'stale',
)

/* directories are created with parents, and existing ones are tolerated */
await files.mkdir(host, '/srv/app/deep/nested/dir')
assert.ok(sftp.dirs.has('/srv/app/deep/nested/dir'))
await files.mkdir(host, '/srv/app/deep')

/* Existing files and arbitrary SFTP mkdir failures must not look successful. */
const originalMkdir = sftp.mkdir.bind(sftp)
sftp.mkdir = (path, options, cb) => {
  if (path.endsWith('/main.ts')) return cb(Object.assign(new Error('not a directory'), { code: 4 }))
  if (path.endsWith('/blocked')) return cb(Object.assign(new Error('disk full'), { code: 4 }))
  return originalMkdir(path, options, cb)
}
await assert.rejects(() => files.mkdir(host, '/srv/app/blocked'))
await assert.rejects(() => files.mkdir(host, '/srv/app/main.ts'))
assert.equal(sftp.dirs.has('/srv/app/blocked'), false)
sftp.mkdir = originalMkdir

/* rename + remove */
await files.rename(host, '/srv/app/README.md', '/srv/app/docs/README.md')
assert.ok(sftp.entries.has('/srv/app/docs/README.md'))
assert.equal(sftp.entries.has('/srv/app/README.md'), false)

const removed = await files.remove(host, '/srv/app/logo.bin')
assert.equal(removed.removed, true)
assert.equal(sftp.entries.has('/srv/app/logo.bin'), false)

const recursive = await files.remove(host, '/srv/app/deep', { recursive: true })
assert.equal(recursive.removed, true)
assert.match(executed.at(-1), /^rm -rf -- '\/srv\/app\/deep'$/)

/* environment probe is cached per host */
const info = await files.info(host)
assert.equal(info.tmux, true)
assert.equal(info.kernel, 'Linux 6.1.0')
assert.equal(info.shell, '/bin/bash')
assert.equal(info.home, '/home/u')
assert.equal(await files.info(host), info)

console.log('files: ok (listing, text guards, atomic write, stale guard, mkdir, rename, remove)')
