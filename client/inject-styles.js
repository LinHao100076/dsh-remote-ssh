/**
 * Per-document stylesheet injection.
 *
 * This used to be "first one wins": once a `<style>` with a given id existed in
 * `document.head`, every later call returned early. That is only safe while the
 * module is evaluated exactly once per page — and the client bundle is not
 * always re-evaluated together with the document. `client-hmr` swaps the module
 * while the page keeps running, so the new markup ends up styled by the
 * *previous* build's selectors. Issue #3 ("界面没有渲染出来") was that state: every
 * element present and readable, not one rule matching — the pre-rewrite sheet
 * has no `.rs-phead` / `.rs-hostline` at all, which is exactly what the
 * screenshot showed (default fonts, default buttons, `<h3>`-sized heading).
 *
 * Two rules now:
 *
 *   - the sheet belongs to the document that hosts the panel, not to whichever
 *     document the module happened to be evaluated in (a popped-out or split
 *     pane is a separate document with its own `<head>`);
 *   - a sheet whose text differs from the current CSS is overwritten, so an
 *     upgrade can never leave stale rules shadowing a live panel.
 *
 * Kept free of CSS imports so the suite can exercise it under plain Node.
 * @module dsh-remote-ssh/client/inject-styles
 */

const sheets = []

/**
 * Record a stylesheet to be kept in sync.
 * @param {string} id - element id, also the de-duplication key
 * @param {string} css - stylesheet text
 */
export function registerStyle(id, css) {
  sheets.push([id, css])
}

/**
 * Insert or refresh one sheet in one document.
 * @param {Document} doc - document that will host the panel
 * @param {string} id - element id
 * @param {string} css - stylesheet text
 * @returns {boolean} whether the document changed
 */
export function syncStyle(doc, id, css) {
  const head = doc?.head
  if (head === undefined || head === null) return false
  const existing = doc.getElementById(id)
  if (existing === null) {
    const style = doc.createElement('style')
    style.id = id
    style.textContent = css
    head.append(style)
    return true
  }
  if (existing.textContent !== css) {
    existing.textContent = css
    return true
  }
  return false
}

/**
 * Bring a document up to date with every registered sheet.
 * @param {Document} [doc] - defaults to the global document
 */
export function ensureStyles(doc) {
  const target = doc ?? (typeof document === 'undefined' ? undefined : document)
  if (target === undefined || target === null) return
  for (const [id, css] of sheets) syncStyle(target, id, css)
}
