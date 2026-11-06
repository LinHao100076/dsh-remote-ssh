/**
 * Errors with a stable machine-readable code for the JSON API.
 *
 * They live in their own module because both `pool.js` and `auth.js` need to
 * raise them, and `auth.js` must not import `pool.js` back (a cycle that ESM
 * tolerates only until someone reads a binding at module-evaluation time).
 * `pool.js` re-exports `RemoteError`, so the rest of the plugin keeps importing
 * it from there.
 * @module dsh-remote-ssh/ssh/errors
 */

/** Error carrying a stable code, an HTTP status and optional details. */
export class RemoteError extends Error {
  constructor(code, message, status = 400, details) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
    this.status = status
    this.details = details
  }
}

/**
 * Message patterns ssh2 uses, mapped to the code the UI branches on.
 *
 * Order matters: `Cannot parse privateKey` also mentions `passphrase`, so the
 * key rule has to be tested before the generic catch-all, and the auth-failed
 * rule has to come before `timeout` because ssh2 wraps some auth failures in a
 * handshake-timeout error.
 */
const RULES = [
  [/All configured authentication methods failed/i, 'auth-failed', '认证失败：密钥/密码被拒绝，或密钥未加入远端 authorized_keys', 401],
  [/Host denied|host key verification failed|Host key verification/i, 'host-key-changed', '主机指纹与首次记录不一致，已中止连接', 409],
  [/Cannot parse privateKey|bad passphrase|Encrypted private OpenSSH key/i, 'key-invalid', '私钥无法解析：检查路径、格式或 passphrase', 400],
  [/Timed out while waiting for handshake|ETIMEDOUT|timeout/i, 'timeout', '连接超时：检查主机地址、端口与网络可达性', 504],
  [/ENOTFOUND|getaddrinfo/i, 'dns-failed', '主机名无法解析', 400],
  [/ECONNREFUSED/i, 'refused', '连接被拒绝：端口未监听或被防火墙拦截', 502],
]

/**
 * Map an ssh2 failure to a `RemoteError` the UI can branch on.
 * @param {unknown} error - anything ssh2 (or we) threw.
 * @returns {RemoteError} never throws; already-classified errors pass through.
 */
export function classify(error) {
  if (error instanceof RemoteError) return error
  const message = String(error?.message ?? error)
  for (const [pattern, code, text, status] of RULES) {
    if (pattern.test(message)) return new RemoteError(code, text, status)
  }
  return new RemoteError('ssh-error', message, 502)
}
