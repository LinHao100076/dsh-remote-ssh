/**
 * Jump-chain test: a real two-bastion chain, dialled for real.
 *
 * `test/auth.mjs` proves a *single* hop uses its own credential. This one proves
 * the part that a single hop cannot: that hop 1 opens its channel to **hop 2**
 * and not to the target, that the second hop's port and credential are its own,
 * that the chain unwinds without hanging, and that a failure names the hop it
 * happened on.
 *
 * Every server here is a real `ssh2` `Server`, because the bug this guards
 * against is invisible in a fake: `forwardOut(dest)` looks correct no matter
 * what hostname you pass it. Only a recorded `direct-tcpip` request (`dialled`)
 * can tell "hop 1 dialled hop 2" from "hop 1 dialled the target" — and the
 * latter is the classic multi-hop bug, because the first bastion usually cannot
 * reach the target at all.
 *
 * Run: `node test/jump.mjs`
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import ssh2 from 'ssh2'
import { SshPool } from '../src/ssh/pool.js'

const { Server } = ssh2

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
})

/** Resolve once `check()` is true, or reject after `timeoutMs`. */
async function until(check, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/**
 * One ssh2 server: fixed password auth, optional `direct-tcpip` forwarding.
 *
 * `dialled` records every channel request, which is how "did hop 1 dial hop 2
 * or the target?" becomes an assertion. `prompts` makes the hop ask for a
 * keyboard-interactive answer instead of accepting a password, which is the
 * only way a hop can be reached with no credential of its own.
 */
async function startServer({ user, password, tcpip = false, prompts = false } = {}) {
  const seen = []
  const dialled = []
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('error', () => {})
    client.on('authentication', (auth) => {
      seen.push({ method: auth.method, username: auth.username })
      if (auth.method === 'password') {
        if (auth.username === user && auth.password === password) auth.accept()
        else auth.reject()
        return
      }
      if (prompts && auth.method === 'keyboard-interactive') {
        auth.prompt([{ prompt: 'Password: ', echo: false }], 'dsh', '', (answers) => {
          if (answers[0] === 'anything') auth.accept()
          else auth.reject()
        })
        return
      }
      auth.reject(prompts ? ['password', 'keyboard-interactive'] : ['password'])
    })
    client.on('ready', () => {
      if (tcpip) {
        client.on('tcpip', (accept, reject, info) => {
          dialled.push({ destIP: info.destIP, destPort: info.destPort })
          const upstream = netConnect({ host: info.destIP, port: info.destPort })
          upstream.on('error', () => reject?.())
          const stream = accept()
          upstream.on('connect', () => { stream.pipe(upstream).pipe(stream) })
          stream.on('error', () => upstream.destroy())
        })
      }
      client.on('session', (acceptSession) => {
        const session = acceptSession()
        session.on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec()
          stream.write(`ran:${info.command}\n`)
          stream.exit(0)
          stream.end()
        })
      })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, seen, dialled, close: () => server.close() }
}

/* ── 两跳真的连通：第 1 跳连第 2 跳，最后一跳才连目标 ────────────────── */

const hop1 = await startServer({ user: 'j1', password: 'p1', tcpip: true })
const hop2 = await startServer({ user: 'j2', password: 'p2', tcpip: true })
const target = await startServer({ user: 'tu', password: 'tp' })

const pins = []
const pool = new SshPool({ onJumpFingerprint: (...args) => pins.push(args) })
const chain = {
  id: 'chain',
  host: '127.0.0.1',
  port: target.port,
  user: 'tu',
  auth: { type: 'password', password: 'tp' },
  jump: {
    hops: [
      { host: '127.0.0.1', port: hop1.port, user: 'j1', auth: { type: 'password', password: 'p1' } },
      { host: '127.0.0.1', port: hop2.port, user: 'j2', auth: { type: 'password', password: 'p2' } },
    ],
  },
}

const execChain = await pool.exec(chain, 'uname -s')
assert.equal(execChain.stdout, 'ran:uname -s\n', '两跳串起来要能真的跑到目标机')

