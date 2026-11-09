import assert from 'node:assert/strict'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import ssh2 from 'ssh2'
import { BrowserUploads, UPLOAD_CHUNK_BYTES } from '../src/remote/browser-uploads.js'
import { SshPool } from '../src/ssh/pool.js'
import { buildApi } from '../src/api.js'
import { readJsonBody, writeOk, writeError } from '../src/wire.js'
import { MemorySftp } from './helpers/memory-sftp.mjs'

const memory = new MemorySftp()
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
const ssh = new ssh2.Server({ hostKeys: [privateKey] }, client => {
  client.on('error', () => {})
  client.on('authentication', ctx => ctx.accept())
  client.on('ready', () => client.on('session', accept => {
    accept().on('sftp', acceptSftp => {
      const stream = acceptSftp()
      const status = (id, error) => stream.status(id, error ? (typeof error.code === 'number' ? error.code : 4) : 0)
      stream.on('OPEN', (id, path, flags, attrs) => memory.open(path, 'w', (error, handle) => error ? status(id, error) : stream.handle(id, handle)))
      stream.on('WRITE', (id, handle, offset, data) => memory.write(handle, data, 0, data.length, offset, error => status(id, error)))
      stream.on('CLOSE', (id, handle) => memory.close(handle, error => status(id, error)))
      stream.on('STAT', (id, path) => memory.stat(path, (error, attrs) => error ? status(id, error) : stream.attrs(id, attrs)))
      stream.on('RENAME', (id, from, to) => memory.rename(from, to, error => status(id, error)))
      stream.on('REMOVE', (id, path) => memory.unlink(path, error => status(id, error)))
      stream.on('EXTENDED', id => stream.status(id, 8))
    })
  }))
})
await new Promise(resolve => ssh.listen(0, '127.0.0.1', resolve))
const host = { id: 'h1', host: '127.0.0.1', port: ssh.address().port, user: 'u', auth: { type: 'password', password: 'p' } }
const pool = new SshPool()
const uploads = new BrowserUploads(pool)
const api = buildApi({ ctx: {}, store: { host: id => id === host.id ? host : undefined }, pool, uploads })
let maxBody = 0
const http = createServer(async (req, res) => {
  try {
    const payload = await readJsonBody(req)
    writeOk(res, await api[req.url.slice(1)](payload))
  } catch (error) { writeError(res, error) }
})
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
const request = async (method, payload) => {
  const body = JSON.stringify({ hostId: host.id, sessionId: 's1', ...payload })
  maxBody = Math.max(maxBody, Buffer.byteLength(body))
  const response = await fetch(`http://127.0.0.1:${http.address().port}/${method}`, { method: 'POST', body })
  const result = await response.json()
  if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code })
  return result.value
}
const begin = (path, size) => request('fs.upload.begin', { path, size })
const chunk = (uploadId, offset, bytes) => request('fs.upload.chunk', { uploadId, offset, data: bytes.toString('base64') })
const finish = uploadId => request('fs.upload.finish', { uploadId })
try {
  const path = '/home/u/big.bin'
  memory.put(path, 'original')
  const data = Buffer.alloc(20 * 1024 * 1024 + 17)
  for (let i = 0; i < data.length; i++) data[i] = i % 251
  const { uploadId } = await begin(path, data.length)
  for (let offset = 0; offset < data.length; offset += UPLOAD_CHUNK_BYTES) {
    await chunk(uploadId, offset, data.subarray(offset, offset + UPLOAD_CHUNK_BYTES))
    assert.equal(memory.entries.get(path).buffer.toString(), 'original', 'destination is untouched before finish')
  }
  await finish(uploadId)
  assert.equal(createHash('sha256').update(memory.entries.get(path).buffer).digest('hex'), createHash('sha256').update(data).digest('hex'))
  assert(maxBody < 2 * 1024 * 1024)
  assert.equal(memory.handles.size, 0)

  const incomplete = await begin(path, 10)
  await chunk(incomplete.uploadId, 0, Buffer.from('abc'))
  await assert.rejects(() => finish(incomplete.uploadId), error => error.code === 'upload-incomplete')
  assert.deepEqual(memory.entries.get(path).buffer, data)

  const isolated = await begin('/isolated', 3)
  await assert.rejects(() => uploads.chunk('other-host', 's1', isolated.uploadId, 0, 'YWJj'), error => error.code === 'upload-not-found')
  await assert.rejects(() => uploads.chunk(host.id, 'other-session', isolated.uploadId, 0, 'YWJj'), error => error.code === 'upload-not-found')
  await assert.rejects(() => chunk(isolated.uploadId, 1, Buffer.from('abc')), error => error.code === 'upload-offset')

  const cancelled = await begin(path, 3)
  await chunk(cancelled.uploadId, 0, Buffer.from('abc'))
  await request('fs.upload.abort', { uploadId: cancelled.uploadId })
  assert.deepEqual(memory.entries.get(path).buffer, data)
  await assert.rejects(() => finish(cancelled.uploadId), error => error.code === 'upload-not-found')

  const oversized = await begin('/oversized', UPLOAD_CHUNK_BYTES + 1)
  await assert.rejects(() => chunk(oversized.uploadId, 0, Buffer.alloc(UPLOAD_CHUNK_BYTES + 1)), error => error.code === 'bad-chunk')
  const empty = await begin('/empty', 0)
  await finish(empty.uploadId)
  assert.equal(memory.entries.get('/empty').buffer.length, 0)

  const failed = await begin(path, 3)
  await chunk(failed.uploadId, 0, Buffer.from('abc'))
  const rename = memory.rename
  memory.rename = (from, to, cb) => cb(Object.assign(new Error('permission denied'), { code: 3 }))
  await assert.rejects(() => finish(failed.uploadId))
  memory.rename = rename
  assert.deepEqual(memory.entries.get(path).buffer, data)

  const expired = await begin('/expired', 3)
  uploads.entries.get(expired.uploadId).touched = 0
  await uploads.expire()
  assert.equal(uploads.entries.size, 0)
  assert.equal(memory.handles.size, 0)
  assert.equal([...memory.entries.keys()].some(key => key.includes('.dsh-tmp-')), false)
  console.log(`browser-uploads: ok (real HTTP + SSH/SFTP, 20 MB hash, max request ${maxBody} bytes, incomplete/cancel/isolation/offset/empty/rename/expiry)`)
} finally {
  await uploads.dispose()
  pool.dispose()
  await new Promise(resolve => http.close(resolve))
  await new Promise(resolve => ssh.close(resolve))
}
