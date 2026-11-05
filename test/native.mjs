/**
 * Native-entry test: what the client registers when better-sidebar is not there.
 *
 * Issue #1 was that disabling better-sidebar made the plugin disappear from the
 * sidebar. The fix is a second, independent entry in DSH's own right sidebar, and
 * this suite pins its contract: the four better-sidebar tabs when that service
 * exists, the native type + body + header opener when it does not, and a clean
 * handover when better-sidebar activates later.
 *
 * The bundle is evaluated the way the browser module table would, so this tests
 * the shipped artefact, not the sources.
 * Run: `node test/native.mjs`
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
globalThis.self = fakeWindow
globalThis.window = fakeWindow
globalThis.document = fakeDocument

const stubReact = {
  createElement: () => null,
  Fragment: 'fragment',
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: undefined }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useSyncExternalStore: () => undefined,
}

new Function('window', 'document', 'navigator', bundle)(
  fakeWindow,
  fakeDocument,
  { clipboard: { writeText: async () => {} } },
)
assert.ok(record.entry !== undefined, 'bundle must register itself')
const exported = record.entry.factory((name) => {
  if (name === 'react') return stubReact
  throw new Error(`unexpected require: ${name}`)
})
assert.equal(record.entry.id, 'dsh-remote-ssh')

const KIND = exported.NATIVE.KIND
assert.equal(KIND, 'dsh-remote-ssh', 'the native kind is the package name')

/* ── fakes that behave like the real services ─────────────────────────── */

/** better-sidebar: throws on a duplicate id, as 0.28.0 does. */
function makeSidebar() {
  const tabs = new Map()
  return {
    tabs,
    registerTab(descriptor) {
      if (tabs.has(descriptor.id)) throw new Error(`tab "${descriptor.id}" already registered`)
      tabs.set(descriptor.id, descriptor)
      return () => { if (tabs.get(descriptor.id) === descriptor) tabs.delete(descriptor.id) }
    },
    getTab: (id) => tabs.get(id),
    getTabs: () => [...tabs.values()],
    openTab: () => {},
    hostRouteUrl: (path) => path,
  }
}

/** DSH's native right sidebar: one tab type per kind, keyed slot entries. */
function makeNative() {
  const types = new Map()
  const entries = []
  const opened = []
  const DECLARED = new Set(['sidebar.right.pane.tab', 'conversation.session.header.utilities'])

  const keyOf = (options) => `${options.name}:${options.key ?? options.id}`

  return {
    types,
    entries,
    opened,
    sidebarRightTabs: {
      get: (kind) => types.get(kind),
      entries: () => [...types.values()],
      register(definition) {
        if (types.has(definition.kind)) throw new Error(`kind "${definition.kind}" already registered`)
        types.set(definition.kind, definition)
        return () => { if (types.get(definition.kind) === definition) types.delete(definition.kind) }
      },
    },
    sidebarRight: {
      openTab: (kind) => { opened.push(kind) },
      mounted: { get: () => undefined, subscribe: () => () => {} },
    },
    slots: {
      inject(name, callback) {
        return DECLARED.has(name) ? callback() : () => {}
      },
      register(options, Component) {
        const key = keyOf(options)
        if (entries.some((entry) => entry.key === key)) throw new Error(`slot entry "${key}" already registered`)
        const entry = { key, ...options, Component }
        entries.push(entry)
        return () => {
          const index = entries.indexOf(entry)
          if (index >= 0) entries.splice(index, 1)
        }
      },
    },
  }
}

/**
 * A context that behaves like cordis' scoped injection: a callback fires at once
 * when its dependencies are up, and stays pending otherwise until `provide`.
 */
function makeCtx({ sidebar, native } = {}) {
  const disposers = []
  const pending = []
  let sidebarRef = sidebar
  const services = () => ({
    betterSidebar: sidebarRef,
    slots: native?.slots,
    sidebarRightTabs: native?.sidebarRightTabs,
    sidebarRight: native?.sidebarRight,
  })

  const ctx = {
    get: (name) => services()[name],
    effect(fn) {
      const dispose = fn()
      const wrapped = typeof dispose === 'function' ? dispose : () => {}
      disposers.push(wrapped)
      return wrapped
    },
    inject(deps, callback) {
      const ready = () => deps.every((dep) => services()[dep] !== undefined)
      if (!ready()) {
        pending.push({ deps, callback })
        return () => {}
      }
      const inner = { ...services(), get: (name) => services()[name] }
      const out = callback(inner)
      return typeof out === 'function' ? out : () => {}
    },
    /** Provide a service after the fact, the way a later activation does. */
    setSidebar(service) {
      sidebarRef = service
    },
    provide() {
      for (const item of [...pending]) {
        if (item.deps.every((dep) => services()[dep] !== undefined)) {
          pending.splice(pending.indexOf(item), 1)
          const inner = { ...services(), get: (name) => services()[name] }
          item.callback(inner)
        }
      }
    },
    disposers,
  }
  return ctx
}

