import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { SyncEngine } from '../src/sync/engine.js'
import { sleep } from '../src/util.js'

async function until(check) {
  const deadline = Date.now() + 10000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('watcher test timed out')
    await sleep(30)
  }
}
const root = await mkdtemp(join(tmpdir(), 'dsh-sync-'))
const store = new Store(join(root, 'state.json'))
const host = { id: 'h' }
await store.upsertHost(host)
let release
let block = true
const uploads = []
const remote = new Map()
const engine = new SyncEngine({ pool: {}, store,
  files: { stat: async (h, path) => remote.get(path) },
  transfer: {
    uploadFile: async (h, local, path, { signal } = {}) => {
      const text = await readFile(local, 'utf8')
      uploads.push({ path, text })
      if (block) await new Promise((resolve) => { release = resolve })
      if (signal?.aborted) throw new Error('aborted')
      const info = { size: Buffer.byteLength(text), mtimeMs: 100000 }
      remote.set(path, info)
      return info
    },
    downloadFile: async (h, path, local) => {
      await writeFile(local, 'remote')
      remote.set(path, { size: 6, mtimeMs: 1000 })
      return { size: 6, mtimeMs: 2000, remoteMtimeMs: 1000 }
    },
  },
})
try {
  const localRoot = join(root, 'workspace')
  await mkdir(join(localRoot, 'src'), { recursive: true })
  const mapping = { id: 'm', hostId: 'h', localRoot, remoteRoot: '/srv', include: ['**/*.js'] }
  await engine.save('s', mapping, root)
  const file = join(localRoot, 'src', 'main.js')
  await writeFile(file, 'first')
  await until(() => release !== undefined)
  await writeFile(file, 'second version')
  // Let the real chokidar stability window and debounce observe the second save.
  await sleep(750)
  block = false
  release()
  await engine.flush('s')
  assert.deepEqual(uploads.map((item) => item.text), ['first', 'second version'])

  for (const rel of ['../outside', 'src/../../outside', '/absolute', 'C:/outside', '\\\\server\\share', 'bad\0name']) {
    await assert.rejects(() => engine.pull('s', 'm', rel), /映射目录/)
  }
  const outside = join(root, 'outside')
  await mkdir(outside)
  await symlink(outside, join(localRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(() => engine.pull('s', 'm', 'escape/new.txt'), /映射目录/)
  await engine.pull('s', 'm', 'pulled.txt')
  assert.equal(store.baselines('s')['m:pulled.txt'].remoteMtimeMs, 1000)
  assert.equal(store.baselines('s')['m:pulled.txt'].localMtimeMs, 2000)

  // Same mapping ids in different sessions must have independent debounce keys.
  const other = join(root, 'other')
  await mkdir(other)
  await engine.save('other-session', { ...mapping, localRoot: other, remoteRoot: '/other' }, root)
  await Promise.all([writeFile(file, 'third'), writeFile(join(other, 'other.js'), 'other')])
  await until(() => uploads.length >= 4)
  await engine.flush('s')
  await engine.flush('other-session')
  assert.ok(uploads.some((item) => item.path === '/other/other.js'))

  // Same-size edits one second apart must not hide remote drift or local saves.
  remote.set('/srv/src/main.js', { size: 5, mtimeMs: 101000 })
  await writeFile(file, 'forth')
  await until(() => engine.list('s').conflicts.length === 1)
  assert.equal(engine.list('s').conflicts[0].rel, 'src/main.js')
  await engine.save('s', { ...mapping, enabled: false }, root)
  assert.deepEqual(engine.list('s').conflicts, [])
  const beforePause = uploads.length
  await writeFile(file, 'paused')
  await sleep(750)
  assert.equal(uploads.length, beforePause)
  remote.delete('/srv/src/main.js')
  await engine.save('s', mapping, root)

  // A removed mapping must cancel in-flight publication and never restore baselines.
  block = true
  release = undefined
  await writeFile(file, 'pending removal')
  await until(() => release !== undefined)
  await engine.remove('s', 'm')
  release()
  await sleep(100)
  assert.deepEqual(engine.list('s').queue, [])
  assert.deepEqual(engine.list('s').conflicts, [])
  assert.deepEqual(store.baselines('s'), {})
  // Pending debounce callbacks cannot recreate a removed mapping's queue.
  await engine.save('s', mapping, root)
  const beforeRemove = uploads.length
  await writeFile(join(localRoot, 'late.js'), 'late')
  await sleep(250)
  await engine.remove('s', 'm')
  await sleep(750)
  assert.equal(uploads.length, beforeRemove)
  assert.deepEqual(engine.list('s').queue, [])
  console.log('sync: ok (real watcher, resave, session isolation, traversal/symlinks, baselines, removal)')
} finally {
  release?.()
  await engine.dispose()
  await store.flush()
  await rm(root, { recursive: true, force: true })
}
