/**
 * Transport test against an in-process ssh2 server.
 *
 * Covers the parts of the pool that a unit test cannot: handshake, password
 * auth, exec output collection, PTY channel wiring, host-key pinning (TOFU), and
 * the error classification the UI branches on. SFTP is not implemented by the
 * fake server — that path needs a real host (see `scripts/check-ssh.mjs`).
 *
 * Run: `node test/ssh.mjs`         — against `src/` (imports `ssh2` normally)
 *      `node test/ssh.mjs --bundle` — against `lib/server.mjs`, where `ssh2`
 *                                        has been inlined by esbuild
 *
 * The second form is the one that matters for installs: the published package
 * ships no `dependencies`, so if the inlined copy of `ssh2` cannot complete a
 * handshake, users find out instead of us.
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import ssh2 from 'ssh2'

const bundle = process.argv.includes('--bundle') || process.env.RS_BUNDLE === '1'
const { SshPool } = await import(bundle ? '../lib/server.mjs' : '../src/ssh/pool.js')
const label = bundle ? 'bundle' : 'src'

const { Server } = ssh2

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

const server = new Server({ hostKeys: [privateKey] }, (client) => {
  // A rejected handshake is the point of two assertions below; the fake server
  // must not crash on the client-side disconnect that follows.
  client.on('error', () => {})
  client.on('authentication', (auth) => {
    if (auth.method === 'password' && auth.username === 'u' && auth.password === 'p') auth.accept()
    else auth.reject(['password'])
  })
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (acceptPty) => acceptPty?.())
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec()
        stream.write(`ran:${info.command}\n`)
        stream.stderr.write('stderr-line\n')
        stream.exit(0)
        stream.end()
      })
      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        stream.write('welcome\r\n')
        stream.on('data', (chunk) => stream.write(`echo:${chunk.toString()}`))
        stream.on('end', () => stream.close())
      })
    })
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const base = {
  id: 'test-host',
  name: 'test',
  host: '127.0.0.1',
  port,
  user: 'u',
  auth: { type: 'password', password: 'p' },
}

const fingerprints = []
const pool = new SshPool({
  onFingerprint: (hostId, fingerprint) => fingerprints.push({ hostId, fingerprint }),
})

/* exec over a real channel */
const execResult = await pool.exec(base, 'uname -s')
assert.equal(execResult.stdout, 'ran:uname -s\n')
assert.equal(execResult.stderr, 'stderr-line\n')
assert.equal(execResult.code, 0)
assert.equal(pool.status('test-host'), 'connected')

/* the pin was recorded on first connect (TOFU) */
assert.equal(fingerprints.length, 1)
assert.match(fingerprints[0].fingerprint, /^SHA256:/)

/* PTY shell channel */
const channel = await pool.channel(base, { cols: 80, rows: 24 })
const banner = await new Promise((resolve) => channel.once('data', (chunk) => resolve(chunk.toString())))
assert.equal(banner, 'welcome\r\n')
channel.write('ls\n')
const echoed = await new Promise((resolve) => channel.once('data', (chunk) => resolve(chunk.toString())))
assert.equal(echoed, 'echo:ls\n')
channel.close()

/* a changed host key is refused before authentication */
const pinned = new SshPool({})
pinned.close('pinned')
await assert.rejects(
  () => pinned.ensure({ ...base, id: 'pinned', fingerprint: 'SHA256:not-the-real-one' }),
  (error) => {
    assert.equal(error.code, 'host-key-changed')
    return true
  },
)

/* wrong password is classified for the UI */
const bad = new SshPool({})
await assert.rejects(
  () => bad.ensure({ ...base, id: 'bad', auth: { type: 'password', password: 'wrong' } }),
  (error) => {
    assert.equal(error.code, 'auth-failed')
    return true
  },
)
assert.equal(bad.status('bad'), 'error')

/* a second ensure() reuses the live client instead of reconnecting */
const clientA = await pool.ensure(base)
const clientB = await pool.ensure(base)
assert.equal(clientA, clientB)

/* A failed attempt is retried, not replayed: the record is `error`, so the next
   ensure() starts a fresh one. */
await bad.ensure({ ...base, id: 'bad', auth: { type: 'password', password: 'p' } })
assert.equal(bad.status('bad'), 'connected')

/* Issue #5: a *configuration* error must not claim the connection slot.
   Opening the panel against a password host with no secret on hand made a
   background attempt that threw inside `#options`; the record stayed on
   `connecting` with an already-rejected promise, so the later attempt that did
   carry the password was answered by replaying `请输入密码` — the password was on
   the wire and the user was told to type one. */
const retry = new SshPool({})
await assert.rejects(
  () => retry.ensure({ ...base, id: 'retry', auth: { type: 'password' } }),
  (error) => {
    assert.equal(error.code, 'bad-password')
    return true
  },
)
assert.equal(retry.status('retry'), 'disconnected', 'a missing password must leave the slot free')
await retry.ensure({ ...base, id: 'retry', auth: { type: 'password', password: 'p' } })
assert.equal(retry.status('retry'), 'connected', 'the same host must connect once the password arrives')

/* --- ssh config: `Include` globbing without `node:fs.globSync` --------------

   `globSync` landed in Node 22 while `engines` promises Node 20, and importing a
   missing named export fails at *load* time — so on Node 20 the plugin did not
   even start, and no local run could catch it (the dev machine is on 22). CI on
   the oldest supported Node caught it; this section keeps it caught without
   needing that runner. The helper always comes from `src/`, in both modes: it is
   a pure path function and bundling it changes nothing but the import path. */
const { expandGlob } = await import('../src/ssh/config.js')

const cfgRoot = mkdtempSync(join(tmpdir(), 'dsh-ssh-cfg-'))
mkdirSync(join(cfgRoot, 'config.d'), { recursive: true })
writeFileSync(join(cfgRoot, 'config.d', '01-base'), 'Host a\n  HostName 10.0.0.1\n')
writeFileSync(join(cfgRoot, 'config.d', '02-extra'), 'Host b\n  HostName 10.0.0.2\n')
writeFileSync(join(cfgRoot, 'config.d', 'notes.txt'), 'not a config\n')

assert.deepEqual(
  expandGlob('config.d/*', cfgRoot).map((path) => basename(path)).sort(),
  ['01-base', '02-extra', 'notes.txt'],
  'a bare star matches every entry',
)
assert.deepEqual(
  expandGlob('config.d/0*', cfgRoot).map((path) => basename(path)).sort(),
  ['01-base', '02-extra'],
  'a prefix star narrows the set',
)
assert.deepEqual(
  expandGlob('config.d/?otes.txt', cfgRoot).map((path) => basename(path)),
  ['notes.txt'],
  '? matches exactly one character',
)
assert.deepEqual(
  expandGlob(join(cfgRoot, 'config.d', '01-*'), cfgRoot).map((path) => basename(path)),
  ['01-base'],
  'an absolute pattern ignores cwd',
)
assert.deepEqual(expandGlob('nowhere.d/*', cfgRoot), [], 'no match is an empty list, not a throw')
assert.deepEqual(expandGlob('', cfgRoot), [], 'an empty pattern matches nothing')
rmSync(cfgRoot, { recursive: true, force: true })

pool.dispose()
bad.dispose()
pinned.dispose()
retry.dispose()
server.close()

console.log(`ssh[${label}]: ok (handshake, exec, pty channel, TOFU pin, auth + host-key errors, issue #5 retry, Include glob)`)
process.exit(0)
