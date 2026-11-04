/**
 * Transport test against an in-process ssh2 server.
 *
 * Covers the parts of the pool that a unit test cannot: handshake, password
 * auth, exec output collection, PTY channel wiring, host-key pinning (TOFU), and
 * the error classification the UI branches on. SFTP is not implemented by the
 * fake server — that path needs a real host (see `scripts/check-ssh.mjs`).
 *
 * Run: `node test/ssh.mjs`
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { SshPool } from '../src/ssh/pool.js'

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

pool.dispose()
bad.dispose()
pinned.dispose()
server.close()

console.log('ssh: ok (handshake, exec, pty channel, TOFU pin, auth + host-key errors)')
process.exit(0)
