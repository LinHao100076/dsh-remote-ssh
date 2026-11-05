/**
 * Port-forwarding test: real TCP round-trips through a fake SSH server, for all
 * three shapes.
 *
 * Flow under test:
 *   -L: local socket → `ForwardManager` listener → direct-tcpip → ssh2 server → echo
 *   -D: SOCKS5 client → `ForwardManager` listener → direct-tcpip → ssh2 server → echo
 *   -R: local socket → server's own listener → forwarded-tcpip → manager → local echo
 *
 * That end-to-end shape is the point — a stub would prove the API surface but not
 * that bytes actually move, and byte plumbing is where forwarders break. The fake
 * server is a real ssh2 `Server`, so channel open, global requests and cancel all
 * go through the actual protocol rather than a private shortcut.
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

/** Resolve once `check()` is true, or reject after `timeoutMs`. */
async function until(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
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
    socket.on('close', () => {
      clearTimeout(timer)
      reject(new Error(`tunnel ${port} closed without data`))
    })
    socket.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

/**
 * A SOCKS5 CONNECT followed by one payload, in a single write.
 *
 * Pipelining is deliberate: a client is allowed to send its first payload
 * immediately after the request, and a proxy that drops those bytes corrupts
 * every connection that does it. The handshake parser has to hand them back.
 */
function socksExchange(port, host, targetPort, payload) {
  const expected = `echo:${payload}`
  return new Promise((resolve, reject) => {
    const socket = netConnect({ port, host: '127.0.0.1' })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('socks timed out')) }, 5000)
    const fail = (error) => { clearTimeout(timer); socket.destroy(); reject(error) }
    let greetingDone = false
    let buffer = Buffer.alloc(0)

    socket.on('connect', () => {
      const name = Buffer.from(host, 'utf8')
      socket.write(Buffer.concat([
        Buffer.from([5, 1, 0]), // greeting: one method, "no auth"
        Buffer.from([5, 1, 0, 3, name.length]), name,
        Buffer.from([targetPort >> 8, targetPort & 0xff]),
        Buffer.from(payload, 'utf8'),
      ]))
    })
    socket.on('error', fail)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (!greetingDone) {
        if (buffer.length < 2) return
        if (buffer[0] !== 5 || buffer[1] !== 0) return fail(new Error(`bad method reply ${buffer[0]}/${buffer[1]}`))
        greetingDone = true
        buffer = buffer.subarray(2)
      }
      if (buffer.length < 10) return
      if (buffer[0] !== 5) return fail(new Error(`bad reply version ${buffer[0]}`))
      const code = buffer[1]
      if (code !== 0) {
        clearTimeout(timer)
        socket.end()
        resolve({ code, body: '' })
        return
      }
      const body = buffer.subarray(10).toString('utf8')
      if (body.length < expected.length) return
      clearTimeout(timer)
      socket.end()
      resolve({ code, body })
    })
  })
}

/* ── the "remote" service and the SSH server in front of it ───────────── */

const echo = createNetServer((socket) => {
  socket.on('error', () => {})
  socket.on('data', (chunk) => socket.write(`echo:${chunk}`))
})
await new Promise((resolve) => echo.listen(0, '127.0.0.1', resolve))
const echoPort = echo.address().port

/** Ports the fake server was asked to open channels to (`-L` / `-D`). */
const outbound = []
/** Ports the fake server was asked to listen on (`-R`). */
const inbound = []
/** Live listeners the fake server holds on behalf of `-R` rules. */
const reverseServers = new Map()
/** Every server-side client, so the test can drop a connection on purpose. */
const serverClients = []

/** Simulate OpenSSH refusing the channel *before* it opens (a dead target). */
const REFUSED_PORT = 9

