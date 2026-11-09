import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeMapping, createMatcher } from '../src/sync/mapping.js'
import { Transfer } from '../src/remote/transfer.js'
import { RemoteFiles } from '../src/remote/files.js'
import { renameRemote } from '../src/remote/publish.js'
import { MemorySftp } from './helpers/memory-sftp.mjs'
import { Store } from '../src/store.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-safety-'))
const host = { id: 'h' }
try {
  assert.equal(normalizeMapping({ localRoot: 'src', remoteRoot: '/srv' }, root).localRoot, join(root, 'src'))
  for (const localRoot of ['/', 'C:/', 'c:\\', 'Z:/', '//server/share/', 'C:/folder/..']) {
    // POSIX cannot resolve a Windows non-root path; drive/UNC roots are checked everywhere.
    if (process.platform !== 'win32' && localRoot === 'C:/folder/..') continue
    assert.throws(() => normalizeMapping({ localRoot, remoteRoot: '/srv' }), /根目录/)
  }
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'main.js'), 'hello')
  const tree = new Transfer({}, {})
  tree.uploadFile = async () => ({ size: 5, mtimeMs: 1 })
  assert.equal((await tree.uploadTree(host, root, '/srv', { matcher: createMatcher({ include: ['**/*.js'] }) })).files, 1)
  await assert.rejects(() => tree.uploadTree(host, join(root, 'missing'), '/srv'), /无法读取/)

  const sftp = new MemorySftp()
  const files = new RemoteFiles({ sftp: async () => sftp })
  sftp.put('/target', 'valuable')
  await assert.rejects(() => files.rename(host, '/missing', '/target'))
  assert.equal(sftp.entries.get('/target').buffer.toString(), 'valuable')
  const rename = sftp.rename.bind(sftp)
  sftp.rename = (from, to, cb) => cb(Object.assign(new Error('Permission denied'), { code: 3 }))
  await assert.rejects(() => files.writeText(host, '/target', 'replacement'))
  await assert.rejects(() => files.writeBytes(host, '/target', Buffer.from('replacement')))
  assert.equal(sftp.entries.get('/target').buffer.toString(), 'valuable')
  assert.equal([...sftp.entries.keys()].some((key) => key.includes('.dsh-tmp-')), false)
  sftp.rename = rename
  sftp.ext_openssh_rename = (from, to, cb) => cb(Object.assign(new Error('unsupported'), { code: 8 }))
  sftp.put('/source', 'new')
  await renameRemote(sftp, '/source', '/target')
  assert.equal(sftp.entries.get('/target').buffer.toString(), 'new')
  sftp.ext_openssh_rename = (from, to, cb) => cb(Object.assign(new Error('denied'), { code: 3 }))
  sftp.put('/source', 'next')
  await assert.rejects(() => renameRemote(sftp, '/source', '/target'))
  assert.equal(sftp.entries.get('/target').buffer.toString(), 'new')
  delete sftp.ext_openssh_rename
  // ssh2 throws synchronously when the server did not advertise the extension.
  sftp.ext_openssh_rename = () => { throw new Error('Server does not support this extended request') }
  await renameRemote(sftp, '/source', '/target')
  assert.equal(sftp.entries.get('/target').buffer.toString(), 'next')
  delete sftp.ext_openssh_rename

  sftp.put('/shrinking', 'abc')
  const downloads = new Transfer({ sftp: async () => sftp }, { stat: async () => ({ size: 10, mtimeMs: 1000 }) })
  const output = join(root, 'download.txt')
  await writeFile(output, 'original')
  await assert.rejects(() => downloads.downloadFile(host, '/shrinking', output), (e) => e.code === 'source-changed')
  assert.equal(await readFile(output, 'utf8'), 'original')
  assert.equal(sftp.handles.size, 0)

  sftp.put('/changing', 'abcdef', 100)
  const transfer = new Transfer({ sftp: async () => sftp }, files)
  await assert.rejects(() => transfer.downloadFile(host, '/changing', output, {
    onProgress: () => { sftp.entries.get('/changing').mtime = 101 },
  }), (e) => e.code === 'source-changed')
  assert.equal(await readFile(output, 'utf8'), 'original')
  const info = await transfer.downloadFile(host, '/changing', output)
  assert.equal(info.remoteMtimeMs, 101000)
  const controller = new AbortController()
  await assert.rejects(() => transfer.downloadFile(host, '/changing', output, {
    signal: controller.signal,
    onProgress: () => controller.abort(),
  }), (e) => e.code === 'aborted')
  assert.equal(await readFile(output, 'utf8'), 'abcdef')

  const source = join(root, 'upload.txt')
  await writeFile(source, 'abcdef')
  sftp.put('/upload-target', 'original')
  await assert.rejects(() => transfer.uploadFile(host, source, '/upload-target', {
    chunkSize: 3,
    onProgress: () => { writeFileSync(source, 'x') },
  }), (e) => e.code === 'source-changed')
  assert.equal(sftp.entries.get('/upload-target').buffer.toString(), 'original')
  await writeFile(source, 'abcdef')
  await transfer.uploadFile(host, source, '/upload-target')
  sftp.rename = (from, to, cb) => cb(Object.assign(new Error('denied'), { code: 3 }))
  await assert.rejects(() => transfer.uploadFile(host, source, '/upload-target'))
  assert.equal(sftp.entries.get('/upload-target').buffer.toString(), 'abcdef')
  const blocked = join(root, 'blocked')
  await writeFile(blocked, 'not a directory')
  const store = new Store(join(blocked, 'state.json'))
  const originalError = console.error
  const errors = []
  console.error = (...args) => errors.push(args)
  try {
    await store.upsertHost(host)
    await assert.rejects(() => store.flush())
    await rm(blocked)
    await store.flush()
    assert.equal(JSON.parse(await readFile(store.path, 'utf8')).hosts[0].id, host.id)
    assert.equal(errors.length, 1)
  } finally {
    console.error = originalError
  }
  console.log('safety: ok (roots, includes, failed publication, early EOF, source drift)')
} finally {
  await rm(root, { recursive: true, force: true })
}
