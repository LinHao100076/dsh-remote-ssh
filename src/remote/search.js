/**
 * Content search that runs on the remote side.
 *
 * The point is to never pull a tree across the wire to look inside it: `rg` is
 * used when present, `grep -r` otherwise, and only the matching lines come
 * back. Both engines are parsed through a channel that is safe for arbitrary
 * file content — ripgrep emits one JSON object per line, grep is told to put a
 * NUL after the filename (`-Z`) — because the obvious `path:line:text` protocol
 * breaks the moment a path or a line contains a colon.
 *
 * Output is cut with `head -n`, which terminates the engine through SIGPIPE
 * (exit 141) rather than letting a huge repository stream megabytes into the
 * host process. A cut at a line boundary keeps every parsed record complete,
 * so truncation never corrupts a hit.
 * @module dsh-remote-ssh/remote/search
 */
import { RemoteError } from '../ssh/pool.js'
import { shq } from '../util.js'

/** Directories that are never worth searching, for engines without ignore files. */
const WALK_EXCLUDES = [
  '.git', 'node_modules', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build', '.next', '.cache', '.idea',
]

const MAX_TEXT = 320
const DEFAULT_LIMIT = 200
const HARD_LIMIT = 2000

/**
 * Cut a very long line while keeping the match visible.
 *
 * A plain "first N characters" cut is worse than useless for search results:
 * minified files and single-line JSON put the match megabytes in, so the
 * preview would show the head of the line and none of the reason it matched.
 * When the engine reports where the match starts, the window is centred there.
 * @param {string} text - the line.
 * @param {number} [focus] - 0-based offset of the match inside `text`.
 */
