/**
 * Build both halves of the plugin.
 *
 * ## Client — `lib/client.js`
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
 *
 * ## Host — `lib/server.mjs`
 *
 * `ssh2`, `ws` and `chokidar` are bundled in. They used to be plain
 * `dependencies`, which works when the package is installed from a tarball
 * (pnpm resolves and installs them) but silently breaks when it is installed
 * from an extracted folder: pnpm turns that into a `link:` dependency and a
 * linked directory's own dependencies are never installed, so the first
 * `import 'ssh2'` fails with ERR_MODULE_NOT_FOUND and the whole plugin refuses
 * to activate. Shipping one self-contained file makes the install method
 * irrelevant — and drops three packages, one of which (`ssh2`) tries to build a
 * native addon on install.
 *
 * Two things need help in that bundle:
 *
 * - `ssh2` probes for an optional native crypto binding (`*.node`) and for
 *   `cpu-features`; `ws` probes for `bufferutil` / `utf-8-validate`. All of them
 *   are optional fast paths guarded by try/catch, so they are replaced with
 *   stubs — the portable JS path is what runs.
 * - `__dirname` / `__filename` do not exist in an ES module, and both `ssh2`
 *   and its vendored emscripten blob reference them. A banner re-creates them
 *   from `import.meta.url`.
 */
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const minify = process.argv.includes('--minify')

/**
 * Replace optional native modules with an empty object.
 *
 * Everything they guard is `try { require(x) } catch {}`, so an empty export is
 * exactly what a machine without the optional package sees.
 * @returns {import('esbuild').Plugin}
 */
function stubOptionalNatives() {
  const optional = new Set(['cpu-features', 'bufferutil', 'utf-8-validate'])
  return {
    name: 'stub-optional-natives',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /\.node$/ }, (args) => ({ path: args.path, namespace: 'stub-native' }))
      pluginBuild.onResolve({ filter: /^[^./]/ }, (args) =>
        optional.has(args.path) ? { path: args.path, namespace: 'stub-native' } : undefined,
      )
      pluginBuild.onLoad({ filter: /.*/, namespace: 'stub-native' }, () => ({
        contents: 'module.exports = {};',
        loader: 'js',
      }))
    },
  }
}

/* ------------------------------------------------------------------ client */

const client = await build({
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

const body = client.outputFiles[0].text
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
const clientOut = join(root, 'lib/client.js')
await mkdir(dirname(clientOut), { recursive: true })
await writeFile(clientOut, `${banner}${body}${footer}`, 'utf8')
console.log(`built lib/client.js — ${(Buffer.byteLength(body) / 1024).toFixed(1)} KiB raw${minify ? ' (minified)' : ''}`)

/* ------------------------------------------------------------------- host */

const server = await build({
  entryPoints: [join(root, 'src/index.js')],
  outfile: join(root, 'lib/server.mjs'),
  bundle: true,
  write: true,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  // Keep stack traces usable: this runs on the user's machine, and a minified
  // frame is worthless in a bug report.
  minify: false,
  legalComments: 'none',
  plugins: [stubOptionalNatives()],
  // Node builtins stay external (esbuild does that for platform: node); the
  // plugin's own imports are all bundled.
  banner: {
    js: [
      "import { createRequire as __bundleCreateRequire } from 'node:module';",
      "import { fileURLToPath as __bundleFileURLToPath } from 'node:url';",
      "import { dirname as __bundleDirname } from 'node:path';",
      // `ws` and `ssh2` are CommonJS and reach for builtins lazily
      // (`require('events')`), which esbuild cannot rewrite. Its `__require`
      // helper uses a real `require` whenever one is in scope, so declaring one
      // here is what keeps those calls working in an ES module.
      'const require = __bundleCreateRequire(import.meta.url);',
      'const __filename = __bundleFileURLToPath(import.meta.url);',
      'const __dirname = __bundleDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'warning',
})

const serverBytes = (await import('node:fs')).statSync(join(root, 'lib/server.mjs')).size
const warnings = server.warnings.filter((w) => w.id !== 'empty-import-meta')
for (const warning of warnings) console.log(`  warn: ${warning.text} (${warning.location?.file ?? '?'})`)
console.log(`built lib/server.mjs — ${(serverBytes / 1024).toFixed(1)} KiB`)
