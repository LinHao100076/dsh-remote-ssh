/**
 * Host-half smoke test: mounts the plugin against a fake cordis context, drives
 * the JSON API over a fake Node request/response pair, and checks the pure
 * helpers (mapping matcher, path math, tmux decision).
 *
 * Run: `node test/smoke.mjs` (no DSH, no SSH server, no network required).
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../src/index.js'
import { createMatcher, normalizeMapping } from '../src/sync/mapping.js'
import { dirnameRemote, joinRemote, formatBytes, shq } from '../src/util.js'
import { attachTerminal } from '../src/ws/term.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-remote-ssh-test-'))
const storePath = join(root, 'state.json')

/* ── fake host context ────────────────────────────────────────────────── */

function fakeContext() {
  const routes = []
  const upgrades = []
  const tools = []
  const disposers = []
  const target = {
    webServer: {
      register(route) { routes.push(route); return () => {} },
      registerUpgrade(route) { upgrades.push(route); return () => {} },
    },
    sessions: { get: () => undefined },
    get(name) {
      if (name === 'tools') return { register: (tool) => tools.push(tool) }
      return undefined
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  /*
   * A real cordis context is a Proxy that refuses reads of undeclared services
   * with `cannot get property "x" without inject`. A plain object accepts any
   * read, which is exactly how `ctx.pluginVersion` survived to production and
   * turned `system.ping` into a 500. Mirror the proxy so tests catch it.
   */
  const ctx = new Proxy(target, {
    get(obj, key, receiver) {
      if (typeof key === 'symbol' || key in obj) return Reflect.get(obj, key, receiver)
      throw new Error(`cannot get property "${key}" without inject`)
    },
  })
  return { ctx, routes, upgrades, tools, disposers }
}

/** POST one JSON API method through the registered route handler. */
async function callApi(route, method, payload = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))])
  req.method = 'POST'
  req.url = `/remote/api/${method}`
  let status = 0
  let body = ''
  const res = {
    writeHead(code) { status = code; return this },
    end(chunk) { body += chunk ?? ''; return this },
  }
  await route.handler(req, res)
  return { status, payload: JSON.parse(body) }
}

/* ── mount ────────────────────────────────────────────────────────────── */

const { ctx, routes, upgrades, tools, disposers } = fakeContext()
await apply(ctx, { storePath })

const apiRoute = routes.find((route) => route.path === '/remote/api')
assert.ok(apiRoute, 'the JSON API route must be registered')
assert.ok(upgrades.some((route) => route.path === '/remote/ws/term'), 'the terminal upgrade route must be registered')
assert.equal(tools.length, 3, 'ssh_exec, ssh_sync and ssh_hosts are registered')

/* ── ping ─────────────────────────────────────────────────────────────── */

let ping = await callApi(apiRoute, 'system.ping')
assert.equal(ping.status, 200, 'system.ping must not touch undeclared services')
assert.equal(ping.payload.ok, true)
assert.equal(typeof ping.payload.value.pong, 'number')
assert.match(ping.payload.value.version, /^\d+\.\d+\.\d+$/, 'the footer version comes from the plugin, not ctx')

/* ── hosts ────────────────────────────────────────────────────────────── */

let result = await callApi(apiRoute, 'hosts.list')
assert.deepEqual(result.payload, { ok: true, value: { hosts: [], statuses: {} } })

result = await callApi(apiRoute, 'hosts.save', {
  host: { host: '10.0.3.21', user: 'ubuntu', port: 22, auth: { type: 'key', keyPath: '~/.ssh/id_ed25519' } },
})
assert.equal(result.payload.ok, true, 'saving a host succeeds')
const hostId = result.payload.value.host.id
assert.ok(hostId)
assert.equal(result.payload.value.host.name, '10.0.3.21', 'name falls back to the address')
assert.equal(result.payload.value.host.auth.keyPath, '~/.ssh/id_ed25519')
assert.equal(result.payload.value.host.auth.password, undefined, 'no secret is persisted')

result = await callApi(apiRoute, 'hosts.save', { host: { host: 'h', user: 'u', port: 22, auth: { type: 'key' } } })
assert.equal(result.payload.ok, false)
assert.equal(result.payload.error.code, 'missing-key', 'key auth without a path is rejected')

result = await callApi(apiRoute, 'hosts.save', { host: { host: 'h', user: 'u', port: 70000, auth: { type: 'agent' } } })
assert.equal(result.payload.error.code, 'bad-port')

/* ── mappings ─────────────────────────────────────────────────────────── */

result = await callApi(apiRoute, 'sync.save', {
  sessionId: 's1',
  mapping: { hostId, localRoot: root, remoteRoot: '/srv/app/' },
})
assert.equal(result.payload.ok, true, 'mapping saves')
const mapping = result.payload.value.mappings[0]
assert.equal(mapping.remoteRoot, '/srv/app', 'trailing slash is normalised')
assert.equal(mapping.direction, 'push', 'push is the default direction')
assert.equal(mapping.policy, 'save', 'save-on-write is the default policy')
assert.ok(mapping.exclude.includes('node_modules'), 'default excludes are applied')

