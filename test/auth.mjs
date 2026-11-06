/**
 * Authentication test: the ways in that are not "a key file on disk".
 *
 * Everything here runs against a real ssh2 `Server`, because the interesting
 * failures are protocol-level: a server that only offers
 * `keyboard-interactive`, a server that asks two questions in one request, a
 * bastion that answers a different password than the target behind it.
 *
 * Covered:
 *   - a single hidden prompt answered from the password, with no dialog at all;
 *   - two prompts (password + OTP): password filled in, only the code asked;
 *   - the same server with no credential → the prompt reaches the panel;
 *   - a background attempt (interactive: false) refusing to prompt at all;
 *   - a prompt nobody answers timing out instead of hanging forever;
 *   - a jump hop using its own password, and never silently the target's.
 *
 * Run: `node test/auth.mjs`
 */
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { connect as netConnect } from 'node:net'
import ssh2 from 'ssh2'
import { SshPool } from '../src/ssh/pool.js'
import { planPrompts } from '../src/ssh/auth.js'
import { parseJumpChain } from '../src/ssh/config.js'

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
 * An ssh2 server that answers `exec` and authenticates however `ask` says.
 *
 * `ask` returns `true` when it has called `accept()` / `reject()` itself, and
 * `false` when this method is not one it handles — the helper then rejects with
 * the `allowed` list, which is how the client learns what to try next. Every
 * terminal failure calls `reject()` with no list, so a bad credential ends the
 * attempt instead of inviting an endless retry.
 */