const sshServer = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
  serverClients.push(client)
  /** Listeners this connection opened on the server's behalf. */
  const own = new Map()
  client.on('error', () => {})
  client.on('authentication', (auth) => {
    if (auth.method === 'password' && auth.username === 'u' && auth.password === 'p') auth.accept()
    else auth.reject(['password'])
  })
  client.on('ready', () => {
    client.on('tcpip', (accept, reject, info) => {
      outbound.push(`${info.destIP}:${info.destPort}`)
      // A real sshd connects before it confirms the channel, so a refused target
      // surfaces as a failed channel open. That difference is exactly what a
      // SOCKS client must see as "connection refused" rather than as success
      // followed by EOF.
      if (info.destPort === REFUSED_PORT) {
        reject()
        return
      }
      const stream = accept()
      const upstream = netConnect({ port: info.destPort, host: info.destIP })
      upstream.on('connect', () => { stream.pipe(upstream).pipe(stream) })
      upstream.on('error', () => { stream.close?.() })
      stream.on('error', () => {})
    })

    client.on('request', (accept, reject, name, info) => {
      if (name === 'tcpip-forward') {
        const server = createNetServer((socket) => {
          socket.on('error', () => {})
                    // Argument order is (boundAddr, boundPort, peerAddr, peerPort): the
          // bound pair is what the client matches against its own forwardIn
          // registration, so swapping these makes the client reject every channel.
          client.forwardOut(info.bindAddr, info.bindPort, socket.remoteAddress ?? '127.0.0.1', socket.remotePort ?? 0, (error, stream) => {
            if (error) { socket.destroy(); return }
            stream.on('error', () => {})
            socket.pipe(stream).pipe(socket)
          })
        })
        server.on('error', () => { reject?.() })
        server.listen(info.bindPort, '127.0.0.1', () => {
          const { port } = server.address()
          own.set(info.bindPort, server)
          reverseServers.set(info.bindPort, server)
          inbound.push(port)
          // Port 0 asks the server to choose; the granted port goes back in the
          // reply. A fixed port just gets a plain accept.
          if (info.bindPort === 0) accept?.(port)
          else accept?.()
        })
        return
      }
      if (name === 'cancel-tcpip-forward') {
        const server = own.get(info.bindPort)
        if (server === undefined) {
          reject?.()
          return
        }
        own.delete(info.bindPort)
        reverseServers.delete(info.bindPort)
        server.close()
        accept?.()
        return
      }
      reject?.()
    })
  })
  // A real sshd drops its listeners with the connection; without this the second
  // `tcpip-forward` for the same port would collide with the stale first one and
  // the reconnect test could never pass.
  client.on('close', () => {
    for (const [port, server] of own) {
      server.close()
      if (reverseServers.get(port) === server) reverseServers.delete(port)
    }
    own.clear()
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
let view = await manager.save('h1', { listen: { port: localPort }, target: { host: '127.0.0.1', port: echoPort } })
assert.equal(view.rules.length, 1)
const rule = view.rules[0]
assert.equal(rule.kind, 'local', 'no kind means -L')
assert.equal(rule.listenSide, 'local')
assert.equal(rule.listen.host, '127.0.0.1', '默认只绑回环')
assert.equal(rule.autoStart, true, '默认随连接自动启动')
assert.equal(rule.state, 'stopped')
assert.equal(rule.exposed, false)
assert.equal(rule.link, `127.0.0.1:${localPort}`)
assert.equal(rule.to, `127.0.0.1:${echoPort}`)

/* ── -L: bytes actually traverse the tunnel ────────────────────────────── */

view = await manager.start('h1', rule.id)
assert.equal(view.rules[0].state, 'listening')

const reply = await roundTrip(localPort, 'ping')
assert.equal(reply, 'echo:ping')
assert.ok(outbound.some((target) => target.endsWith(`:${echoPort}`)), 'ssh2 server must receive a direct-tcpip for the target')

await new Promise((resolve) => setTimeout(resolve, 60))
view = manager.list('h1')[0]
assert.ok(view.rules[0].bytes > 0, '流量统计必须记录字节数')

/* ── -D: SOCKS5 dispatch, resolved on the remote side ──────────────────── */

const socksPort = await freePort()
view = await manager.save('h1', { kind: 'dynamic', listen: { port: socksPort } })
const socksRule = view.rules.at(-1)
assert.equal(socksRule.kind, 'dynamic')
assert.equal(socksRule.to, 'SOCKS5', 'a dynamic rule has no fixed target')
view = await manager.start('h1', socksRule.id)
assert.equal(view.rules.find((item) => item.id === socksRule.id).state, 'listening')

// Domain name, not an IP: the whole point of `-D` is that the *server* resolves
// the name, so the SOCKS request must carry the name through untouched.
const socks = await socksExchange(socksPort, 'localhost', echoPort, 'hello')
assert.equal(socks.code, 0, 'SOCKS5 CONNECT must succeed')
assert.equal(socks.body, 'echo:hello', 'pipelined payload must survive the handshake')
assert.ok(outbound.some((target) => target.startsWith('localhost:')), 'the target name must reach the server unresolved')

const refused = await socksExchange(socksPort, '127.0.0.1', REFUSED_PORT, '')
assert.equal(refused.code, 5, 'a failed channel open must answer "connection refused", not success')

// A broken handshake is not a rule failure: port scanners hit this all the time.
const junk = netConnect({ port: socksPort, host: '127.0.0.1' })
await new Promise((resolve) => junk.on('connect', resolve))
junk.write('GET / HTTP/1.1\r\n\r\n')
await new Promise((resolve) => junk.on('close', resolve))
await new Promise((resolve) => setTimeout(resolve, 40))
assert.equal(manager.list('h1')[0].rules.find((item) => item.id === socksRule.id).state, 'listening', 'a non-SOCKS client must not mark the rule broken')
assert.equal(manager.list('h1')[0].rules.find((item) => item.id === socksRule.id).error, undefined)

/* ── -R: the server listens, the tunnel comes back here ────────────────── */

const reversePort = await freePort()
view = await manager.save('h1', { kind: 'remote', listen: { port: reversePort }, target: { port: echoPort } })
const reverseRule = view.rules.at(-1)
assert.equal(reverseRule.kind, 'remote')
assert.equal(reverseRule.listenSide, 'remote')
view = await manager.start('h1', reverseRule.id)
assert.equal(view.rules.find((item) => item.id === reverseRule.id).state, 'listening')
assert.equal(view.rules.find((item) => item.id === reverseRule.id).granted, reversePort)
assert.ok(inbound.includes(reversePort), 'the server must have been asked to listen')

// The connection enters the server's listener and comes back out at this machine.
const back = await roundTrip(reversePort, 'roundtrip')
assert.equal(back, 'echo:roundtrip')

// A dead local target closes the channel instead of hanging the remote peer.
const deadTarget = await freePort()
const deadRule = (await manager.save('h1', { kind: 'remote', listen: { port: await freePort() }, target: { port: deadTarget } })).rules.at(-1)
await manager.start('h1', deadRule.id)
await assert.rejects(() => roundTrip(deadRule.listen.port, 'nobody-home'), 'a closed channel must not look like a hang')
await manager.remove('h1', deadRule.id)

/* ── -R survives a dropped connection by re-requesting the port ────────── */

// Dropping the transport is what a keepalive timeout looks like. The server's
// listener died with it, so the pool has to ask again — otherwise the rule keeps
// claiming "listening" while the port is gone.
serverClients.at(-1).end()
await until(() => pool.status('h1') === 'disconnected', 'the pool to notice the drop')
await pool.ensure({ id: 'h1', name: 'fake', host: '127.0.0.1', port: sshPort, user: 'u', auth: { type: 'password', password: 'p' } })
assert.equal(pool.status('h1'), 'connected')
const afterDrop = await roundTrip(reversePort, 'again')
assert.equal(afterDrop, 'echo:again', 'the reverse tunnel must heal itself after a reconnect')
assert.equal(manager.list('h1')[0].rules.find((item) => item.id === reverseRule.id).state, 'listening')

/* ── a second rule on the same socket is refused by name ───────────────── */

await assert.rejects(
  () => manager.save('h1', { listen: { port: localPort }, target: { port: echoPort } }),
  (error) => {
    assert.equal(error.code, 'duplicate-port')
    assert.match(error.message, /已被另一条规则/)
    return true
  },
)

/* ── a wildcard bind covers the loopback one ────────────────────────────── */

await assert.rejects(
  () => manager.save('h1', { listen: { host: '0.0.0.0', port: localPort }, target: { port: echoPort } }),
  (error) => {
    assert.equal(error.code, 'duplicate-port', '0.0.0.0 and 127.0.0.1 on one port cannot coexist')
    assert.match(error.message, new RegExp(`端口 ${localPort}`))
    return true
  },
)

/* ── a port already bound by something else reports port-in-use ─────────── */

const occupied = createNetServer()
await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve))
const occupiedPort = occupied.address().port
const busy = await manager.save('h1', { listen: { port: occupiedPort }, target: { port: echoPort } })
await assert.rejects(
  () => manager.start('h1', busy.rules.at(-1).id),
  (error) => {
    assert.equal(error.code, 'port-in-use')
    assert.match(error.message, new RegExp(`端口 127\\.0\\.0\\.1:${occupiedPort}`))
    return true
  },
)
// A rule that failed to start still explains itself in the list view.
assert.equal(manager.list('h1')[0].rules.at(-1).state, 'error')
assert.match(manager.list('h1')[0].rules.at(-1).error, /已被占用/)
await manager.remove('h1', busy.rules.at(-1).id)
await new Promise((resolve) => occupied.close(resolve))

