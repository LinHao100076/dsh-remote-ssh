/**
 * Interactive terminal bridge: one WebSocket ⇄ one SSH channel with a PTY.
 *
 * The tmux decision is made here, per connection: when the remote has tmux the
 * bridge runs `tmux new -A -s dsh-<host>` so a browser reload, an IDE restart or
 * a network blip re-attaches to the same shell. When tmux is missing the bridge
 * falls back to a plain login shell and reports `warning` so the UI can explain
 * what will be lost — the design contract is "use tmux when present, degrade
 * loudly when absent", never "require tmux".
 *
 * Frames are JSON text, not binary, because the channel yields byte buffers that
 * must be decoded with a streaming decoder: a multi-byte character split across
 * two SSH packets would otherwise arrive corrupted.
 * @module dsh-remote-ssh/ws/term
 */

/** Clamp a numeric query parameter. */
function bounded(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/** tmux session name for a host: stable across reloads, safe as an argv token. */
function tmuxSessionName(hostId) {
  return `dsh-${String(hostId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 14) || 'remote'}`
}

/**
 * Attach one websocket to one remote PTY.
 * @param {object} options - bridge dependencies.
 * @param {import('ws').WebSocket} options.ws - the accepted socket.
 * @param {URL} options.url - upgrade URL carrying `hostId`, `cols`, `rows`, `tmux`.
 * @param {object} options.store - state store (host rows).
 * @param {object} options.pool - SSH pool.
 * @param {object} options.files - remote file service (for environment facts).
 * @returns {Promise<void>} resolves when the bridge is wired.
 */
export async function attachTerminal({ ws, url, store, pool, files }) {
  const send = (frame) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }
  const params = url.searchParams
  const hostId = params.get('hostId') ?? ''
  const host = store.host(hostId)
  if (host === undefined) {
    send({ t: 'error', code: 'host-missing', message: '主机不存在，请先在侧边栏保存连接' })
    ws.close()
    return
  }
  const cols = bounded(params.get('cols'), 100, 20, 400)
  const rows = bounded(params.get('rows'), 30, 6, 200)
  const tmuxMode = params.get('tmux') === 'off' ? 'off' : 'auto'
  const decoder = new TextDecoder('utf-8')
  /** @type {import('ssh2').ClientChannel|undefined} */
  let channel

  send({ t: 'status', state: 'connecting' })

  try {
    const info = await files.info(host)
    const useTmux = tmuxMode === 'auto' && info.tmux
    channel = await pool.channel(host, {
      command: useTmux ? `tmux new -A -s ${tmuxSessionName(hostId)}` : undefined,
      cols,
      rows,
    })
    send({
      t: 'ready',
      tmux: useTmux,
      tmuxAvailable: info.tmux,
      kernel: info.kernel,
      shell: info.shell,
      home: info.home,
      warning: info.tmux
        ? undefined
        : '远端未安装 tmux：刷新页面或断线后，本次会话的进程会一起结束。',
    })
  } catch (error) {
    send({ t: 'error', code: error?.code ?? 'ssh-error', message: String(error?.message ?? error) })
    ws.close()
    return
  }

  channel.on('data', (chunk) => send({ t: 'out', d: decoder.decode(chunk, { stream: true }) }))
  channel.stderr?.on('data', (chunk) => send({ t: 'out', d: decoder.decode(chunk, { stream: true }) }))
  channel.on('close', (code) => {
    send({ t: 'exit', code: typeof code === 'number' ? code : null })
    ws.close()
  })
  channel.on('error', (error) => {
    send({ t: 'error', code: 'channel-error', message: String(error?.message ?? error) })
  })

  ws.on('message', (raw) => {
    let frame
    try {
      frame = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (channel === undefined) return
    if (frame.t === 'in' && typeof frame.d === 'string' && channel.writable) {
      channel.write(frame.d)
      return
    }
    if (frame.t === 'resize') {
      const nextCols = bounded(frame.cols, cols, 20, 400)
      const nextRows = bounded(frame.rows, rows, 6, 200)
      try {
        channel.setWindow(nextRows, nextCols, 0, 0)
      } catch {
        // A closed channel rejects resize; the close handler already reported it.
      }
    }
  })

  ws.on('close', () => {
    // Closing the channel does not kill the remote process when tmux owns it:
    // that is exactly the detach/reattach behaviour the bridge promises.
    try {
      channel?.close()
    } catch {
      // Already gone.
    }
  })
}
