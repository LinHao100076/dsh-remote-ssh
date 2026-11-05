/**
 * SOCKS5 server side of `ssh -D`: the handshake only.
 *
 * The transport is deliberately not here. `readSocksRequest()` consumes exactly
 * the bytes of the greeting and the request, then hands back the target address
 * plus whatever the client pipelined after them — the caller dials, and pipes
 * both ways with the SSH channel. Keeping the dial out of this module is what
 * lets the reply carry the *real* outcome: a channel that cannot be opened must
 * answer `0x05` (connection refused), not a cheerful success followed by a
 * closed socket, because SOCKS clients report the failure differently.
 *
 * Only `CONNECT` is implemented. `BIND` and `UDP ASSOCIATE` are answered with
 * `0x07 command not supported` instead of being ignored: a client waiting for a
 * reply that never comes is a hang, and a hang in a proxy looks like the network.
 * @module dsh-remote-ssh/forward/socks5
 */

/** Reply codes (RFC 1928 §6). */
export const REPLY = {
  ok: 0x00,
  general: 0x01,
  notAllowed: 0x02,
  netUnreachable: 0x03,
  hostUnreachable: 0x04,
  refused: 0x05,
  ttlExpired: 0x06,
  command: 0x07,
  address: 0x08,
}

// Every field this parser waits for is length-prefixed by a single byte, so the
// amount of data a peer can make it buffer is bounded at 262 bytes — no separate
// cap is needed, and any extra bytes are simply the client's pipelined payload.
const VERSION = 0x05
const NO_AUTH = 0x00
const NO_ACCEPTABLE = 0xff
const CMD_CONNECT = 0x01
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04

/** A handshake failure that knows which SOCKS reply code to send. */
export class SocksError extends Error {
  /**
   * @param {string} code - machine-readable code for logs.
   * @param {string} message - Chinese message for the panel.
   * @param {number} [reply] - SOCKS reply code to send, when the socket still allows it.
   */
  constructor(code, message, reply) {
    super(message)
    this.name = 'SocksError'
    this.code = code
    this.reply = reply
  }
}

/**
 * A complete SOCKS5 reply with a zeroed bind address.
 *
 * The bind address is only meaningful for `BIND`; for `CONNECT` every client
 * implementation ignores it, and reporting `0.0.0.0:0` is honest — this module
 * never knows the address the SSH server used towards the target.
 * @param {number} code - reply code.
 * @returns {Buffer} 10-byte reply.
 */
export function replyBuffer(code) {
  return Buffer.from([VERSION, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0])
}

/** Map a dial failure onto the closest SOCKS reply code. */
export function replyForError(error) {
  const code = error?.code
  if (code === 'target-refused') return REPLY.refused
  if (code === 'timeout' || code === 'exec-timeout') return REPLY.hostUnreachable
  if (code === 'dns-failed') return REPLY.hostUnreachable
  if (code === 'refused' || code === 'auth-failed') return REPLY.notAllowed
  return REPLY.general
}

/** Read a fixed-size field, or `undefined` when the buffer is too short. */
function at(buffer, offset, length) {
  return buffer.length < offset + length ? undefined : buffer.subarray(offset, offset + length)
}

/** Address bytes for the request's ATYP, or a description of what is missing. */
function readAddress(buffer) {
  const atyp = buffer[3]
  if (atyp === ATYP_IPV4) {
    const addr = at(buffer, 4, 4)
    const tail = at(buffer, 8, 2)
    if (addr === undefined || tail === undefined) return undefined
    return { host: `${addr[0]}.${addr[1]}.${addr[2]}.${addr[3]}`, port: tail.readUInt16BE(0), used: 10 }
  }
  if (atyp === ATYP_IPV6) {
    const addr = at(buffer, 4, 16)
    const tail = at(buffer, 20, 2)
    if (addr === undefined || tail === undefined) return undefined
    const groups = []
    for (let index = 0; index < 16; index += 2) groups.push(addr.readUInt16BE(index).toString(16))
    return { host: groups.join(':'), port: tail.readUInt16BE(0), used: 22 }
  }
  if (atyp === ATYP_DOMAIN) {
    const lengthAt = at(buffer, 4, 1)
    if (lengthAt === undefined) return undefined
    const length = lengthAt[0]
    if (length === 0) throw new SocksError('socks-bad-address', 'SOCKS5 请求里的域名为空', REPLY.address)
    const name = at(buffer, 5, length)
    const tail = at(buffer, 5 + length, 2)
    if (name === undefined || tail === undefined) return undefined
    return { host: name.toString('utf8'), port: tail.readUInt16BE(0), used: 5 + length + 2 }
  }
  throw new SocksError('socks-bad-atyp', `SOCKS5 不支持地址类型 0x${atyp.toString(16)}`, REPLY.address)
}

