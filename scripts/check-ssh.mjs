#!/usr/bin/env node
/**
 * Live connection check against a real SSH server.
 *
 * The unit tests use a fake transport, so SFTP behaviour on a real host (banner
 * quirks, permission bits, `rename` semantics, shell startup files) has to be
 * verified once on the machine you actually target. This script runs the same
 * code paths the plugin uses, in order, and prints one line per step.
 *
 *   node scripts/check-ssh.mjs --host 10.0.3.21 --user ubuntu --key ~/.ssh/id_ed25519
 *   node scripts/check-ssh.mjs --host box --user root --password
 *   node scripts/check-ssh.mjs --alias prod-web-01        # from ~/.ssh/config
 *
 * Nothing is written outside the remote temp file this script creates and
 * deletes, and no host is added to the plugin's state file.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SshPool } from '../src/ssh/pool.js'
import { RemoteFiles } from '../src/remote/files.js'
import { Transfer } from '../src/remote/transfer.js'
import { readSshConfig } from '../src/ssh/config.js'
import { expandHome } from '../src/ssh/paths.js'

/* ── arguments ───────────────────────────────────────────────────────── */

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index === -1 ? fallback : argv[index + 1]
}
const flag = (name) => argv.includes(`--${name}`)

const alias = arg('alias')
const config = alias === undefined ? undefined : readSshConfig().find((entry) => entry.alias === alias)
const keyArg = arg('key') ?? config?.identityFile
const usePassword = flag('password') || keyArg === undefined
const host = {
  id: 'check',
  name: alias ?? arg('host', ''),
  host: arg('host', config?.host ?? alias ?? ''),
  port: Number(arg('port', config?.port ?? 22)),
  user: arg('user', config?.user ?? process.env.USER ?? process.env.USERNAME),
  auth: usePassword ? { type: 'password' } : { type: 'key', keyPath: expandHome(keyArg) },
  proxyJump: arg('jump', config?.proxyJump),
  fingerprint: undefined,
}

if (host.host === '') {
  console.error('usage: node scripts/check-ssh.mjs --host <addr> --user <name> [--key ~/.ssh/id_ed25519 | --password] [--port 22] [--jump bastion]')
  process.exit(2)
}
if (host.auth.type === 'password') {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  host.auth.password = await rl.question(`password for ${host.user}@${host.host}: `)
  rl.close()
}

/* ── runner ──────────────────────────────────────────────────────────── */

const pool = new SshPool({ onFingerprint: (_id, fingerprint) => { host.fingerprint = fingerprint } })
const files = new RemoteFiles(pool)
const transfer = new Transfer(pool, files)
let failures = 0

async function step(name, run) {
  const started = Date.now()
  try {
    const detail = await run()
    console.log(`  ✓ ${name}${detail === undefined ? '' : ` — ${detail}`} ${Date.now() - started}ms`)
    return true
  } catch (error) {
    failures += 1
    console.log(`  ✗ ${name} — ${error.message}`)
    return false
  }
}

console.log(`\nchecking ${host.user}@${host.host}:${host.port} (auth: ${host.auth.type})\n`)

const connected = await step('connect', async () => {
  await pool.ensure(host)
  return host.fingerprint
})
if (!connected) {
  pool.dispose()
  process.exit(1)
}

const info = await step('environment', async () => (await files.info(host)).kernel)
await step('tmux', async () => ((await files.info(host)).tmux ? 'available' : 'missing — sessions will not survive a reload'))
const home = await step('home', async () => files.home(host))

await step('exec', async () => {
  const result = await pool.exec(host, 'echo ok; printf "%s" "$USER"')
  if (!result.stdout.includes('ok')) throw new Error(`unexpected stdout: ${result.stdout}`)
  return result.stdout.trim().split('\n').pop()
})

await step('list home', async () => {
  const entries = await files.list(host, home)
  return `${entries.length} entries`
})

const remoteDir = `${home}/.dsh-remote-ssh-check-${Date.now().toString(36)}`
let fixture
await step('mkdir', async () => {
  await files.mkdir(host, remoteDir)
  return remoteDir
})

await step('write + read text', async () => {
  const target = `${remoteDir}/hello.txt`
  await files.writeText(host, target, 'hello 世界\n')
  const read = await files.readText(host, target)
  if (read.text !== 'hello 世界\n') throw new Error('content mismatch')
  return `${read.size} bytes, utf-8 intact`
})

await step('upload fixture', async () => {
  const local = await mkdtemp(join(tmpdir(), 'dsh-ssh-check-'))
  fixture = join(local, 'upload.bin')
  await writeFile(fixture, Buffer.from(Array.from({ length: 2048 }, (_, index) => index % 251)))
  const result = await transfer.uploadFile(host, fixture, `${remoteDir}/upload.bin`)
  return `${result.size} bytes`
})

await step('download fixture', async () => {
  const local = `${fixture}.back`
  await transfer.downloadFile(host, `${remoteDir}/upload.bin`, local)
  const [source, copy] = await Promise.all([readFile(fixture), readFile(local)])
  if (!source.equals(copy)) throw new Error('round-trip bytes differ')
  return 'bytes identical'
})

await step('pty channel', async () => {
  const channel = await pool.channel(host, { cols: 80, rows: 24 })
  const output = await new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('no output from the shell in 8s')), 8000)
    channel.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.includes('CHANNEL-OK')) {
        clearTimeout(timer)
        resolve(buffer)
      }
    })
    channel.on('error', (error) => { clearTimeout(timer); reject(error) })
    setTimeout(() => channel.write('echo CHANNEL-OK\n'), 400)
  })
  channel.close()
  return `${output.length} bytes received`
})

await step('cleanup', async () => {
  await files.remove(host, remoteDir, { recursive: true })
  if (fixture !== undefined) await rm(`${fixture}.back`, { force: true }).catch(() => {})
})

pool.dispose()
console.log(failures === 0 ? '\nall checks passed\n' : `\n${failures} check(s) failed\n`)
process.exit(failures === 0 ? 0 : 1)
