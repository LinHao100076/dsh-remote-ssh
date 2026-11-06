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

/* ── jump chains ───────────────────────────────────────────────────────── */

/* hop order is traffic order, so it must survive the trip through the API */
await api['hosts.connect']({
  draft: {
    ...draft,
    jump: { hops: [{ host: 'a', port: 22, user: 'j1' }, { host: 'b', port: 2222, user: 'j2' }] },
  },
  auth: { password: 'p' },
})
assert.deepEqual(seen[5].jump.hops.map((hop) => hop.host), ['a', 'b'], '链路的顺序不能被重排')
assert.equal(seen[5].jump.hops[1].port, 2222, '每一跳带着自己的端口')

/* per-hop passwords are index-aligned and stay out of the target's `auth` */
await api['hosts.connect']({
  draft: {
    ...draft,
    jump: {
      hops: [
        { host: 'a', auth: { type: 'password' } },
        { host: 'b', auth: { type: 'password' } },
      ],
    },
  },
  auth: { password: 'target', jumpPasswords: ['p1', 'p2'] },
})
assert.equal(seen[6].jump.hops[0].auth.password, 'p1', '第 1 跳拿第 1 个密码')
assert.equal(seen[6].jump.hops[1].auth.password, 'p2', '第 2 跳拿第 2 个密码')
assert.equal(seen[6].auth.password, 'target', '目标机的密码不受影响')
assert.equal(seen[6].auth.jumpPasswords, undefined, '整组密码不能漏进目标机的 auth')

/* the 0.6.1 single-hop shape is still accepted and read as one hop */
await api['hosts.connect']({
  draft: { ...draft, jump: { host: 'legacy', port: 2200, user: 'old', auth: { type: 'agent' } } },
  auth: { password: 'p' },
})
assert.equal(seen[7].jump.hops.length, 1, '单跳形状升级成一跳的链路')
assert.equal(seen[7].jump.hops[0].port, 2200, '端口跟着走')

/* a chain of six is a design problem, not a configuration */
await assert.rejects(
  api['hosts.connect']({
    draft: {
      ...draft,
      jump: { hops: Array.from({ length: 6 }, (_, index) => ({ host: `h${index}` })) },
    },
  }),
  /最多 5 跳/,
)

/* a hop with no host is a mistake worth naming, not something to skip silently */
await assert.rejects(
  api['hosts.connect']({ draft: { ...draft, jump: { hops: [{ host: 'a' }, { host: '  ' }] } } }),
  /第 2 跳缺少主机地址/,
)

console.log('api: ok (draft key is stable per target, edited host keeps its pinned key, chain order + per-hop secrets)')
process.exit(0)
