/**
 * End-to-end probe against a live DSH web server (throwaway harness).
 *
 * Runs the plugin inside a real DSH profile rather than a fake context, so it
 * covers what unit tests cannot: route mounting behind the gateway's admission
 * fence, cookies on the WebSocket upgrade, both terminal branches against a real
 * PTY, and a port forward driven entirely through the HTTP API. The fake SSH
 * server reports tmux via the `files.info()` probe, records every command it is
 * asked to run, and accepts `direct-tcpip` so the tunnel has somewhere to land.
 *
 * Prereqs: a booted profile and a cookie jar.
 * Run: `RS_COOKIE_JAR=... node test/e2e-profile.mjs`
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import { createServer as createNetServer, connect as netConnect } from 'node:net'
import ssh2 from 'ssh2'
import WebSocket from 'ws'

const ORIGIN = process.env.RS_ORIGIN ?? 'http://127.0.0.1:4987'

// The cookie jar path differs between Git Bash (`/tmp`) and Node on Windows
// (`C:\tmp`), so the caller passes the resolved path in.
const jar = readFileSync(process.env.RS_COOKIE_JAR ?? '/tmp/rs.jar', 'utf8')
const authLine = jar.split(/\r?\n/).find((row) => row.startsWith('#HttpOnly_'))
const cookie = `${authLine.split('\t')[5]}=${authLine.split('\t')[6]}`

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

/** Boot a fake ssh2 host; `tmux` decides what the info probe reports. */
async function startHost({ tmux, allowForward = false }) {
  const commands = []
  const forwarded = []
  const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
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
          commands.push(info.command)
          const stream = acceptExec()
          if (info.command.startsWith('tmux ')) {
            stream.write('tmux-attached\r\n')
          } else {
            // files.info() probe: kernel, shell, home, tmux path.
            stream.write(`Linux 6.1.0\n/bin/bash\n/home/u\n${tmux ? '/usr/bin/tmux' : ''}\n`)
          }
          stream.exit(0)
          stream.end()
        })
        session.on('shell', (acceptShell) => {
          const stream = acceptShell()
          stream.write('welcome\r\n')
          stream.on('data', (chunk) => stream.write(`echo:${chunk.toString()}`))
        })
      })

      // direct-tcpip: the server side of an `ssh -L` tunnel.
      if (allowForward) {
        client.on('tcpip', (accept, reject, info) => {
          forwarded.push(`${info.destIP}:${info.destPort}`)
          const stream = accept()
          const upstream = netConnect({ port: info.destPort, host: info.destIP })
          upstream.on('connect', () => { stream.pipe(upstream).pipe(stream) })
          upstream.on('error', () => { stream.close?.() })
          stream.on('error', () => {})
        })
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, commands, forwarded }
}

async function api(method, payload = {}) {
  const res = await fetch(`${ORIGIN}/remote/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(payload),
  })
  return { status: res.status, body: await res.json() }
}

/** Connect a host row and return the frames the terminal bridge emits. */
async function openTerminal({ port, label }) {
  const saved = await api('hosts.save', {
    host: { host: '127.0.0.1', port, user: 'u', name: label, auth: { type: 'password' } },
  })
  assert.equal(saved.status, 200, 'hosts.save')
  const hostId = saved.body.value.host.id

  const connected = await api('hosts.connect', { hostId, auth: { type: 'password', password: 'p' } })
  assert.equal(connected.status, 200, `hosts.connect: ${JSON.stringify(connected.body)}`)

  const frames = []
  const ws = new WebSocket(`${ORIGIN.replace(/^http/, 'ws')}/remote/ws/term?hostId=${hostId}&cols=100&rows=30`, {
    headers: { cookie },
  })
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())))
  ws.on('error', (error) => console.log('ws error:', error.message))

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready frame, got ${JSON.stringify(frames)}`)), 8000)
    ws.on('message', () => {
      const hit = frames.find((frame) => frame.t === 'ready' || frame.t === 'error')
      if (hit) { clearTimeout(timer); resolve(hit) }
    })
  })
  return { ws, frames, ready, hostId, info: connected.body.value.info }
}

/* ── branch 1: no tmux => plain login shell, warned loudly ─────────────── */

const plain = await startHost({ tmux: false })
const first = await openTerminal({ port: plain.port, label: 'e2e-plain' })

assert.equal(first.ready.t, 'ready', `terminal handshake failed: ${JSON.stringify(first.ready)}`)
assert.equal(first.ready.tmux, false, 'no tmux on the fake host => plain shell')
assert.match(String(first.ready.warning), /tmux/, 'the degradation must be reported to the UI')
assert.equal(first.ready.kernel, 'Linux 6.1.0')
assert.equal(first.ready.home, '/home/u')
assert.equal(first.ready.shell, '/bin/bash')
console.log('plain  :', JSON.stringify({ tmux: first.ready.tmux, shell: first.ready.shell }))

first.ws.send(JSON.stringify({ t: 'in', d: 'hello-pty\r' }))
const echoed = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('no echo frame')), 5000)
  const check = () => {
    const text = first.frames.filter((f) => f.t === 'out').map((f) => f.d).join('')
    if (text.includes('echo:hello-pty')) { clearTimeout(timer); resolve(text) }
  }
  first.ws.on('message', check)
  check()
})
console.log('pty    :', JSON.stringify(echoed.slice(0, 40)))

