/**
 * Remote terminal, content only.
 *
 * Each local tab owns one xterm instance and one WebSocket; tabs are kept
 * mounted and hidden rather than unmounted, so switching to the file tree for a
 * moment does not kill a shell (or its tmux attachment). The remote side owns
 * the process: tmux availability arrives with the first frame and decides which
 * promise the hint bar can make.
 * @module dsh-remote-ssh/client/terminal-view
 */
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'
import { wsUrl } from './state.js'
import { Icon, IconButton } from './ui.jsx'

/** Read one theme token from an element, with a fallback. */
function token(styles, name, fallback) {
  const value = styles.getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

/**
 * Resolve one of the panel's own `--rs-*` tokens to a concrete colour.
 *
 * `getPropertyValue` hands back the *token text* (`light-dark(#fff, #15181e)`),
 * which xterm cannot parse, so the renderer has to be asked through a probe.
 * @param {Element} root - panel root, the element that owns the tokens
 * @param {string} name - custom property name
 * @param {string} fallback - value used when the token is missing
 */
function colorOf(root, name, fallback) {
  const probe = document.createElement('span')
  probe.style.color = `var(${name}, ${fallback})`
  probe.style.display = 'none'
  root.appendChild(probe)
  const value = getComputedStyle(probe).color
  probe.remove()
  return value === '' ? fallback : value
}

/** xterm theme built from the panel palette, so the shell matches its frame. */
function themeOf(root) {
  const pick = (name, fallback) => colorOf(root, name, fallback)
  return {
    background: pick('--rs-term-bg', '#ffffff'),
    foreground: pick('--rs-term-fg', '#24292f'),
    cursor: pick('--rs-term-fg', '#24292f'),
    selectionBackground: pick('--rs-line2', '#d8dce3'),
    black: pick('--rs-term-fg', '#24292f'),
    red: pick('--rs-err', '#c0332b'),
    green: pick('--rs-ok', '#12805c'),
    yellow: pick('--rs-warn', '#a2610a'),
    blue: pick('--rs-accent', '#2f6feb'),
    magenta: pick('--rs-violet', '#6b4fd8'),
    cyan: '#0e7490',
    white: pick('--rs-line', '#e6e8ec'),
  }
}

/**
 * One shell: emulator, socket, status bar and key hints.
 * @param {object} props - `ctx`, `sessionId`, `hostId`, `active`, `tmux`.
 */
function TermSession({ ctx, sessionId, hostId, terminalId, active, tmux }) {
  const containerRef = useRef(null)
  const termRef = useRef(undefined)
  const fitRef = useRef(undefined)
  const socketRef = useRef(undefined)
  const [info, setInfo] = useState(undefined)
  const [error, setError] = useState(undefined)
  const [notice, setNotice] = useState('')
  const [size, setSize] = useState({ cols: 0, rows: 0 })
  const [nonce, setNonce] = useState(0)

  /* Build the emulator and the socket once per (host, nonce). */
  useEffect(() => {
    if (containerRef.current === null) return undefined
    // `ended` — an `exit` frame already explained why the channel is closing.
    // `disposed` — the cleanup below is closing it on purpose.
    let ended = false
    let disposed = false
    const container = containerRef.current
    const styles = getComputedStyle(container)
    const term = new Terminal({
      fontFamily: token(styles, '--ds-font-family-code', 'ui-monospace, Consolas, monospace'),
      fontSize: 12,
      lineHeight: 1.3,
      cursorBlink: true,
      scrollback: 3000,
      allowProposedApi: true,
      theme: themeOf(container.closest('.rs-root') ?? container),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    termRef.current = term
    fitRef.current = fit
    try {
      fit.fit()
    } catch {
      // A hidden pane has no box to fit; the resize observer runs on reveal.
    }
    setSize({ cols: term.cols, rows: term.rows })
    setInfo(undefined)
    setError(undefined)
    setNotice('')

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      const mod = event.metaKey || event.ctrlKey
      if (mod && !event.shiftKey && event.key.toLowerCase() === 'k') {
        term.clear()
        return false
      }
      if (mod && event.shiftKey && event.key.toLowerCase() === 'v') {
        void navigator.clipboard?.readText?.()
          .then((text) => { if (text !== '') term.paste(text) })
          .catch(() => {})
        return false
      }
      return true
    })

    const socket = new WebSocket(wsUrl(ctx, 'remote/ws/term', {
      hostId,
      sessionId,
      terminalId,
      cols: term.cols,
      rows: term.rows,
    }))
    socketRef.current = socket

    socket.onopen = () => term.focus()
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
        ended = true
        term.write(`\r\n\x1b[2m[远端进程已退出${frame.code === null ? '' : ` · ${frame.code}`}]\x1b[0m\r\n`)
        setNotice('会话已结束，点「重连」开启新的会话')
        setError('远端进程已退出')
        return
      }
      if (frame.t === 'error') setError(frame.message ?? '终端连接失败')
    }
    socket.onerror = () => setError('终端 WebSocket 断开')
    socket.onclose = () => {
      if (socketRef.current === socket) socketRef.current = undefined
      // Unmounting closes the socket on purpose; anything else is the transport
      // going away underneath us — a host restart (issue #4) most of all. The
      // emulator keeps its last screen either way, so without this the pane sits
      // there showing a live cursor while `onData` drops every keystroke into a
      // socket that is already closed.
      if (disposed) return
      term.write('\r\n\x1b[2m[连接已断开]\x1b[0m\r\n')
      if (!ended) setError('终端连接已断开——宿主可能已重启')
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
      setSize({ cols: term.cols, rows: term.rows })
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'resize', cols: term.cols, rows: term.rows }))
      }
    })
    observer.observe(container)

    return () => {
      disposed = true
      observer.disconnect()
      dataDisposable.dispose()
      socket.close()
      term.dispose()
      termRef.current = undefined
      fitRef.current = undefined
      socketRef.current = undefined
    }
  }, [ctx, hostId, sessionId, terminalId, nonce])

  /* Reveal: fit to the box that just appeared, then take the keyboard. */
  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => {
      try {
        fitRef.current?.fit()
      } catch {
        return
      }
      const term = termRef.current
      if (term !== undefined) {
        setSize({ cols: term.cols, rows: term.rows })
        term.focus()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [active, nonce])

  const clear = () => termRef.current?.clear()
  const paste = () => {
    void navigator.clipboard?.readText?.()
      .then((text) => { if (text !== '') termRef.current?.paste(text) })
      .catch(() => {})
  }
  const reconnect = () => {
    setNotice('')
    setError(undefined)
    setNonce((value) => value + 1)
  }

  const persistent = info?.tmux === true || tmux === true

  return (
    <div className="rs-term-shell" hidden={!active}>
      <div className="rs-term-status">
        <span className={`rs-dot${error === undefined ? ' on' : ' err'}`} />
        <span>ssh · xterm-256color · {size.cols}×{size.rows} · UTF-8</span>
        <span style={{ flex: 1 }} />
        {error !== undefined
          ? <button type="button" onClick={reconnect} style={{ color: 'var(--rs-err)' }}>重连</button>
          : <span>{persistent ? 'tmux 已接管' : 'login shell'}</span>}
      </div>

      {error !== undefined ? <div className="rs-err-box" style={{ margin: '8px 12px 0' }}><code>{error}</code></div> : null}
      {notice !== '' ? <div className="rs-muted" style={{ padding: '0 12px 6px' }}>{notice}</div> : null}

      <div className="rs-term-host" ref={containerRef} />

      <div className="rs-hintbar">
        <button type="button" onClick={clear}>清屏</button>
        <button type="button" onClick={paste}>粘贴</button>
        <span style={{ flex: 1 }} />
        <span>{persistent ? '进程存活由远端 tmux 保底' : '未安装 tmux：刷新后 shell 不保留'}</span>
      </div>
    </div>
  )
}

