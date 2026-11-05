/**
 * Chunked, resumable transfer.
 *
 * The property that matters is not "it copies bytes" — `fastPut` did that. It is
 * **an interrupted transfer resumes instead of restarting**, and that resuming
 * never splices bytes from two different versions of a file. The part file's
 * size is the resume point and its name carries the source fingerprint, so both
 * claims are checked here by aborting a real transfer mid-flight and looking at
 * what is on the other side.
 *
 * Run: `node test/transfer.mjs`
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteFiles } from '../src/remote/files.js'
import { Transfer, isPartPath } from '../src/remote/transfer.js'
import { MemorySftp } from './helpers/memory-sftp.mjs'

const CHUNK = 1024 * 1024
/** Deterministic non-repeating bytes: any offset slip becomes a mismatch. */
function pattern(size) {
  const buffer = Buffer.alloc(size)
  for (let index = 0; index < size; index += 1) buffer[index] = index % 251
  return buffer
}

const sftp = new MemorySftp()
sftp.mkdirs('/srv', '/srv/app', '/srv/tree')
const pool = {
  sftp: async () => sftp,
  exec: async () => ({ stdout: '', stderr: '', code: 0 }),
}
const files = new RemoteFiles(pool)
const transfer = new Transfer(pool, files)
const host = { id: 'h1', name: 'test' }
const dir = mkdtempSync(join(tmpdir(), 'rs-transfer-'))
const parts = () => [...sftp.entries.keys()].filter(isPartPath)