first.ws.send(JSON.stringify({ t: 'resize', cols: 132, rows: 40 }))
await new Promise((resolve) => setTimeout(resolve, 300))
assert.equal(first.frames.some((f) => f.t === 'exit'), false, 'channel must survive a resize')
first.ws.close()
await api('hosts.delete', { hostId: first.hostId })
plain.server.close()

/* ── branch 2: tmux present => attach-or-create a named session ────────── */

const withTmux = await startHost({ tmux: true })
const second = await openTerminal({ port: withTmux.port, label: 'e2e-tmux' })

assert.equal(second.ready.t, 'ready', `terminal handshake failed: ${JSON.stringify(second.ready)}`)
assert.equal(second.ready.tmux, true, 'tmux reported => the bridge must use it')
assert.equal(second.ready.warning, undefined, 'no warning when tmux exists')
assert.equal(second.info.tmux, true)

const tmuxCommand = withTmux.commands.find((command) => command.startsWith('tmux '))
assert.ok(tmuxCommand, `expected a tmux command, got ${JSON.stringify(withTmux.commands)}`)
assert.match(tmuxCommand, /^tmux new -A -s dsh-[a-z0-9]+$/, `tmux argv must attach-or-create: ${tmuxCommand}`)
console.log('tmux   :', tmuxCommand)

await new Promise((resolve) => setTimeout(resolve, 300))
assert.ok(
  second.frames.some((f) => f.t === 'out' && f.d.includes('tmux-attached')),
  'output from the tmux exec must reach the socket',
)

second.ws.close()
await api('hosts.delete', { hostId: second.hostId })
withTmux.server.close()

/* ── branch 3: port forward, created and started over HTTP ─────────────── */

// A real TCP service standing in for "the remote's Redis".
const echoService = createNetServer((socket) => {
  socket.on('error', () => {})
  socket.on('data', (chunk) => socket.write(`echo:${chunk}`))
})
await new Promise((resolve) => echoService.listen(0, '127.0.0.1', resolve))
const echoPort = echoService.address().port

// Ask the OS for a free local port, then release it for the plugin to claim.
const probe = createNetServer()
await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
const localPort = probe.address().port
await new Promise((resolve) => probe.close(resolve))

const tunnelHost = await startHost({ tmux: false, allowForward: true })
const savedTunnel = await api('hosts.save', {
  host: { host: '127.0.0.1', port: tunnelHost.port, user: 'u', name: 'e2e-forward', auth: { type: 'password' } },
})
const tunnelHostId = savedTunnel.body.value.host.id
const tunnelConnected = await api('hosts.connect', { hostId: tunnelHostId, auth: { type: 'password', password: 'p' } })
assert.equal(tunnelConnected.status, 200, `hosts.connect: ${JSON.stringify(tunnelConnected.body)}`)

const savedRule = await api('forward.save', {
  hostId: tunnelHostId,
  rule: { listen: { port: localPort }, target: { host: '127.0.0.1', port: echoPort } },
})
assert.equal(savedRule.status, 200, `forward.save: ${JSON.stringify(savedRule.body)}`)
const ruleId = savedRule.body.value.rules[0].id
assert.equal(savedRule.body.value.rules[0].state, 'stopped')

const startedRule = await api('forward.start', { hostId: tunnelHostId, ruleId })
assert.equal(startedRule.status, 200, `forward.start: ${JSON.stringify(startedRule.body)}`)
assert.equal(startedRule.body.value.rules[0].state, 'listening')
console.log('forward:', `127.0.0.1:${localPort} -> 127.0.0.1:${echoPort}`)

// The proof: a plain TCP round-trip through the listener the plugin bound.
const tunnelled = await new Promise((resolve, reject) => {
  const socket = netConnect({ port: localPort, host: '127.0.0.1' })
  const timer = setTimeout(() => { socket.destroy(); reject(new Error('tunnel timed out')) }, 5000)
  socket.on('connect', () => socket.write('through-the-gateway'))
  socket.on('data', (chunk) => { clearTimeout(timer); socket.end(); resolve(chunk.toString()) })
  socket.on('error', (error) => { clearTimeout(timer); reject(error) })
})
assert.equal(tunnelled, 'echo:through-the-gateway', 'bytes must traverse listener → direct-tcpip → service')
assert.ok(tunnelHost.forwarded.some((target) => target.endsWith(`:${echoPort}`)), 'the SSH server must see a direct-tcpip')

await new Promise((resolve) => setTimeout(resolve, 120))
const listed = await api('forward.list', { hostId: tunnelHostId })
const listedRule = listed.body.value.hosts[0].rules[0]
assert.equal(listedRule.state, 'listening')
assert.ok(listedRule.bytes > 0, 'traffic is counted for the panel')

const stoppedRule = await api('forward.stop', { hostId: tunnelHostId, ruleId })
assert.equal(stoppedRule.body.value.rules[0].state, 'stopped')
await assert.rejects(
  () => new Promise((resolve, reject) => {
    const socket = netConnect({ port: localPort, host: '127.0.0.1' })
    socket.on('connect', () => { socket.destroy(); resolve() })
    socket.on('error', reject)
  }),
  'a stopped rule must release the port',
)

await api('forward.remove', { hostId: tunnelHostId, ruleId })
const afterRemove = await api('forward.list', { hostId: tunnelHostId })
assert.equal(afterRemove.body.value.hosts[0].rules.length, 0)

await api('hosts.delete', { hostId: tunnelHostId })
tunnelHost.server.close()
echoService.close()

console.log('e2e: ok (mount, auth gate, both terminal branches, pty round-trip, resize, forward through the gateway)')
process.exit(0)
