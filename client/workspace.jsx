/**
 * The plugin's whole surface: one panel, one host, five panes.
 *
 * This is the only entry the plugin registers now — the four separate
 * better-sidebar tabs were the first thing users asked to change (issue #1:
 * "建议只会出现一个选项叫做 Remote SSH"), and the same component backs DSH's
 * native right sidebar, so both installs look identical.
 *
 * Layout follows `ui/prototype.html`:
 *
 *   host header (switch host / reconnect / disconnect)
 *   tab strip   (文件 / 终端 / 同步 / 转发 / 设置)
 *   body        (the active pane, or the connect gate when there is nothing to
 *                show yet)
 *   footer      (connection, mappings, queue)
 *
 * Connection state lives here rather than in a pane: switching from files to
 * terminal must not look like a different product, and the password prompt has
 * to work no matter which pane asked for the connection.
 * @module dsh-remote-ssh/client/workspace
 */
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import {
  api, hostStore, refreshHosts, refreshStatuses, secretStore, usePolling, useStore,
} from './state.js'
import { ensureStyles } from './inject-styles.js'
import { Dot, Icon, IconButton } from './ui.jsx'
import { ConnectView } from './connect-view.jsx'
import { FilesPane } from './files-view.jsx'
import { ForwardPane } from './forward-view.jsx'
import { SettingsPane } from './settings-view.jsx'
import { SyncPane } from './sync-view.jsx'
import { TerminalPane } from './terminal-view.jsx'

/** Tab id shared with the native right sidebar. */
export const KIND = 'dsh-remote-ssh'

/** Strip order and labels. `badge` reads a count out of the sync snapshot. */
export const VIEWS = [
  { id: 'files', label: '文件', icon: 'folder' },
  { id: 'terminal', label: '终端', icon: 'terminal' },
  { id: 'sync', label: '同步', icon: 'sync', badge: 'queue' },
  { id: 'forward', label: '转发', icon: 'link' },
  { id: 'settings', label: '设置', icon: 'cog' },
]

/** Panes that cannot say anything useful without a live connection. */
const GATED = new Set(['files', 'terminal'])

/** Stand-in for the seat-provided hook, so the body can call one unconditionally. */
const useNoTabInfo = () => undefined

/**
 * The panel.
 * @param {object} props - slot props: `ctx`, plus `scope`/`sessionId`, plus the
 *   seat's `useTabInfo` when it provides one.
 */