try {
  /* ── a small file lands under its real name, no part survives ───────── */

  const small = join(dir, 'small.txt')
  writeFileSync(small, 'hello remote\n')
  const up = await transfer.uploadFile(host, small, '/srv/app/small.txt')
  assert.equal(up.size, 13)
  assert.equal(up.resumedFrom, 0)
  assert.equal(sftp.entries.get('/srv/app/small.txt').buffer.toString('utf8'), 'hello remote\n')
  assert.deepEqual(parts(), [], 'a completed upload leaves no part file')

  /* ── a multi-chunk file keeps every byte ────────────────────────────── */

  const bigBytes = pattern(CHUNK * 2 + 34567)
  const big = join(dir, 'big.bin')
  writeFileSync(big, bigBytes)
  const bigUp = await transfer.uploadFile(host, big, '/srv/app/big.bin')
  assert.equal(bigUp.size, bigBytes.length)
  assert.deepEqual(sftp.entries.get('/srv/app/big.bin').buffer, bigBytes, 'chunked upload is byte-exact')
  assert.deepEqual(parts(), [])

  /* ── abort mid-flight, then resume: only the tail is sent ───────────── */

  const resumeTarget = '/srv/app/resume.bin'
  const controller = new AbortController()
  let abortedAt = 0
  await assert.rejects(
    () => transfer.uploadFile(host, big, resumeTarget, {
      signal: controller.signal,
      onProgress: ({ transferred }) => {
        abortedAt = transferred
        if (transferred >= CHUNK) controller.abort()
      },
    }),
    (error) => error.code === 'aborted',
  )
  assert.ok(abortedAt >= CHUNK && abortedAt < bigBytes.length, 'the abort lands between chunks')
  const leftover = parts()
  assert.equal(leftover.length, 1, 'the interrupted upload keeps exactly one part file')
  assert.equal(sftp.entries.get(leftover[0]).buffer.length, abortedAt, 'part size is the resume point')
  assert.equal(sftp.entries.has(resumeTarget), false, 'the real name never shows a partial file')

  const sentAfterResume = []
  const resumed = await transfer.uploadFile(host, big, resumeTarget, {
    onProgress: ({ transferred }) => sentAfterResume.push(transferred),
  })
  assert.equal(resumed.resumedFrom, abortedAt, 'the second attempt starts where the first stopped')
  assert.equal(sentAfterResume[0], abortedAt + CHUNK, 'only the missing tail is transferred')
  assert.deepEqual(sftp.entries.get(resumeTarget).buffer, bigBytes, 'the resumed file is byte-exact')
  assert.deepEqual(parts(), [], 'the part is consumed by the rename')

  /* ── a changed source never splices into an old part ────────────────── */

  const changed = join(dir, 'changed.bin')
  const changedBytes = pattern(CHUNK * 2 + 34567 + 10)
  writeFileSync(changed, changedBytes)
  const changedUp = await transfer.uploadFile(host, changed, resumeTarget)
  assert.equal(changedUp.resumedFrom, 0, 'a different size fingerprints to a different part')
  assert.deepEqual(sftp.entries.get(resumeTarget).buffer, changedBytes)

  /* a stale part larger than the source is discarded, not trusted */
  sftp.put('/srv/app/oversize.bin.dsh-part-9-9', pattern(CHUNK * 4))
  const smallAgain = await transfer.uploadFile(host, small, '/srv/app/oversize.bin')
  assert.equal(smallAgain.resumedFrom, 0)
  assert.equal(sftp.entries.get('/srv/app/oversize.bin').buffer.toString('utf8'), 'hello remote\n')
  assert.ok(
    [...sftp.entries.keys()].some((key) => key.endsWith('oversize.bin.dsh-part-9-9')),
    'a part from another version is left alone rather than silently reused',
  )

  /* an explicit sweep removes leftovers (and nothing else) */
  const swept = await transfer.cleanParts(host, '/srv/app')
  assert.ok(swept.removed >= 1, 'the sweep reports what it removed')
  assert.equal([...sftp.entries.keys()].some(isPartPath), false, 'no part file survives a sweep')
  assert.equal(sftp.entries.has('/srv/app/small.txt'), true, 'a sweep only touches part files')

  /* ── download: same guarantees in the other direction ───────────────── */

  sftp.put('/srv/app/dl.bin', bigBytes)
  const dlTarget = join(dir, 'dl.bin')
  const dl = await transfer.downloadFile(host, '/srv/app/dl.bin', dlTarget)
  assert.equal(dl.size, bigBytes.length)
  assert.deepEqual(readFileSync(dlTarget), bigBytes)

  const dlResumeTarget = join(dir, 'dl-resume.bin')
  const dlController = new AbortController()
  let dlAt = 0
  await assert.rejects(
    () => transfer.downloadFile(host, '/srv/app/dl.bin', dlResumeTarget, {
      signal: dlController.signal,
      onProgress: ({ transferred }) => {
        dlAt = transferred
        if (transferred >= CHUNK) dlController.abort()
      },
    }),
    (error) => error.code === 'aborted',
  )
  assert.equal(existsSync(dlResumeTarget), false, 'a partial download never takes the real name')
  assert.deepEqual([...sftp.entries.keys()].filter(isPartPath), [], 'download parts live on the local side')

  const dlResumed = await transfer.downloadFile(host, '/srv/app/dl.bin', dlResumeTarget)
  assert.ok(dlResumed.resumedFrom > 0, 'the second download continues from the local part')
  assert.equal(dlResumed.resumedFrom, dlAt)
  assert.deepEqual(readFileSync(dlResumeTarget), bigBytes)

  /* ── a tree walk ignores part files ─────────────────────────────────── */

  sftp.put('/srv/tree/a.txt', 'a\n')
  sftp.put('/srv/tree/junk.dsh-part-1-2', 'unfinished\n')
  const treeTarget = join(dir, 'tree')
  await transfer.downloadTree(host, '/srv/tree', treeTarget)
  assert.ok(existsSync(join(treeTarget, 'a.txt')))
  assert.equal(existsSync(join(treeTarget, 'junk.dsh-part-1-2')), false, 'part files are not content')

  assert.equal(isPartPath('/x/y.dsh-part-12-345'), true)
  assert.equal(isPartPath('/x/y.txt'), false)

  console.log('transfer: ok (chunked upload/download, resume from part size, fingerprint guards, part files skipped)')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(0)
