/**
 * Remote file browser tab.
 *
 * A lazy tree over SFTP: a directory is listed when it is first expanded, and
 * the current path stays as a breadcrumb. Selecting a file opens a text peek
 * that can be edited and saved back atomically (the remote mtime travels with
 * the read and is checked again on write, so a concurrent change on the server
 * fails loudly instead of being overwritten).
 * @module dsh-remote-ssh/client/files-view
 */
import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  api, connectHost, dirnameRemote, formatBytes, hostStore, joinLocal, joinRemote,
  readFileBase64, refreshHosts, refreshStatuses, sinceLabel, usePolling, useStore,
} from './state.js'
import {
  Banner, Button, Dot, Empty, Field, Icon, IconButton, Input, Select,
} from './ui.js'
import { HostForm } from './host-form.js'

/** Small toast hook: one message, auto-cleared. */
function useToast() {
  const [message, setMessage] = useState('')
  const timer = useRef(0)
  const show = useCallback((text) => {
    setMessage(text)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setMessage(''), 2200)
  }, [])
  useEffect(() => () => clearTimeout(timer.current), [])
  return [message, show]
}

export function FilesPane({ ctx, scope, visible }) {
  const sessionId = scope?.sessionId ?? 'default'
  const { hosts, statuses, loaded } = useStore(hostStore)
  const [hostId, setHostId] = useState('')
  const [path, setPath] = useState('')
  const [dirs, setDirs] = useState({})
  const [open, setOpen] = useState({})
  const [peek, setPeek] = useState(undefined)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState(undefined)
  const [busy, setBusy] = useState('')
  const [mapping, setMapping] = useState(undefined)
  const [showForm, setShowForm] = useState(false)
  const [toast, showToast] = useToast()
  const fileInput = useRef(null)

  const host = hosts.find((item) => item.id === hostId)
  const status = statuses[hostId]?.status ?? 'disconnected'
  const statusError = statuses[hostId]?.error

  /* Boot: hosts + this session's mapping decide the initial target. */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [hostList, sync] = await Promise.all([
          refreshHosts(ctx),
          api(ctx, 'sync.list', { sessionId }).catch(() => ({ mappings: [] })),
        ])
        if (cancelled) return
        const primary = (sync.mappings ?? [])[0]
        const first = primary?.hostId ?? hostList.hosts?.[0]?.id ?? ''
        setMapping((sync.mappings ?? []).find((item) => item.hostId === first))
        setHostId((current) => current || first)
        if (primary?.remoteRoot) setPath((current) => current || primary.remoteRoot)
      } catch (failure) {
        if (!cancelled) setError(failure.message)
      }
    })()
    return () => { cancelled = true }
  }, [ctx, sessionId])

  usePolling(visible === true && hostId !== '', 5000, () => refreshStatuses(ctx))

  /** List one directory and make it current. */
  const load = useCallback(async (target) => {
    if (hostId === '') return
    setBusy('load')
    setError(undefined)
    try {
      const value = await api(ctx, 'fs.list', { sessionId, hostId, path: target })
      setDirs((current) => ({ ...current, [value.path]: value.entries }))
      setPath(value.path)
      setMapping((current) => (current === undefined ? current : current))
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }, [ctx, hostId, sessionId])

  /* A connected host with no listing yet: open the mapped root (or home). */
  useEffect(() => {
    if (status !== 'connected') return
    if (path !== '' && dirs[path] !== undefined) return
    void load(path)
  }, [status, path, dirs, load])

  const connect = async () => {
    if (host === undefined) return
    setBusy('connect')
    setError(undefined)
    try {
      await connectHost(ctx, host)
      await refreshStatuses(ctx)
      const info = await api(ctx, 'hosts.info', { hostId }).catch(() => undefined)
      if (info?.info?.home) setPath((current) => current || info.info.home)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }

  const disconnect = async () => {
    setBusy('disconnect')
    try {
      await api(ctx, 'hosts.disconnect', { hostId })
      setDirs({})
      setOpen({})
      setPeek(undefined)
      await refreshStatuses(ctx)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }

  const toggleDir = async (entry) => {
    if (open[entry.path] === true) {
      setOpen((current) => ({ ...current, [entry.path]: false }))
      return
    }
    setOpen((current) => ({ ...current, [entry.path]: true }))
    if (dirs[entry.path] === undefined) {
      try {
        const value = await api(ctx, 'fs.list', { sessionId, hostId, path: entry.path })
        setDirs((current) => ({ ...current, [value.path]: value.entries }))
      } catch (failure) {
        setError(failure.message)
      }
    }
  }

  const openFile = async (entry) => {
    setPeek({ path: entry.path, size: entry.size, loading: true })
    setEditing(false)
    setError(undefined)
    try {
      const value = await api(ctx, 'fs.read', { sessionId, hostId, path: entry.path })
      setPeek({ path: entry.path, ...value, loading: false })
      setDraft(value.text)
    } catch (failure) {
      setPeek({ path: entry.path, size: entry.size, error: failure.message })
    }
  }

  const save = async () => {
    if (peek?.path === undefined) return
    setBusy('save')
    try {
      const value = await api(ctx, 'fs.write', {
        sessionId, hostId, path: peek.path, text: draft, expectedMtimeMs: peek.mtimeMs,
      })
      setPeek((current) => ({ ...current, text: draft, mtimeMs: value.mtimeMs, size: value.size }))
      setEditing(false)
      showToast('已保存到远端')
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }

  const upload = async (event) => {
    const files = [...(event.target.files ?? [])]
    event.target.value = ''
    if (files.length === 0 || path === '') return
    setBusy('upload')
    try {
      for (const file of files) {
        const data = await readFileBase64(file)
        await api(ctx, 'fs.putBase64', { sessionId, hostId, path: joinRemote(path, file.name), data })
      }
      showToast(`已上传 ${files.length} 个文件`)
      await load(path)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }

  const download = async () => {
    if (peek?.path === undefined) return
    const root = mapping?.remoteRoot ?? ''
    if (mapping === undefined || !peek.path.startsWith(root)) {
      showToast('先为该主机建立路径映射，才能下载到本地')
      return
    }
    const rel = peek.path.slice(root.length).replace(/^\/+/, '')
    setBusy('download')
    try {
      await api(ctx, 'transfer.download', {
        sessionId, hostId, remotePath: peek.path, localPath: joinLocal(mapping.localRoot, rel),
      })
      showToast('已下载到本地映射目录')
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }

  const remove = async () => {
    if (peek?.path === undefined) return
    if (!window.confirm(`删除远端 ${peek.path}？此操作不可撤销。`)) return
    setBusy('remove')
    try {
      await api(ctx, 'fs.remove', { sessionId, hostId, path: peek.path, recursive: true })
      setPeek(undefined)
      showToast('已删除')
      await load(path)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }

  const newFolder = async () => {
    const name = window.prompt('新目录名称')
    if (name === null || name.trim() === '') return
    try {
      await api(ctx, 'fs.mkdir', { sessionId, hostId, path: joinRemote(path, name.trim()) })
      await load(path)
    } catch (failure) {
      setError(failure.message)
    }
  }

  /* ── render ──────────────────────────────────────────────────────── */

  const rowsFor = (dir, depth) => {
    const entries = dirs[dir] ?? []
    const rows = []
    for (const entry of entries) {
      const isDir = entry.type === 'dir'
      rows.push(h('div', {
        key: entry.path,
        className: `rs-row${peek?.path === entry.path ? ' sel' : ''}`,
        style: { paddingLeft: `${6 + depth * 13}px` },
        onClick: () => (isDir ? toggleDir(entry) : openFile(entry)),
        title: entry.path,
      },
      isDir
        ? h(Icon, { name: 'chevron', size: 11, className: `rs-chev${open[entry.path] ? ' open' : ''}` })
        : h('span', { style: { width: '11px', flex: 'none' } }),
      h(Icon, { name: isDir ? 'folder' : 'file', size: 13, className: `rs-fico${isDir ? ' dir' : ''}` }),
      h('span', { className: 'rs-name' }, entry.name),
      h('span', { className: 'rs-tags' },
        entry.type === 'link' ? h('span', { className: 'rs-badge' }, 'link') : null,
        isDir ? null : h('span', { className: 'rs-badge' }, formatBytes(entry.size)))))
      if (isDir && open[entry.path] === true) rows.push(...rowsFor(entry.path, depth + 1))
    }
    return rows
  }

  const segments = path.split('/').filter(Boolean)
  const crumb = h('div', { className: 'rs-crumb' },
    h('span', { style: { cursor: 'pointer' }, onClick: () => load('/') }, '/'),
    segments.map((segment, index) => {
      const target = `/${segments.slice(0, index + 1).join('/')}`
      const last = index === segments.length - 1
      return h(Fragment, { key: target },
        h('span', {
          style: { cursor: 'pointer', color: last ? 'var(--rs-fg)' : undefined },
          onClick: () => load(target),
        }, segment),
        last ? null : h('span', { className: 'rs-sl' }, ' / '))
    }))

  const header = h('div', { className: 'rs-head' },
    h(Dot, { status }),
    h('div', { className: 'rs-grow' },
      h('div', { className: 'rs-host' },
        hosts.length > 1
          ? h('select', {
            className: 'rs-select',
            style: { width: 'auto', maxWidth: '160px', border: 'none', background: 'transparent', fontWeight: 600, padding: '0 2px' },
            value: hostId,
            onChange: (event) => { setHostId(event.target.value); setDirs({}); setOpen({}); setPath(''); setPeek(undefined) },
          }, hosts.map((item) => h('option', { key: item.id, value: item.id }, item.name)))
          : h('span', { className: 'rs-host-name' }, host?.name ?? '未连接')),
      h('div', { className: 'rs-host-meta' },
        host === undefined ? '还没有远程主机' : `${host.user}@${host.host}:${host.port}`)),
    host === undefined
      ? h(Button, { variant: 'primary', size: 'sm', onClick: () => setShowForm(true) }, '新建连接')
      : status === 'connected'
        ? h(Fragment, null,
          h(IconButton, { name: 'refresh', title: '刷新目录', onClick: () => load(path) }),
          h(IconButton, { name: 'edit', title: '编辑连接', onClick: () => setShowForm(true) }),
          h(IconButton, { name: 'x', title: '断开', onClick: disconnect }))
        : h(Button, {
          variant: 'primary',
          size: 'sm',
          onClick: connect,
          disabled: busy === 'connect' || status === 'connecting',
        }, status === 'connecting' || busy === 'connect' ? '连接中…' : status === 'error' ? '重试' : '连接'))

  const toolbar = status === 'connected'
    ? h('div', { style: { display: 'flex', alignItems: 'center', gap: '2px', padding: '4px 6px', borderBottom: '1px solid var(--rs-line)' } },
      h(IconButton, { name: 'up', title: '上一级', onClick: () => load(dirnameRemote(path)) }),
      crumb,
      h(IconButton, { name: 'folderPlus', title: '新建目录', onClick: newFolder }),
      h(IconButton, { name: 'up', title: '上传文件', onClick: () => fileInput.current?.click() }),
      h('input', { type: 'file', multiple: true, ref: fileInput, style: { display: 'none' }, onChange: upload }))
    : null

  const body = host === undefined
    ? h(Empty, {
      title: '连接一台远程服务器',
      hint: '支持 ssh config 导入、密钥 / ssh-agent / 密码认证，主机指纹首次连接时记录。',
      action: h(Button, { variant: 'primary', onClick: () => setShowForm(true) }, '新建 SSH 连接'),
    })
    : status !== 'connected'
      ? h(Empty, {
        title: status === 'error' ? '连接失败' : '未连接',
        hint: status === 'error' ? (statusError ?? '检查主机地址、用户名与认证方式') : '连接后可浏览远端文件、打开终端，并把本地改动同步过去。',
        action: h(Button, { variant: 'primary', onClick: connect, disabled: busy === 'connect' }, busy === 'connect' ? '连接中…' : '连接'),
      })
      : h('div', { className: 'rs-scroll', style: { padding: '4px 5px 8px' } },
        busy === 'load' && dirs[path] === undefined
          ? h('div', { className: 'rs-empty' }, '读取目录…')
          : rowsFor(path, 0),
        (dirs[path]?.length ?? 0) === 0 && busy !== 'load'
          ? h('div', { className: 'rs-empty' }, '（空目录）')
          : null)

  const peekPanel = peek === undefined
    ? null
    : h('div', { className: 'rs-peek' },
      h('div', { className: 'rs-peek-head' },
        h(Icon, { name: 'file', size: 13, className: 'rs-fico' }),
        h('span', { className: 'rs-peek-path', title: peek.path }, peek.path.replace(/^.*\//, '')),
        h('span', { className: 'rs-badge' }, peek.loading === true ? '读取中' : formatBytes(peek.size ?? 0)),
        h('span', { className: 'rs-muted' }, peek.mtimeMs ? sinceLabel(peek.mtimeMs) : '')),
      peek.error !== undefined
        ? h('div', { style: { padding: '0 9px 8px' } }, h(Banner, { tone: 'error' }, peek.error))
        : h('textarea', {
          className: 'rs-code',
          value: editing ? draft : (peek.text ?? ''),
          readOnly: !editing,
          spellCheck: false,
          onChange: (event) => setDraft(event.target.value),
          style: { height: '132px' },
        }),
      h('div', { className: 'rs-peek-acts' },
        editing
          ? h(Fragment, null,
            h(Button, { variant: 'primary', size: 'sm', onClick: save, disabled: busy === 'save' }, busy === 'save' ? '保存中…' : '保存'),
            h(Button, { size: 'sm', onClick: () => { setEditing(false); setDraft(peek.text ?? '') } }, '取消'))
          : h(Button, { size: 'sm', onClick: () => setEditing(true), disabled: peek.error !== undefined }, h(Icon, { name: 'edit', size: 11 }), '编辑'),
        h(Button, { size: 'sm', onClick: download, disabled: busy === 'download' }, h(Icon, { name: 'down', size: 11 }), '下载'),
        h('span', { style: { flex: 1 } }),
        h(Button, { size: 'sm', variant: 'danger', onClick: remove }, h(Icon, { name: 'trash', size: 11 }), '删除')))

  const syncBadge = mapping === undefined
    ? h('span', null, '未建立映射')
    : h('span', null, `${mapping.localRoot.replace(/^.*[\\/]/, '…/')} ⇄ ${mapping.remoteRoot}`)

  return h('div', { className: 'rs-root', style: { position: 'relative' } },
    header,
    toolbar,
    error !== undefined && status !== 'error'
      ? h(Banner, { tone: 'error' }, error)
      : null,
    h('div', { className: 'rs-body' }, body),
    peekPanel,
    h('div', { className: 'rs-foot' },
      h('span', null, host === undefined ? '未配置' : status === 'connected' ? '已连接' : status),
      h('span', { className: 'rs-sep' }),
      syncBadge,
      h('span', { style: { flex: 1 } }),
      h('span', null, 'SFTP')),
    toast !== '' ? h('div', { className: 'rs-toast' }, toast) : null,
    showForm
      ? h(HostForm, {
        ctx,
        host,
        onClose: () => setShowForm(false),
        onSaved: async (saved) => {
          await refreshHosts(ctx)
          if (hostId === '' || hosts.length === 0) setHostId(saved.id)
          setShowForm(false)
        },
      })
      : null)
}
