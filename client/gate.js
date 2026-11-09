/**
 * Which body the panel shows: the panes, or the connect gate.
 *
 * One line of boolean logic, but it is the line issue #18 was about, so it lives
 * in its own module: `.jsx` cannot be imported by the test runner, and a rule
 * that decides whether a first-run user can ever see the new-connection form
 * deserves to be pinned by a test rather than retyped in a screenshot.
 *
 * The rule is "the gate stands in for panes that have nothing to say yet":
 *
 *   - no host selected → nothing to browse or type into, so the gate takes the
 *     body — **unless** the person asked for settings. That exception is the
 *     whole fix: the create form *is* the settings pane, and with zero hosts
 *     selected there is no host to select, so gating on `host === undefined`
 *     alone made the form unreachable forever (issue #18: "无法新建 ssh 链接").
 *   - a gated pane (files / terminal) without a live tunnel → the gate, because
 *     an SFTP tree with no socket behind it is a lie.
 *
 * The exception keys off `view` alone, not off a "creating" flag: every path
 * that opens the form sets `view` (`openSettings` does both), while a stray
 * `creating` with `view === 'files'` must not hand the body to panes that have
 * no host to work with. Narrower rule, fewer ways to get it wrong.
 *
 * @module dsh-remote-ssh/client/gate
 */

const GATED = new Set(['files', 'terminal'])

/**
 * @param {{host?: unknown, view?: string, live?: boolean}} state
 *   `host` is the selected row (presence counts, not truthiness), `view` the
 *   active tab id, `live` whether the tunnel is up.
 * @returns {boolean} true → render the connect gate instead of the panes.
 */
export function gateFor({ host, view, live } = {}) {
  if (host === undefined || host === null) return view !== 'settings'
  return GATED.has(view) && live !== true
}
