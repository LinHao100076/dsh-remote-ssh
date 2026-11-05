/**
 * Stylesheet injection test, pinned to issue #3.
 *
 * The screenshot in that issue showed the whole panel in default browser
 * styling — default fonts, beveled `<button>`s, `<h3>`-sized heading — while
 * every piece of text was there. That is what a *stale* sheet looks like: the
 * `<style>` in the head belonged to a previous build, so none of its selectors
 * matched the markup that was on screen. The old injection helper made that
 * state permanent by bailing out as soon as an element with the same id existed.
 *
 * These four assertions keep it from coming back:
 *   - the sheet lands in the document that hosts the panel;
 *   - a second call is a no-op (same node, no duplicate);
 *   - a sheet whose text is not the current CSS is rewritten;
 *   - a document without a head is not a crash.
 *
 * Run: `node test/styles.mjs`
 */
import assert from 'node:assert/strict'

const { ensureStyles, registerStyle, syncStyle } = await import('../client/inject-styles.js')

/** Minimal document with just the surface the injector uses. */
function makeDocument(label, { withHead = true } = {}) {
  const created = []
  const head = withHead ? { append: (node) => created.push(node) } : undefined
  return {
    label,
    created,
    head,
    getElementById: (id) => created.find((node) => node.id === id) ?? null,
    createElement: () => ({ id: '', textContent: '' }),
  }
}

const PANEL_CSS = '.rs-root { display: flex }'
const XTERM_CSS = '.xterm { contain: strict }'
registerStyle('dsh-remote-ssh/panel', PANEL_CSS)
registerStyle('dsh-remote-ssh/xterm', XTERM_CSS)

/* ── 1. injects every registered sheet into the given document ──────────── */

const first = makeDocument('first')
ensureStyles(first)
assert.equal(first.created.length, 2, 'both sheets should be inserted')
assert.deepEqual(first.created.map((node) => node.id).sort(), ['dsh-remote-ssh/panel', 'dsh-remote-ssh/xterm'])
assert.equal(first.created.find((node) => node.id === 'dsh-remote-ssh/panel').textContent, PANEL_CSS)

/* ── 2. calling again is a no-op, not a duplicate ───────────────────────── */

const panelNode = first.created.find((node) => node.id === 'dsh-remote-ssh/panel')
ensureStyles(first)
assert.equal(first.created.length, 2, 'a second pass must not append anything')
assert.equal(first.created.find((node) => node.id === 'dsh-remote-ssh/panel'), panelNode, 'node identity should survive')

/* ── 3. a sheet from an earlier build is refreshed in place ─────────────── */

const stale = makeDocument('stale')
stale.created.push({ id: 'dsh-remote-ssh/panel', textContent: '.rs-old-head { font: 13px system-ui }' })
ensureStyles(stale)
const refreshed = stale.created.find((node) => node.id === 'dsh-remote-ssh/panel')
assert.equal(refreshed.textContent, PANEL_CSS, 'issue #3: a stale sheet must be overwritten, not kept')
assert.equal(stale.created.length, 2, 'only the missing sheet is appended')

/* ── 4. the hosting document wins over the module-level one ─────────────── */

const popped = makeDocument('popped')
assert.equal(syncStyle(popped, 'dsh-remote-ssh/panel', PANEL_CSS), true)
assert.equal(first.created.length, 2, 'a foreign document must not touch the first document')

/* ── 5. no head (early document, XML) is a no-op, not a throw ───────────── */

assert.equal(syncStyle(makeDocument('headless', { withHead: false }), 'dsh-remote-ssh/panel', PANEL_CSS), false)
assert.doesNotThrow(() => ensureStyles(null))

console.log('styles: ok (per-document injection, idempotent, stale sheet refreshed)')