/**
 * Consume a SOCKS5 greeting and one `CONNECT` request from a socket.
 *
 * Resolves with the target and any bytes the client sent after the request, so
 * the caller can forward them instead of dropping them — a client is allowed to
 * pipeline its first payload right behind the handshake, and losing it would
 * make the proxy corrupt every connection that does.
 * @param {import('node:net').Socket} socket - inbound connection.
 * @param {{timeoutMs?: number}} [options] - handshake bound.
 * @returns {Promise<{host: string, port: number, rest: Buffer}>} the requested target.
 */
export function readSocksRequest(socket, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let stage = 'greeting'

    const done = (error, value) => {
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('close', onClose)
      socket.removeListener('error', onError)
      if (error === undefined) resolve(value)
      else reject(error)
    }

    /** Refuse the handshake politely, then hand the error back. */
    const refuse = (error) => {
      if (error.reply !== undefined) socket.end(replyBuffer(error.reply))
      else socket.destroy()
      done(error)
    }

    const timer = setTimeout(() => {
      refuse(new SocksError('socks-timeout', `SOCKS5 握手超时（${timeoutMs}ms）`))
    }, timeoutMs)

    const onClose = () => done(new SocksError('socks-closed', '客户端在 SOCKS5 握手完成前断开'))
    const onError = (error) => done(error)

    const onData = (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])

      if (stage === 'greeting') {
        if (buffer.length < 2) return
        if (buffer[0] !== VERSION) {
          // Not SOCKS5 at all — a browser pointed at the port, a health check.
          // There is no valid reply to send, so close.
          refuse(new SocksError('socks-bad-version', `不是 SOCKS5 请求（版本字节 0x${buffer[0].toString(16)}）`))
          return
        }
        const count = buffer[1]
        if (buffer.length < 2 + count) return
        const methods = buffer.subarray(2, 2 + count)
        buffer = buffer.subarray(2 + count)
        if (!methods.includes(NO_AUTH)) {
          // No-auth is the only method a tunnel can offer; the credentials would
          // have nowhere to go (the SSH connection is already authenticated).
          socket.end(Buffer.from([VERSION, NO_ACCEPTABLE]))
          done(new SocksError('socks-no-method', 'SOCKS5 客户端只提供了需要认证的方法，本机代理只支持免认证'))
          return
        }
        socket.write(Buffer.from([VERSION, NO_AUTH]))
        stage = 'request'
      }

      if (stage === 'request') {
        if (buffer.length < 4) return
        if (buffer[0] !== VERSION) {
          refuse(new SocksError('socks-bad-version', `SOCKS5 请求版本字节异常（0x${buffer[0].toString(16)}）`, REPLY.general))
          return
        }
        const command = buffer[1]
        if (command !== CMD_CONNECT) {
          const label = command === 0x02 ? 'BIND' : command === 0x03 ? 'UDP ASSOCIATE' : `0x${command.toString(16)}`
          refuse(new SocksError('socks-bad-command', `SOCKS5 只支持 CONNECT，收到 ${label}`, REPLY.command))
          return
        }
        let parsed
        try {
          parsed = readAddress(buffer)
        } catch (error) {
          refuse(error)
          return
        }
        if (parsed === undefined) return
        if (parsed.port === 0) {
          refuse(new SocksError('socks-bad-port', 'SOCKS5 请求的目标端口为 0', REPLY.address))
          return
        }
        done(undefined, { host: parsed.host, port: parsed.port, rest: buffer.subarray(parsed.used) })
      }
    }

    socket.on('data', onData)
    socket.on('close', onClose)
    socket.on('error', onError)
  })
}
