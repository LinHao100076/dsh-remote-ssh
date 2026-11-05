/**
 * WebSocket round-trip through the built bundle — the regression for issue #4.
 *
 * 0.3.1 replaced the optional native modules with an empty object. `ws` reads a
 * *successful* `require('bufferutil')` as "the fast masker is installed", so it
 * overwrote its own pure-JS mask/unmask with wrappers that delegate to
 * `bufferUtil.mask` / `bufferUtil.unmask` for payloads over 48 / 32 bytes. The
 * first terminal frame bigger than that threw
 *
 *   TypeError: bufferUtil.unmask is not a function
 *
 * from inside the socket's `data` handler — an uncaught exception in the host
 * process, which is what the user saw as "应用无法启动或已意外停止" the moment they
 * clicked 终端.
 *
 * Nothing in the suite ever opened a socket, so it shipped. This test drives the
 * bundle's `WebSocketServer` with a real client and pushes payloads across every
 * threshold ws has: 48 bytes (server-side mask), 32 bytes (unmask), and 24 bytes
 * (UTF-8 validation), plus one payload large enough to be split across frames.
 *
 * Only the bundle is tested: against source, `ws` comes straight out of
 * `node_modules`, where `bufferutil` is not installed at all, so the pure-JS
 * path runs and the bug cannot exist. The bundle is the thing that ships.
 *
 * Run: `node test/ws.mjs`
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import WebSocket from 'ws'

process.on('uncaughtException', (error) => {
  console.error(`ws: FAILED — the bundle threw while handling a frame: ${error.message}`)
  process.exit(1)
})

// `RS_WS_BUNDLE` lets this run against a deliberately broken build; the default
// is the artifact that ships.
const bundleUrl = process.env.RS_WS_BUNDLE
  ? pathToFileURL(resolve(process.env.RS_WS_BUNDLE)).href
  : new URL('../lib/server.mjs', import.meta.url).href
const { WebSocketServer } = await import(bundleUrl)

/* ── an echo server built from the bundled copy of `ws` ─────────────────── */

const server = createServer()
const wss = new WebSocketServer({ server })
wss.on('connection', (socket) => {
  socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const { port } = server.address()

const client = new WebSocket(`ws://127.0.0.1:${port}/`)
await once(client, 'open')

/** Send one payload and require the echo to come back byte-identical. */
function roundTrip(payload, isBinary, label) {
  return new Promise((resolve, reject) => {
    const expected = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    const timer = setTimeout(() => reject(new Error(`${label}: no echo within 5s`)), 5000)
    const done = (data, binary) => {
      clearTimeout(timer)
      client.off('message', done)
      const actual = Buffer.isBuffer(data) ? data : Buffer.from(data)
      assert.equal(binary, isBinary, `${label}: frame type changed`)
      assert.equal(actual.length, expected.length, `${label}: length changed (${actual.length} vs ${expected.length})`)
      assert.ok(actual.equals(expected), `${label}: payload corrupted`)
      resolve()
    }
    client.on('message', done)
    client.send(payload, { binary: isBinary })
  })
}

/* ── every threshold ws branches on ─────────────────────────────────────── */

await roundTrip('hi', false, 'text below every threshold')
await roundTrip('x'.repeat(40), false, 'text above utf-8 threshold (24)')
await roundTrip('远端终端回显 ✓ — 超过二十四个字节的一行', false, 'multi-byte text')
await roundTrip(Buffer.alloc(64, 0x41), true, 'binary above unmask threshold (32)')
await roundTrip(Buffer.alloc(4096, 0x7f), true, 'binary above mask threshold (48)')
await roundTrip(Buffer.from(Array.from({ length: 200_000 }, (_, i) => i & 0xff)), true, 'binary split across frames')

client.close()
await once(client, 'close')
for (const socket of wss.clients) socket.terminate()
wss.close()
server.close()
await once(server, 'close')

console.log('ws: ok (bundle round-trips text + binary across the mask/unmask/utf-8 thresholds)')