/* ── stop closes the socket for real, on both sides ────────────────────── */

view = await manager.stop('h1', rule.id)
assert.equal(view.rules.find((item) => item.id === rule.id).state, 'stopped')
await assert.rejects(
  () => roundTrip(localPort, 'nobody-home'),
  (error) => {
    assert.equal(error.code, 'ECONNREFUSED', `停止后必须拒绝连接，实际 ${error.code}`)
    return true
  },
)

// Stopping a `-R` rule must also tell the server to stop listening; otherwise the
// port stays open on a machine the user cannot see.
view = await manager.stop('h1', reverseRule.id)
assert.equal(view.rules.find((item) => item.id === reverseRule.id).state, 'stopped')
await until(() => !reverseServers.has(reversePort), 'the server to release the port')
const reclaimed = createNetServer()
await new Promise((resolve, reject) => {
  reclaimed.once('error', reject)
  reclaimed.listen(reversePort, '127.0.0.1', resolve)
})
await new Promise((resolve) => reclaimed.close(resolve))

/* ── autoStart=false rules stay down through startAll ─────────────────── */

const manualPort = await freePort()
const manual = await manager.save('h1', { listen: { port: manualPort }, target: { port: echoPort }, autoStart: false })
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
assert.equal(saved.forwards.h1.length, 4)
assert.equal(saved.forwards.h1[0].listen.port, localPort)
assert.equal(saved.forwards.h1[0].listen.host, '127.0.0.1')
assert.equal(saved.forwards.h1[0].kind, 'local')
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

console.log('forward: ok (-L/-D/-R round-trips, SOCKS5 codes + pipelining, reverse re-arm after a drop, wildcard clash, byte count, occupied port, stop releases both sides, autoStart, persistence, dispose)')
process.exit(0)
