/**
 * Remote content search.
 *
 * Two things are being pinned here. First the **protocol**: ripgrep is parsed
 * through `--json` and grep through `-Z` (NUL after the filename), because the
 * obvious `path:line:text` format breaks on a path or a line that contains a
 * colon — and the resulting mis-parse would show a hit against the wrong file
 * rather than an error. Second the **command line**: quoting, case flags,
 * `head` truncation and the grep fallback all go through a real `sh` when one
 * is available, so a broken quote shows up as a failed search instead of as a
 * silent zero-result on the user's machine.
 *
 * Run: `node test/search.mjs`
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteSearch } from '../src/remote/search.js'

/** A pool whose `exec` answers from a script and records every command. */
function scriptedPool(replies) {
  const calls = []
  return {
    calls,
    exec: async (host, command, options) => {
      calls.push({ command, options })
      const next = replies.shift()
      if (next === undefined) throw new Error(`unexpected exec: ${command}`)
      return typeof next === 'function' ? next(command) : next
    },
  }
}

const rgProbe = { stdout: '/usr/bin/rg\n', stderr: '', code: 0 }
const grepProbe = { stdout: '/usr/bin/grep\n', stderr: '', code: 0 }
const noneProbe = { stdout: '', stderr: '', code: 1 }

/* ── engine detection ─────────────────────────────────────────────────── */

{
  const pool = scriptedPool([rgProbe, { stdout: '', stderr: '', code: 1 }])
  const search = new RemoteSearch(pool)
  assert.equal(await search.engine({ id: 'h1' }), 'rg')
  assert.equal(await search.engine({ id: 'h1' }), 'rg')
  assert.equal(pool.calls.length, 1, 'the engine probe runs once per host, then stays cached')
}

{
  const pool = scriptedPool([grepProbe])
  assert.equal(await new RemoteSearch(pool).engine({ id: 'h1' }), 'grep')
}

{
  const pool = scriptedPool([noneProbe])
  await assert.rejects(
    () => new RemoteSearch(pool).engine({ id: 'h1' }),
    (error) => error.code === 'no-search-tool',
  )
}

/* ── ripgrep: JSON channel ────────────────────────────────────────────── */

{
  const stdout = [
    JSON.stringify({ type: 'begin', data: { path: { text: 'src/a:b.ts' } } }),
    JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'src/a:b.ts' },
        lines: { text: 'const needle = 1\n' },
        line_number: 12,
        submatches: [{ match: { text: 'needle' }, start: 6, end: 12 }],
      },
    }),
    JSON.stringify({
      type: 'match',
      data: {
        path: { text: 'deep/b.md' },
        lines: { text: '中文 needle 命中\n' },
        line_number: 3,
        submatches: [{ start: 3, end: 9 }],
      },
    }),
    'not json at all',
    JSON.stringify({ type: 'end', data: { path: { text: 'deep/b.md' } } }),
  ].join('\n')
  const pool = scriptedPool([rgProbe, { stdout, stderr: '', code: 0 }])
  const result = await new RemoteSearch(pool).search({ id: 'h1' }, { root: '/home/u/proj', query: 'needle' })

  assert.equal(result.engine, 'rg')
  assert.equal(result.hits.length, 2)
  assert.deepEqual(result.hits[0], { path: '/home/u/proj/src/a:b.ts', line: 12, column: 7, text: 'const needle = 1' })
  assert.equal(result.hits[1].text, '中文 needle 命中')
  assert.equal(result.files, 2)
  assert.equal(result.truncated, false)

  const command = pool.calls[1].command
  assert.match(command, /^rg --json /)
  assert.match(command, / -F /, 'plain text search must be fixed-strings by default')
  assert.match(command, / -i /, 'smart case: an all-lowercase query folds case')
  assert.match(command, / -- 'needle' '\/home\/u\/proj'/, 'the pattern and root must be shell-quoted after --')
  assert.match(command, / \| head -n \d+$/, 'output is cut inside the remote, not after it')
}

