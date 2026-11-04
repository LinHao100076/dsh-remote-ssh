/**
 * Stylesheet for the remote sidebar, injected once from inside the client
 * factory.
 *
 * Colours are read from the host's `--dsw-*` aliases with light-mode fallbacks,
 * so the panel follows whatever theme DSH is using (including the dark skin)
 * without shipping its own palette. Every selector is `rs-` prefixed: this CSS
 * lands in the same document as every other plugin's.
 * @module dsh-remote-ssh/client/styles
 */
export const CSS = `
.rs-root {
  --rs-bg: var(--dsw-alias-bg-base, #ffffff);
  --rs-layer1: var(--dsw-alias-bg-layer-1, #fafbfc);
  --rs-layer2: var(--dsw-alias-bg-layer-2, #f1f3f6);
  --rs-line: var(--dsw-alias-border-l1, #e6e8ec);
  --rs-line2: var(--dsw-alias-border-l2, #d8dce3);
  --rs-fg: var(--dsw-alias-label-primary, #1c2028);
  --rs-fg2: var(--dsw-alias-label-secondary, #5c6472);
  --rs-fg3: var(--dsw-alias-label-tertiary, #8d95a3);
  --rs-accent: var(--dsw-alias-brand-primary, #2f6feb);
  --rs-hover: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,.045));
  --rs-ok: var(--dsw-alias-state-success-primary, #12805c);
  --rs-warn: var(--dsw-alias-state-warn-primary, #a2610a);
  --rs-err: var(--dsw-alias-state-error-primary, #c0332b);
  --rs-mono: var(--ds-font-family-code, ui-monospace, Consolas, monospace);
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--rs-bg); color: var(--rs-fg);
  font-size: var(--dsw-font-xxs-12, 12px); line-height: 1.5;
}

/* ── chrome ─────────────────────────────────────────────────────────── */
.rs-head { display: flex; align-items: center; gap: 6px; padding: 7px 8px; border-bottom: 1px solid var(--rs-line); flex: none; }
.rs-head .rs-grow { flex: 1; min-width: 0; }
.rs-host { display: flex; align-items: center; gap: 6px; min-width: 0; }
.rs-host-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rs-host-meta { font-family: var(--rs-mono); font-size: 10.5px; color: var(--rs-fg3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rs-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--rs-fg3); flex: none; }
.rs-dot.on { background: var(--rs-ok); }
.rs-dot.warn { background: var(--rs-warn); }
.rs-dot.err { background: var(--rs-err); }

.rs-foot { display: flex; align-items: center; gap: 8px; padding: 5px 9px; border-top: 1px solid var(--rs-line); background: var(--rs-layer1); color: var(--rs-fg3); font-size: 10.5px; flex: none; }
.rs-foot .rs-sep { width: 1px; height: 9px; background: var(--rs-line2); }

.rs-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.rs-scroll { flex: 1; min-height: 0; overflow: auto; }

/* ── controls ───────────────────────────────────────────────────────── */
.rs-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  height: 26px; padding: 0 9px; border-radius: 6px; cursor: pointer;
  border: 1px solid var(--rs-line2); background: var(--rs-bg); color: var(--rs-fg2);
  font: inherit; white-space: nowrap;
}
.rs-btn:hover:not(:disabled) { color: var(--rs-fg); border-color: var(--rs-fg3); }
.rs-btn:disabled { opacity: .45; cursor: default; }
.rs-btn.primary { background: var(--rs-accent); border-color: var(--rs-accent); color: #fff; font-weight: 500; }
.rs-btn.primary:hover:not(:disabled) { filter: brightness(1.06); color: #fff; }
.rs-btn.ghost { border-color: transparent; background: transparent; }
.rs-btn.ghost:hover:not(:disabled) { background: var(--rs-hover); }
.rs-btn.danger { color: var(--rs-err); border-color: var(--rs-err); }
.rs-btn.sm { height: 22px; padding: 0 7px; font-size: 11px; border-radius: 5px; }
.rs-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; border-radius: 5px; cursor: pointer; color: var(--rs-fg3);
  border: 0; background: transparent; padding: 0; flex: none;
}
.rs-icon:hover { background: var(--rs-hover); color: var(--rs-fg); }
.rs-icon[disabled] { opacity: .4; cursor: default; }
.rs-icon svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.rs-icon svg.sm { width: 11px; height: 11px; }

.rs-input, .rs-select {
  width: 100%; height: 27px; padding: 0 7px; border-radius: 6px; outline: none;
  border: 1px solid var(--rs-line2); background: var(--rs-bg); color: var(--rs-fg);
  font: 11.5px/1 var(--rs-mono);
}
.rs-select { font-family: inherit; }
.rs-input:focus, .rs-select:focus { border-color: var(--rs-accent); box-shadow: 0 0 0 2px var(--rs-layer2); }
.rs-field { display: grid; gap: 3px; }
.rs-field > label { font-size: 10.5px; color: var(--rs-fg3); }
.rs-grid2 { display: grid; grid-template-columns: 1fr 74px; gap: 6px; }

.rs-badge { display: inline-flex; align-items: center; gap: 3px; padding: 0 5px; height: 15px; border-radius: 4px; font-size: 10px; font-family: var(--rs-mono); background: var(--rs-layer2); color: var(--rs-fg2); }
.rs-badge.warn { background: rgba(162,97,10,.12); color: var(--rs-warn); }
.rs-badge.err { background: rgba(192,51,43,.12); color: var(--rs-err); }
.rs-badge.ok { background: rgba(18,128,92,.12); color: var(--rs-ok); }

/* ── tree ───────────────────────────────────────────────────────────── */
.rs-crumb { display: flex; align-items: center; gap: 2px; flex: 1; min-width: 0; font-family: var(--rs-mono); font-size: 11px; color: var(--rs-fg2); overflow: hidden; }
.rs-crumb b { color: var(--rs-fg); font-weight: 600; }
.rs-crumb .rs-sl { color: var(--rs-fg3); }
.rs-row { display: flex; align-items: center; gap: 5px; height: 24px; padding: 0 6px; border-radius: 5px; cursor: default; color: var(--rs-fg2); user-select: none; }
.rs-row:hover { background: var(--rs-hover); }
.rs-row.sel { background: var(--rs-layer2); color: var(--rs-fg); }
.rs-row .rs-name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rs-row .rs-tags { margin-left: auto; display: flex; gap: 4px; align-items: center; }
.rs-chev { width: 11px; height: 11px; flex: none; color: var(--rs-fg3); transition: transform .12s; }
.rs-chev.open { transform: rotate(90deg); }
.rs-fico { width: 13px; height: 13px; flex: none; color: var(--rs-fg3); }
.rs-fico.dir { color: var(--rs-accent); }

/* ── code / preview ─────────────────────────────────────────────────── */
.rs-peek { border-top: 1px solid var(--rs-line); background: var(--rs-layer1); flex: none; }
.rs-peek-head { display: flex; align-items: center; gap: 6px; padding: 6px 9px; }
.rs-peek-path { font-family: var(--rs-mono); font-size: 11px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rs-code {
  width: 100%; min-height: 96px; max-height: 40vh; resize: vertical; display: block;
  margin: 0; padding: 8px 10px; border: 0; border-top: 1px solid var(--rs-line);
  background: var(--rs-bg); color: var(--rs-fg); font: 11px/1.6 var(--rs-mono);
  tab-size: 2; outline: none; white-space: pre; overflow: auto;
}
.rs-peek-acts { display: flex; gap: 6px; padding: 7px 9px; }

/* ── terminal ───────────────────────────────────────────────────────── */
.rs-term-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--rs-bg); }
.rs-term-host { flex: 1; min-height: 0; padding: 4px 6px; overflow: hidden; }
.rs-term-host .xterm { height: 100%; }
.rs-term-status { display: flex; align-items: center; gap: 7px; padding: 4px 9px; border-bottom: 1px solid var(--rs-line); font-family: var(--rs-mono); font-size: 10px; color: var(--rs-fg3); flex: none; }
.rs-banner { display: flex; gap: 6px; align-items: flex-start; padding: 6px 9px; background: rgba(162,97,10,.10); color: var(--rs-warn); font-size: 11px; border-bottom: 1px solid var(--rs-line); flex: none; }

/* ── cards ──────────────────────────────────────────────────────────── */
.rs-card { border: 1px solid var(--rs-line); border-radius: 8px; background: var(--rs-bg); margin: 8px; overflow: hidden; }
.rs-card-h { display: flex; align-items: center; gap: 6px; padding: 7px 9px; border-bottom: 1px solid var(--rs-line); font-size: 11.5px; color: var(--rs-fg2); }
.rs-card-h b { color: var(--rs-fg); font-weight: 600; }
.rs-card-b { padding: 8px 9px; display: grid; gap: 7px; }
.rs-map-row { display: flex; align-items: center; gap: 6px; font-family: var(--rs-mono); font-size: 10.5px; }
.rs-path { padding: 1px 5px; border-radius: 4px; background: var(--rs-layer2); color: var(--rs-fg2); max-width: 42%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rs-q { display: flex; align-items: center; gap: 6px; padding: 5px 9px; border-bottom: 1px solid var(--rs-line); font-size: 11px; }
.rs-q:last-child { border-bottom: 0; }
.rs-q .rs-qname { font-family: var(--rs-mono); font-size: 10.5px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--rs-fg2); }
.rs-q .rs-qstate { font-family: var(--rs-mono); font-size: 10px; color: var(--rs-fg3); flex: none; }

/* Forward rule: addresses on one line, state and actions on the next — four
   action buttons never fit beside two addresses in a 424px panel. */
.rs-frow { padding: 6px 9px; border-bottom: 1px solid var(--rs-line); display: grid; gap: 5px; }
.rs-frow:last-child { border-bottom: 0; }
.rs-frow-l { display: flex; align-items: center; gap: 5px; min-width: 0; font-family: var(--rs-mono); font-size: 10.5px; }
.rs-frow-l .rs-path { max-width: none; flex: 0 1 auto; }
.rs-frow-r { display: flex; align-items: center; gap: 5px; }
.rs-frow-meta { font-family: var(--rs-mono); font-size: 10px; color: var(--rs-fg3); white-space: nowrap; }
.rs-empty { padding: 26px 18px; text-align: center; color: var(--rs-fg3); font-size: 11.5px; }
.rs-empty h3 { margin: 0 0 4px; font-size: 12.5px; color: var(--rs-fg); font-weight: 600; }
.rs-empty p { margin: 0 0 12px; line-height: 1.6; }
.rs-notice { margin: 8px; padding: 7px 9px; border-radius: 7px; font-size: 11px; background: rgba(192,51,43,.1); color: var(--rs-err); display: flex; gap: 6px; align-items: flex-start; }
.rs-toast { position: absolute; left: 50%; bottom: 34px; transform: translateX(-50%); background: var(--rs-fg); color: var(--rs-bg); padding: 5px 10px; border-radius: 6px; font-size: 11px; z-index: 20; max-width: 88%; }
.rs-modal-bg { position: absolute; inset: 0; background: rgba(0,0,0,.28); display: grid; place-items: center; z-index: 30; padding: 14px; }
.rs-modal { background: var(--rs-bg); border-radius: 9px; border: 1px solid var(--rs-line); width: 100%; max-height: 100%; overflow: auto; box-shadow: 0 12px 32px -12px rgba(0,0,0,.4); }
.rs-modal-h { display: flex; align-items: center; padding: 9px 11px; border-bottom: 1px solid var(--rs-line); font-weight: 600; }
.rs-modal-b { padding: 10px 11px; display: grid; gap: 8px; }
.rs-modal-f { display: flex; gap: 6px; padding: 9px 11px; border-top: 1px solid var(--rs-line); }
.rs-muted { color: var(--rs-fg3); font-size: 10.5px; line-height: 1.55; }
.rs-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.rs-scroll::-webkit-scrollbar-thumb { background: var(--rs-line2); border-radius: 4px; }
`
