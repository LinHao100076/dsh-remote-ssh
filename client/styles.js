/**
 * Stylesheet for the remote panel, injected once from inside the client factory.
 *
 * The visual language is the one in `ui/prototype.html`: one host header, one
 * underlined tab strip, flat cards, mono for anything that is a path or a
 * number. The palette is the prototype's own light/dark pair, resolved through
 * `light-dark()` so the panel follows DSH's `color-scheme` — DSH's `--dsw-*`
 * aliases are deliberately *not* used for colour: in the current build the
 * brand colour is monochrome (#0f1115) and the border alias is 4% black, which
 * flattens the prototype's blue accents and hides every divider.
 *
 * Only the font stack is borrowed from the host, so the panel is set in the
 * same mono face as the editor around it.
 *
 * Every selector is `rs-` prefixed — this CSS lands in the same document as
 * every other plugin's.
 * @module dsh-remote-ssh/client/styles
 */
export const CSS = `
.rs-root {
  /* Light palette: ui/prototype.html :root. */
  --rs-bg: #ffffff;
  --rs-layer1: #fafbfc;
  --rs-layer2: #f1f3f6;
  --rs-line: #e6e8ec;
  --rs-line2: #d8dce3;
  --rs-fg: #1c2028;
  --rs-fg2: #5c6472;
  --rs-fg3: #8d95a3;
  --rs-accent: #2f6feb;
  --rs-accent-soft: #e8f0ff;
  --rs-hover: rgba(16, 24, 40, .045);
  --rs-ok: #12805c;
  --rs-ok-soft: #e4f4ee;
  --rs-warn: #a2610a;
  --rs-warn-soft: #fdf1dd;
  --rs-err: #c0332b;
  --rs-err-soft: #fdeceb;
  --rs-violet: #6b4fd8;
  --rs-term-bg: #fbfbfd;
  --rs-term-fg: #24292f;
  --rs-shadow: 0 1px 2px rgba(16, 24, 40, .06), 0 8px 24px -12px rgba(16, 24, 40, .18);
  --rs-mono: var(--ds-font-family-code, ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace);

  display: flex; flex-direction: column; height: 100%; min-height: 0;
  background: var(--rs-bg); color: var(--rs-fg); position: relative; overflow: hidden;
  font: 12.5px/1.5 ui-sans-serif, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  -webkit-font-smoothing: antialiased;
}

/*
 * Dark palette: ui/prototype.html html[data-theme="dark"], keyed off the host
 * color-scheme instead of an attribute we do not own. Engines without
 * light-dark() keep the light values above.
 */
@supports (color: light-dark(#ffffff, #000000)) {
  .rs-root {
    --rs-bg: light-dark(#ffffff, #15181e);
    --rs-layer1: light-dark(#fafbfc, #191d24);
    --rs-layer2: light-dark(#f1f3f6, #1e232b);
    --rs-line: light-dark(#e6e8ec, #262b34);
    --rs-line2: light-dark(#d8dce3, #333a46);
    --rs-fg: light-dark(#1c2028, #e7eaf0);
    --rs-fg2: light-dark(#5c6472, #a2abb9);
    --rs-fg3: light-dark(#8d95a3, #737c8a);
    --rs-accent: light-dark(#2f6feb, #6ba1ff);
    --rs-accent-soft: light-dark(#e8f0ff, #1b2942);
    --rs-hover: light-dark(rgba(16, 24, 40, .045), rgba(255, 255, 255, .06));
    --rs-ok: light-dark(#12805c, #45c08d);
    --rs-ok-soft: light-dark(#e4f4ee, #12291f);
    --rs-warn: light-dark(#a2610a, #e2ab55);
    --rs-warn-soft: light-dark(#fdf1dd, #2b2313);
    --rs-err: light-dark(#c0332b, #f07f74);
    --rs-err-soft: light-dark(#fdeceb, #2d1917);
    --rs-violet: light-dark(#6b4fd8, #a48bff);
    --rs-term-bg: light-dark(#fbfbfd, #101318);
    --rs-term-fg: light-dark(#24292f, #dbe1ea);
    --rs-shadow: 0 1px 2px light-dark(rgba(16, 24, 40, .06), rgba(0, 0, 0, .4)),
      0 8px 24px -12px light-dark(rgba(16, 24, 40, .18), rgba(0, 0, 0, .7));
  }
}

.rs-root *, .rs-root *::before, .rs-root *::after { box-sizing: border-box; }
.rs-root :where(button) { font: inherit; color: inherit; background: none; border: 0; cursor: pointer; padding: 0; }
.rs-root :where(button:disabled) { cursor: default; }
.rs-root :where(svg) { display: block; }
.rs-root .ic { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.rs-root :where(input, select, textarea) { font: inherit; }

/* ── panel header ───────────────────────────────────────────────────── */
.rs-phead { padding: 12px 14px 0; border-bottom: 1px solid var(--rs-line); flex: none; background: var(--rs-bg); }
.rs-hostline { display: flex; align-items: center; gap: 9px; }
.rs-hostico {
  width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center;
  background: var(--rs-layer2); color: var(--rs-fg2); flex: none;
}
.rs-hosttxt { min-width: 0; flex: 1; }
.rs-hostname {
  display: flex; align-items: center; gap: 6px; max-width: 100%;
  font-weight: 600; letter-spacing: -.01em; color: var(--rs-fg);
  border-radius: 5px; padding: 1px 4px 1px 2px; margin-left: -2px;
}
.rs-hostname:hover { background: var(--rs-hover); }
.rs-hostname > span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rs-hostname .rs-chev-d { color: var(--rs-fg3); }
.rs-hostmeta {
  font-size: 11px; color: var(--rs-fg3); font-family: var(--rs-mono);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-left: 2px;
}
.rs-hostauth { display: flex; gap: 2px; flex: none; }

.rs-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--rs-fg3); flex: none; }
.rs-dot.on { background: var(--rs-ok); box-shadow: 0 0 0 3px var(--rs-ok-soft); }
.rs-dot.warn { background: var(--rs-warn); box-shadow: 0 0 0 3px var(--rs-warn-soft); }
.rs-dot.err { background: var(--rs-err); box-shadow: 0 0 0 3px var(--rs-err-soft); }
.rs-dot.pulse { animation: rs-pulse 1.3s ease-in-out infinite; }
@keyframes rs-pulse { 0%, 100% { opacity: 1 } 50% { opacity: .35 } }
@keyframes rs-spin { to { transform: rotate(360deg) } }

/* ── tab strip ──────────────────────────────────────────────────────── */
.rs-tabs { display: flex; gap: 1px; margin-top: 10px; overflow: hidden; }
.rs-tab {
  position: relative; padding: 6px 8px 8px; color: var(--rs-fg3); font-size: 12px;
  display: flex; align-items: center; gap: 5px; border-radius: 6px 6px 0 0; white-space: nowrap;
}
.rs-tab:hover { color: var(--rs-fg); background: var(--rs-layer1); }
.rs-tab[aria-selected="true"] { color: var(--rs-fg); font-weight: 500; }
.rs-tab[aria-selected="true"]::after {
  content: ""; position: absolute; left: 6px; right: 6px; bottom: -1px; height: 2px;
  background: var(--rs-accent); border-radius: 2px 2px 0 0;
}
.rs-tab .rs-count {
  min-width: 15px; height: 15px; padding: 0 4px; border-radius: 999px; font-size: 10px;
  display: grid; place-items: center; background: var(--rs-warn-soft); color: var(--rs-warn);
  font-weight: 600; font-family: var(--rs-mono);
}

/* ── body + footer ──────────────────────────────────────────────────── */
.rs-pbody { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
.rs-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.rs-pane[hidden] { display: none; }
.rs-pfoot {
  border-top: 1px solid var(--rs-line); padding: 6px 12px; display: flex; align-items: center; gap: 9px;
  font-size: 10.5px; color: var(--rs-fg3); background: var(--rs-layer1); flex: none;
  white-space: nowrap; overflow: hidden;
}
.rs-pfoot b { font-weight: 500; color: var(--rs-fg2); }
.rs-pfoot .rs-sep { width: 1px; height: 10px; background: var(--rs-line2); flex: none; }
.rs-pfoot .rs-grow { flex: 1; }

/* ── buttons / inputs ───────────────────────────────────────────────── */
.rs-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 28px; padding: 0 11px; border-radius: 7px; border: 1px solid var(--rs-line2);
  background: var(--rs-bg); color: var(--rs-fg2); font-size: 12px; transition: color .14s, border-color .14s, background .14s;
  white-space: nowrap;
}
.rs-btn:hover:not(:disabled) { border-color: var(--rs-fg3); color: var(--rs-fg); }
.rs-btn:disabled { opacity: .45; }
.rs-btn.primary { background: var(--rs-accent); border-color: var(--rs-accent); color: #fff; font-weight: 500; }
.rs-btn.primary:hover:not(:disabled) { filter: brightness(1.06); color: #fff; }
.rs-btn.ghost { border-color: transparent; background: transparent; }
.rs-btn.ghost:hover:not(:disabled) { background: var(--rs-hover); }
.rs-btn.danger { color: var(--rs-err); border-color: var(--rs-err-soft); }
.rs-btn.danger:hover:not(:disabled) { border-color: var(--rs-err); color: var(--rs-err); }
.rs-btn.sm { height: 24px; padding: 0 8px; font-size: 11.5px; border-radius: 6px; }

.rs-icon {
  width: 24px; height: 24px; border-radius: 6px; display: grid; place-items: center;
  color: var(--rs-fg3); border: 0; background: transparent; flex: none;
}
.rs-icon:hover:not(:disabled) { background: var(--rs-hover); color: var(--rs-fg); }
.rs-icon:disabled { opacity: .4; }
.rs-icon.on { background: var(--rs-accent-soft); color: var(--rs-accent); }

.rs-field { display: grid; gap: 4px; min-width: 0; }
.rs-field > label { font-size: 11px; color: var(--rs-fg3); }
.rs-input, .rs-select {
  width: 100%; height: 30px; padding: 0 9px; border-radius: 7px; border: 1px solid var(--rs-line2);
  background: var(--rs-bg); color: var(--rs-fg); font: 12px var(--rs-mono); outline: none;
}
.rs-select { font-family: inherit; }
.rs-input:focus, .rs-select:focus { border-color: var(--rs-accent); box-shadow: 0 0 0 3px var(--rs-accent-soft); }
.rs-grid2 { display: grid; grid-template-columns: 1fr 84px; gap: 8px; }
/* Both cells carry the same kind of control (a port and an address), so they get
   equal room; the 84px column above is for a wide field beside a short one. */
.rs-grid2.even { grid-template-columns: 1fr 1fr; }
.rs-grid2.wide { grid-template-columns: 1fr 118px; }
.rs-rowacts { display: flex; gap: 6px; flex-wrap: wrap; }
.rs-rowacts .rs-btn { flex: none; }

.rs-seg { display: flex; background: var(--rs-layer2); border-radius: 7px; padding: 2px; gap: 2px; }
.rs-seg button { flex: 1; height: 24px; border-radius: 5px; font-size: 11.5px; color: var(--rs-fg3); white-space: nowrap; }
.rs-seg button[aria-selected="true"] { background: var(--rs-bg); color: var(--rs-fg); font-weight: 500; box-shadow: 0 1px 2px rgba(0,0,0,.08); }

.rs-badge {
  display: inline-flex; align-items: center; gap: 3px; padding: 0 5px; height: 16px; border-radius: 4px;
  font-size: 10px; font-family: var(--rs-mono); background: var(--rs-layer2); color: var(--rs-fg2); flex: none;
}
.rs-badge.ok { background: var(--rs-ok-soft); color: var(--rs-ok); }
.rs-badge.warn { background: var(--rs-warn-soft); color: var(--rs-warn); }
.rs-badge.err { background: var(--rs-err-soft); color: var(--rs-err); }

/* ── files ──────────────────────────────────────────────────────────── */
.rs-bar { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--rs-line); flex: none; }
.rs-file-location, .rs-file-progress {
  display: flex; align-items: center; gap: 6px; padding: 5px 12px; flex: none;
  border-bottom: 1px solid var(--rs-line); color: var(--rs-fg3); font-size: 10.5px;
}
.rs-file-location > :not(.rs-file-location-path) { flex: none; }
.rs-file-location-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rs-file-location .rs-file-location-path { font-family: var(--rs-mono); }
.rs-file-action { margin: 8px 12px 0; flex: none; max-height: 60%; overflow: auto; }
.rs-inline-form { display: grid; gap: 9px; padding-top: 9px; border-top: 1px solid var(--rs-line); }
.rs-crumb {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 1px;
  font-family: var(--rs-mono); font-size: 11.5px; color: var(--rs-fg2); overflow: hidden;
}
.rs-crumb button { color: var(--rs-fg2); border-radius: 4px; padding: 1px 2px; }
.rs-crumb button:hover { color: var(--rs-fg); background: var(--rs-hover); }
.rs-crumb .rs-sl { color: var(--rs-fg3); }
.rs-crumb .rs-last { color: var(--rs-fg); font-weight: 600; }
.rs-crumb .rs-crumb-host { color: var(--rs-fg3); }

.rs-tree { flex: 1; min-height: 0; overflow: auto; padding: 4px 6px 8px; }
.rs-row {
  display: flex; align-items: center; gap: 6px; padding: 0 6px; height: 26px; border-radius: 6px;
  color: var(--rs-fg2); cursor: default; position: relative; user-select: none;
}
.rs-row:hover { background: var(--rs-hover); }
.rs-row.sel { background: var(--rs-accent-soft); color: var(--rs-fg); }
.rs-chev { width: 12px; height: 12px; flex: none; color: var(--rs-fg3); transition: transform .12s; }
.rs-crumb button { padding: 1px 1px; }
.rs-chev.open { transform: rotate(90deg); }
.rs-row .rs-fico { width: 13px; height: 13px; flex: none; color: var(--rs-fg3); }
.rs-row .rs-fico.dir { color: var(--rs-accent); }
.rs-row .rs-name { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rs-row .rs-tags { margin-left: auto; display: flex; align-items: center; gap: 4px; font-size: 10.5px; font-family: var(--rs-mono); flex: none; }
.rs-row .rs-tags .rs-link { display: flex; color: var(--rs-accent); }
.rs-row .rs-acts { display: none; margin-left: auto; gap: 2px; flex: none; }
.rs-row:hover .rs-acts { display: flex; }
.rs-row:hover .rs-acts ~ .rs-tags, .rs-row:hover .rs-tags { display: none; }
.rs-act { width: 20px; height: 20px; border-radius: 5px; display: grid; place-items: center; color: var(--rs-fg3); }
.rs-act:hover { background: var(--rs-bg); color: var(--rs-fg); box-shadow: 0 0 0 1px var(--rs-line); }
.rs-hint { padding: 14px 16px; text-align: center; color: var(--rs-fg3); font-size: 11.5px; }

.rs-peek { border-top: 1px solid var(--rs-line); background: var(--rs-layer1); flex: none; max-height: 52%; display: flex; flex-direction: column; }
.rs-peek-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px 6px; flex: none; }
.rs-peek-path { font-family: var(--rs-mono); font-size: 11.5px; color: var(--rs-fg); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rs-peek-meta { font-size: 10.5px; color: var(--rs-fg3); font-family: var(--rs-mono); flex: none; }
.rs-code {
  margin: 0 12px 8px; padding: 8px 10px; border-radius: 7px; background: var(--rs-bg);
  border: 1px solid var(--rs-line); font: 11px/1.65 var(--rs-mono); color: var(--rs-fg);
  overflow: auto; min-height: 84px; max-height: 34vh; display: block; width: auto;
  white-space: pre; outline: none; resize: none; tab-size: 2;
}
.rs-peek-acts { display: flex; gap: 6px; padding: 0 12px 10px; flex: none; }
.rs-peek-acts .rs-grow { flex: 1; }
.rs-st { font-weight: 700; font-family: var(--rs-mono); font-size: 10.5px; }
.rs-st.m { color: var(--rs-warn); }
.rs-st.a { color: var(--rs-ok); }
.rs-st.d { color: var(--rs-err); }
.rs-st.u { color: var(--rs-fg3); }

/* ── terminal ───────────────────────────────────────────────────────── */
.rs-ttabs { display: flex; align-items: center; gap: 2px; padding: 6px 8px; border-bottom: 1px solid var(--rs-line); flex: none; overflow: hidden; }
.rs-ttab {
  display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px;
  font-family: var(--rs-mono); font-size: 11.5px; color: var(--rs-fg2); max-width: 190px;
}
.rs-ttab:hover { background: var(--rs-hover); }
.rs-ttab[aria-selected="true"] { background: var(--rs-layer2); color: var(--rs-fg); }
.rs-ttab .rs-tname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rs-ttab .rs-x { color: var(--rs-fg3); display: flex; }
.rs-ttab .rs-x:hover { color: var(--rs-fg); }
.rs-term-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--rs-term-bg); }
.rs-term-status {
  display: flex; align-items: center; gap: 8px; padding: 5px 12px; font-size: 10.5px; color: var(--rs-fg3);
  font-family: var(--rs-mono); border-bottom: 1px solid var(--rs-line); flex: none;
  white-space: nowrap; overflow: hidden;
}
.rs-term-host { flex: 1; min-height: 0; padding: 8px 10px 4px; overflow: hidden; }
.rs-term-host .xterm { height: 100%; }
.rs-term-shell { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.rs-term-shell[hidden] { display: none; }
.rs-hintbar {
  display: flex; align-items: center; gap: 10px; padding: 5px 12px; border-top: 1px solid var(--rs-line);
  font-size: 10.5px; color: var(--rs-fg3); background: var(--rs-layer1); flex: none;
}
.rs-hintbar kbd {
  font: 10.5px var(--rs-mono); padding: 1px 4px; border: 1px solid var(--rs-line2); border-bottom-width: 2px;
  border-radius: 4px; color: var(--rs-fg2); background: var(--rs-bg); margin-right: 3px;
}
.rs-hintbar button { color: var(--rs-fg3); font-size: 10.5px; }
.rs-hintbar button:hover { color: var(--rs-fg); }

/* ── remote content search ──────────────────────────────────────────── */
.rs-search { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.rs-sfield {
  display: flex; align-items: center; gap: 6px; margin: 8px 12px 0; padding: 0 8px; height: 30px;
  border-radius: 7px; border: 1px solid var(--rs-line2); background: var(--rs-bg); flex: none;
}
.rs-sfield:focus-within { border-color: var(--rs-accent); box-shadow: 0 0 0 3px var(--rs-accent-soft); }
.rs-sico { color: var(--rs-fg3); flex: none; }
.rs-sinput {
  flex: 1; min-width: 0; height: 28px; border: 0; background: transparent; outline: none;
  color: var(--rs-fg); font: 12px var(--rs-mono);
}
.rs-sinput::placeholder { color: var(--rs-fg3); }
.rs-sx { flex: none; width: 18px; height: 18px; border-radius: 4px; display: grid; place-items: center; color: var(--rs-fg3); }
.rs-sx:hover { background: var(--rs-hover); color: var(--rs-fg); }

.rs-sopts { display: flex; align-items: center; gap: 5px; padding: 7px 12px 5px; flex: none; }
.rs-search-mode { width: 128px; flex: none; }
.rs-stog {
  height: 20px; min-width: 22px; padding: 0 5px; border-radius: 5px; border: 1px solid var(--rs-line2);
  background: var(--rs-bg); color: var(--rs-fg3); font: 10.5px var(--rs-mono); flex: none;
}
.rs-stog:hover { color: var(--rs-fg); border-color: var(--rs-fg3); }
.rs-stog.on { background: var(--rs-accent-soft); border-color: var(--rs-accent); color: var(--rs-accent); font-weight: 600; }
.rs-snum {
  margin-left: auto; font: 10.5px var(--rs-mono); color: var(--rs-fg3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.rs-sres { flex: 1; min-height: 0; overflow: auto; padding: 2px 6px 8px; }
.rs-sgroup { margin-bottom: 4px; }
.rs-sghead {
  display: flex; align-items: center; gap: 5px; padding: 3px 6px; border-radius: 5px;
  font: 11px var(--rs-mono); color: var(--rs-fg2); position: sticky; top: 0;
  background: var(--rs-layer1); z-index: 1;
}
.rs-sghead .rs-fico { flex: none; color: var(--rs-fg3); }
.rs-sgpath { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rs-sgn { flex: none; font-size: 10px; color: var(--rs-fg3); background: var(--rs-layer2); border-radius: 4px; padding: 0 4px; }
.rs-shit {
  display: flex; gap: 8px; padding: 2px 6px 2px 14px; border-radius: 5px;
  font: 11px/1.62 var(--rs-mono); color: var(--rs-fg2);
}
.rs-shit:hover { background: var(--rs-hover); color: var(--rs-fg); }
.rs-shit.sel { background: var(--rs-accent-soft); color: var(--rs-fg); }
.rs-shn { flex: none; width: 34px; text-align: right; color: var(--rs-fg3); font-variant-numeric: tabular-nums; }
.rs-sht { flex: 1; min-width: 0; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
.rs-mark { background: var(--rs-warn-soft); color: var(--rs-warn); border-radius: 3px; padding: 0 1px; }

/* ── cards (sync / forward / settings) ──────────────────────────────── */
.rs-scroll { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.rs-card { border: 1px solid var(--rs-line); border-radius: 9px; background: var(--rs-bg); margin-bottom: 10px; overflow: hidden; }
.rs-card-h { display: flex; align-items: center; gap: 8px; padding: 9px 11px; border-bottom: 1px solid var(--rs-line); font-size: 11.5px; color: var(--rs-fg2); }
.rs-card-h b { color: var(--rs-fg); font-weight: 600; font-size: 12px; }
.rs-card-h .rs-grow { flex: 1; }
.rs-card-b { padding: 10px 11px; display: grid; gap: 9px; }
.rs-map-row { display: flex; align-items: center; gap: 8px; font-family: var(--rs-mono); font-size: 11px; min-width: 0; }
.rs-map-row .rs-path { flex: 0 1 auto; max-width: 62%; }
.rs-path {
  padding: 2px 6px; border-radius: 5px; background: var(--rs-layer2); color: var(--rs-fg2);
  flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rs-arrow { color: var(--rs-fg3); display: flex; gap: 1px; flex: none; }
.rs-qitem { display: flex; align-items: center; gap: 8px; padding: 7px 11px; border-bottom: 1px solid var(--rs-line); font-size: 11.5px; position: relative; }
.rs-qitem:last-child { border-bottom: 0; }
.rs-qico { width: 18px; height: 18px; border-radius: 5px; display: grid; place-items: center; flex: none; }
.rs-qico.up { background: var(--rs-accent-soft); color: var(--rs-accent); }
.rs-qico.dn { background: var(--rs-ok-soft); color: var(--rs-ok); }
.rs-qico.off { background: var(--rs-layer2); color: var(--rs-fg3); }
.rs-qname { font-family: var(--rs-mono); font-size: 11px; color: var(--rs-fg2); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rs-qstate { font-size: 10.5px; color: var(--rs-fg3); font-family: var(--rs-mono); flex: none; }
.rs-qbar { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--rs-accent); transition: width .3s; }
.rs-qbar.indeterminate { width: 32%; animation: rs-slide 1.15s ease-in-out infinite; }
@keyframes rs-slide { 0% { left: 0; width: 18% } 50% { left: 40%; width: 34% } 100% { left: 82%; width: 18% } }
.rs-frow { padding: 8px 11px; border-bottom: 1px solid var(--rs-line); display: grid; gap: 6px; }
.rs-frow:last-child { border-bottom: 0; }
.rs-frow-l { display: flex; align-items: center; gap: 5px; min-width: 0; font-family: var(--rs-mono); font-size: 11px; }
.rs-frow-l .rs-path { flex: 0 1 auto; }
.rs-kind {
  flex: none; width: 15px; height: 15px; border-radius: 4px; display: grid; place-items: center;
  font-size: 9.5px; font-weight: 700; line-height: 1; color: var(--rs-fg3); background: var(--rs-layer2);
  font-family: var(--rs-mono, monospace);
}
.rs-frow-r { display: flex; align-items: center; gap: 6px; min-width: 0; }
.rs-frow-r .rs-grow { flex: 1; }
.rs-stat { display: flex; gap: 14px; padding: 9px 12px; font-size: 10.5px; color: var(--rs-fg3); font-family: var(--rs-mono); border-top: 1px solid var(--rs-line); }
.rs-stat b { color: var(--rs-fg2); font-weight: 600; }
.rs-stat .rs-grow { flex: 1; }
.rs-conflict { border: 1px solid color-mix(in srgb, var(--rs-warn) 32%, var(--rs-line)); background: var(--rs-warn-soft); border-radius: 9px; padding: 10px 11px; margin-bottom: 10px; }
.rs-conflict-h { display: flex; align-items: center; gap: 7px; color: var(--rs-warn); font-size: 11.5px; font-weight: 600; margin-bottom: 4px; }
.rs-conflict p { margin: 0 0 8px; font-size: 11.5px; color: var(--rs-fg2); line-height: 1.55; }
.rs-conflict .rs-acts { display: flex; gap: 6px; }
.rs-muted { color: var(--rs-fg3); font-size: 10.5px; line-height: 1.6; }
.rs-sect { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--rs-fg3); margin: 16px 0 8px; }
.rs-sect:first-child { margin-top: 2px; }
.rs-empty { padding: 30px 18px; text-align: center; color: var(--rs-fg3); font-size: 11.5px; }
.rs-empty h3 { margin: 0 0 4px; font-size: 12.5px; color: var(--rs-fg); font-weight: 600; }
.rs-empty p { margin: 0 0 12px; line-height: 1.6; }

/* ── connect / states ───────────────────────────────────────────────── */
.rs-center { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 22px; text-align: center; overflow: auto; }
/* The prototype's stage is 424px wide; in a panel dragged wider the centred
   states keep a readable column instead of stretching edge to edge. */
.rs-center > * { max-width: 360px; }
.rs-big-ico { width: 44px; height: 44px; border-radius: 13px; display: grid; place-items: center; background: var(--rs-layer2); color: var(--rs-fg2); margin-bottom: 12px; flex: none; }
.rs-big-ico.err { background: var(--rs-err-soft); color: var(--rs-err); }
.rs-center h2 { margin: 0 0 5px; font-size: 14px; font-weight: 600; }
.rs-center p { margin: 0 0 16px; font-size: 12px; color: var(--rs-fg3); line-height: 1.6; max-width: 290px; }
.rs-hostlist { width: 100%; display: grid; gap: 6px; margin-bottom: 14px; }
.rs-hitem {
  display: flex; align-items: center; gap: 9px; padding: 9px 10px; border: 1px solid var(--rs-line);
  border-radius: 9px; text-align: left; width: 100%;
}
.rs-hitem:hover { border-color: var(--rs-line2); background: var(--rs-layer1); }
.rs-hitem[aria-current="true"] { border-color: var(--rs-accent); background: var(--rs-accent-soft); }
.rs-hitem .rs-hico { color: var(--rs-fg3); flex: none; }
.rs-hitem .rs-htxt { min-width: 0; flex: 1; }
.rs-hitem .rs-nm { font-family: var(--rs-mono); font-size: 11.5px; color: var(--rs-fg); display: flex; align-items: center; gap: 6px; }
.rs-hitem .rs-ad { font-size: 10.5px; color: var(--rs-fg3); font-family: var(--rs-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rs-hitem .rs-r { margin-left: auto; color: var(--rs-fg3); flex: none; display: flex; align-items: center; gap: 4px; }
.rs-hintline { font-size: 10.5px; color: var(--rs-fg3); display: flex; align-items: center; gap: 5px; justify-content: center; margin-top: 12px; }
.rs-steps { width: 100%; display: grid; gap: 2px; text-align: left; margin-bottom: 10px; }
.rs-step { display: flex; align-items: center; gap: 9px; padding: 7px 2px; font-size: 12px; color: var(--rs-fg3); }
.rs-step .rs-mark { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--rs-line2); display: grid; place-items: center; flex: none; }
.rs-step.done { color: var(--rs-fg2); }
.rs-step.done .rs-mark { border-color: var(--rs-ok); background: var(--rs-ok); color: #fff; }
.rs-step.now { color: var(--rs-fg); }
.rs-step.now .rs-mark { border-color: var(--rs-accent); border-top-color: transparent; animation: rs-spin .8s linear infinite; }
.rs-err-box { width: 100%; border: 1px solid color-mix(in srgb, var(--rs-err) 26%, var(--rs-line)); background: var(--rs-err-soft); border-radius: 9px; padding: 10px; text-align: left; margin-bottom: 12px; }
.rs-err-box .rs-t { display: flex; align-items: center; gap: 6px; color: var(--rs-err); font-weight: 600; font-size: 12px; margin-bottom: 3px; }
.rs-err-box code { font-family: var(--rs-mono); font-size: 10.5px; color: var(--rs-fg2); word-break: break-word; }
.rs-cred { width: 100%; display: grid; gap: 8px; margin-bottom: 12px; text-align: left; }
.rs-center .rs-rowacts { display: flex; gap: 6px; width: 100%; }
.rs-center .rs-rowacts .rs-btn { flex: 1; }

/* ── host menu ──────────────────────────────────────────────────────── */
.rs-menu-bg { position: absolute; inset: 0; z-index: 24; }
.rs-hostmenu {
  position: absolute; left: 12px; right: 12px; top: 44px; z-index: 25;
  background: var(--rs-bg); border: 1px solid var(--rs-line2); border-radius: 10px;
  box-shadow: var(--rs-shadow); padding: 4px; max-height: 70%; overflow: auto;
}
.rs-hmhead { font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: var(--rs-fg3); padding: 6px 8px 4px; }
.rs-hmitem { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 8px; border-radius: 7px; text-align: left; }
.rs-hmitem:hover { background: var(--rs-hover); }
.rs-hmitem[aria-current="true"] { background: var(--rs-accent-soft); }
.rs-hmitem .rs-htxt { min-width: 0; flex: 1; }
.rs-hmitem .rs-nm { font-size: 12px; color: var(--rs-fg); display: flex; align-items: center; gap: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rs-hmitem .rs-ad { font-size: 10.5px; color: var(--rs-fg3); font-family: var(--rs-mono); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rs-hmsep { height: 1px; background: var(--rs-line); margin: 4px 6px; }
.rs-hmadd { display: flex; align-items: center; gap: 7px; width: 100%; padding: 8px; border-radius: 7px; color: var(--rs-fg2); font-size: 12px; }
.rs-hmadd:hover { background: var(--rs-hover); color: var(--rs-fg); }

/* ── modal (credentials) ────────────────────────────────────────────── */
.rs-modal-bg { position: absolute; inset: 0; background: rgba(0,0,0,.3); display: grid; place-items: center; z-index: 30; padding: 14px; }
.rs-modal { background: var(--rs-bg); border-radius: 10px; border: 1px solid var(--rs-line); width: 100%; max-height: 100%; overflow: auto; box-shadow: var(--rs-shadow); }
.rs-modal-h { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--rs-line); font-weight: 600; font-size: 12.5px; }
.rs-modal-h .rs-grow { flex: 1; }
.rs-modal-b { padding: 11px 12px; display: grid; gap: 9px; }
.rs-modal-f { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--rs-line); }

/* ── toast ──────────────────────────────────────────────────────────── */
.rs-toast {
  position: absolute; left: 50%; bottom: 44px; transform: translateX(-50%);
  background: var(--rs-fg); color: var(--rs-bg); padding: 6px 12px; border-radius: 8px;
  font-size: 11.5px; z-index: 40; max-width: 88%; box-shadow: 0 8px 24px -8px rgba(0,0,0,.5); text-align: center;
}

/* ── scrollbars ─────────────────────────────────────────────────────── */
.rs-root ::-webkit-scrollbar { width: 8px; height: 8px; }
.rs-root ::-webkit-scrollbar-thumb { background: var(--rs-line2); border-radius: 4px; }
.rs-root ::-webkit-scrollbar-track { background: transparent; }
`