function clip(text, focus) {
  if (text.length <= MAX_TEXT) return text
  const lead = 120
  const at = Number.isInteger(focus) && focus >= 0 ? focus : -1
  const start = at < 0
    // No position known (grep without a literal anchor): keep both ends.
    ? 0
    : Math.max(0, Math.min(at - lead, text.length - MAX_TEXT + 40))
  const width = at < 0 ? MAX_TEXT : MAX_TEXT - 40
  if (at < 0) {
    const head = Math.ceil(width * 0.6)
    const tail = width - head
    return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
  }
  const end = Math.min(text.length, start + width)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/** Decode ripgrep's `{text}` / `{bytes}` path wrapper. */
function textOf(value) {
  if (typeof value?.text === 'string') return value.text
  if (typeof value?.bytes === 'string') return Buffer.from(value.bytes, 'base64').toString('utf8')
  return ''
}

/**
 * Absolute-ize an engine-reported path.
 *
 * Engines echo paths relative to the walked root when the root is relative and
 * absolute ones verbatim, and a Windows drive path (`C:/…`) is absolute despite
 * not starting with `/`. Treating it as relative would produce
 * `…/proj/C:/proj/src/a.ts` — a path that looks plausible and opens nothing.
 */
function resolvePath(path, root) {
  if (/^(?:\/|[A-Za-z]:[\\/])/.test(path)) return path
  const base = root.replace(/\/+$/, '')
  return path.startsWith(`${base}/`) ? path : `${base}/${path}`
}

export class RemoteSearch {
  /** @type {Map<string, 'rg'|'grep'>} */
  #engines = new Map()

  constructor(pool) {
    this.pool = pool
  }

  /** Filename lookup never opens file contents; NUL records preserve unusual names. */
  async names(host, { root, query, case: caseMode = 'smart', limit = DEFAULT_LIMIT, timeoutMs = 30000 }) {
    const pattern = String(query ?? '')
    if (pattern === '') throw new RemoteError('bad-query', '文件名不能为空', 400)
    const maxHits = Math.min(Math.max(Math.floor(Number(limit)) || DEFAULT_LIMIT, 1), HARD_LIMIT)
    const insensitive = caseMode === 'insensitive' || (caseMode === 'smart' && pattern === pattern.toLowerCase())
    const literal = pattern.replace(/[\\*?\[\]]/g, '\\$&')
    const excluded = WALK_EXCLUDES.map(dir => `-name ${shq(dir)}`).join(' -o ')
    // GNU find/head are available on the supported Ubuntu hosts. Do not split
    // on newlines: they are legal in POSIX filenames.
    const command = `find ${shq(root)} \\( -type d \\( ${excluded} \\) -prune \\) -o \\( -type f ${insensitive ? '-iname' : '-name'} ${shq(`*${literal}*`)} -print0 \\) | head -z -n ${maxHits + 1}`
    const started = Date.now()
    const { stdout, stderr, code } = await this.pool.exec(host, command, { timeoutMs, maxBytes: 8 * 1024 * 1024 })
    if (code !== 0 || stderr.trim() !== '') throw new RemoteError('search-failed', stderr.trim().split('\n')[0] || '文件名搜索失败', 502)
    const paths = stdout.split('\0').filter(Boolean)
    return {
      mode: 'name', engine: 'find', root, query: pattern,
      hits: paths.slice(0, maxHits).map(path => ({ path: resolvePath(path, root), text: path.slice(path.lastIndexOf('/') + 1) })),
      files: Math.min(paths.length, maxHits), truncated: paths.length > maxHits, skipped: 0, durationMs: Date.now() - started,
    }
  }

  /**
   * Which engine this host has. `rg` when available (it respects ignore files
   * and is fast), `grep` otherwise, and an explicit error when neither exists —
   * a silent empty result would look like "no matches" and send the user
   * hunting for a bug in their query.
   * @param {object} host - stored host row.
   * @returns {Promise<'rg'|'grep'>} engine name.
   */
  async engine(host) {
    const cached = this.#engines.get(host.id)
    if (cached !== undefined) return cached
    const { stdout } = await this.pool.exec(
      host,
      'command -v rg 2>/dev/null || command -v grep 2>/dev/null || true',
      { timeoutMs: 8000 },
    )
    const found = stdout.trim()
    if (found === '') {
      throw new RemoteError('no-search-tool', '远端既没有 ripgrep 也没有 grep，无法搜索', 501)
    }
    const engine = /(^|\/)rg$/.test(found) ? 'rg' : 'grep'
    this.#engines.set(host.id, engine)
    return engine
  }

  /**
   * Run one search.
   * @param {object} host - stored host row.
   * @param {object} options - query and bounds.
   * @param {string} options.root - absolute directory to search.
   * @param {string} options.query - pattern or literal.
   * @param {'smart'|'sensitive'|'insensitive'} [options.case] - case handling.
   * @param {boolean} [options.regex] - treat the query as a regular expression.
   * @param {string} [options.glob] - restrict to matching file names.
   * @param {number} [options.limit] - maximum hits to return.
   * @param {number} [options.timeoutMs] - host-side budget for the command.
   * @returns {Promise<object>} hits plus how they were produced.
   */
  async search(host, { root, query, case: caseMode = 'smart', regex = false, glob, limit = DEFAULT_LIMIT, timeoutMs = 30000 }) {
    const pattern = String(query ?? '')
    if (pattern === '') throw new RemoteError('bad-query', '搜索内容不能为空', 400)
    const maxHits = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), HARD_LIMIT)
    let engine = await this.engine(host)
    const started = Date.now()
    let result = await this.#run(host, engine, { root, pattern, caseMode, regex, glob, maxHits, timeoutMs })
    if (result.fallback === true) {
      // The remote rg rejected `--json` (very old build): remember that and use
      // grep from now on instead of failing every subsequent search.
      engine = 'grep'
      this.#engines.set(host.id, 'grep')
      result = await this.#run(host, engine, { root, pattern, caseMode, regex, glob, maxHits, timeoutMs })
    }
    return {
      engine,
      root,
      query: pattern,
      hits: result.hits,
      files: new Set(result.hits.map((hit) => hit.path)).size,
      truncated: result.hits.length >= maxHits,
      skipped: result.skipped,
      durationMs: Date.now() - started,
    }
  }

  /** Build and execute one engine invocation. */
  async #run(host, engine, { root, pattern, caseMode, regex, glob, maxHits, timeoutMs }) {
    const insensitive = caseMode === 'insensitive'
      || (caseMode === 'smart' && pattern === pattern.toLowerCase() && pattern !== pattern.toUpperCase())
    const parts = []
    let parser
    if (engine === 'rg') {
      parts.push('rg', '--json', '--color', 'never', '--no-messages', '--max-filesize', '4M')
      if (regex !== true) parts.push('-F')
      if (caseMode === 'sensitive') parts.push('-s')
      else if (insensitive) parts.push('-i')
      if (typeof glob === 'string' && glob !== '') parts.push('-g', shq(glob))
      parts.push('--', shq(pattern), shq(root))
      // A match produces a `match` object and an `end` object, plus one `begin`
      // per file; three lines per hit plus headroom is always enough.
      parts.push('|', 'head', '-n', String(maxHits * 3 + 64))
      parser = parseRg
    } else {
      parts.push('grep', '-rInZ', '--binary-files=without-match')
      // Plain text is fixed-strings; a "regex" has to be *extended* regex, or
      // `foo|bar` and `a+` would be matched literally (BRE treats both as
      // characters) and a user who ticked the box would get nothing back.
      parts.push(regex === true ? '-E' : '-F')
      if (insensitive) parts.push('-i')
      if (typeof glob === 'string' && glob !== '') parts.push(`--include=${shq(glob)}`)
      for (const dir of WALK_EXCLUDES) parts.push(`--exclude-dir=${shq(dir)}`)
      parts.push('-e', shq(pattern), '--', shq(root))
      parts.push('|', 'head', '-n', String(maxHits + 8))
      parser = parseGrep
    }

    const { stdout, stderr, code } = await this.pool.exec(host, parts.join(' '), {
      timeoutMs,
      maxBytes: 8 * 1024 * 1024,
    })

    // 0 = matches, 1 = none, 141 = SIGPIPE from `head` doing its job.
    if (code !== 0 && code !== 1 && code !== 141) {
      if (code === 2 && engine === 'rg' && /unrecognized|unknown|--json/i.test(stderr)) {
        return { hits: [], skipped: 0, fallback: true }
      }
      if (code === 2 && /regular expression|regex|invalid|unmatched/i.test(stderr)) {
        throw new RemoteError('bad-pattern', `正则表达式无效：${stderr.trim().split('\n')[0] ?? pattern}`, 400)
      }
      throw new RemoteError('search-failed', stderr.trim().split('\n')[0] || `搜索失败（退出码 ${code}）`, 502)
    }
    const hits = parser(stdout, root, maxHits, pattern, insensitive)
    return { hits, skipped: 0, fallback: false }
  }

  /** Forget the cached engine after a reconnect. */
  forget(hostId) {
    this.#engines.delete(hostId)
  }
}

