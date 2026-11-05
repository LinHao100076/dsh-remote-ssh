/**
 * Draft hosts in the JSON API.
 *
 * The settings pane can test a connection before it is saved, so `hosts.connect`
 * accepts a transient `draft` row. Two things about that row are easy to get
 * wrong and both were part of issue #5's confusion:
 *
 * - **Its id must be stable per target.** A random id per request left one live
 *   ssh2 client behind per click on 测试连接; borrowing the *selected* host's id
 *   (which the creating form used to do) made a brand-new host write into the
 *   connection slot of the host already in use.
 * - **An edited host must keep its pinned key.** A draft carries no fingerprint,
 *   so without inheritance "测试连接" on an existing host would re-pin whatever
 *   key answered — silently losing the TOFU protection.
 *
 * Run: `node test/api.mjs`
 */
import assert from 'node:assert/strict'
import { buildApi } from '../src/api.js'

const SAVED = {
  id: 'host-saved',
  host: '10.0.0.9',
  port: 22,
  user: 'u',
  auth: { type: 'password' },
  fingerprint: 'SHA256:pinned',
}

const seen = []
const store = {
  host: (id) => (id === SAVED.id ? { ...SAVED } : undefined),
  hosts: () => [],
  upsertHost: async () => {},
}
const pool = {
  ensure: async (host) => { seen.push(host); return {} },
  close: () => {},
  statuses: () => ({}),
  status: () => 'connected',
}
const files = { info: async () => ({ kernel: 'Linux', tmux: true }) }
const forward = { startAll: async () => [], stopHost: async () => {} }
const api = buildApi({
  ctx: {},
  store,
  pool,
  files,
  transfer: {},
  engine: { primaryMapping: () => undefined },
  forward,
  version: 'test',
})

const draft = { host: '10.0.0.9', port: 22, user: 'u', auth: { type: 'password' } }

/* the password travels, and the draft gets a key derived from the target */
await api['hosts.connect']({ draft, auth: { password: 'p' } })
assert.equal(seen[0].id, 'draft:u@10.0.0.9:22')
assert.equal(seen[0].auth.type, 'password')
assert.equal(seen[0].auth.password, 'p')

/* clicking 测试连接 again must reuse that slot instead of opening another connection */
await api['hosts.connect']({ draft, auth: { password: 'p' } })
assert.equal(seen[1].id, seen[0].id, 'a repeated test must reuse one connection slot')

/* a different target is a different slot */
await api['hosts.connect']({ draft: { ...draft, user: 'v' }, auth: { password: 'p' } })
assert.equal(seen[2].id, 'draft:v@10.0.0.9:22')

/* an edit keeps the stored host's pinned fingerprint */
await api['hosts.connect']({ draft: { ...draft, id: SAVED.id }, auth: { password: 'p' } })
assert.equal(seen[3].id, SAVED.id)
assert.equal(seen[3].fingerprint, 'SHA256:pinned', 'editing a host must keep its pinned key')

/* an explicitly supplied fingerprint still wins (re-pinning is a deliberate act) */
await api['hosts.connect']({ draft: { ...draft, id: SAVED.id, fingerprint: 'SHA256:new' }, auth: { password: 'p' } })
assert.equal(seen[4].fingerprint, 'SHA256:new')

console.log('api: ok (draft key is stable per target, edited host keeps its pinned key)')
process.exit(0)
