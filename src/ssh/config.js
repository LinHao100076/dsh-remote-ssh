/**
 * `~/.ssh/config` reader.
 *
 * Only used to offer host suggestions and to seed the connection form — the
 * actual connection is made by the ssh2 client, which does not read this file
 * itself. Parsing therefore stays deliberately shallow: one value per key,
 * first match wins, wildcard `Host` blocks are skipped (they are rules, not
 * connectable hosts).
 * @module dsh-remote-ssh/ssh/config
 */
import { existsSync, globSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expandHome } from './paths.js'

const MAX_INCLUDE_DEPTH = 4

/** Strip a trailing `#` comment that is not inside quotes. */
function stripComment(line) {
  let quote = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== '' && char === quote) quote = ''
    else if (quote === '' && (char === '"' || char === "'")) quote = char
    else if (quote === '' && char === '#') return line.slice(0, index)
  }
  return line
}

/** Split `Key value` / `Key = value` into a normalized pair. */
function splitDirective(line) {
  const trimmed = line.trim()
  if (trimmed === '') return undefined
  const match = /^(\S+)\s*(?:=\s*)?(.*)$/.exec(trimmed)
  if (match === null) return undefined
  return { key: match[1].toLowerCase(), value: match[2].trim() }
}

/** Expand `Include` targets (globs allowed) and read them, depth-first. */
function readConfigFile(path, depth, seen) {
  if (depth > MAX_INCLUDE_DEPTH) return []
  if (seen.has(path) || !existsSync(path)) return []
  seen.add(path)
  const text = readFileSync(path, 'utf8')
  const lines = []
  for (const raw of text.split(/\r?\n/)) {
    const directive = splitDirective(stripComment(raw))
    if (directive === undefined) continue
    if (directive.key === 'include') {
      for (const pattern of directive.value.split(/\s+/).filter(Boolean)) {
        const target = expandHome(pattern)
        let matches = []
        try {
          matches = globSync(target, { cwd: join(homedir(), '.ssh') })
        } catch {
          matches = []
        }
        for (const match of matches) {
          const resolved = match.startsWith('/') ? match : join(homedir(), '.ssh', match)
          lines.push(...readConfigFile(resolved, depth + 1, seen))
        }
      }
      continue
    }
    lines.push({ key: directive.key, value: directive.value })
  }
  return lines
}

/**
 * Parse ssh config text into connectable host blocks.
 * @param {readonly {key: string, value: string}[]} directives - flattened directives.
 * @returns {Array<Record<string, string|number|undefined>>} host entries, in file order.
 */
export function parseDirectives(directives) {
  const hosts = []
  let current
  const flush = () => {
    if (current !== undefined) {
      current.port = current.port ?? 22
      hosts.push(current)
    }
    current = undefined
  }
  for (const { key, value } of directives) {
    if (key === 'host') {
      flush()
      const aliases = value.split(/\s+/).filter(Boolean)
      if (aliases.length === 0) continue
      // Wildcard blocks are pattern rules; `!` entries are negations.
      if (aliases.some((alias) => /[*?!]/.test(alias))) continue
      current = { alias: aliases[0], aliases }
      continue
    }
    if (key === 'match') { flush(); continue }
    if (current === undefined) continue
    if (key === 'hostname') current.host = value
    else if (key === 'user') current.user = value
    else if (key === 'port') current.port = Number.parseInt(value, 10) || 22
    else if (key === 'identityfile') current.identityFile = expandHome(value)
    else if (key === 'proxyjump') current.proxyJump = value === 'none' ? undefined : value
  }
  flush()
  return hosts
}

/**
 * Read the user's ssh config and return its connectable hosts.
 * @returns {Array<Record<string, string|number|undefined>>} hosts, empty when no config exists.
 */
export function readSshConfig() {
  const path = join(homedir(), '.ssh', 'config')
  if (!existsSync(path)) return []
  const hosts = parseDirectives(readConfigFile(path, 0, new Set()))
  return hosts.map((host) => ({
    alias: host.alias,
    host: host.host ?? host.alias,
    port: host.port ?? 22,
    user: host.user,
    identityFile: host.identityFile,
    proxyJump: host.proxyJump,
  }))
}

/**
 * Find one ssh-config host block by alias.
 * @param {string} alias - the `Host` token.
 * @returns {Record<string, string|number|undefined>|undefined} the resolved block.
 */
export function findSshHost(alias) {
  if (typeof alias !== 'string' || alias === '') return undefined
  return readSshConfig().find((host) => host.alias === alias || host.host === alias)
}