/* ── 1. better-sidebar present: one tab, and only that ────────────────── */

{
  const sidebar = makeSidebar()
  const native = makeNative()
  exported.apply(makeCtx({ sidebar, native }))
  assert.deepEqual(
    sidebar.getTabs().map((tab) => tab.id),
    ['dsh-remote-ssh'],
    'better-sidebar gets exactly one tab (issue #1)',
  )
  const tab = sidebar.getTabs()[0]
  assert.equal(tab.title(), '远程 SSH', 'the single tab is called 远程 SSH')
  assert.equal(tab.order, 46)
  assert.equal(typeof tab.component, 'function', 'the single tab renders the workspace')
  assert.equal(native.types.size, 0, 'no native entry while better-sidebar is there')
  assert.equal(native.entries.length, 0, 'no native slots while better-sidebar is there')
}

/* ── 2. better-sidebar absent: the native entry carries the plugin ────── */

{
  const native = makeNative()
  const ctx = makeCtx({ native })
  exported.apply(ctx)

  const type = native.types.get(KIND)
  assert.ok(type !== undefined, 'the native tab type is registered')
  assert.equal(type.kind, KIND)
  assert.equal(type.priority, 'extension', 'an outside type outranks the product ones')
  assert.equal(type.title(), '远程 SSH')
  assert.equal(type.guide?.[0]?.id, KIND, 'the guide page offers an entry')

  const body = native.entries.find((entry) => entry.name === 'sidebar.right.pane.tab')
  assert.ok(body !== undefined, 'a tab body is registered')
  assert.equal(body.key, KIND, 'the body is keyed by the type id')
  assert.equal(typeof body.Component, 'function', 'the body is a component')
  const injected = body.inject('session-1')
  assert.equal(injected.sessionId, 'session-1')
  assert.equal(typeof injected.ctx, 'object', 'the body receives the client context')

  const header = native.entries.find((entry) => entry.name === 'conversation.session.header.utilities')
  assert.ok(header !== undefined, 'the header opener is registered')
  assert.equal(header.id, KIND)
  header.inject('session-1').open()
  assert.deepEqual(native.opened, [KIND], 'the opener opens the native panel')
}

/* ── 3. nothing at all: silent, not a crash ───────────────────────────── */

{
  const ctx = makeCtx({})
  exported.apply(ctx)
  // One effect scope is opened for the native entry; with no service inside, it
  // registers nothing. Tearing it down must also be silent.
  for (const dispose of ctx.disposers) dispose()
}

/* ── 4. re-apply must not duplicate (hot reload) ──────────────────────── */

{
  const native = makeNative()
  const ctx = makeCtx({ native })
  exported.apply(ctx)
  // A second activation of the same context sees its own registrations; cordis
  // disposes the previous effect scope first, which this fake does through the
  // returned disposers.
  for (const dispose of ctx.disposers.splice(0)) dispose()
  const afterDispose = native.types.size + native.entries.length
  assert.equal(afterDispose, 0, `disposing left ${afterDispose} native registrations behind`)

  exported.apply(ctx)
  assert.equal(native.types.size, 1, 're-apply registers the type again, exactly once')
  assert.equal(native.entries.length, 2, 're-apply registers both slots again, exactly once')
}

/* ── 5. better-sidebar activating late takes over ─────────────────────── */

{
  const native = makeNative()
  const ctx = makeCtx({ native })
  exported.apply(ctx)
  assert.equal(native.types.size, 1, 'native entry first')

  const sidebar = makeSidebar()
  ctx.setSidebar(sidebar)
  ctx.provide()

  assert.equal(native.types.size, 0, 'the native type is released on handover')
  assert.equal(native.entries.length, 0, 'the native slots are released on handover')
  assert.equal(sidebar.getTabs().length, 1, 'better-sidebar takes over with its single tab')
}

console.log('native: ok (one tab vs native entry, silent without services, handover on late activation)')
