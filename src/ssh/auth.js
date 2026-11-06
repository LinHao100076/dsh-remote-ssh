/**
 * Authentication for one SSH hop — target host or jump host alike.
 *
 * Kept out of `pool.js` because the jump chain needs the same rules applied to
 * a *different* credential set, and because "which prompts can I answer without
 * the user" is a pure function worth testing on its own.
 *
 * Three things are deliberate here:
 *
 * 1. `password` and `keyboard` are separate kinds. `password` says "I have the
 *    password" and fails fast when it is missing, so the connect gate can ask
 *    for it before a handshake is attempted. `keyboard` says "ask me whatever
 *    the server asks" — the entry point for OTP / 2FA servers, and the only
 *    kind that can connect with no credential at all.
 * 2. `tryKeyboard` is always on. A server can disable `password` and leave only
 *    `keyboard-interactive` (that is what PAM-backed sshd does), and a key-only
 *    server can still demand a TOTP. Turning it on costs nothing: the pool
 *    answers the prompts it can and refuses the rest rather than hanging.
 * 3. Secrets never leave this module's caller: `hopAuth` only *reads* them off
 *    the auth object, and `secretOf` is what the pool keeps in memory.
 * @module dsh-remote-ssh/ssh/auth
 */
import { readFileSync } from 'node:fs'
import { RemoteError } from './errors.js'
import { expandHome } from './paths.js'

/** Auth kinds the store and the form are allowed to hold. */
export const AUTH_TYPES = ['agent', 'key', 'password', 'keyboard']

/** Human labels, shared by the panel and the error messages. */
export const AUTH_LABEL = {
  agent: 'ssh-agent',
  key: '密钥文件',
  password: '密码',
  keyboard: '键盘交互',
}

/** Only the shape that may be persisted: never a password, never a passphrase. */
export function normalizeAuth(raw) {
  const type = AUTH_TYPES.includes(raw?.type) ? raw.type : 'agent'
  const keyPath = typeof raw?.keyPath === 'string' && raw.keyPath.trim() !== ''
    ? raw.keyPath.trim()
    : undefined
  return keyPath === undefined ? { type } : { type, keyPath }
}

/** `SSH_AUTH_SOCK`, or the Windows OpenSSH named pipe when unset. */
export function agentSocket() {
  if (process.env.SSH_AUTH_SOCK) return process.env.SSH_AUTH_SOCK
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent'
  return undefined
}

/** The secrets an auth object carries, in the shape the pool remembers. */
export function secretOf(auth) {
  const secret = {}
  if (typeof auth?.password === 'string' && auth.password !== '') secret.password = auth.password
  if (typeof auth?.passphrase === 'string' && auth.passphrase !== '') secret.passphrase = auth.passphrase
  return secret
}

/**
 * Connect-time shape: the persisted fields plus whatever secret came with them.
 *
 * `normalizeAuth` is for the store (and drops secrets on purpose), `withSecrets`
 * is for the pool. Keeping them as two named functions is the reason a stored
 * row can be passed straight to `ssh2` without anyone wondering whether the
 * password survived the round trip.
 */
export function withSecrets(auth) {
  return { ...normalizeAuth(auth), ...secretOf(auth) }
}

/**
 * ssh2 connection options for one hop.
 *
 * @param {object} auth - `{type, keyPath, password?, passphrase?}`.
 * @param {object} [options] - `label` names the hop in errors, `config` supplies
 *   ssh-config defaults (identity file), `requirePassword` decides whether a
 *   missing password is a configuration error (target) or a prompt (jump).
 * @returns {object} options to spread into `client.connect()`.
 */
export function hopAuth(auth, { label = '目标机', config, requirePassword = true } = {}) {
  const type = AUTH_TYPES.includes(auth?.type) ? auth.type : 'agent'
  const options = { tryKeyboard: true }
  if (type === 'key') {
    const keyPath = expandHome(auth.keyPath ?? config?.identityFile)
    if (typeof keyPath !== 'string' || keyPath === '') {
      throw new RemoteError('bad-key', `${label}：请指定私钥文件`, 400)
    }
    try {
      options.privateKey = readFileSync(keyPath)
    } catch (error) {
      throw new RemoteError('key-unreadable', `${label}：无法读取私钥 ${keyPath}：${error.message}`, 400)
    }
    if (typeof auth.passphrase === 'string' && auth.passphrase !== '') options.passphrase = auth.passphrase
    return options
  }
  if (type === 'password' || type === 'keyboard') {
    if (typeof auth.password === 'string' && auth.password !== '') {
      options.password = auth.password
      return options
    }
    if (type === 'keyboard' || requirePassword !== true) return options
    // No password on a `password` host: a configuration gap, not a failed
    // attempt. The gate asks for it *before* dialling, which is why this has to
    // stay a distinct code instead of becoming an auth failure 20s later.
    throw new RemoteError('bad-password', `${label}：请输入密码`, 400)
  }
  const agent = agentSocket()
  if (agent === undefined) {
    throw new RemoteError('no-agent', `${label}：未找到 ssh-agent，请改用密钥文件认证`, 400)
  }
  options.agent = agent
  return options
}

const PASSWORD_PROMPT = /pass(word)?|密码|口令/i

/**
 * Split server prompts into "answer from the password" and "ask the user".
 *
 * The heuristic is intentionally narrow: at most **one** prompt is filled, and
 * only when it is hidden and either names itself as a password or is the only
 * question. Anything else is shown to a person — guessing wrong is not a small
 * mistake here, because a rejected reply burns an attempt against
 * `MaxAuthTries` and can lock the account out.
 *
 * The "only question" fallback exists because the prompt is server-localised
 * (`Contraseña:`, `パスワード:`, `请输入密码：`), so matching on the word is not
 * enough to avoid asking for a password the caller already has. It is a *guess*,
 * and the caller must stop guessing once it has been made: pass `password` on
 * the first ask for a hop and `undefined` afterwards, so a rejected guess turns
 * into a real question instead of the same wrong answer twice.
 *
 * @param {Array<{prompt?: string, echo?: boolean}>} prompts - from ssh2.
 * @param {string} [password] - the credential we already hold for this hop.
 * @returns {{answers: string[], ask: Array<{index: number, prompt: string, echo: boolean}>}}
 *   `answers` is pre-filled where possible; `ask` lists what a human must type,
 *   with `index` pointing back into `answers`.
 */
export function planPrompts(prompts, password) {
  const list = Array.isArray(prompts) ? prompts : []
  const answers = list.map(() => '')
  if (list.length === 0) return { answers, ask: [] }
  let fill = -1
  if (typeof password === 'string' && password !== '') {
    const named = list.findIndex((item) => item.echo !== true && PASSWORD_PROMPT.test(String(item.prompt ?? '')))
    if (named >= 0) fill = named
    else if (list.length === 1 && list[0].echo !== true) fill = 0
  }
  const ask = []
  list.forEach((item, index) => {
    if (index === fill) {
      answers[index] = password
      return
    }
    ask.push({ index, prompt: String(item.prompt ?? ''), echo: item.echo !== false })
  })
  return { answers, ask }
}