/*
 * The regression this file exists for. `forwardOut`'s destination is the next
 * hop; pointing hop 1 at the target would make it dial a machine it cannot
 * reach (the whole reason the chain exists) and the connect would time out.
 * The recorded channel requests are the only observable difference.
 */
assert.deepEqual(hop1.dialled.map((item) => item.destPort), [hop2.port], '第 1 跳必须去连第 2 跳，不能直接连目标机')
assert.deepEqual(hop2.dialled.map((item) => item.destPort), [target.port], '最后一跳才连目标机')
assert.deepEqual(hop1.dialled.map((item) => item.destIP), ['127.0.0.1'], '第 1 跳转发的地址就是第 2 跳的主机')

/* 每一跳各用各的账号：串号会让「密码认证」看起来能用其实是借的 */
assert.equal(hop1.seen.find((item) => item.method === 'password')?.username, 'j1', '第 1 跳用自己的账号')
assert.equal(hop2.seen.find((item) => item.method === 'password')?.username, 'j2', '第 2 跳用自己的账号')

/*
 * TOFU per hop: two hops, two pins, and the pin carries the *whole* chain so a
 * chain that came from `ProxyJump` can be written back as editable hops.
 */
assert.equal(pins.length, 2, '每一跳各记一次指纹')
assert.deepEqual(pins.map((pin) => pin[2]), [0, 1], '指纹要记在对应的那一跳上')
assert.equal(pins[0][3].length, 2, '回写的是整条链路')
assert.match(pins[0][1], /^SHA256:/, '指纹是 OpenSSH 的形状')
assert.equal(pins[0][3][0].fingerprint, pins[0][1], '回写时把这一跳的指纹填上')
assert.equal(pins[0][3][1].fingerprint, undefined, '别的跳还没见过，不能替它填')
pool.close('chain')

/* ── 第 2 跳认证失败：错误要指到第 2 跳 ──────────────────────────────── */

const poolB = new SshPool({})
const wrongHop2 = {
  ...chain,
  id: 'chain-bad-hop2',
  jump: {
    hops: [
      chain.jump.hops[0],
      { host: '127.0.0.1', port: hop2.port, user: 'j2', auth: { type: 'password', password: 'wrong' } },
    ],
  },
}
const failureB = await poolB.ensure(wrongHop2).then(() => undefined, (error) => error)
assert.equal(failureB?.code, 'jump-auth-failed', '第 2 跳认证失败要单独成码')
assert.equal(failureB.details?.hop, 2, '错误里要写第 2 跳')
assert.match(failureB.message, /第 2 跳/, '文案要说出是第 2 跳')
assert.match(failureB.message, new RegExp(`:${hop2.port}`), '还要说出是哪个地址')
assert.equal(poolB.status('chain-bad-hop2'), 'error')
poolB.dispose()

/**
 * A bastion that refuses every channel (`PermitTunnel no`, or no route to the
 * next hop), recording what it was asked for.
 *
 * Deterministic on purpose: an OS-level "port is closed" gives a `timeout` on
 * some platforms and `refused` on others, but a refused channel is always the
 * same immediate failure — and the recorded destination still proves *which*
 * hop the chain was trying to reach.
 */
