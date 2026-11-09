/** Local browser harness for the shipped client; API fixtures are installed by the browser test. */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { WebSocketServer } from 'ws'

const runtime = await build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
    const plugin = window.__clientRecord.factory(name => {
      if (name === 'react') return React;
      throw new Error('unexpected module: ' + name);
    });
    // Exercise apply() and the native slot registration, not an exported pane shortcut.
    let nativeEntry;
    const slots = {
      inject: (name, callback) => callback(),
      register: (entry, component) => { if (entry.name === 'sidebar.right.pane.tab') nativeEntry = { entry, component }; return () => {}; },
    };
    const services = { slots, sidebarRightTabs: { get: () => undefined, register: () => () => {} }, sidebarRight: { openTab: () => {} } };
    const ctx = { get: name => services[name], effect: fn => fn(), inject: (names, callback) => { if (names.includes('slots')) callback(ctx); return () => {}; } };
    plugin.apply(ctx);
    if (!nativeEntry) throw new Error('native sidebar entry was not registered');
    createRoot(document.getElementById('app')).render(React.createElement(nativeEntry.component,
      { ...nativeEntry.entry.inject('ui-session'), visible: true }));`,
    resolveDir: process.cwd(),
  }, bundle: true, write: false, format: 'iife', define: { 'process.env.NODE_ENV': '"production"' },
})
const sockets = []
const connections = []
const inputs = []
const server = createServer(async (req, res) => {
  if (req.url === '/runtime.js') {
    res.setHeader('content-type', 'text/javascript')
    return res.end(runtime.outputFiles[0].text)
  }
  if (req.url === '/client.js') {
    res.setHeader('content-type', 'text/javascript')
    return res.end(await readFile(new URL('../lib/client.js', import.meta.url)))
  }
  if (req.url === '/__term') return res.end(JSON.stringify(connections))
  if (req.url === '/__inputs') return res.end(JSON.stringify(inputs))
  if (req.url === '/__exit') {
    for (const socket of sockets) {
      if (socket.readyState === 1) { socket.send(JSON.stringify({ t: 'exit', code: 0 })); socket.close() }
    }
    return res.end('ok')
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>DSH button checks</title>
    <style>html,body{margin:0;height:100%;}#app{width:424px;height:900px;} .rs-root{height:100%;}</style></head>
    <body><div id="app"></div><script>window.__ModuleLoader__={load:r=>window.__clientRecord=r}</script>
    <script src="/client.js"></script><script src="/runtime.js"></script></body></html>`)
})
const wss = new WebSocketServer({ server })
wss.on('connection', (socket, req) => {
  sockets.push(socket)
  connections.push(req.url)
  socket.send(JSON.stringify({ t: 'ready', tmux: true, kernel: 'UI fixture', shell: '/bin/sh' }))
  socket.send(JSON.stringify({ t: 'out', d: 'ui-fixture$ ' }))
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw))
    if (frame.t === 'in') { inputs.push(frame.d); socket.send(JSON.stringify({ t: 'out', d: frame.d })) }
  })
})
server.listen(0, '127.0.0.1', () => console.log(`UI_HARNESS=http://127.0.0.1:${server.address().port}/`))