export function Workspace(props) {
  const { ctx, tab } = props
  const useTabInfo = props.useTabInfo ?? useNoTabInfo
  const info = useTabInfo()
  const sessionId = props.scope?.sessionId ?? props.sessionId ?? info?.tab?.navigation?.params?.sessionId ?? 'default'
  const visible = props.visible ?? info?.tab?.visible ?? true
  const seededHostId = info?.tab?.navigation?.params?.hostId ?? tab?.meta?.hostId ?? ''

  const { hosts, statuses, loaded } = useStore(hostStore)
  const [hostId, setHostId] = useState('')
  const [view, setView] = useState('files')
  const [visited, setVisited] = useState({ files: true })
  const [menu, setMenu] = useState(false)
  const [creating, setCreating] = useState(false)
  const [seed, setSeed] = useState(0)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState(undefined)
  const [errorCode, setErrorCode] = useState(undefined)
  const [hostInfo, setHostInfo] = useState(undefined)
  const [sync, setSync] = useState({ mappings: [], queue: [], conflicts: [], stats: {} })
  const [toast, setToast] = useState('')
  const primaryHost = useRef('')
  const toastTimer = useRef(0)
  const rootRef = useRef(null)

  // The panel may be hosted by a document the factory never saw (a popped-out or
  // split pane has its own `<head>`), so the sheets are asserted against the
  // document that actually carries `.rs-root`. Issue #3: unstyled markup with a
  // stylesheet sitting in another document's head looks identical to no CSS at
  // all.
  const bindRoot = useCallback((node) => {
    rootRef.current = node
    if (node !== null) ensureStyles(node.ownerDocument)
  }, [])

  const flash = useCallback((text) => {
    setToast(text)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2200)
  }, [])
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const host = hosts.find((item) => item.id === hostId)
  const status = statuses[hostId]?.status ?? 'disconnected'
  const live = status === 'connected'
  const busyStatus = connecting || status === 'connecting'

  /* ── boot: hosts, the session's primary mapping, statuses ───────────── */

  useEffect(() => { void refreshHosts(ctx).catch(() => {}) }, [ctx])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const value = await api(ctx, 'sync.list', { sessionId })
        if (!cancelled) {
          primaryHost.current = value.mappings?.[0]?.hostId ?? ''
          setSync(value)
        }
      } catch {
        // No session mapping is a normal first run.
      }
    })()
    return () => { cancelled = true }
  }, [ctx, sessionId])

  useEffect(() => {
    if (!loaded) return
    if (hosts.length === 0) {
      setHostId('')
      return
    }
    setHostId((current) => {
      if (current !== '' && hosts.some((item) => item.id === current)) return current
      if (seededHostId !== '' && hosts.some((item) => item.id === seededHostId)) return seededHostId
      if (primaryHost.current !== '' && hosts.some((item) => item.id === primaryHost.current)) return primaryHost.current
      return hosts[0].id
    })
  }, [loaded, hosts, seededHostId])

  usePolling(visible === true, 4000, async () => {
    await refreshStatuses(ctx)
    if (live) setSync(await api(ctx, 'sync.list', { sessionId }).catch(() => sync))
  })

  /* ── connect / disconnect ───────────────────────────────────────────── */

  const connect = useCallback(async (target, secret) => {
    if (target === undefined || target === null) return false
    setError(undefined)
    setErrorCode(undefined)
    setConnecting(true)
    try {
      await api(ctx, 'hosts.connect', { hostId: target.id, auth: secret ?? {} })
      if (secret !== undefined && Object.keys(secret).length > 0) {
        secretStore.set(target.id, { ...(secretStore.get(target.id) ?? {}), ...secret })
      }
      const value = await api(ctx, 'hosts.info', { hostId: target.id }).catch(() => undefined)
      setHostInfo(value?.info)
      await refreshStatuses(ctx)
      return true
    } catch (failure) {
      setError(failure.message)
      setErrorCode(failure.code)
      return false
    } finally {
      setConnecting(false)
    }
  }, [ctx])

  /** Connect using the in-memory secret; ask on screen when there is none. */
  const start = useCallback((target = host) => {
    if (target === undefined) return
    const cached = secretStore.get(target.id) ?? {}
    if (target.auth?.type === 'password' && (cached.password ?? '') === '') {
      setError(undefined)
      setErrorCode('bad-password')
      return
    }
    const secret = target.auth?.type === 'password' && cached.password !== undefined
      ? { password: cached.password }
      : target.auth?.type === 'key' && cached.passphrase !== undefined
        ? { passphrase: cached.passphrase }
        : {}
    void connect(target, secret)
  }, [connect, host])

  const disconnect = useCallback(async () => {
    if (host === undefined) return
    try {
      await api(ctx, 'hosts.disconnect', { hostId: host.id })
      setHostInfo(undefined)
      await refreshStatuses(ctx)
      flash('已断开')
    } catch (failure) {
      setError(failure.message)
    }
  }, [ctx, host, flash])

  /** Drop the tunnel and open it again with the same in-memory secret. */
  const reconnect = useCallback(async () => {
    if (host === undefined) return
    try {
      await api(ctx, 'hosts.disconnect', { hostId: host.id })
      await refreshStatuses(ctx)
    } catch {
      // A tunnel that was already gone is exactly what we wanted.
    }
    setHostInfo(undefined)
    start(host)
  }, [ctx, host, start])

  /** The connect page asked for a password; hand it to the API verbatim. */
  const connectWithPassword = useCallback(async (target, password) => {
    const ok = await connect(target, { password })
    if (ok) flash(`已连接 ${target.name}`)
    return ok
  }, [connect, flash])

  /** A key host that answered `auth-failed`: switch it to password on purpose. */
  const usePassword = useCallback(async (target) => {
    const next = { ...target, auth: { type: 'password', keyPath: target.auth?.keyPath } }
    try {
      await api(ctx, 'hosts.save', { host: next })
      await refreshHosts(ctx)
      setErrorCode('bad-password')
      setError(undefined)
      flash('已切换为密码认证，请输入密码')
    } catch (failure) {
      setError(failure.message)
    }
  }, [ctx, flash])

  /* ── host switching + settings ──────────────────────────────────────── */

  const selectHost = useCallback((id) => {
    setHostId(id)
    setHostInfo(undefined)
    setError(undefined)
    setErrorCode(undefined)
    setMenu(false)
  }, [])

  const openSettings = useCallback((isNew) => {
    setCreating(isNew === true)
    setSeed((value) => value + 1)
    setView('settings')
    setVisited((current) => ({ ...current, settings: true }))
    setMenu(false)
  }, [])

  const select = useCallback((id) => {
    setView(id)
    setVisited((current) => (current[id] ? current : { ...current, [id]: true }))
  }, [])

  const onSaved = useCallback(async (saved, secret) => {
    if (secret !== undefined && Object.keys(secret).length > 0) {
      secretStore.set(saved.id, { ...(secretStore.get(saved.id) ?? {}), ...secret })
    }
    await refreshHosts(ctx)
    setHostId(saved.id)
    setCreating(false)
    setView('files')
    setVisited((current) => ({ ...current, files: true }))
    flash('已保存，点右上角连接')
  }, [ctx, flash])

  const onDeleted = useCallback(async (deletedId) => {
    await refreshHosts(ctx)
    if (deletedId === hostId) setHostId('')
    setCreating(false)
    setView('files')
  }, [ctx, hostId])

  /* ── derived ────────────────────────────────────────────────────────── */

  const pending = sync.queue.filter((task) => task.state === 'queued' || task.state === 'uploading').length
  const gate = host === undefined || (GATED.has(view) && !live)
  const meta = !host
    ? '未选择主机'
    : busyStatus
      ? '正在建立连接…'
      : live
        ? [`${host.user}@${host.host}:${host.port}`, hostInfo?.kernel, hostInfo?.tmux ? 'tmux 已接管' : 'login shell']
          .filter(Boolean).join(' · ')
        : status === 'error'
          ? `连接失败 · ${statuses[hostId]?.error ?? error ?? '未知错误'}`
          : `${host.user}@${host.host}:${host.port} · 未连接`

  const paneProps = { ctx, sessionId, hostId, host, hosts, statuses, hostInfo, visible }

  /** One pane, chosen by id — a lookup table reads better than nested ternaries. */
  const paneFor = (id) => {
    if (id === 'files') return <FilesPane {...paneProps} active={visible && view === 'files'} />
    if (id === 'terminal') return <TerminalPane {...paneProps} active={visible && view === 'terminal'} />
    if (id === 'sync') return <SyncPane {...paneProps} active={visible && view === 'sync'} snapshot={sync} />
    if (id === 'forward') return <ForwardPane {...paneProps} active={visible && view === 'forward'} />
    return (
      <SettingsPane
        ctx={ctx}
        // A new connection is not the selected one: handing it `host` made the
        // form carry the current host's id, so testing a brand-new host wrote
        // its connection into the slot of the host you were already using.
        host={creating === true ? undefined : host}
        hosts={hosts}
        hostId={hostId}
        sessionId={sessionId}
        seed={seed}
        creating={creating}
        onSaved={onSaved}
        onDeleted={onDeleted}
        onConnect={(target, password) => connectWithPassword(target, password)}
        onCancelNew={() => { setCreating(false); setView('files') }}
      />
    )
  }

  return (
    <div className="rs-root" ref={bindRoot}>
      <header className="rs-phead">
        <div className="rs-hostline">
          <span className="rs-hostico"><Icon name="server" size={15} /></span>
          <div className="rs-hosttxt">
            <button
              type="button"
              className="rs-hostname"
              title="切换远程主机"
              onClick={() => setMenu((value) => !value)}
            >
              <Dot status={busyStatus ? 'connecting' : status} pulse={busyStatus} />
              <span>{host?.name ?? '远程 SSH'}</span>
              <Icon name="chevronDown" size={11} className="rs-chev-d" />
            </button>
            <div className="rs-hostmeta" title={meta}>{meta}</div>
          </div>
          <div className="rs-hostauth">
            {host !== undefined && live
              ? <IconButton name="refresh" title="重新连接" onClick={() => { void reconnect(); }} />
              : host !== undefined
                ? <IconButton name="plug" title="连接" onClick={() => start(host)} disabled={busyStatus} />
                : null}
            {live
              ? <IconButton name="power" title="断开" onClick={() => { void disconnect(); }} />
              : null}
          </div>
        </div>

        {host !== undefined
          ? <nav className="rs-tabs" role="tablist">
            {VIEWS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                className="rs-tab"
                aria-selected={view === item.id}
                onClick={() => select(item.id)}
              >
                <Icon name={item.icon} size={12} />
                {item.label}
                {item.badge === 'queue' && pending > 0 ? <span className="rs-count">{pending}</span> : null}
              </button>
            ))}
          </nav>
          : null}
      </header>

      <div className="rs-pbody">
        {gate
          ? <ConnectView
            ctx={ctx}
            hosts={hosts}
            statuses={statuses}
            host={host}
            status={busyStatus ? 'connecting' : status}
            error={error ?? statuses[hostId]?.error}
            errorCode={errorCode}
            onConnect={(password) => (password === undefined
              ? start(host)
              : connectWithPassword(host, password))}
            onSelect={selectHost}
            onNew={() => openSettings(true)}
            onUsePassword={() => host !== undefined && void usePassword(host)}
            onCancel={() => { void disconnect() }}
          />
          : VIEWS.map((item) => (visited[item.id] !== true ? null : (
            <section key={item.id} className="rs-pane" hidden={view !== item.id}>
              {paneFor(item.id)}
            </section>
          )))}
      </div>

      <footer className="rs-pfoot">
        <span>
          <Dot status={busyStatus ? 'connecting' : status} />
          {' '}
          <b>{live ? '已连接' : busyStatus ? '连接中' : status === 'error' ? '连接失败' : '未连接'}</b>
        </span>
        <span className="rs-sep" />
        <span>映射 <b>{sync.mappings.length}</b></span>
        <span className="rs-sep" />
        <span>队列 <b>{pending}</b></span>
        <span className="rs-grow" />
        <span>{hostInfo?.tmux ? 'tmux' : host === undefined ? 'SFTP' : 'login shell'} · SFTP</span>
      </footer>

      {menu
        ? [
          <div key="bg" className="rs-menu-bg" onClick={() => setMenu(false)} />,
          <div key="menu" className="rs-hostmenu" role="menu">
            <div className="rs-hmhead">远程主机 · {hosts.length}</div>
            {hosts.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="rs-hmitem"
                aria-current={item.id === hostId}
                onClick={() => selectHost(item.id)}
              >
                <Dot status={statuses[item.id]?.status ?? 'disconnected'} />
                <span className="rs-htxt">
                  <span className="rs-nm">{item.name}{item.id === hostId ? <Icon name="check" size={11} /> : null}</span>
                  <span className="rs-ad">{item.user}@{item.host}:{item.port}</span>
                </span>
                {statuses[item.id]?.status === 'connected' ? <span className="rs-badge ok">在线</span> : null}
              </button>
            ))}
            <div className="rs-hmsep" />
            <button type="button" className="rs-hmadd" onClick={() => openSettings(true)}>
              <Icon name="plus" size={13} />新建 SSH 连接
            </button>
            <button type="button" className="rs-hmadd" onClick={() => openSettings(false)}>
              <Icon name="cog" size={13} />管理当前主机
            </button>
          </div>,
        ]
        : null}

      {toast !== ''
        ? <div className="rs-toast">{toast}</div>
        : null}
    </div>
  )
}

/**
 * The conversation-header control that opens the native panel (a profile
 * without better-sidebar has no other way in).
 * @param {{open: () => void}} props - injected opener.
 */
export function RemoteHeaderButton({ open }) {
  return (
    <button
      type="button"
      className="rs-icon"
      title="远程 SSH"
      aria-label="远程 SSH"
      onClick={() => open?.()}
    >
      <Icon name="server" size={15} />
    </button>
  )
}
