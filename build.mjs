/**
 * Build the client half into `lib/client.js`.
 *
 * DSH's browser module table consumes a client bundle as a registration call:
 * `window.__ModuleLoader__.load({ id, factory })`, where `factory` receives a
 * `require` that resolves against the module table (react is baseline). esbuild
 * emits CommonJS, and this script wraps that output in the registration shell —
 * the same shape the official plugins ship.
 *
 * CSS is imported with esbuild's `text` loader so the same file can be injected
 * from inside the factory (bundle-time CSS extraction would emit a second file
 * the loader does not serve).
 */
import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(await (await import('node:fs/promises')).readFile(join(root, 'package.json'), 'utf8'))
const minify = process.argv.includes('--minify')

const result = await build({
  entryPoints: [join(root, 'client/index.js')],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome110', 'firefox110', 'safari16'],
  external: ['react', 'react-dom', 'react-dom/client'],
  loader: { '.css': 'text' },
  // Classic JSX: the module table only resolves `react`, not `react/jsx-runtime`,
  // so the automatic runtime would fail to load inside DSH. Every `.jsx` file
  // imports `createElement as h`, which is what the transform calls.
  jsx: 'transform',
  jsxFactory: 'h',
  jsxFragment: 'Fragment',
  legalComments: 'none',
  minify,
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})

const body = result.outputFiles[0].text
const banner = `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(pkg.name)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
`
const footer = `
\t\treturn module.exports;
\t}
});
`
const out = join(root, 'lib/client.js')
await mkdir(dirname(out), { recursive: true })
await writeFile(out, `${banner}${body}${footer}`, 'utf8')
const bytes = Buffer.byteLength(body)
console.log(`built lib/client.js — ${(bytes / 1024).toFixed(1)} KiB raw${minify ? ' (minified)' : ''}`)
