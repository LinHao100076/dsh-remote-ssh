/**
 * Render test: the panel and every pane are mounted once with real React.
 *
 * The other suites never render a component — they check registration and the
 * API — so a crash inside a render tree (a typo, a hook called conditionally, a
 * missing prop) would only surface in the browser. This runs the *built* bundle
 * through `react-dom/server`, which executes the render path offline and fails
 * loudly instead.
 *
 * Effects do not run during server rendering, so no request is made: this proves
 * the initial paint of each screen, which is where such bugs live. Two of the
 * assertions pin issue #2 directly: the connect page and the settings pane must
 * both offer a password field.
 *
 * Run: `node test/render.mjs`
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToString } from 'react-dom/server'

const here = dirname(fileURLToPath(import.meta.url))
const bundle = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/* ── evaluate the bundle the way the browser module table would ────────── */

const record = {}
const fakeWindow = { __ModuleLoader__: { load: (entry) => { record.entry = entry } } }
const fakeDocument = {
  baseURI: 'http://localhost/',
  getElementById: () => null,
  head: { append: () => {} },
  createElement: () => ({ style: {}, setAttribute: () => {} }),
}
// xterm ships as a UMD bundle that wraps itself in `(function (self) {...})(self)`
// at module scope, so `self` has to exist before the factory body evaluates.
globalThis.self = fakeWindow
globalThis.window = fakeWindow
globalThis.document = fakeDocument
new Function('window', 'document', 'navigator', bundle)(
  fakeWindow,
  fakeDocument,
  { clipboard: { writeText: async () => {} } },
)

assert.ok(record.entry !== undefined, 'bundle must register itself')
const exported = record.entry.factory((name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
})
assert.ok(exported.PANES !== undefined, 'the bundle must expose its panes')

/* ── a context shaped like the one the sidebar passes ─────────────────── */

const ctx = {
  get: () => undefined,
  inject: () => {},
  effect: () => () => {},
}

const passwordHost = {
  id: 'host-1',
  name: 'prod-web-01',
  host: '10.0.3.21',
  port: 22,
  user: 'ubuntu',
  auth: { type: 'password' },
}

const base = {
  ctx,
  sessionId: 'test-session',
  hostId: '',
  host: undefined,
  hosts: [],
  statuses: {},
  hostInfo: undefined,
  visible: false,
  active: false,
}

/** Mount one exported screen and return its markup. */
function render(name, props = {}) {
  const Pane = exported.PANES[name]
  assert.equal(typeof Pane, 'function', `${name} pane must be exported`)
  return renderToString(React.createElement(Pane, { ...base, ...props }))
}

/* ── the connect gate ─────────────────────────────────────────────────── */

const empty = render('connect')
assert.match(empty, /连接远程服务器/, 'connect gate offers the empty state')
assert.match(empty, /新建 SSH 连接/, 'connect gate can start a new host')

const passwordGate = render('connect', {
  hosts: [passwordHost],
  host: passwordHost,
  status: 'disconnected',
})
assert.match(passwordGate, /type="password"/, 'a password host gets a field on the connect gate (#2)')
assert.match(passwordGate, /仅本次会话/, 'the field says the secret is not persisted')
assert.match(passwordGate, /连接/, 'the gate can connect')

const failed = render('connect', {
  hosts: [passwordHost],
  host: passwordHost,
  status: 'error',
  error: 'All configured authentication methods failed',
  errorCode: 'auth-failed',
})
assert.match(failed, /认证失败/, 'a failed attempt is named, not swallowed')
assert.match(failed, /不可|authentication/i, 'the failure reason reaches the panel')

const connecting = render('connect', { hosts: [passwordHost], host: passwordHost, status: 'connecting' })
assert.match(connecting, /正在连接/, 'the handshake has its own state')
assert.match(connecting, /prod-web-01/, 'the handshake names the host')
assert.match(connecting, /建立 SSH 通道/, 'the handshake names what it is doing')

/* ── the panes ────────────────────────────────────────────────────────── */

const files = render('files')
assert.match(files, /rs-bar/, 'files pane renders its toolbar')
assert.match(files, /rs-tree/, 'files pane renders its tree')

const terminal = render('terminal')
assert.match(terminal, /rs-ttabs/, 'terminal pane renders its tab strip')
assert.match(terminal, /rs-term-status/, 'terminal pane reports the session')

const sync = render('sync', { snapshot: { mappings: [], queue: [], conflicts: [], stats: {} } })
assert.match(sync, /还没有路径映射/, 'sync pane empty state')
assert.match(sync, /建立映射后/, 'sync pane explains the contract before anything is configured')

const forward = render('forward')
assert.match(forward, /还没有转发规则/, 'forward pane empty state')
assert.match(forward, /远端地址|127\.0\.0\.1/, 'forward pane hints at the target address semantics')

const settings = render('settings', { host: passwordHost, hostId: passwordHost.id, hosts: [passwordHost] })
assert.match(settings, /type="password"/, 'settings offers a password field for a password host (#2)')
assert.match(settings, /保存并连接/, 'settings can save and connect in one step')
assert.match(settings, /删除主机/, 'settings can remove the host')

const blankSettings = render('settings', { creating: true, hosts: [] })
assert.match(blankSettings, /新建连接/, 'settings doubles as the create form')
assert.match(blankSettings, /创建并连接/, 'the create form can connect right away')

/* ── the workspace ────────────────────────────────────────────────────── */

const Workspace = exported.NATIVE?.RemoteWorkspace
assert.equal(typeof Workspace, 'function', 'the workspace must be exported')

const workspace = renderToString(React.createElement(Workspace, { ctx, sessionId: 'test-session' }))
assert.match(workspace, /rs-phead/, 'workspace renders its host header')
assert.match(workspace, /rs-pfoot/, 'workspace renders its footer')
assert.match(workspace, /连接远程服务器/, 'with no host the workspace shows the connect gate')
assert.match(workspace, /远程 SSH/, 'the workspace names the plugin')

const seated = renderToString(React.createElement(Workspace, {
  ctx,
  sessionId: 'test-session',
  useTabInfo: () => ({ tab: { visible: false, navigation: { params: { hostId: 'host-1' } } } }),
}))
assert.match(seated, /rs-pfoot/, 'workspace paints with the seat hook present')

/* ── and it must survive a second render (no module-level state leak) ─── */

assert.equal(renderToString(React.createElement(Workspace, { ctx, sessionId: 'test-session' })), workspace)

/* ── the header opener ────────────────────────────────────────────────── */

const opener = renderToString(React.createElement(exported.NATIVE.RemoteHeaderButton, { open: () => {} }))
assert.match(opener, /rs-icon/, 'header opener uses the plugin icon button')
assert.match(opener, /远程 SSH/, 'header opener is labelled')

console.log('render: ok (gate four states, five views, workspace paint; password fields present)')