result = await callApi(apiRoute, 'sync.save', {
  sessionId: 's1',
  mapping: { hostId, localRoot: root, remoteRoot: 'srv/app' },
})
assert.equal(result.payload.error.code, 'internal')
assert.match(result.payload.error.message, /绝对路径/)

result = await callApi(apiRoute, 'sync.save', {
  sessionId: 's1',
  mapping: { hostId, localRoot: '/', remoteRoot: '/srv' },
})
assert.match(result.payload.error.message, /根目录/)

result = await callApi(apiRoute, 'sync.list', { sessionId: 's1' })
assert.equal(result.payload.value.mappings.length, 1)
assert.equal(result.payload.value.mappings[0].watching, true, 'watcher starts for a push mapping')

/* ── port forwarding: rules, defaults, validation ─────────────────────── */

result = await callApi(apiRoute, 'forward.list')
assert.deepEqual(result.payload.value, { hosts: [] }, 'no rules yet')

result = await callApi(apiRoute, 'forward.save', { hostId, rule: { listen: { port: 0 }, target: { port: 80 } } })
assert.equal(result.payload.error.code, 'bad-port', 'a rule needs a real port')

result = await callApi(apiRoute, 'forward.save', { hostId: 'nope', rule: { listen: { port: 8080 }, target: { port: 80 } } })
assert.equal(result.payload.error.code, 'host-missing')

result = await callApi(apiRoute, 'forward.save', {
  hostId,
  rule: { listen: { port: 18080 }, target: { port: 3000 }, note: 'dev server' },
})
assert.equal(result.payload.ok, true, 'saving a rule succeeds')
const savedRule = result.payload.value.rules[0]
assert.equal(savedRule.kind, 'local', 'a rule is local forwarding unless told otherwise')
assert.equal(savedRule.listen.host, '127.0.0.1', 'rules bind loopback unless told otherwise')
assert.equal(savedRule.target.host, '127.0.0.1', 'the target host defaults to loopback')
assert.equal(savedRule.autoStart, true)
assert.equal(savedRule.state, 'stopped', 'saving does not start the listener')
assert.equal(savedRule.exposed, false)
assert.equal(savedRule.link, '127.0.0.1:18080')

// A wildcard bind covers the loopback one: the OS will not hand out both, so the
// check must refuse it here instead of leaving it to fail at listen time.
result = await callApi(apiRoute, 'forward.save', {
  hostId,
  rule: { listen: { host: '0.0.0.0', port: 18080 }, target: { port: 5432 } },
})
assert.equal(result.payload.error.code, 'duplicate-port', '0.0.0.0 covers 127.0.0.1 on the same port')

result = await callApi(apiRoute, 'forward.save', {
  hostId,
  rule: { listen: { port: 18080 }, target: { port: 6379 } },
})
assert.equal(result.payload.error.code, 'duplicate-port', 'the same local port cannot be claimed twice')

// A `-R` rule listens on the *server*, so it may reuse a port a `-L` rule holds here.
result = await callApi(apiRoute, 'forward.save', {
  hostId,
  rule: { kind: 'remote', listen: { port: 18080 }, target: { port: 3000 } },
})
assert.equal(result.payload.ok, true, 'a reverse rule may reuse a local port: it binds on the server')

// A dynamic rule has no target at all — the SOCKS client names it per connection.
result = await callApi(apiRoute, 'forward.save', { hostId, rule: { kind: 'dynamic', listen: { port: 1080 } } })
assert.equal(result.payload.ok, true, 'a SOCKS5 rule needs only a listening port')
assert.equal(result.payload.value.rules.at(-1).to, 'SOCKS5')

result = await callApi(apiRoute, 'forward.list', { hostId })
assert.equal(result.payload.value.hosts[0].rules.length, 3)
assert.equal(result.payload.value.hosts[0].hostName, '10.0.3.21')

result = await callApi(apiRoute, 'forward.remove', { hostId, ruleId: savedRule.id })
assert.equal(result.payload.value.rules.length, 2)

/* ── error + method routing ───────────────────────────────────────────── */

result = await callApi(apiRoute, 'nope.method')
assert.equal(result.status, 404)
assert.equal(result.payload.error.code, 'not-found')

result = await callApi(apiRoute, 'fs.list', { hostId: 'no-such-host' })
assert.equal(result.payload.ok, false, 'unknown host id is rejected')
assert.equal(result.payload.error.code, 'host-missing')

/* ── persistence ──────────────────────────────────────────────────────── */

await new Promise((resolve) => setTimeout(resolve, 400))
assert.ok(existsSync(storePath), 'state file is written')
const state = JSON.parse(await readFile(storePath, 'utf8'))
assert.equal(state.hosts.length, 1)
assert.equal(state.hosts[0].auth.password, undefined, 'no password on disk')
assert.equal(state.mappings.s1.length, 1)
assert.equal(state.forwards[hostId].length, 2, 'forward rules survive a reload')
assert.deepEqual(
  state.forwards[hostId].map((rule) => rule.kind).sort(),
  ['dynamic', 'remote'],
  'the round-trip through disk keeps each rule shape',
)

