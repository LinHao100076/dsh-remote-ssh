/**
 * SOCKS5 handshake test: the protocol layer only, no SSH involved.
 *
 * The end-to-end path is covered by `test/forward.mjs`; what cannot be reached
 * there is the ugly half of the protocol — a client that delivers its greeting
 * one byte per packet, one that speaks HTTP at the port by mistake, one that asks
 * for `BIND`. Each of those has a specific correct answer, and getting one wrong
 * turns into a hang rather than an error, which is the hardest kind of bug to
 * report.
 *
 * Run: `node test/socks5.mjs`
 */
import assert from 'node:assert/strict'
import { createServer, connect } from 'node:net'
import { REPLY, replyBuffer, replyForError, readSocksRequest } from '../src/forward/socks5.js'

/** Handshake outcomes the test server observed. */
const seen = []

const server = createServer((socket) => {
  socket.on('error', () => {})
  readSocksRequest(socket, { timeoutMs: 300 }).then(
    (request) => {
      seen.push({ ok: true, host: request.host, port: request.port, rest: request.rest.toString() })
      socket.end()
    },
    (error) => {
      seen.push({ ok: false, code: error.code, reply: error.reply })
      if (!socket.destroyed) socket.destroy()
    },
  )
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

/**
 * Write `chunks` (one flush each, so splits are real), collect everything the
 * server sends back, and report both sides of the exchange.
 * @returns {Promise<{reply: Buffer, result: object}>} received bytes and the outcome.
 */
async function probe(chunks) {
  const start = seen.length
  const socket = connect({ port, host: '127.0.0.1' })
  const received = []
  await new Promise((resolve) => socket.on('connect', resolve))
  socket.on('data', (chunk) => received.push(chunk))
  socket.on('error', () => {})
  const closed = new Promise((resolve) => socket.on('close', resolve))
  for (const chunk of chunks) {
    socket.write(chunk)
    // A split is only meaningful if the peer handles the first part first.
    if (chunks.length > 1) await new Promise((resolve) => setTimeout(resolve, 5))
  }
  if (chunks.length === 0) await new Promise((resolve) => setTimeout(resolve, 400))
  await closed
  while (seen.length === start) await new Promise((resolve) => setTimeout(resolve, 10))
  return { reply: Buffer.concat(received), result: seen[start] }
}

/** The reply code of the last 10-byte frame (the method reply comes first). */
const codeOf = (reply) => (reply.length >= 10 ? reply.subarray(reply.length - 10)[1] : undefined)

/** Build one CONNECT request with a domain name. */
function domainRequest(name, { command = 1 } = {}) {
  const bytes = Buffer.from(name, 'utf8')
  return Buffer.from([5, command, 0, 3, bytes.length, ...bytes, 0x1f, 0x90])
}

/* ── happy path, including a split greeting and a split request ────────── */

{
  const request = domainRequest('example.com')
  const { reply, result } = await probe([
    Buffer.from([5, 1]), // half a greeting
    Buffer.from([0]), // the rest of it
    request.subarray(0, 3), // half a request
    request.subarray(3),
  ])
  assert.deepEqual([...reply], [5, 0], 'method selection must be "no auth"')
  assert.deepEqual(result, { ok: true, host: 'example.com', port: 8080, rest: '' })
}

/* ── the payload a client pipelines behind the request is handed back ─── */

{
  const { result } = await probe([
    Buffer.concat([Buffer.from([5, 1, 0]), domainRequest('db.internal'), Buffer.from('GET / HTTP/1.1\r\n\r\n')]),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.host, 'db.internal')
  assert.equal(result.rest, 'GET / HTTP/1.1\r\n\r\n', 'pipelined bytes must not be swallowed by the parser')
}

/* ── IPv4 and IPv6 literals ───────────────────────────────────────────── */

{
  const { result } = await probe([
    Buffer.concat([Buffer.from([5, 1, 0]), Buffer.from([5, 1, 0, 1, 10, 0, 0, 7, 0x01, 0xbb])]),
  ])
  assert.deepEqual(result, { ok: true, host: '10.0.0.7', port: 443, rest: '' })
}

{
  const v6 = Buffer.from([0xfe, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
  const { result } = await probe([
    Buffer.concat([Buffer.from([5, 1, 0]), Buffer.from([5, 1, 0, 4]), v6, Buffer.from([0x00, 0x50])]),
  ])
  assert.equal(result.ok, true)
  assert.equal(result.host, 'fe80:0:0:0:0:0:0:1')
  assert.equal(result.port, 80)
}

/* ── unsupported commands are refused, not ignored ────────────────────── */

{
  const { reply, result } = await probe([Buffer.concat([Buffer.from([5, 1, 0]), domainRequest('x', { command: 2 })])])
  assert.equal(codeOf(reply), REPLY.command, 'BIND must be answered with 0x07')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'socks-bad-command')
}

/* ── a request with no target port to speak of ────────────────────────── */

{
  const { reply, result } = await probe([
    Buffer.concat([Buffer.from([5, 1, 0]), Buffer.from([5, 1, 0, 3, 3]), Buffer.from('abc'), Buffer.from([0, 0])]),
  ])
  assert.equal(codeOf(reply), REPLY.address)
  assert.equal(result.code, 'socks-bad-port')
}

{
  const { reply, result } = await probe([Buffer.concat([Buffer.from([5, 1, 0]), Buffer.from([5, 1, 0, 3, 0, 0, 80])])])
  assert.equal(codeOf(reply), REPLY.address)
  assert.equal(result.code, 'socks-bad-address', 'an empty domain is not a target')
}

/* ── a client that offers only authenticated methods ──────────────────── */

{
  const { reply, result } = await probe([Buffer.from([5, 1, 2])]) // 0x02 = user/pass
  assert.deepEqual([...reply], [5, 0xff], 'no acceptable methods')
  assert.equal(result.code, 'socks-no-method')
}

/* ── something that is not SOCKS at all ───────────────────────────────── */

{
  const { result } = await probe([Buffer.from('GET / HTTP/1.1\r\nHost: x\r\n\r\n')])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'socks-bad-version')
  assert.equal(result.reply, undefined, 'there is no valid reply to send, so the socket just closes')
}

/* ── a silent client times out instead of holding the socket forever ───── */

{
  const { result } = await probe([])
  assert.equal(result.code, 'socks-timeout')
}

/* ── reply codes: the mapping a caller relies on ──────────────────────── */

assert.equal(replyForError({ code: 'target-refused' }), REPLY.refused)
assert.equal(replyForError({ code: 'timeout' }), REPLY.hostUnreachable)
assert.equal(replyForError({ code: 'dns-failed' }), REPLY.hostUnreachable)
assert.equal(replyForError({ code: 'auth-failed' }), REPLY.notAllowed)
assert.equal(replyForError({ code: 'anything-else' }), REPLY.general)
assert.equal(replyBuffer(REPLY.ok).length, 10, 'a reply is a fixed 10-byte frame')

server.close()
console.log('socks5: ok (split greeting/request, pipelined payload, v4/v6 names, BIND refused, bad address/port, no-auth only, non-SOCKS peer, timeout, reply codes)')
process.exit(0)
