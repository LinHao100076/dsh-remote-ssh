/**
 * Local path helpers shared by the config reader and the sync engine.
 * @module dsh-remote-ssh/ssh/paths
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Expand a leading `~` (and `~/`) against the current user's home.
 * @param {string} path - user supplied path, possibly tilde-prefixed.
 * @returns {string} an absolute-or-as-given path.
 */
export function expandHome(path) {
  if (typeof path !== 'string' || path === '') return path
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Force a path to absolute, resolving relative input against `base`.
 * @param {string} path - candidate path.
 * @param {string} base - fallback base directory.
 * @returns {string} absolute path (not realpath'd; symlinks are preserved).
 */
export function absoluteLocal(path, base) {
  const expanded = expandHome(path)
  return isAbsolute(expanded) ? expanded : resolve(base, expanded)
}
