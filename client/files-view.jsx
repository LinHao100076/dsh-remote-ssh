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
  api, dirnameRemote, formatBytes, joinRemote, readFileBase64, sinceLabel, useToast, usePolling,
} from './state.js'
import { Button, Icon, IconButton } from './ui.jsx'

/**
 * @param {object} props - `ctx`, `sessionId`, `hostId`, `host`, `hostInfo`.
 */
export function FilesPane({ ctx, sessionId, hostId, host, hostInfo, active = true }) {
  const [path, setPath] = useState('')
  const [dirs, setDirs] = useState({})
  const [open, setOpen] = useState({})
  const [peek, setPeek] = useState(undefined)
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(undefined)
  const [folder, setFolder] = useState(undefined)
  const [downloadEntry, setDownloadEntry] = useState(undefined)
  const [localPath, setLocalPath] = useState('')
  const [uploadProgress, setUploadProgress] = useState('')
  const uploadJob = useRef(null)
  const location = useRef({ hostId, path })
  location.current = { hostId, path }
  const [searchOpen, setSearchOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [regex, setRegex] = useState(false)
  const [found, setFound] = useState(undefined)
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(undefined)
  const [toast, flash] = useToast()
  const fileInput = useRef(null)
  const codeRef = useRef(null)
  /* Only the newest search may write results: a slow earlier request must not
     replace the hits of the query the user is actually looking at. */
  const searchSeq = useRef(0)
  const loadSeq = useRef(0)
  const refreshSeq = useRef(0)
  const peekSeq = useRef(0)

  const closePreview = () => {
    peekSeq.current += 1
    setPeek(undefined)
    setEditing(false)
    setDraft('')
  }

  useEffect(() => () => { if (uploadJob.current) uploadJob.current.cancelled = true }, [hostId, sessionId])

  /** List one directory and make it current. */
  const load = useCallback(async (target) => {
    if (hostId === '') return
    const seq = ++loadSeq.current
    setBusy('load')
    setError(undefined)
    try {
      const value = await api(ctx, 'fs.list', { sessionId, hostId, path: target ?? '' })
      if (seq !== loadSeq.current) return
      setDirs((current) => ({ ...current, [value.path]: value.entries }))
      setPath(value.path)
    } catch (failure) {
      if (seq === loadSeq.current) setError(failure.message)
    } finally {
      if (seq === loadSeq.current) setBusy('')
    }
  }, [ctx, hostId, sessionId])

  const navigate = (target) => {
    closePreview()
    setOpen({})
    void load(target)
  }

  // Refresh expanded children too: a sync may have created files inside them.
  const refresh = async () => {
    const seq = loadSeq.current
    const refreshId = ++refreshSeq.current
    const targets = [...new Set([path, ...Object.keys(open).filter(key => open[key])])]
    const values = await Promise.all(targets.map(target => api(ctx, 'fs.list', { sessionId, hostId, path: target })))
    if (seq !== loadSeq.current || refreshId !== refreshSeq.current) return
    setDirs(current => ({ ...current, ...Object.fromEntries(values.map(value => [value.path, value.entries])) }))
  }
  usePolling(active === true && hostId !== '' && path !== '', 4000, async () => {
    try { await refresh() } catch (failure) { setError(failure.message) }
  })

  /* Host switch: start from the mapped remote root, else the login home. */
  useEffect(() => {
    if (hostId === '') return undefined
    setFolder(undefined)
    setDownloadEntry(undefined)
    setDirs({})
    setOpen({})
    setPeek(undefined)
    setEditing(false)
    setPath('')
    setError(undefined)
    setFound(undefined)
    setSearchError(undefined)
    setQuery('')
    let cancelled = false
    void (async () => {
      let root = hostInfo?.home ?? ''
      try {
        const value = await api(ctx, 'sync.list', { sessionId })
        const found = (value.mappings ?? []).find((item) => item.hostId === hostId)
        if (found !== undefined) {
          if (found.remoteRoot !== '') root = found.remoteRoot
        }
      } catch {
        // No mapping is normal; the home directory is a fine start.
      }
      if (!cancelled) void load(root)
    })()
    return () => { cancelled = true; loadSeq.current += 1; peekSeq.current += 1; searchSeq.current += 1 }
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

  const openFile = async (entry, focusLine) => {
    const seq = ++peekSeq.current
    setPeek({ path: entry.path, size: entry.size, loading: true, focusLine })
    setEditing(false)
    setError(undefined)
    try {
      const value = await api(ctx, 'fs.read', { sessionId, hostId, path: entry.path })
      if (seq !== peekSeq.current) return
      setPeek({ path: entry.path, ...value, loading: false, focusLine })
      setDraft(value.text)
    } catch (failure) {
      if (seq === peekSeq.current) setPeek({ path: entry.path, size: entry.size, error: failure.message, focusLine })
    }
  }

  /**
   * Run one content search from the current directory.
   *
   * The search runs on the remote (`rg`, or `grep` when ripgrep is absent), so
   * it covers files the browser has never listed — a repository's worth of
   * code, not just what fits in the mapping.
   */
  const runSearch = useCallback(async (text) => {
    const needle = text.trim()
    if (needle === '' || hostId === '') {
      setFound(undefined)
      setSearchError(undefined)
      return
    }
    const seq = searchSeq.current + 1
    searchSeq.current = seq
    setSearching(true)
    setSearchError(undefined)
    try {
      const value = await api(ctx, 'fs.search', {
        sessionId,
        hostId,
        path,
        query: needle,
        case: caseSensitive ? 'sensitive' : 'smart',
        regex,
        limit: 200,
      })
      if (searchSeq.current === seq) setFound(value)
    } catch (failure) {
      if (searchSeq.current === seq) {
        setFound(undefined)
        setSearchError(failure.message)
      }
    } finally {
      if (searchSeq.current === seq) setSearching(false)
    }
  }, [ctx, sessionId, hostId, path, caseSensitive, regex])

  /* Debounced live search; Enter runs it immediately. */
  useEffect(() => {
    searchSeq.current += 1
    setSearching(false)
    setFound(undefined)
    setSearchError(undefined)
    if (searchOpen !== true || query.trim() === '') return undefined
    const timer = setTimeout(() => { void runSearch(query) }, 350)
    return () => clearTimeout(timer)
  }, [searchOpen, query, runSearch])

  /* Scroll the preview so the selected hit is on screen. */
  useEffect(() => {
    const node = codeRef.current
    if (node === null || peek?.loading === true || peek?.focusLine === undefined) return
    const lineHeight = Number.parseFloat(window.getComputedStyle(node).lineHeight)
    const step = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 18
    node.scrollTop = Math.max(0, (peek.focusLine - 1) * step - node.clientHeight / 3)
  }, [peek?.focusLine, peek?.text, peek?.loading])

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
    if (files.length === 0 || path === '' || uploadJob.current) return
    const target = path
    const job = { cancelled: false }
    uploadJob.current = job
    setBusy('upload')
    setError(undefined)
    try {
      for (const file of files) {
        if (job.cancelled) throw new Error('上传已取消')
        job.committing = false
        setUploadProgress(`${file.name} · 准备上传…`)
        let uploadId
        let committed = false
        try {
          const begun = await api(ctx, 'fs.upload.begin', { sessionId, hostId, path: joinRemote(target, file.name), size: file.size })
          uploadId = begun.uploadId
          const chunkBytes = Math.min(begun.chunkBytes, 256 * 1024)
          if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) throw new Error('上传分块大小无效')
          for (let offset = 0; offset < file.size; offset += chunkBytes) {
            if (job.cancelled) throw new Error('上传已取消')
            const data = await readFileBase64(file.slice(offset, offset + chunkBytes))
            if (job.cancelled) throw new Error('上传已取消')
            await api(ctx, 'fs.upload.chunk', { sessionId, hostId, uploadId, offset, data })
            setUploadProgress(`${file.name} · ${formatBytes(Math.min(offset + chunkBytes, file.size))} / ${formatBytes(file.size)}`)
          }
          if (job.cancelled) throw new Error('上传已取消')
          job.committing = true
          setUploadProgress(`${file.name} · 正在发布…`)
          await api(ctx, 'fs.upload.finish', { sessionId, hostId, uploadId })
          committed = true
        } finally {
          if (uploadId && !committed) await api(ctx, 'fs.upload.abort', { sessionId, hostId, uploadId }).catch(() => {})
        }
      }
      flash(`已上传 ${files.length} 个文件到 ${target}`)
    } catch (failure) {
      setError(failure.message)
    } finally {
      uploadJob.current = null
      setUploadProgress('')
      setBusy('')
      if (location.current.hostId === hostId && location.current.path === target) void refresh().catch(failure => setError(failure.message))
    }
  }

  /** Download one remote path into the mapping's local root. */
  const downloadMapped = async (entry) => {
    setBusy('download')
    try {
      const snapshot = await api(ctx, 'sync.list', { sessionId })
      const mapping = (snapshot.mappings ?? [])
        .filter((item) => item.hostId === hostId && entry.path.startsWith(`${item.remoteRoot.replace(/\/+$/, '')}/`))
        .sort((a, b) => b.remoteRoot.length - a.remoteRoot.length)[0]
      if (mapping === undefined) {
        flash('先为该主机建立路径映射，才能下载到本地')
        return
      }
      const prefix = `${mapping.remoteRoot.replace(/\/+$/, '')}/`
      const rel = entry.path.slice(prefix.length)
      await api(ctx, 'sync.pull', {
        sessionId, mappingId: mapping.id, rel,
      })
      flash(`已下载 ${entry.name ?? rel}`)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }

  const downloadTo = (entry) => { setDownloadEntry(entry); setLocalPath(''); setError(undefined) }
  const download = () => {
    if (peek?.path !== undefined) downloadTo({ path: peek.path, name: peek.path.replace(/^.*\//, '') })
  }
  const downloadCustom = async () => {
    if (!downloadEntry || localPath.trim() === '') return
    setBusy('download')
    setError(undefined)
    try {
      await api(ctx, 'transfer.download', { sessionId, hostId, remotePath: downloadEntry.path, localPath: localPath.trim() })
      flash(`已下载到 ${localPath.trim()}`)
      setDownloadEntry(undefined)
    } catch (failure) { setError(failure.message) }
    finally { setBusy('') }
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
    const name = folder?.name.trim() ?? ''
    if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
      setError('请输入有效的单级目录名称（不含斜杠）')
      return
    }
    const parent = folder.parent
    setBusy('mkdir')
    setError(undefined)
    try {
      await api(ctx, 'fs.mkdir', { sessionId, hostId, path: joinRemote(parent, name) })
      setFolder(undefined)
      flash('目录已创建')
      if (location.current.path === parent && location.current.hostId === hostId) await load(parent)
    } catch (failure) { setError(failure.message) }
    finally { setBusy('') }
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
          onClick={() => {
            if (isDir) { closePreview(); void toggleDir(entry) }
            else if (peek?.path === entry.path) closePreview()
            else void openFile(entry)
          }}
          onDoubleClick={isDir ? () => navigate(entry.path) : undefined}
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
                title="下载到本地…"
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
      <button type="button" className="rs-crumb-host" onClick={() => navigate('')}>{host?.name ?? 'remote'}</button>
      <span className="rs-sl">:/</span>
      {segments.map((segment, index) => {
        const target = `/${segments.slice(0, index + 1).join('/')}`
        const last = index === segments.length - 1
        return (
          <Fragment key={target}>
            <button
              type="button"
              className={last ? 'rs-last' : undefined}
              onClick={() => navigate(target)}
            >
              {segment}
            </button>
            {last ? null : <span className="rs-sl">/</span>}
          </Fragment>
        )
      })}
    </div>
  )

  /* ── search results ─────────────────────────────────────────────────── */

  const hits = found?.hits ?? []
  const groups = []
  for (const hit of hits) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.path === hit.path) last.hits.push(hit)
    else groups.push({ path: hit.path, hits: [hit] })
  }

  const rootPrefix = path === '' || path === '/' ? '' : path.replace(/\/+$/, '')
  const shortName = (target) => (rootPrefix !== '' && target.startsWith(rootPrefix)
    ? target.slice(rootPrefix.length).replace(/^\/+/, '')
    : target)

  /** Wrap the matched span so a hit stays readable inside a clipped line. */
  const marked = (text) => {
    const needle = query.trim()
    if (needle === '') return text
    let at = -1
    let length = needle.length
    if (regex) {
      try {
        const match = new RegExp(needle, caseSensitive ? '' : 'i').exec(text)
        if (match !== null && match[0] !== '') { at = match.index; length = match[0].length }
      } catch {
        return text
      }
    } else {
      at = (caseSensitive ? text : text.toLowerCase()).indexOf(caseSensitive ? needle : needle.toLowerCase())
    }
    if (at < 0) return text
    return (
      <>
        {text.slice(0, at)}
        <mark className="rs-mark">{text.slice(at, at + length)}</mark>
        {text.slice(at + length)}
      </>
    )
  }

  const summary = searching
    ? '搜索中…'
    : found === undefined
      ? ''
      : `${found.hits.length} 处 · ${found.files} 个文件 · ${found.engine} · ${found.durationMs}ms${found.truncated ? '（已截断）' : ''}`

  const searchPane = (
    <div className="rs-search">
      <div className="rs-sfield">
        <Icon name="search" size={13} className="rs-sico" />
        <input
          className="rs-sinput"
          autoFocus
          spellCheck={false}
          placeholder={`在 ${shortName(path) === '' ? path : shortName(path)} 下搜索…`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(query) }}
        />
        {query === '' ? null : (
          <button
            type="button"
            className="rs-sx"
            title="清空"
            onClick={() => { setQuery(''); setFound(undefined); setSearchError(undefined) }}
          >
            <Icon name="x" size={11} />
          </button>
        )}
      </div>

      <div className="rs-sopts">
        <button
          type="button"
          className={caseSensitive ? 'rs-stog on' : 'rs-stog'}
          title="区分大小写"
          aria-pressed={caseSensitive}
          onClick={() => setCaseSensitive((value) => !value)}
        >Aa</button>
        <button
          type="button"
          className={regex ? 'rs-stog on' : 'rs-stog'}
          title="按正则表达式解释"
          aria-pressed={regex}
          onClick={() => setRegex((value) => !value)}
        >.*</button>
        <span className="rs-snum">{summary}</span>
      </div>

      <div className="rs-sres">
        {searchError === undefined ? null : (
          <div className="rs-err-box" style={{ margin: '8px 0' }}><code>{searchError}</code></div>
        )}
        {found === undefined && searching !== true && searchError === undefined
          ? <div className="rs-hint">输入关键词，回车或稍候自动搜索</div>
          : null}
        {found !== undefined && hits.length === 0 && searching !== true
          ? <div className="rs-hint">没有匹配</div>
          : null}
        {groups.map((group) => (
          <div className="rs-sgroup" key={group.path}>
            <div className="rs-sghead" title={group.path}>
              <Icon name="file" size={11} className="rs-fico" />
              <span className="rs-sgpath">{shortName(group.path)}</span>
              <span className="rs-sgn">{group.hits.length}</span>
            </div>
            {group.hits.map((hit, index) => (
              <div
                key={`${hit.line}:${hit.column}:${index}`}
                className={peek?.path === hit.path && peek?.focusLine === hit.line ? 'rs-shit sel' : 'rs-shit'}
                title={hit.path}
                onClick={() => void openFile({ path: hit.path }, hit.line)}
              >
                <span className="rs-shn">{hit.line}</span>
                <span className="rs-sht">{marked(hit.text)}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <>
      <div className="rs-bar">
        {breadcrumb}
        <IconButton name="levelUp" title="上一级" onClick={() => navigate(dirnameRemote(path))} disabled={atRoot} />
        <IconButton name="folderPlus" title="新建目录" onClick={() => { setFolder({ parent: path, name: '' }); setError(undefined) }} disabled={path === '' || busy !== ''} />
        <IconButton name="up" title="上传文件" onClick={() => fileInput.current?.click()} disabled={path === '' || busy !== ''} />
        <IconButton name="refresh" title="刷新" onClick={() => { void refresh().catch(failure => setError(failure.message)) }} />
        <IconButton
          name="search"
          title="在远端搜索内容"
          active={searchOpen}
          onClick={() => setSearchOpen((value) => !value)}
        />
        <input type="file" multiple ref={fileInput} style={{ display: 'none' }} onChange={upload} />
      </div>

      <div className="rs-hint" style={{ padding: '4px 12px' }}>上传位置：{path || '正在读取…'} · 单击展开目录，双击进入目录</div>
      {uploadProgress === '' ? null : <div className="rs-hint">{uploadProgress}<Button size="sm" disabled={uploadJob.current?.committing === true} onClick={() => { if (uploadJob.current) uploadJob.current.cancelled = true }}>取消上传</Button></div>}
      {folder === undefined ? null : <form className="rs-card" style={{ margin: '8px 12px', padding: '10px' }} onSubmit={event => { event.preventDefault(); void newFolder() }}>
        <div className="rs-muted">新建于：{folder.parent}</div>
        <label>目录名称<input className="rs-input" autoFocus value={folder.name} onChange={event => setFolder({ ...folder, name: event.target.value })} /></label>
        <Button type="submit" size="sm" disabled={busy === 'mkdir'}>创建目录</Button>
        <Button size="sm" onClick={() => setFolder(undefined)} disabled={busy === 'mkdir'}>取消创建</Button>
      </form>}
      {downloadEntry === undefined ? null : <form className="rs-card" style={{ margin: '8px 12px', padding: '10px' }} onSubmit={event => { event.preventDefault(); void downloadCustom() }}>
        <div className="rs-muted">下载：{downloadEntry.path}</div>
        <label>本地保存路径（含文件名）<input className="rs-input" autoFocus placeholder="C:/Downloads/file.txt 或 /home/user/Downloads/file.txt" value={localPath} onChange={event => setLocalPath(event.target.value)} /></label>
        <div className="rs-muted">保存到运行 DSH 的电脑。填写完整绝对路径，无需建立映射。</div>
        <Button type="submit" size="sm" disabled={busy === 'download' || localPath.trim() === ''}>保存到本地</Button>
        <Button size="sm" disabled={busy === 'download'} onClick={() => { void downloadMapped(downloadEntry) }}>下载到映射目录</Button>
        <Button size="sm" disabled={busy === 'download'} onClick={() => setDownloadEntry(undefined)}>取消下载</Button>
      </form>}

      {error !== undefined ? <div className="rs-err-box" style={{ margin: '8px 12px 0' }}><div className="rs-t"><Icon name="warn" size={12} />操作失败</div><code>{error}</code></div> : null}

      {searchOpen === true ? searchPane : (
        <div className="rs-tree" onClick={event => { if (!event.target.closest('.rs-row')) closePreview() }}>
          {busy === 'load' && dirs[path] === undefined
            ? <div className="rs-hint">读取目录…</div>
            : rowsFor(path, 0)}
          {(dirs[path]?.length ?? 0) === 0 && busy !== 'load'
            ? <div className="rs-hint">（空目录）</div>
            : null}
        </div>
      )}

      {peek === undefined ? null : (
        <div className="rs-peek">
          <div className="rs-peek-head">
            <Icon name="file" size={12} className="rs-fico" />
            <span className="rs-peek-path" title={peek.path}>{peek.path.replace(/^.*\//, '')}</span>
            <span className="rs-badge">{peek.loading === true ? '读取中' : formatBytes(peek.size ?? 0)}</span>
            {peek.focusLine === undefined ? null : <span className="rs-badge">第 {peek.focusLine} 行</span>}
            <span className="rs-peek-meta">{peek.mtimeMs ? sinceLabel(peek.mtimeMs) : ''}</span>
            <IconButton name="x" title="隐藏预览" onClick={closePreview} />
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
              : <pre className="rs-code" ref={codeRef}>{peek.loading === true ? '…' : (peek.text ?? '')}</pre>}

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
