/**
 * Remote file browser (SFTP), content only — the host header, tab strip and
 * footer belong to `workspace.jsx`.
 *
 * A directory is listed when it is first expanded; the current path stays as a
 * breadcrumb. Selecting a file opens a peek that can be edited and saved back
 * atomically: the remote mtime travels with the read and is checked again on
 * write, so a concurrent change on the server fails loudly instead of being
 * overwritten.
 * @module dsh-remote-ssh/client/files-view
 */
import { createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  api, dirnameRemote, formatBytes, joinLocal, joinRemote, readFileBase64, sinceLabel, useToast,
} from './state.js'
import { Button, Icon, IconButton } from './ui.jsx'

/**
 * @param {object} props - `ctx`, `sessionId`, `hostId`, `host`, `hostInfo`.
 */
export function FilesPane({ ctx, sessionId, hostId, host, hostInfo }) {
  const [path, setPath] = useState('')
  const [dirs, setDirs] = useState({})
  const [open, setOpen] = useState({})
  const [peek, setPeek] = useState(undefined)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(undefined)
  const [mapping, setMapping] = useState(undefined)
  const [toast, flash] = useToast()
  const fileInput = useRef(null)

  /** List one directory and make it current. */
  const load = useCallback(async (target) => {
    if (hostId === '') return
    setBusy('load')
    setError(undefined)
    try {
      const value = await api(ctx, 'fs.list', { sessionId, hostId, path: target ?? '' })
      setDirs((current) => ({ ...current, [value.path]: value.entries }))
      setPath(value.path)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }, [ctx, hostId, sessionId])

  /* Host switch: start from the mapped remote root, else the login home. */
  useEffect(() => {
    if (hostId === '') return undefined
    setDirs({})
    setOpen({})
    setPeek(undefined)
    setEditing(false)
    setPath('')
    setError(undefined)
    setMapping(undefined)
    let cancelled = false
    void (async () => {
      let root = hostInfo?.home ?? ''
      try {
        const value = await api(ctx, 'sync.list', { sessionId })
        const found = (value.mappings ?? []).find((item) => item.hostId === hostId)
        if (found !== undefined) {
          setMapping(found)
          if (found.remoteRoot !== '') root = found.remoteRoot
        }
      } catch {
        // No mapping is normal; the home directory is a fine start.
      }
      if (!cancelled) void load(root)
    })()
    return () => { cancelled = true }
  }, [hostId, hostInfo?.home, ctx, sessionId, load])

  const toggleDir = async (entry) => {
    const isOpen = open[entry.path] === true
    setOpen((current) => ({ ...current, [entry.path]: !isOpen }))
    if (isOpen || dirs[entry.path] !== undefined) return
    try {
      const value = await api(ctx, 'fs.list', { sessionId, hostId, path: entry.path })
      setDirs((current) => ({ ...current, [value.path]: value.entries }))
    } catch (failure) {
      setError(failure.message)
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
      flash('已保存到远端')
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
      flash(`已上传 ${files.length} 个文件`)
      await load(path)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }

  /** Download one remote path into the mapping's local root. */
  const downloadTo = async (entry) => {
    const root = mapping?.remoteRoot ?? ''
    if (mapping === undefined || root === '' || !entry.path.startsWith(root)) {
      flash('先为该主机建立路径映射，才能下载到本地')
      return
    }
    const rel = entry.path.slice(root.length).replace(/^\/+/, '')
    setBusy('download')
    try {
      await api(ctx, 'transfer.download', {
        sessionId, hostId, remotePath: entry.path, localPath: joinLocal(mapping.localRoot, rel),
      })
      flash(`已下载 ${entry.name ?? rel}`)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }

  const download = () => {
    if (peek?.path === undefined) return
    void downloadTo({ path: peek.path, name: peek.path.replace(/^.*\//, '') })
  }

  const remove = async () => {
    if (peek?.path === undefined) return
    if (!window.confirm(`删除远端 ${peek.path}？此操作不可撤销。`)) return
    setBusy('remove')
    try {
      await api(ctx, 'fs.remove', { sessionId, hostId, path: peek.path, recursive: true })
      setPeek(undefined)
      flash('已删除')
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

  /* ── render ─────────────────────────────────────────────────────────── */

  const rowsFor = (dir, depth) => {
    const entries = dirs[dir] ?? []
    return entries.flatMap((entry) => {
      const isDir = entry.type === 'dir'
      const row = (
        <div
          key={entry.path}
          className={`rs-row${peek?.path === entry.path ? ' sel' : ''}`}
          style={{ paddingLeft: 6 + depth * 13 }}
          title={entry.path}
          onClick={() => (isDir ? toggleDir(entry) : openFile(entry))}
        >
          {isDir
            ? <Icon name="chevron" size={12} className={`rs-chev${open[entry.path] ? ' open' : ''}`} />
            : <span style={{ width: '12px', flex: 'none' }} />}
          <Icon name={isDir ? 'folder' : 'file'} size={13} className={`rs-fico${isDir ? ' dir' : ''}`} />
          <span className="rs-name">{entry.name}</span>
          <span className="rs-acts">
            {isDir ? null : (
              <button
                type="button"
                className="rs-act"
                title="下载到本地映射目录"
                onClick={(event) => { event.stopPropagation(); void downloadTo(entry) }}
              >
                <Icon name="down" size={12} />
              </button>
            )}
          </span>
          <span className="rs-tags">
            {entry.type === 'link' ? <span className="rs-link"><Icon name="link" size={11} /></span> : null}
            {isDir ? null : <span>{formatBytes(entry.size)}</span>}
          </span>
        </div>
      )
      return isDir && open[entry.path] === true ? [row, ...rowsFor(entry.path, depth + 1)] : [row]
    })
  }

  const segments = path.split('/').filter(Boolean)
  const atRoot = path === '/' || path === ''

  const breadcrumb = (
    <div className="rs-crumb">
      <button type="button" className="rs-crumb-host" onClick={() => load('')}>{host?.name ?? 'remote'}</button>
      <span className="rs-sl">:/</span>
      {segments.map((segment, index) => {
        const target = `/${segments.slice(0, index + 1).join('/')}`
        const last = index === segments.length - 1
        return (
          <Fragment key={target}>
            <button
              type="button"
              className={last ? 'rs-last' : undefined}
              onClick={() => load(target)}
            >
              {segment}
            </button>
            {last ? null : <span className="rs-sl">/</span>}
          </Fragment>
        )
      })}
    </div>
  )

  return (
    <>
      <div className="rs-bar">
        {breadcrumb}
        <IconButton name="levelUp" title="上一级" onClick={() => load(dirnameRemote(path))} disabled={atRoot} />
        <IconButton name="folderPlus" title="新建目录" onClick={newFolder} />
        <IconButton name="up" title="上传文件" onClick={() => fileInput.current?.click()} />
        <IconButton name="refresh" title="刷新" onClick={() => load(path)} />
        <input type="file" multiple ref={fileInput} style={{ display: 'none' }} onChange={upload} />
      </div>

      {error !== undefined ? <div className="rs-err-box" style={{ margin: '8px 12px 0' }}><div className="rs-t"><Icon name="warn" size={12} />操作失败</div><code>{error}</code></div> : null}

      <div className="rs-tree">
        {busy === 'load' && dirs[path] === undefined
          ? <div className="rs-hint">读取目录…</div>
          : rowsFor(path, 0)}
        {(dirs[path]?.length ?? 0) === 0 && busy !== 'load'
          ? <div className="rs-hint">（空目录）</div>
          : null}
      </div>

      {peek === undefined ? null : (
        <div className="rs-peek">
          <div className="rs-peek-head">
            <Icon name="file" size={12} className="rs-fico" />
            <span className="rs-peek-path" title={peek.path}>{peek.path.replace(/^.*\//, '')}</span>
            <span className="rs-badge">{peek.loading === true ? '读取中' : formatBytes(peek.size ?? 0)}</span>
            <span className="rs-peek-meta">{peek.mtimeMs ? sinceLabel(peek.mtimeMs) : ''}</span>
          </div>

          {peek.error !== undefined
            ? <div className="rs-err-box" style={{ margin: '0 12px 8px' }}><code>{peek.error}</code></div>
            : editing
              ? <textarea
                className="rs-code"
                spellCheck={false}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
              : <pre className="rs-code">{peek.loading === true ? '…' : (peek.text ?? '')}</pre>}

          <div className="rs-peek-acts">
            {editing ? (
              <>
                <Button variant="primary" size="sm" onClick={save} disabled={busy === 'save'}>
                  {busy === 'save' ? '保存中…' : '保存'}
                </Button>
                <Button size="sm" onClick={() => { setEditing(false); setDraft(peek.text ?? '') }}>取消</Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setEditing(true)} disabled={peek.error !== undefined || peek.loading === true}>
                <Icon name="edit" size={11} />编辑
              </Button>
            )}
            <Button size="sm" onClick={download} disabled={busy === 'download'}>
              <Icon name="down" size={11} />下载
            </Button>
            <span className="rs-grow" />
            <Button size="sm" variant="danger" onClick={remove}><Icon name="trash" size={11} />删除</Button>
          </div>
        </div>
      )}

      {toast !== '' ? <div className="rs-toast">{toast}</div> : null}
    </>
  )
}