async function startRefusingBastion({ user, password, prompts = false } = {}) {
  const dialled = []
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('error', () => {})
    client.on('authentication', (auth) => {
      if (auth.method === 'password' && auth.username === user && auth.password === password) {
        auth.accept()
        return
      }
      if (prompts && auth.method === 'keyboard-interactive') {
        auth.prompt([{ prompt: 'Password: ', echo: false }], 'dsh', '', (answers) => {
          if (answers[0] === 'anything') auth.accept()
          else auth.reject()
        })
        return
      }
      auth.reject(prompts ? ['password', 'keyboard-interactive'] : ['password'])
    })
    client.on('ready', () => {
      client.on('tcpip', (_accept, reject, info) => {
        dialled.push({ destIP: info.destIP, destPort: info.destPort })
        reject?.()
      })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, dialled, close: () => server.close() }
}

/* ── 第 1 跳开不到第 2 跳的通道：错误指明「哪一跳」和「去哪」──────────── */

const refusing = await startRefusingBastion({ user: 'j1', password: 'p1' })
const poolC = new SshPool({})
const failureC = await poolC
  .ensure({
    ...chain,
    id: 'chain-refused-channel',
    jump: {
      hops: [
        { host: '127.0.0.1', port: refusing.port, user: 'j1', auth: { type: 'password', password: 'p1' } },
        chain.jump.hops[1],
      ],
    },
  })
  .then(() => undefined, (error) => error)
assert.equal(failureC?.code, 'jump-forward-failed', '跳板不肯开通道要单独成码，不能混成认证失败或超时')
assert.equal(failureC.details?.hop, 1, '是第 1 跳开不出来')
assert.equal(failureC.details?.to?.port, hop2.port, '要说清是想开到第 2 跳')
assert.deepEqual(refusing.dialled.map((item) => item.destPort), [hop2.port], '第 1 跳确实去连了第 2 跳')
assert.match(failureC.message, /第 2 跳/, '文案要指出目的地是第 2 跳')
poolC.dispose()
refusing.close()

/* ── 旧的单跳形状仍然能连（升级不该断开任何人）───────────────────────── */

const poolD = new SshPool({})
const legacy = {
  id: 'legacy-single',
  host: '127.0.0.1',
  port: target.port,
  user: 'tu',
  auth: { type: 'password', password: 'tp' },
  jump: { host: '127.0.0.1', port: hop1.port, user: 'j1', auth: { type: 'password', password: 'p1' } },
}
const execLegacy = await poolD.exec(legacy, 'whoami')
assert.equal(execLegacy.stdout, 'ran:whoami\n', '0.6.1 写下的单跳 jump{host} 必须还能用')
poolD.close('legacy-single')

/* ── ProxyJump 字符串：按顺序展开成两跳，第一跳的凭据靠继承（所以要问） ── */

const askingHop = await startRefusingBastion({ user: 'k1', prompts: true })
// A port that was listening a moment ago and is not any more.
const closed = await startServer({ user: 'x', password: 'x' })
const closedPort = closed.port
closed.close()
await new Promise((resolve) => setTimeout(resolve, 50))

const poolE = new SshPool({})
// `inherit` borrows the target's *method*, not its password, so this hop has to
// ask — which is the path a real `~/.ssh/config` ProxyJump host takes on first
// connect, and the reason `needs-credential` exists for background attempts.
const pendingE = poolE
  .ensure({
    id: 'proxyjump-chain',
    host: '127.0.0.1',
    port: target.port,
    user: 'tu',
    auth: { type: 'password', password: 'tp' },
    proxyJump: `127.0.0.1:${askingHop.port},127.0.0.1:${closedPort}`,
  }, { interactive: true })
  .then(() => undefined, (error) => error)
await until(() => poolE.challenge() !== undefined, 'the inherited hop to ask')
const challengeE = poolE.challenge()
assert.equal(challengeE.hop, 1, '第一跳就要问')
assert.equal(challengeE.hopLabel, '第 1 跳', '多跳时界面要按跳来称呼')
poolE.answerAuth(challengeE.id, ['anything'])
const failureE = await pendingE
/*
 * The string really became two hops: the refused channel is the one to the
 * second address. A single-hop implementation would instead have dialled a
 * hostname containing a comma and reported a DNS failure.
 */
assert.equal(failureE?.code, 'jump-forward-failed', '第二跳不存在，通道开不出来')
assert.equal(failureE.details?.hop, 1, '失败发生在第 1 跳上')
assert.equal(failureE.details?.to?.port, closedPort, '但它要去的是第 2 跳 —— 说明字符串被展开成了两跳')
assert.deepEqual(askingHop.dialled.map((item) => item.destPort), [closedPort], '展开出来的第二跳就是逗号后面那一段')
assert.match(failureE.message, /第 2 跳/, '文案要说出去的是第 2 跳')
poolE.dispose()

/* ── 收摊 ──────────────────────────────────────────────────────────────── */

hop1.close()
hop2.close()
target.close()
askingHop.close()

console.log('jump: ok (two-hop chain, per-hop port + credential, inside-out teardown, hop-indexed errors, legacy single hop, ProxyJump expansion)')
