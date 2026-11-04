/**
 * Port-forwarding test: a real TCP round-trip through a fake SSH server.
 *
 * Flow under test: local socket → `ForwardManager` listener → `direct-tcpip`
 * channel → ssh2 server → a real echo service. That end-to-end shape is the
 * point — a stub would prove the API surface but not that bytes actually move,
 * and byte plumbing is where forwarders break.
 *
 * Run: `node test/forward.mjs`
 */
import assert from 'node:assert/strict'
import { createServer as createNetServer, connect as netConnect } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ssh2 from 'ssh2'
import { SshPool } from '../src/ssh/pool.js'
import { Store } from '../src/store.js'
import { ForwardManager } from '../src/forward/manager.js'

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

/** Ask the OS for a free port, then release it for the test to claim. */
async function freePort() {
  const probe = createNetServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** One request/response against a local port. */
function roundTrip(port, message) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ port, host: '127.0.0.1' })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`tunnel ${port} timed out`)) }, 5000)
    socket.on('connect', () => socket.write(message))
    socket.on('data', (chunk) => {
      clearTimeout(timer)
      socket.end()
      resolve(chunk.toString())
    })
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

/* ── the "remote" service and the SSH server in front of it ───────────── */

const echo = createNetServer((socket) => {
  socket.on('error', () => {})
  socket.on('data', (chunk) => socket.write(`echo:${chunk}`))
})
await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve))
const echoPort = echo.address().port

const opened = []
const sshServer = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
  client.on('error', () => {})
  client.on('authentication', (auth) => {
    if (auth.method === 'password' && auth.username === 'u' && auth.password === 'p') auth.accept()
    else auth.reject(['password'])
  })
  client.on('ready', () => {
    client.on('tcpip', (accept, reject, info) => {
      opened.push(`${info.destIP}:${info.destPort}`)
      const stream = accept()
      const upstream = netConnect({ port: info.destPort, host: info.destIP })
      upstream.on('connect', () => { stream.pipe(upstream).pipe(stream) })
      upstream.on('error', () => { stream.close?.() })
      stream.on('error', () => {})
    })
  })
})
await new Promise((resolve) => sshServer.listen(0, '127.0.0.1', resolve))
const sshPort = sshServer.address().port

/* ── wiring ───────────────────────────────────────────────────────────── */

const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-fwd-'))
const store = new Store(join(root, 'state.json'))
await store.load()
// The row is stored the way the UI stores it: auth kind only, no secret.
await store.upsertHost({ id: 'h1', name: 'fake', host: '127.0.0.1', port: sshPort, user: 'u', auth: { type: 'password' } })

const pool = new SshPool({})
const manager = new ForwardManager({ store, pool })

// Establish the authenticated connection first, exactly like hosts.connect does
// (the password arrives with that request and never reaches the store).
await pool.ensure({ id: 'h1', name: 'fake', host: '127.0.0.1', port: sshPort, user: 'u', auth: { type: 'password', password: 'p' } })
assert.equal(pool.status('h1'), 'connected')

/* ── save + defaults ──────────────────────────────────────────────────── */

const localPort = await freePort()
let view = await manager.save('h1', { localPort, remoteHost: '127.0.0.1', remotePort: echoPort })
assert.equal(view.rules.length, 1)
const rule = view.rules[0]
assert.equal(rule.bind, '127.0.0.1', '默认只绑回环')
assert.equal(rule.autoStart, true, '默认随连接自动启动')
assert.equal(rule.state, 'stopped')
assert.equal(rule.exposed, false)
assert.match(rule.local, new RegExp(`127\\.0\\.0\\.1:${localPort}`))
assert.match(rule.target, new RegExp(`127\\.0\\.0\\.1:${echoPort}`))

/* ── start: bytes actually traverse the tunnel ─────────────────────────── */

view = await manager.start('h1', rule.id)
assert.equal(view.rules[0].state, 'listening')