async function startServer(ask, { tcpip = false, allowed = ['keyboard-interactive'] } = {}) {
  const seen = []
  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on('error', () => {})
    client.on('authentication', (auth) => {
      seen.push(auth.method)
      if (ask(auth) === true) return
      auth.reject(allowed)
    })
    client.on('ready', () => {
      if (tcpip) {
        client.on('tcpip', (accept, reject, info) => {
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
  return { port: server.address().port, seen, close: () => server.close() }
}

/* ── planPrompts: the rules that decide who answers what ───────────────── */

{
  const single = planPrompts([{ prompt: 'Password: ', echo: false }], 'p')
  assert.deepEqual(single.answers, ['p'], '唯一一个隐藏提问就是密码，直接填')
  assert.equal(single.ask.length, 0, '能填的不要问人')

  const twoFactor = planPrompts([
    { prompt: 'Password: ', echo: false },
    { prompt: 'Verification code: ', echo: false },
  ], 'p')
  assert.deepEqual(twoFactor.answers, ['p', ''], '密码位填好')
  assert.deepEqual(twoFactor.ask.map((item) => item.index), [1], '只问验证码')
  assert.equal(twoFactor.ask[0].echo, false, 'echo=false 的输入框要遮住')

  const visible = planPrompts([{ prompt: 'Verification code: ', echo: true }], 'p')
  assert.deepEqual(visible.ask.map((item) => item.index), [0], '不叫密码的提问不能拿密码去猜')

  const unnamed = planPrompts([{ prompt: 'OTP: ', echo: false }], 'p')
  assert.equal(unnamed.ask.length, 0, '只有一个隐藏提问时可以猜一次（服务器可能不用英文问密码）')

  const noPassword = planPrompts([{ prompt: 'Password: ', echo: false }], undefined)
  assert.equal(noPassword.ask.length, 1, '没有密码就问人')

  const nothing = planPrompts([], 'p')
  assert.deepEqual(nothing.answers, [], '零提问直接放行')
}

/* ── parseJumpChain ────────────────────────────────────────────────────── */

assert.deepEqual(parseJumpChain('bastion'), [{ host: 'bastion' }])
assert.deepEqual(parseJumpChain('ops@bastion:2222'), [{ host: 'bastion', port: 2222, user: 'ops' }])
assert.deepEqual(parseJumpChain('a,b'), [{ host: 'a' }, { host: 'b' }], '多跳要按顺序拆开，不能当成一个主机名')
assert.deepEqual(parseJumpChain('[::1]:2200'), [{ host: '::1', port: 2200 }], 'IPv6 用方括号')
assert.deepEqual(parseJumpChain(''), [])

/* ── 只开 keyboard-interactive 的服务器：密码来自配置，不打扰人 ──────── */

const kbdOnly = await startServer((auth) => {
  if (auth.method !== 'keyboard-interactive' || auth.username !== 'u') return false
  auth.prompt([{ prompt: 'Password: ', echo: false }], 'dsh', '', (answers) => {
    if (answers[0] === 'p') auth.accept()
    else auth.reject()
  })
  return true
})

const poolA = new SshPool({})
const hostA = {
  id: 'kbd-auto',
  host: '127.0.0.1',
  port: kbdOnly.port,
  user: 'u',
  // `password` (not `keyboard`): the credential is known, the *method* the
  // server wants is not. That is exactly the PAM-only sshd case.
  auth: { type: 'password', password: 'p' },
}
const execA = await poolA.exec(hostA, 'uname -s')
assert.equal(execA.stdout, 'ran:uname -s\n', 'keyboard-interactive 必须能连上并跑命令')
assert.equal(poolA.challenge(), undefined, '密码能答的提问不该弹到界面上')
poolA.close('kbd-auto')

/* ── 密码 + OTP：只问验证码 ───────────────────────────────────────────── */

const otp = await startServer((auth) => {
  if (auth.method !== 'keyboard-interactive' || auth.username !== 'u') return false
  auth.prompt([
    { prompt: 'Password: ', echo: false },
    { prompt: 'Verification code: ', echo: false },
  ], 'dsh', '', (answers) => {
    if (answers[0] === 'p' && answers[1] === '123456') auth.accept()
    else auth.reject()
  })
  return true
})

const poolB = new SshPool({})
const hostB = { id: 'otp', host: '127.0.0.1', port: otp.port, user: 'u', auth: { type: 'password', password: 'p' } }
const pendingB = poolB.ensure(hostB, { interactive: true })
await until(() => poolB.challenge() !== undefined, 'the OTP prompt')
const challengeB = poolB.challenge()
assert.equal(challengeB.hop, 1, '直连时目标机就是第 1 跳')
assert.equal(challengeB.hopLabel, '目标机')
assert.equal(challengeB.prompts.length, 1, '密码那一条不该再问一次')
assert.match(challengeB.prompts[0].prompt, /Verification code/)
assert.equal(challengeB.prompts[0].echo, false)
poolB.answerAuth(challengeB.id, ['123456'])
await pendingB
assert.equal(poolB.status('otp'), 'connected', '答完验证码后握手应继续')
assert.equal(poolB.challenge(), undefined, '答过之后不能再留着这张卡')
poolB.close('otp')

/* 过期的 id 必须被拒绝，而不是答到下一次握手上 */
assert.throws(() => poolB.answerAuth('auth-nope', ['x']), /失效/)

/*
 * 猜错了要有第二次机会：第一次把密码填进唯一的隐藏提问（服务器可能用
 * 「Contraseña:」这种本地化文案），被拒之后，下一次连接必须改成问人 ——
 * ssh2 不会在一次握手里重试同一个认证方式，所以第二次一定是新连接。
 */
const retry = await startServer((auth) => {
  if (auth.method !== 'keyboard-interactive' || auth.username !== 'u') return false
  auth.prompt([{ prompt: 'Code: ', echo: false }], 'dsh', '', (answers) => {
    if (answers[0] === 'otp-9') auth.accept()
    else auth.reject()
  })
  return true
})

const poolR = new SshPool({})
const hostR = { id: 'retry', host: '127.0.0.1', port: retry.port, user: 'u', auth: { type: 'password', password: 'p' } }
const firstR = await poolR.ensure(hostR, { interactive: true }).then(() => undefined, (error) => error)
assert.equal(firstR?.code, 'auth-failed', '第一次可以把密码当答案试一试')

const pendingR = poolR.ensure(hostR, { interactive: true })
await until(() => poolR.challenge() !== undefined, 'the second attempt to ask')
const challengeR = poolR.challenge()
assert.match(challengeR.prompts[0].prompt, /Code/, '猜过一次之后要真的问人')
poolR.answerAuth(challengeR.id, ['otp-9'])
await pendingR
assert.equal(poolR.status('retry'), 'connected', '第二次回答应能连上')
poolR.close('retry')
retry.close()

/* ── 后台连接不许弹窗：给 needs-credential，而不是干等 ────────────────── */

const poolC = new SshPool({})
const hostC = { id: 'otp-bg', host: '127.0.0.1', port: otp.port, user: 'u', auth: { type: 'keyboard' } }
const failureC = await poolC.ensure(hostC).then(() => undefined, (error) => error)
assert.equal(failureC?.code, 'needs-credential', '没有界面的连接不能卡在提问上')
assert.match(failureC.message, /验证码|Verification/)
assert.equal(poolC.challenge(), undefined, '后台连接不该留下待输入状态')
poolC.dispose()

/* ── 没人回答的提问要超时 ─────────────────────────────────────────────── */

const poolD = new SshPool({ authTimeoutMs: 150 })
const hostD = { id: 'otp-timeout', host: '127.0.0.1', port: otp.port, user: 'u', auth: { type: 'keyboard' } }
const pendingD = poolD.ensure(hostD, { interactive: true })
await until(() => poolD.challenge() !== undefined, 'the prompt to appear')
const failureD = await pendingD.then(() => undefined, (error) => error)
assert.equal(failureD?.code, 'auth-timeout', '超时要报超时，不是一句笼统的认证失败')
assert.equal(poolD.challenge(), undefined, '超时后要收起输入框')
poolD.dispose()

/* ── 跳板：每一跳用自己的密码 ─────────────────────────────────────────── */

const target = await startServer((auth) => {
  if (auth.method !== 'password' || auth.username !== 'u') return false
  if (auth.password !== 'target-pw') {
    auth.reject()
    return true
  }
  auth.accept()
  return true
}, { allowed: ['password'] })

const bastion = await startServer((auth) => {
  if (auth.username !== 'u') return false
  if (auth.method === 'password') {
    if (auth.password !== 'jump-pw') {
      auth.reject()
      return true
    }
    auth.accept()
    return true
  }
  if (auth.method === 'keyboard-interactive') {
    auth.prompt([{ prompt: 'Password: ', echo: false }], 'dsh', '', (answers) => {
      if (answers[0] === 'jump-pw') auth.accept()
      else auth.reject()
    })
    return true
  }
  return false
}, { tcpip: true, allowed: ['password', 'keyboard-interactive'] })

const poolE = new SshPool({})
const jumpHost = (jumpAuth) => ({
  id: 'behind-jump',
  host: '127.0.0.1',
  port: target.port,
  user: 'u',
  auth: { type: 'password', password: 'target-pw' },
  jump: { host: '127.0.0.1', port: bastion.port, user: 'u', auth: jumpAuth },
})

const execE = await poolE.exec(jumpHost({ type: 'password', password: 'jump-pw' }), 'uname -s')
assert.equal(execE.stdout, 'ran:uname -s\n', '两跳各自的密码都要能连上')
assert.ok(bastion.seen.includes('password'), '跳板必须收到一次密码认证')
poolE.close('behind-jump')

/* 跳板密码写错：错误要指到跳板，不能说成目标机失败 */
const poolF = new SshPool({})
const failureF = await poolF.ensure(jumpHost({ type: 'password', password: 'wrong-pw' }))
  .then(() => undefined, (error) => error)
assert.equal(failureF?.code, 'jump-auth-failed', '跳板认证失败要单独成码')
assert.match(failureF.message, /跳板/)
assert.match(failureF.message, new RegExp(`:${bastion.port}`), '错误里要指到跳板那台')
assert.equal(poolF.status('behind-jump'), 'error')
poolF.dispose()

/*
 * The regression that matters: a jump with no password of its own must not
 * borrow the target's. Before this change `auth: host.jumpAuth ?? host.auth`
 * handed the bastion `target-pw`, which either logged in with the wrong
 * credential or burned `MaxAuthTries` against the wrong machine.
 */
const poolF2 = new SshPool({})
const failureF2 = await poolF2.ensure(jumpHost({ type: 'password' }))
  .then(() => undefined, (error) => error)
assert.equal(failureF2?.code, 'needs-credential', '跳板没密码时要问人，而不是拿目标机的密码顶上')
assert.equal(failureF2.details?.hop, 1, '要说明是第 1 跳在问')
assert.equal(poolF2.challenge(), undefined, '后台连接不留提问')
poolF2.dispose()

/* 跳板没有密码时：交互式连接把提问交给面板 */
const poolG = new SshPool({})
const pendingG = poolG.ensure(jumpHost({ type: 'password' }), { interactive: true })
await until(() => poolG.challenge() !== undefined, 'the bastion prompt')
const challengeG = poolG.challenge()
assert.equal(challengeG.hop, 1, '跳板是第 1 跳')
assert.equal(challengeG.hopLabel, '跳板', '界面要能说出是哪一跳在问')
poolG.answerAuth(challengeG.id, ['jump-pw'])
await pendingG
assert.equal(poolG.status('behind-jump'), 'connected', '跳板密码输完后应继续连目标机')
poolG.close('behind-jump')

/* ── 多跳配置：明确拒绝，而不是拿逗号当主机名 ─────────────────────────── */

const poolH = new SshPool({})
const failureH = await poolH.ensure({ id: 'multi', host: '127.0.0.1', port: 1, user: 'u', proxyJump: 'a,b' })
  .then(() => undefined, (error) => error)
assert.equal(failureH?.code, 'jump-multi-hop', '多跳还没做，要说清楚')
assert.deepEqual(failureH.details.hops, ['a', 'b'])
poolH.dispose()

target.close()
bastion.close()
kbdOnly.close()
otp.close()

console.log('auth: ok (keyboard-interactive auto-answer, 2FA prompt, background refusal, timeout, per-hop credentials, multi-hop refusal)')