/* ── pure helpers ─────────────────────────────────────────────────────── */

const matcher = createMatcher({ exclude: ['dist', 'node_modules', '*.log', '.git'] })
assert.equal(matcher('src/app/main.ts'), true)
assert.equal(matcher('README.md'), true)
assert.equal(matcher('dist/bundle.js'), false, 'an excluded directory drops its whole subtree')
assert.equal(matcher('packages/x/node_modules/y/index.js'), false)
assert.equal(matcher('logs/server.log'), false, 'a bare glob matches at any depth')
assert.equal(matcher('.git/config'), false)

const includeMatcher = createMatcher({ include: ['src/**'], exclude: ['src/**/*.map'] })
assert.equal(includeMatcher('src/a.ts'), true)
assert.equal(includeMatcher('docs/a.md'), false)
assert.equal(includeMatcher('src/a.ts.map'), false)

assert.equal(joinRemote('/', 'a'), '/a')
assert.equal(joinRemote('/srv/app/', 'a/b'), '/srv/app/a/b')
assert.equal(dirnameRemote('/srv/app/a.ts'), '/srv/app')
assert.equal(dirnameRemote('/a'), '/')
assert.equal(shq("a'b"), "'a'\\''b'")
assert.equal(formatBytes(1536), '1.5 KB')
assert.throws(() => normalizeMapping({ localRoot: '', remoteRoot: '/x' }), /本地路径/)

/* ── terminal: tmux decision + frames ─────────────────────────────────── */

function fakeSocket() {
  const sent = []
  const socket = new EventEmitter()
  socket.readyState = 1
  socket.OPEN = 1
  socket.send = (frame) => sent.push(JSON.parse(frame))
  socket.close = () => { socket.readyState = 3; socket.emit('close') }
  return { socket, sent }
}

function fakeChannel() {
  const channel = new EventEmitter()
  channel.writable = true
  channel.written = []
  channel.window = undefined
  channel.write = (data) => channel.written.push(data)
  channel.setWindow = (rows, cols) => { channel.window = { rows, cols } }
  channel.close = () => channel.emit('close', 0)
  channel.stderr = new EventEmitter()
  return channel
}

async function runTerminal({ tmux, sessionId = '', terminalId = '' }) {
  const { socket, sent } = fakeSocket()
  const channel = fakeChannel()
  let command
  await attachTerminal({
    ws: socket,
    url: new URL(`http://x/remote/ws/term?hostId=h1&cols=90&rows=20&sessionId=${sessionId}&terminalId=${terminalId}`),
    store: { host: (id) => (id === 'h1' ? { id: 'h1', name: 'h1' } : undefined) },
    pool: {
      channel: async (_host, options) => { command = options.command; return channel },
    },
    files: { info: async () => ({ kernel: 'Linux 6.1', shell: '/bin/bash', home: '/home/u', tmux }) },
  })
  return { socket, sent, channel, command }
}

const withTmux = await runTerminal({ tmux: true })
const firstTab = await runTerminal({ tmux: true, sessionId: 's1', terminalId: 't0' })
const secondTab = await runTerminal({ tmux: true, sessionId: 's1', terminalId: 't1' })
const otherSession = await runTerminal({ tmux: true, sessionId: 's2', terminalId: 't0' })
const reattached = await runTerminal({ tmux: true, sessionId: 's1', terminalId: 't0' })
assert.notEqual(firstTab.command, secondTab.command, 'new terminal must own a different tmux session')
assert.notEqual(firstTab.command, otherSession.command, 'conversation sessions must not share shells')
assert.equal(firstTab.command, reattached.command, 'the same tab reconnects to its original tmux session')
assert.match(withTmux.command, /^tmux new -A -s dsh-/, 'tmux owns the session when it exists')
assert.equal(withTmux.sent[0].t, 'status')
const ready = withTmux.sent.find((frame) => frame.t === 'ready')
assert.equal(ready.tmux, true)
assert.equal(ready.warning, undefined)

withTmux.channel.emit('data', Buffer.from('héllo'))
assert.equal(withTmux.sent.at(-1).d, 'héllo')
withTmux.socket.emit('message', Buffer.from(JSON.stringify({ t: 'in', d: 'ls\r' })))
assert.deepEqual(withTmux.channel.written, ['ls\r'])
withTmux.socket.emit('message', Buffer.from(JSON.stringify({ t: 'resize', cols: 120, rows: 40 })))
assert.deepEqual(withTmux.channel.window, { rows: 40, cols: 120 })

const withoutTmux = await runTerminal({ tmux: false })
assert.equal(withoutTmux.command, undefined, 'no tmux means a plain login shell')
assert.match(withoutTmux.sent.find((frame) => frame.t === 'ready').warning, /tmux/)

console.log('smoke: ok (routes, hosts, mappings, forwards, persistence, matcher, terminal)')

/* Watchers keep the loop alive; unmount like the host would, then exit. */
for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    // A disposer that throws must not mask a green suite.
  }
}
setTimeout(() => process.exit(0), 300)
