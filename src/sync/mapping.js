/**
 * Path mapping rules: which local files belong to a remote root.
 *
 * A mapping is deliberately one-directional at the data level and the product
 * default is `push` — local is the truth, remote is the shadow. `both` exists
 * but the sync engine gates it behind the same conflict check as a manual pull,
 * so turning it on never silently overwrites a remote-only edit.
 * @module dsh-remote-ssh/sync/mapping
 */
import { sep, resolve, parse, win32 } from 'node:path'
import { nextId, toLocalPath } from '../util.js'

/** Product default excludes: VCS metadata, dependency trees, build output. */
export const DEFAULT_EXCLUDES = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.pnpm-store',
  '.venv',
  '__pycache__',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  'coverage',
  '*.log',
  '*.tmp',
  '.DS_Store',
  'Thumbs.db',
]

/** Convert a glob (npm-style: `*`, `**`, `?`, trailing `/`) into a RegExp. */
function globToRegExp(pattern) {
  const normalized = pattern.replace(/^\.\//, '').replace(/\/+$/, '')
  if (normalized === '') return /^$/
  let source = ''
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1
        if (normalized[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') { source += '[^/]'; continue }
    if ('\\^$.|+()[]{}'.includes(char)) { source += `\\${char}`; continue }
    source += char
  }
  // A bare name (`node_modules`) matches at any depth; a path pattern is rooted.
  // Tested on the PATTERN, not on `source`: the generated `[^/]*` class would
  // otherwise make every wildcard rule look rooted.
  const rooted = normalized.includes('/')
  return new RegExp(rooted ? `^${source}$` : `^(?:.*/)?${source}$`)
}

/**
 * Build an include/exclude predicate over mapping-relative POSIX paths.
 *
 * A rule matches a path when it matches the path itself or any ancestor
 * directory, so excluding `dist` also drops `dist/assets/app.js` without
 * needing `dist/**` in every rule list.
 * @param {{include?: readonly string[], exclude?: readonly string[]}} rules - glob lists.
 * @returns {(relPath: string, isDir?: boolean) => boolean} true when the path syncs.
 */
export function createMatcher({ include = [], exclude = [] } = {}) {
  const includeRes = include.map(globToRegExp)
  const excludeRes = exclude.map(globToRegExp)
  const hits = (rule, path) => {
    if (rule.test(path)) return true
    let dir = path
    for (;;) {
      const cut = dir.lastIndexOf('/')
      if (cut <= 0) return false
      dir = dir.slice(0, cut)
      if (rule.test(dir)) return true
    }
  }
  return (relPath, isDir = false) => {
    const path = toLocalPath(relPath).replace(/^\/+/, '')
    if (path === '') return true
    for (const rule of excludeRes) if (hits(rule, path)) return false
    if (isDir) return true
    if (includeRes.length === 0) return true
    return includeRes.some((rule) => hits(rule, path))
  }
}

/** POSIX-normalize a mapping-relative path. */
export function relPosix(relPath) {
  return toLocalPath(relPath).replace(/^[/.]+/, '').replace(/\/+/g, '/')
}

/**
 * Validate and normalize one mapping row coming from the UI.
 * @param {object} input - raw mapping from the client.
 * @param {string} [sessionCwd] - base for a relative `localRoot`.
 * @returns {object} a storable mapping.
 */
export function normalizeMapping(input, sessionCwd) {
  const localInput = toLocalPath(String(input.localRoot ?? '').trim())
  if (localInput === '') throw new Error('请填写本地路径')
  // Check Windows roots even on POSIX; do not turn C:/ into drive-relative C:.
  if (/^[a-z]:\/?$/i.test(localInput)
    || (localInput.startsWith('//') && win32.parse(win32.resolve(localInput)).root === win32.resolve(localInput))) {
    throw new Error('不能把整个磁盘根目录设为映射')
  }
  const localRaw = resolve(sessionCwd ?? process.cwd(), localInput)
  const remoteRaw = String(input.remoteRoot ?? '').trim().replace(/\/+$/, '')
  if (!remoteRaw.startsWith('/')) throw new Error('远端路径必须是绝对路径')
  if (parse(localRaw).root === localRaw) throw new Error('不能把整个磁盘根目录设为映射')
  const direction = ['push', 'pull', 'both'].includes(input.direction) ? input.direction : 'push'
  const policy = ['off', 'save', 'all'].includes(input.policy) ? input.policy : 'save'
  const exclude = Array.isArray(input.exclude) && input.exclude.length > 0
    ? input.exclude.map(String)
    : DEFAULT_EXCLUDES
  const include = Array.isArray(input.include) ? input.include.map(String).filter(Boolean) : []
  return {
    id: typeof input.id === 'string' && input.id !== '' ? input.id : nextId('map'),
    hostId: String(input.hostId ?? ''),
    localRoot: localRaw,
    remoteRoot: remoteRaw,
    direction,
    policy,
    include,
    exclude,
    enabled: input.enabled !== false,
    modeTemplate: input.modeTemplate ?? '',
    createdAt: typeof input.createdAt === 'number' ? input.createdAt : Date.now(),
    sessionCwd: sessionCwd ?? undefined,
  }
}

/**
 * Serialize a mapping for the client (adds derived display fields only).
 */
export function describeMapping(mapping) {
  return {
    ...mapping,
    localRootDisplay: mapping.localRoot.replaceAll(sep, '/'),
    directionLabel: mapping.direction === 'push' ? '仅上传' : mapping.direction === 'pull' ? '仅下载' : '双向',
  }
}