const reply = await roundTrip(localPort, 'ping')
assert.equal(reply, 'echo:ping')
assert.ok(opened.some((target) => target.endsWith(`:${echoPort}`)), 'ssh2 server must receive a direct-tcpip for the target')

await new Promise((resolve) => setTimeout(resolve, 60))
view = manager.list('h1')[0]
assert.ok(view.rules[0].bytes > 0, '流量统计必须记录字节数')

/* ── a second rule on the same local port is refused by name ──────────── */

await assert.rejects(
  () => manager.save('h1', { localPort, remoteHost: '127.0.0.1', remotePort: echoPort }),
  (error) => {
    assert.equal(error.code, 'duplicate-port')
    assert.match(error.message, /已被另一条规则/)
    return true
  },
)

/* ── a port already bound by something else reports port-in-use ───────── */

const occupied = createNetServer()
await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve))
const occupiedPort = occupied.address().port
const busy = await manager.save('h1', { localPort: occupiedPort, remotePort: echoPort })
await assert.rejects(
  () => manager.start('h1', busy.rules.at(-1).id),
  (error) => {
    assert.equal(error.code, 'port-in-use')
    assert.match(error.message, new RegExp(`端口 ${occupiedPort}`))
    return true
  },
)
// A rule that failed to start still explains itself in the list view.
assert.equal(manager.list('h1')[0].rules.at(-1).state, 'error')
assert.match(manager.list('h1')[0].rules.at(-1).error, /已被占用/)
await manager.remove('h1', busy.rules.at(-1).id)
await new Promise((resolve) => occupied.close(resolve))

/* ── stop closes the socket for real ──────────────────────────────────── */

view = await manager.stop('h1', rule.id)
assert.equal(view.rules[0].state, 'stopped')
await assert.rejects(
  () => roundTrip(localPort, 'nobody-home'),
  (error) => {
    assert.equal(error.code, 'ECONNREFUSED', `停止后必须拒绝连接，实际 ${error.code}`)
    return true
  },
)

/* ── autoStart=false rules stay down through startAll ─────────────────── */

const manualPort = await freePort()
const manual = await manager.save('h1', { localPort: manualPort, remotePort: echoPort, autoStart: false })
const manualId = manual.rules.at(-1).id
view = await manager.startAll('h1')
assert.equal(view.rules.find((item) => item.id === rule.id).state, 'listening', 'autoStart 规则应被启动')
assert.equal(view.rules.find((item) => item.id === manualId).state, 'stopped', 'autoStart=false 的规则不应被启动')
await manager.stopAll('h1')
assert.ok(manager.list('h1')[0].rules.every((item) => item.state === 'stopped'))

/* ── rules persist, and the file still holds no secret ────────────────── */

await store.flush()
const raw = await readFile(join(root, 'state.json'), 'utf8')
const saved = JSON.parse(raw)
assert.equal(saved.forwards.h1.length, 2)
assert.equal(saved.forwards.h1[0].localPort, localPort)
assert.equal(saved.forwards.h1[0].bind, '127.0.0.1')
// `auth.type` is the string "password" on purpose; what must never appear is an
// actual secret value.
const storedHost = saved.hosts.find((host) => host.id === 'h1')
assert.equal(storedHost.auth.type, 'password')
assert.equal(storedHost.auth.password, undefined, '状态文件不得包含密码')
assert.equal(storedHost.auth.passphrase, undefined, '状态文件不得包含口令')
assert.ok(!raw.includes('"p"'), '状态文件不得包含本次连接用的密码值')

/* ── deleting a host removes its rules ────────────────────────────────── */

await store.deleteHost('h1')
assert.equal(store.forwards('h1').length, 0)

/* ── dispose closes every listener ────────────────────────────────────── */

await manager.dispose()
await assert.rejects(() => roundTrip(localPort, 'after-dispose'))

pool.dispose()
sshServer.close()
echo.close()

console.log('forward: ok (listen, round-trip, byte count, duplicate + occupied port, stop, autoStart, persistence, dispose)')
process.exit(0)