/* a huge line is clipped from both ends, keeping the tail where matches live */
{
  const long = `${'x'.repeat(400)}needle${'y'.repeat(400)}`
  const stdout = JSON.stringify({
    type: 'match',
    data: { path: { text: 'big.txt' }, lines: { text: `${long}\n` }, line_number: 1, submatches: [{ start: 400 }] },
  })
  const pool = scriptedPool([rgProbe, { stdout, stderr: '', code: 0 }])
  const { hits } = await new RemoteSearch(pool).search({ id: 'h1' }, { root: '/r', query: 'needle' })
  assert.ok(hits[0].text.length <= 321, 'a match line is clipped')
  assert.ok(hits[0].text.includes('needle'), 'clipping keeps the matched region')
  assert.ok(hits[0].text.includes('…'))
}

/* ── case modes and the regex switch ──────────────────────────────────── */

async function commandFor(options) {
  const pool = scriptedPool([rgProbe, { stdout: '', stderr: '', code: 1 }])
  const search = new RemoteSearch(pool)
  await search.search({ id: 'h1' }, { root: '/r', query: 'Needle', ...options })
  return pool.calls[1].command
}

assert.match(await commandFor({ case: 'sensitive' }), / -s /)
assert.match(await commandFor({ case: 'insensitive' }), / -i /)
assert.doesNotMatch(await commandFor({ case: 'smart' }), / -[is] /, 'smart case leaves a mixed-case query alone')
assert.match(await commandFor({ regex: true }), / -F |/, 'a regex search must not pass -F')
assert.doesNotMatch(await commandFor({ regex: true }), / -F /)
assert.match(await commandFor({ glob: '*.ts' }), / -g '\*\.ts'/)

/* ── zero matches is not an error ─────────────────────────────────────── */

{
  const pool = scriptedPool([rgProbe, { stdout: '', stderr: '', code: 1 }])
  const result = await new RemoteSearch(pool).search({ id: 'h1' }, { root: '/r', query: 'nothing' })
  assert.deepEqual(result.hits, [])
  assert.equal(result.truncated, false)
  assert.equal(result.files, 0)
}

/* `head` killing the engine through SIGPIPE is the expected truncation path */
{
  const stdout = Array.from({ length: 3 }, (_, index) => JSON.stringify({
    type: 'match',
    data: { path: { text: `f${index}.txt` }, lines: { text: 'needle\n' }, line_number: 1, submatches: [{ start: 0 }] },
  })).join('\n')
  const pool = scriptedPool([rgProbe, { stdout, stderr: '', code: 141 }])
  const result = await new RemoteSearch(pool).search({ id: 'h1' }, { root: '/r', query: 'needle', limit: 2 })
  assert.equal(result.hits.length, 2)
  assert.equal(result.truncated, true, 'hitting the limit is reported, not hidden')
}

/* ── failures ─────────────────────────────────────────────────────────── */

{
  const pool = scriptedPool([rgProbe, { stdout: '', stderr: 'regex parse error: unclosed group', code: 2 }])
  await assert.rejects(
    () => new RemoteSearch(pool).search({ id: 'h1' }, { root: '/r', query: '(', regex: true }),
    (error) => error.code === 'bad-pattern',
  )
}

{
  const pool = scriptedPool([rgProbe, { stdout: '', stderr: 'bash: rg: command not found', code: 127 }])
  await assert.rejects(
    () => new RemoteSearch(pool).search({ id: 'h1' }, { root: '/r', query: 'x' }),
    (error) => error.code === 'search-failed',
  )
}

{
  const pool = scriptedPool([rgProbe])
  await assert.rejects(
    () => new RemoteSearch(pool).search({ id: 'h1' }, { root: '/r', query: '   '.trim() }),
    (error) => error.code === 'bad-query',
  )
}

/* ── an old rg without --json falls back to grep, once ────────────────── */

{
  const grepOut = '/r/src/a:b.ts\0' + '7:needle here\n'
  const pool = scriptedPool([
    rgProbe,
    { stdout: '', stderr: 'error: Found argument --json which wasn\'t expected', code: 2 },
    { stdout: grepOut, stderr: '', code: 0 },
    { stdout: grepOut, stderr: '', code: 0 },
  ])
  const search = new RemoteSearch(pool)
  const first = await search.search({ id: 'h1' }, { root: '/r', query: 'needle' })
  assert.equal(first.engine, 'grep', 'the fallback result reports the engine that actually ran')
  assert.equal(first.hits[0].path, '/r/src/a:b.ts', 'a colon inside the path is not a field separator')
  assert.equal(first.hits[0].line, 7)
  assert.equal(first.hits[0].text, 'needle here')
  assert.match(pool.calls[2].command, /^grep -rInZ/)

  const second = await search.search({ id: 'h1' }, { root: '/r', query: 'needle' })
  assert.match(pool.calls[3].command, /^grep -rInZ/, 'the downgrade is remembered, not retried')
  assert.equal(second.engine, 'grep')
}