/** Parse `rg --json` output into hits; unparsable lines are ignored, never fatal. */
function parseRg(stdout, root, maxHits) {
  const hits = []
  for (const line of stdout.split('\n')) {
    if (line === '' || hits.length >= maxHits) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event?.type !== 'match') continue
    const path = textOf(event.data?.path)
    const text = textOf(event.data?.lines)
    if (path === '') continue
    const first = Array.isArray(event.data?.submatches) && event.data.submatches.length > 0
      ? event.data.submatches[0]
      : undefined
    hits.push({
      path: resolvePath(path, root),
      line: event.data?.line_number ?? 0,
      column: (first?.start ?? 0) + 1,
      text: clip(text.replace(/\r?\n$/, ''), first?.start),
    })
  }
  return hits
}

/** Parse `grep -rInZ` output: `path\0line:text` per record. */
function parseGrep(stdout, root, maxHits, pattern = '', insensitive = false) {
  const hits = []
  const needle = insensitive ? pattern.toLowerCase() : pattern
  for (const record of stdout.split('\n')) {
    if (record === '' || hits.length >= maxHits) continue
    const nul = record.indexOf('\0')
    if (nul <= 0) continue
    const path = record.slice(0, nul)
    const rest = record.slice(nul + 1)
    const colon = rest.indexOf(':')
    if (colon <= 0) continue
    const line = Number(rest.slice(0, colon))
    if (!Number.isFinite(line)) continue
    const body = rest.slice(colon + 1).replace(/\r?\n$/, '')
    // grep reports no column, but a literal query can be located again; a
    // regular expression cannot, and falls back to the two-ended cut.
    const focus = needle === '' ? -1 : (insensitive ? body.toLowerCase() : body).indexOf(needle)
    hits.push({
      path: resolvePath(path, root),
      line,
      column: focus >= 0 ? focus + 1 : 1,
      text: clip(body, focus >= 0 ? focus : undefined),
    })
  }
  return hits
}
