/**
 * Remote terminal tab (xterm.js over the plugin's terminal WebSocket).
 *
 * The emulator is created once per mount and re-attached on demand; the remote
 * side owns the process. tmux availability is reported by the host half with the
 * first frame, so the banner explains the exact loss ("reload ends the session")
 * instead of pretending the shell is persistent.
 * @module dsh-remote-ssh/client/terminal-view
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { createElement as h, useEffect, useRef, useState } from 'react'
import { hostStore, refreshStatuses, usePolling, useStore, wsUrl } from './state.js'
import { Banner, Button, Dot, Empty, Icon, IconButton } from './ui.js'

/** Read one theme token from an element, with a light-mode fallback. */
function token(styles, name, fallback) {
  const value = styles.getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

export function TerminalPane({ ctx, scope, tab, visible }) {
  const sessionId = scope?.sessionId ?? 'default'
  const { hosts, statuses } = useStore(hostStore)
  const seeded = tab?.meta?.hostId ?? tab?.path ?? ''
  const [hostId, setHostId] = useState('')
  const [info, setInfo] = useState(undefined)
  const [error, setError] = useState(undefined)
  const [nonce, setNonce] = useState(0)
  const [notice, setNotice] = useState('')
  const containerRef = useRef(null)
  const termRef = useRef(undefined)
  const fitRef = useRef(undefined)
  const socketRef = useRef(undefined)

  const host = hosts.find((item) => item.id === hostId)
  const status = statuses[hostId]?.status ?? 'disconnected'

  usePolling(visible === true && hostId !== '', 5000, () => refreshStatuses(ctx))

  /* Pick a host once the list arrives (or after the user changes it). */
  useEffect(() => {
    if (hosts.length === 0) return
    setHostId((current) => {
      if (current !== '' && hosts.some((item) => item.id === current)) return current
      if (seeded !== '' && hosts.some((item) => item.id === seeded)) return seeded
      return hosts[0].id
    })
  }, [hosts, seeded])

  /* One emulator + one socket per (host, nonce). */
  useEffect(() => {
    if (hostId === '' || containerRef.current === null) return undefined
    const container = containerRef.current
    const styles = getComputedStyle(container)
    const term = new Terminal({
      fontFamily: token(styles, '--ds-font-family-code', 'ui-monospace, Consolas, monospace'),
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 3000,
      allowProposedApi: true,
      theme: {
        background: token(styles, '--dsw-alias-bg-base', '#ffffff'),
        foreground: token(styles, '--dsw-alias-label-primary', '#1c2028'),
        cursor: token(styles, '--dsw-alias-label-primary', '#1c2028'),
        selectionBackground: token(styles, '--dsw-alias-border-l2', '#d8dce3'),
        black: '#24292f',
        red: '#c0332b',
        green: '#12805c',
        yellow: '#a2610a',
        blue: '#2f6feb',
        magenta: '#6b4fd8',
        cyan: '#0e7490',
        white: '#e6e8ec',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit
    try {
      fit.fit()
    } catch {
      // A zero-sized container at mount (hidden tab) fits on the first resize.
    }
    setInfo(undefined)
    setError(undefined)
    setNotice('')

    const socket = new WebSocket(wsUrl(ctx, 'remote/ws/term', {
      hostId,
      sessionId,
      cols: term.cols,
      rows: term.rows,
    }))
    socketRef.current = socket

    socket.onopen = () => {
      term.focus()
    }
    socket.onmessage = (event) => {
      let frame
      try {
        frame = JSON.parse(event.data)
      } catch {
        return
      }
      if (frame.t === 'out') {
        term.write(frame.d)
        return
      }
      if (frame.t === 'ready') {
        setInfo(frame)
        if (frame.warning) setNotice(frame.warning)
        return
      }
      if (frame.t === 'exit') {
        term.write(`\r\n\x1b[2m[远端进程已退出${frame.code === null ? '' : ` · ${frame.code}`}]\x1b[0m\r\n`)
        setNotice('会话已结束，点「重连」开启新的会话')
        return
      }
      if (frame.t === 'error') {
        setError(frame.message ?? '终端连接失败')
      }
    }
    socket.onerror = () => setError('终端 WebSocket 断开')
    socket.onclose = () => {
      if (socketRef.current === socket) socketRef.current = undefined
    }

    const dataDisposable = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'in', d: data }))
    })

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        return
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
      }
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      dataDisposable.dispose()
      socket.close()
      term.dispose()
      termRef.current = undefined
      fitRef.current = undefined
      socketRef.current = undefined
    }
  }, [ctx, hostId, sessionId, nonce])

  const reconnect = () => {
    setNotice('')
    setError(undefined)
    setNonce((value) => value + 1)
  }

  const openNew = () => {
    const service = ctx.betterSidebar
    if (typeof service?.openTab !== 'function') return
    service.openTab({
      type: 'dsh-remote-ssh:terminal',
      id: `dsh-remote-ssh:terminal:${Date.now().toString(36)}`,
      title: '远程终端',
      meta: { hostId },
      target: 'right',
    })
  }

  if (hosts.length === 0) {
    return h('div', { className: 'rs-root' },
      h('div', { className: 'rs-body' },
        h(Empty, {
          title: '还没有远程主机',
          hint: '先在「远程」文件页里新建一个 SSH 连接，终端才能在这里打开。',
        })))
  }

  return h('div', { className: 'rs-root' },
    h('div', { className: 'rs-head' },
      h(Dot, { status }),
      h('div', { className: 'rs-grow' },
        h('div', { className: 'rs-host' },
          hosts.length > 1
            ? h('select', {
              className: 'rs-select',
              style: { width: 'auto', maxWidth: '150px', border: 'none', background: 'transparent', fontWeight: 600, padding: '0 2px' },
              value: hostId,
              onChange: (event) => { setHostId(event.target.value); setNonce((value) => value + 1) },
            }, hosts.map((item) => h('option', { key: item.id, value: item.id }, item.name)))
            : h('span', { className: 'rs-host-name' }, host?.name ?? '远程终端')),
        h('div', { className: 'rs-host-meta' },
          info === undefined
            ? `${host?.user ?? ''}@${host?.host ?? ''}`
            : `${info.kernel || 'Linux'} · ${info.tmux ? 'tmux 已接管' : '普通 login shell'}`)),
      h(IconButton, { name: 'plus', title: '新建终端标签', onClick: openNew }),
      h(IconButton, { name: 'refresh', title: '重连', onClick: reconnect })),

    info?.tmux === true
      ? h('div', { className: 'rs-term-status' },
        h(Icon, { name: 'check', size: 10 }),
        h('span', null, `tmux new -A -s dsh-… · ${termRef.current?.cols ?? 0}×${termRef.current?.rows ?? 0}`),
        h('span', { style: { flex: 1 } }),
        h('span', null, '刷新可接回'))
      : null,

    notice !== '' ? h(Banner, null, notice) : null,
    error !== undefined ? h(Banner, { tone: 'error' }, error) : null,

    h('div', { className: 'rs-term-wrap' },
      h('div', { className: 'rs-term-host', ref: containerRef }),
      h('div', { className: 'rs-term-status' },
        h('span', null, `${info?.shell || 'shell'} · xterm-256color · UTF-8`),
        h('span', { style: { flex: 1 } }),
        error !== undefined ? h(Button, { size: 'sm', onClick: reconnect }, '重连') : null,
        h('span', null, status === 'connected' ? 'ssh · 复用连接' : status))))
}