/* ── real shell: quoting, exclusion and the NUL channel ───────────────── */

const shellProbe = spawnSync('sh', ['-c', 'command -v grep'], { encoding: 'utf8' })
const hasShell = shellProbe.status === 0 && shellProbe.stdout.trim() !== ''

if (hasShell) {
  const root = mkdtempSync(join(tmpdir(), 'rs-search-'))
  const posixRoot = root.replaceAll('\\', '/')
  try {
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(root, 'skip', '.git'), { recursive: true })
    // A colon inside a *file name* is impossible on Windows (it becomes an NTFS
    // alternate data stream), so the colon case is pinned in the scripted
    // ripgrep section above. Here the absolute path itself carries `C:` on
    // Windows, which exercises the same NUL-vs-colon split on a real shell.
    writeFileSync(join(root, 'src', 'a.ts'), 'line one\nconst needle = 1\nline three\n')
    writeFileSync(join(root, 'src', "it's quoted.txt"), 'needle with an apostrophe\n')
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'needle that must not be found\n')
    writeFileSync(join(root, 'skip', '.git', 'config'), 'needle in git metadata\n')
    writeFileSync(join(root, 'blob.dat'), Buffer.from([0x00, 0x01, 0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65]))

    /** Execute through a real `sh`, exactly as the host half would on Linux. */
    const realPool = {
      exec: async (host, command) => {
        const run = spawnSync('sh', ['-c', command], { cwd: root, encoding: 'utf8' })
        return { stdout: run.stdout ?? '', stderr: run.stderr ?? '', code: run.status ?? 1, truncated: false }
      },
    }
    const pool = {
      exec: async (host, command, options) => {
        if (/command -v rg/.test(command)) return { stdout: '/usr/bin/grep\n', stderr: '', code: 0 }
        return realPool.exec(host, command, options)
      },
    }

    const search = new RemoteSearch(pool)
    const found = await search.search({ id: 'h1' }, { root: posixRoot, query: 'needle' })
    assert.equal(found.engine, 'grep')
    assert.ok(found.hits.length > 0, 'the real shell produced hits')
    const paths = found.hits.map((hit) => hit.path).sort()
    assert.deepEqual(
      [...new Set(paths)].sort(),
      [`${posixRoot}/src/a.ts`, `${posixRoot}/src/it's quoted.txt`],
      'only the two source files match: node_modules, .git and the binary are excluded',
    )
    const hit = found.hits.find((entry) => entry.path.endsWith('/a.ts'))
    assert.equal(hit.line, 2)
    assert.equal(hit.text, 'const needle = 1')
    assert.equal(hit.column, 7, 'grep has no column, so a literal query is located again')

    /* fixed-strings by default: `.` must not behave as "any character" */
    const literal = await search.search({ id: 'h1' }, { root: posixRoot, query: 'a.ts' })
    assert.equal(literal.hits.length, 0, 'no regex behaviour unless asked for')

    /* regex means *extended* regex: `\s+` must not be read as "space, plus sign" */
    const regexxed = await search.search({ id: 'h1' }, { root: posixRoot, query: 'const\\s+needle', regex: true })
    assert.equal(regexxed.hits.length, 1, 'a quantified regex has to work on the grep fallback too')
    assert.equal(regexxed.hits[0].line, 2)

    /* an empty result is a clean empty result, not a thrown error */
    const none = await search.search({ id: 'h1' }, { root: posixRoot, query: 'definitely-not-here' })
    assert.deepEqual(none.hits, [])

    /* the glob narrows the walk */
    const globbed = await search.search({ id: 'h1' }, { root: posixRoot, query: 'needle', glob: '*.txt' })
    assert.deepEqual(
      [...new Set(globbed.hits.map((hit) => hit.path))],
      [`${posixRoot}/src/it's quoted.txt`],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

console.log(`search: ok (rg --json + grep -Z channels, case modes, head truncation, downgrade${hasShell ? ', real shell quoting/exclusion' : ''})`)
process.exit(0)