/**
 * The terminal pane: a strip of local tabs over one live session each.
 * @param {object} props - `ctx`, `sessionId`, `hostId`, `host`, `hostInfo`, `active`.
 */
export function TerminalPane({ ctx, sessionId, hostId, host, hostInfo, active }) {
  const seq = useRef(0)
  const first = useRef(true)
  const [tabs, setTabs] = useState([{ id: 't0' }])
  const [activeId, setActiveId] = useState('t0')

  /* A different host is a different set of shells. */
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    seq.current += 1
    const id = `t${seq.current}`
    setTabs([{ id }])
    setActiveId(id)
  }, [hostId])

  const addTab = () => {
    seq.current += 1
    const id = `t${seq.current}`
    setTabs((current) => [...current, { id }])
    setActiveId(id)
  }

  const closeTab = (id) => {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id)
      if (next.length === 0) {
        seq.current += 1
        const fresh = `t${seq.current}`
        setActiveId(fresh)
        return [{ id: fresh }]
      }
      if (id === activeId) setActiveId(next[next.length - 1].id)
      return next
    })
  }

  const shell = (hostInfo?.shell ?? '').split('/').pop() || 'shell'
  const title = `${shell} — ${host?.name ?? 'remote'}`

  return (
    <>
      <div className="rs-ttabs">
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            className="rs-ttab"
            role="tab"
            aria-selected={tab.id === activeId}
            onClick={() => setActiveId(tab.id)}
          >
            <span className={`rs-dot${tab.id === activeId ? ' on' : ''}`} style={{ width: 5, height: 5, boxShadow: 'none' }} />
            <span className="rs-tname">{index === 0 ? title : `${shell} ${index + 1}`}</span>
            <button
              type="button"
              className="rs-x"
              title="关闭终端"
              onClick={(event) => { event.stopPropagation(); closeTab(tab.id) }}
            >
              <Icon name="x" size={10} />
            </button>
          </div>
        ))}
        <span style={{ flex: 1 }} />
        <IconButton name="plus" title="新建终端" onClick={addTab} />
      </div>

      {tabs.map((tab) => (
        <TermSession
          key={tab.id}
          ctx={ctx}
          sessionId={sessionId}
          hostId={hostId}
          terminalId={tab.id}
          active={tab.id === activeId && active !== false}
          tmux={hostInfo?.tmux}
        />
      ))}
    </>
  )
}
