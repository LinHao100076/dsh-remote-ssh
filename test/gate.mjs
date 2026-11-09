/**
 * Gate test, pinned to issue #18.
 *
 * The report: "无法新建 ssh 链接" on a fresh install. `state.json` had an empty
 * `hosts` array, so `host` was always `undefined`; the gate was
 *
 *   const gate = host === undefined || (GATED.has(view) && !live)
 *
 * which is permanently true in that state. The new-connection form *is* the
 * settings pane, so the two entry points that set `view = 'settings'` ("新建 SSH
 * 连接" on the gate, and the same item in the host menu) each re-rendered the
 * gate over the form they had just opened. Nothing looked broken — the panel
 * simply redrew the welcome screen, which reads as "the click did nothing".
 *
 * The rule now lives in `client/gate.js` so it can be exercised here rather than
 * only in a screenshot, and these assertions are the state machine around the
 * one case that was wrong plus the cases that must not regress.
 *
 * Run: `node test/gate.mjs`
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gateFor } from '../client/gate.js'

const here = dirname(fileURLToPath(import.meta.url))

/* ── the reported case: no host at all ───────────────────────────────── */

assert.equal(
  gateFor({ host: undefined, view: 'settings', creating: true, live: false }),
  false,
  'with no host the settings view must render — it is the only place the first host can be created (#18)',
)

/* Whatever opened the pane, `view` is the flag that counts: `openSettings` sets
   both, and a future caller that only sets `view` must work too. */
assert.equal(
  gateFor({ host: undefined, view: 'settings', live: false }),
  false,
  'view === settings is enough on its own',
)

assert.equal(
  gateFor({ host: undefined, view: 'settings', live: true }),
  false,
  'the settings pane stays reachable even if a tunnel happens to be live',
)

/* ── and the states that must keep the gate ──────────────────────────── */

assert.equal(
  gateFor({ host: undefined, view: 'files', live: false }),
  true,
  'with no host, the files pane has nothing to show — the gate stands in',
)

assert.equal(
  gateFor({ host: undefined, view: 'terminal', live: false }),
  true,
  'same for the terminal',
)

assert.equal(
  gateFor({ host: undefined, view: 'files', creating: true, live: false }),
  true,
  'a stray creating flag must not open panes that have no host to work with',
)

assert.equal(gateFor({}), true, 'an empty state object is the first-run state: gate')

/* ── a selected host: gated panes still need a socket ────────────────── */

const host = { id: 'h1', name: 'prod-web-01', host: '10.0.3.21', port: 22, user: 'ubuntu' }

assert.equal(
  gateFor({ host, view: 'files', live: false }),
  true,
  'files without a live tunnel is a tree with no socket behind it',
)

assert.equal(
  gateFor({ host, view: 'terminal', live: false }),
  true,
  'terminal without a live tunnel would type into nothing',
)

assert.equal(
  gateFor({ host, view: 'files', live: true }),
  false,
  'a live tunnel removes the gate',
)

assert.equal(
  gateFor({ host, view: 'settings', live: false }),
  false,
  'settings never needs a connection (#2: the password field lives there)',
)

assert.equal(
  gateFor({ host, view: 'sync', live: false }),
  false,
  'sync/forward configure themselves offline',
)

assert.equal(
  gateFor({ host, view: 'forward', live: false }),
  false,
  'forward rules can be edited before connecting',
)

/* A row with a falsy-looking id is still a selected host: the check is on
   presence, not truthiness, or an id of `0` would gate the panel. */
assert.equal(
  gateFor({ host: { id: 0, host: 'x' }, view: 'sync', live: true }),
  false,
  'presence, not truthiness, decides whether a host is selected',
)

/* ── the shipped bundle carries the fix ──────────────────────────────── */

const bundle = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')
assert.doesNotMatch(
  bundle,
  /host === void 0 \|\| .{0,40}GATED/,
  'lib/client.js must not regress to the #18 expression (run `npm run build`)',
)
assert.match(
  bundle,
  /function gateFor/,
  'the built bundle should contain the extracted gate rule',
)

console.log('gate: ok (settings reachable with zero hosts, gated panes still gated)')
