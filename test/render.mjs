/**
 * Render test: every panel is mounted once with real React.
 *
 * The other suites never render a component — they check registration and the
 * API — so a crash inside a render tree (a typo, a hook called conditionally, a
 * missing prop) would only surface in the browser. This runs the *built* bundle
 * through `react-dom/server`, which executes the render path offline and fails
 * loudly instead.
 *
 * Effects do not run during server rendering, so no request is made: this proves
 * the initial paint of each tab, which is where such bugs live.
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
  betterSidebar: { hostRouteUrl: (path) => `http://localhost/${path}` },
  get: () => undefined,
  inject: () => {},
  effect: () => () => {},
}

/** Mount one pane and return its markup. */
function render(name) {
  const Pane = exported.PANES[name]
  assert.equal(typeof Pane, 'function', `${name} pane must be exported`)
  return renderToString(React.createElement(Pane, {
    ctx,
    scope: { sessionId: 'test-session' },
    tab: { type: `dsh-remote-ssh:${name}` },
    visible: false,
    expanded: true,
    revealed: true,
  }))
}

/* ── every pane paints, with the right empty state ────────────────────── */

const files = render('files')
assert.match(files, /rs-root/, 'files pane renders its root')
assert.match(files, /还没有远程主机/, 'files pane shows its empty state')

const terminal = render('terminal')
assert.match(terminal, /rs-root/)
assert.match(terminal, /远程终端|还没有远程主机/, 'terminal pane has a header or an empty state')

const sync = render('sync')
assert.match(sync, /rs-root/)
assert.match(sync, /同步/, 'sync pane header')
assert.match(sync, /还没有路径映射/, 'sync pane empty state')
assert.match(sync, /建立映射后/, 'sync pane explains the contract before anything is configured')

const forward = render('forward')
assert.match(forward, /rs-root/)
assert.match(forward, /转发/, 'forward pane header')
assert.match(forward, /还没有转发规则/, 'forward pane empty state')
assert.match(forward, /direct-tcpip/, 'forward pane footer names the mechanism')
// The guidance that makes the feature usable must be on screen, not only in docs.
assert.match(forward, /远端地址|127\.0\.0\.1/, 'forward pane hints at the target address semantics')

/* ── and it must survive a second render (no module-level state leak) ─── */

assert.equal(render('forward'), forward, 'rendering twice is deterministic')

/* ── the native workspace (DSH's own right sidebar) ───────────────────── */
/* This is the entry a profile without better-sidebar sees, so it has to paint
   without any better-sidebar props at all: no `ctx.betterSidebar`, no `scope`,
   and a seat that may or may not provide the tab hook. */

const Workspace = exported.NATIVE?.RemoteWorkspace
assert.equal(typeof Workspace, 'function', 'the native workspace must be exported')

const bare = renderToString(React.createElement(Workspace, { ctx, sessionId: 'test-session' }))
assert.match(bare, /rs-wtabs/, 'workspace renders its own tab strip')
for (const label of ['文件', '终端', '同步', '转发']) {
  assert.match(bare, new RegExp(label), `workspace offers the ${label} pane`)
}
assert.match(bare, /rs-root/, 'the active pane paints inside the workspace')
assert.match(bare, /rs-wpane/, 'panes are mounted into the workspace body')

const seated = renderToString(React.createElement(Workspace, {
  ctx,
  sessionId: 'test-session',
  useTabInfo: () => ({ tab: { visible: false, navigation: { params: { hostId: 'host-1' } } } }),
}))
assert.match(seated, /rs-wtabs/, 'workspace paints with the seat hook present')

/* ── the header opener ────────────────────────────────────────────────── */

const opener = renderToString(React.createElement(exported.NATIVE.RemoteHeaderButton, { open: () => {} }))
assert.match(opener, /rs-icon/, 'header opener uses the plugin icon button')
assert.match(opener, /远程 SSH/, 'header opener is labelled')

console.log('render: ok (four panes + native workspace paint, empty states present, no DOM needed)')
