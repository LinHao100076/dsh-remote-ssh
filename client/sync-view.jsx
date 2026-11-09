/**
 * Sync pane: mappings, direction, transfer queue, conflicts. Content only.
 *
 * The panel is opinionated about direction — the default is push-only (local →
 * remote) and `both` is a per-mapping choice. A conflict is never resolved
 * automatically: three explicit buttons, and nothing is overwritten until one is
 * pressed.
 * @module dsh-remote-ssh/client/sync-view
 */
import { createElement as h, Fragment, useCallback, useEffect, useState } from 'react'
import {
  api, formatBytes, hostStore, sinceLabel, usePolling, useStore,
} from './state.js'
import { Button, Dot, Field, Icon, IconButton, Input, Seg, Select } from './ui.jsx'

const DIRECTION = [
  { value: 'push', label: '仅上传' },
  { value: 'pull', label: '仅下载' },
  { value: 'both', label: '双向' },
]

const POLICY = [
  { value: 'off', label: '关闭' },
  { value: 'save', label: '保存时上传' },
  { value: 'all', label: '全部变更' },
]

const directionLabel = (kind) => DIRECTION.find((item) => item.value === kind)?.label ?? kind

/** One mapping card. */
function MappingCard({ mapping, host, status, busy, onPatch, onPush, onPull, onRemove, onClean }) {
  return (
    <div className="rs-card">
      <div className="rs-card-h">
        <Dot status={status} />
        <b>{host?.name ?? '主机已删除'}</b>
        <span className="rs-badge">{directionLabel(mapping.direction)}</span>
        {mapping.watching === true
          ? <span className="rs-badge ok">监听中</span>
          : <span className="rs-badge">未监听</span>}
        {mapping.conflicts > 0 ? <span className="rs-badge warn">{mapping.conflicts} 冲突</span> : null}
        <span style={{ flex: 1 }} />
        <IconButton name="trash" title="删除映射" onClick={onRemove} />
      </div>
      <div className="rs-card-b">
        <div className="rs-map-row">
          <span className="rs-path" title={mapping.localRoot}>{mapping.localRoot}</span>
          <span className="rs-arrow"><Icon name="up" size={12} /><Icon name="down" size={12} /></span>
          <span className="rs-path" title={mapping.remoteRoot}>{mapping.remoteRoot}</span>
        </div>

        <Seg
          value={mapping.policy}
          onChange={(value) => onPatch({ policy: value })}
          options={POLICY}
        />

        <div className="rs-map-row">
          <span className="rs-muted">方向</span>
          <div style={{ flex: 1 }}>
            <Seg
              value={mapping.direction}
              onChange={(value) => onPatch({ direction: value })}
              options={DIRECTION}
            />
          </div>
        </div>

        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <Button size="sm" onClick={onPush} disabled={busy}>{busy ? '推送中…' : '全量推送'}</Button>
          <Button size="sm" onClick={onPull}>下载单个</Button>
          <Button size="sm" onClick={onClean} disabled={busy} title="删除中断的传输留下的片段文件">清理残留</Button>
          <span style={{ flex: 1 }} />
          {mapping.pending > 0 ? <span className="rs-badge warn">{mapping.pending} 待上传</span> : null}
        </div>
      </div>
    </div>
  )
}

/**
 * @param {object} props - `ctx`, `sessionId`, `hostId`, `hosts`, `statuses`, `active`, `snapshot`.
 */
export function SyncPane({ ctx, sessionId, hostId, hosts, statuses, active, snapshot }) {
  const { hosts: liveHosts } = useStore(hostStore)
  const [state, setState] = useState(snapshot ?? { mappings: [], queue: [], conflicts: [], stats: {} })
  const [form, setForm] = useState(undefined)
  const [error, setError] = useState(undefined)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')

  const reload = useCallback(async () => {
    try {
      const value = await api(ctx, 'sync.list', { sessionId })
      setState(value)
    } catch (failure) {
      setError(failure.message)
    }
  }, [ctx, sessionId])

  useEffect(() => { void reload() }, [reload])
  usePolling(active === true, 2500, reload)

  const flash = (text) => {
    setToast(text)
    setTimeout(() => setToast(''), 2000)
  }

  const run = async (key, fn) => {
    setBusy(key)
    setError(undefined)
    try {
      const value = await fn()
      await reload()
      return value === undefined ? true : value
    } catch (failure) {
      setError(failure.message)
      return undefined
    } finally {
      setBusy('')
    }
  }

  const startAdd = async () => {
    setForm({
      hostId: hostId !== '' ? hostId : (hosts[0]?.id ?? ''),
      localRoot: '',
      remoteRoot: '',
      direction: 'push',
      policy: 'save',
    })
    try {
      const cwd = await api(ctx, 'session.cwd', { sessionId })
      setForm((current) => current === undefined ? current : ({ ...current, localRoot: cwd.cwd ?? '' }))
    } catch {
      // The field stays empty; the user can type a path.
    }
  }

  const submit = async () => {
    if (form === undefined) return
    const ok = await run('save', () => api(ctx, 'sync.save', { sessionId, mapping: form }))
    if (ok !== undefined) {
      setForm(undefined)
      flash('映射已保存，开始监听')
    }
  }

  const allHosts = liveHosts.length > 0 ? liveHosts : hosts
  const pending = state.queue.filter((task) => task.state === 'queued' || task.state === 'uploading').length

  const formCard = form === undefined ? null : (
    <div className="rs-card">
      <div className="rs-card-h"><b>新建映射</b><span style={{ flex: 1 }} /></div>
      <div className="rs-card-b">
        <Field label="主机">
          <Select
            value={form.hostId}
            onChange={(value) => setForm((current) => ({ ...current, hostId: value }))}
            options={allHosts.length === 0
              ? [{ value: '', label: '还没有主机' }]
              : allHosts.map((item) => ({ value: item.id, label: `${item.name} (${item.user}@${item.host})` }))}
          />
        </Field>
        <Field label="本地目录（工作区）">
          <Input value={form.localRoot} onChange={(value) => setForm((current) => ({ ...current, localRoot: value }))} placeholder="C:/work/app" />
        </Field>
        <Field label="远端目录（绝对路径）">
          <Input value={form.remoteRoot} onChange={(value) => setForm((current) => ({ ...current, remoteRoot: value }))} placeholder="/srv/app" />
        </Field>
        <Field label="方向">
          <Seg value={form.direction} onChange={(value) => setForm((current) => ({ ...current, direction: value }))} options={DIRECTION} />
        </Field>
        <Field label="自动上传">
          <Seg value={form.policy} onChange={(value) => setForm((current) => ({ ...current, policy: value }))} options={POLICY} />
        </Field>
        <div className="rs-muted">默认排除 node_modules / .git / dist 与日志。删除本地文件不会删除远端文件。</div>
        <div className="rs-rowacts">
          <Button variant="primary" size="sm" onClick={submit} disabled={busy === 'save'}>
            {busy === 'save' ? '保存中…' : '保存'}
          </Button>
          <Button size="sm" onClick={() => setForm(undefined)}>取消</Button>
        </div>
      </div>
    </div>
  )

  return (
    <>
      <div className="rs-scroll">
        {error !== undefined ? <div className="rs-err-box"><div className="rs-t"><Icon name="warn" size={12} />同步操作失败</div><code>{error}</code></div> : null}

        {formCard}

        {state.mappings.length === 0
          ? (
            <div className="rs-empty">
              <h3>还没有路径映射</h3>
              <p>建立映射后，dsh 改动的文件会在保存时自动上传；远端被改过时不会覆盖，而是报冲突。</p>
              <Button variant="primary" size="sm" onClick={startAdd} disabled={allHosts.length === 0}>
                {allHosts.length === 0 ? '先添加主机' : '新建映射'}
              </Button>
            </div>
          )
          : (
            <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
              <Button size="sm" onClick={startAdd}><Icon name="plus" size={11} />新建映射</Button>
              <span style={{ flex: 1 }} />
              <span className="rs-badge">{state.mappings.length} 个映射</span>
              {pending > 0 ? <span className="rs-badge warn">{pending} 待上传</span> : null}
            </div>
          )}

        {state.mappings.map((mapping) => {
          const host = allHosts.find((item) => item.id === mapping.hostId)
          return (
            <MappingCard
              key={mapping.id}
              mapping={mapping}
              host={host}
              status={statuses?.[mapping.hostId]?.status ?? 'disconnected'}
              busy={busy === `push-${mapping.id}` || busy === `clean-${mapping.id}`}
              onPatch={(patch) => void run(`map-${mapping.id}`, () => api(ctx, 'sync.save', {
                sessionId, mapping: { ...mapping, ...patch },
              }))}
              onPush={() => {
                if (!window.confirm(`把 ${mapping.localRoot} 的全部文件推送到 ${mapping.remoteRoot}？`)) return
                void run(`push-${mapping.id}`, async () => {
                  const value = await api(ctx, 'sync.pushAll', { sessionId, mappingId: mapping.id })
                  if (value.failed?.length > 0) throw new Error(`已推送 ${value.files} 个文件，${value.failed.length} 个失败：${value.failed[0].message}`)
                  flash(`已推送 ${value.files} 个文件 · ${formatBytes(value.bytes)}`)
                })
              }}
              onPull={() => {
                const rel = window.prompt('要下载的映射内相对路径（例如 src/app/main.ts）')
                if (rel === null || rel.trim() === '') return
                void run(`pull-${mapping.id}`, async () => {
                  await api(ctx, 'sync.pull', { sessionId, mappingId: mapping.id, rel: rel.trim() })
                  flash('已下载')
                })
              }}
              onRemove={() => {
                if (!window.confirm('删除该映射？未上传的改动不会回滚。')) return
                void run(`del-${mapping.id}`, () => api(ctx, 'sync.remove', { sessionId, mappingId: mapping.id }))
              }}
              onClean={() => {
                void run(`clean-${mapping.id}`, async () => {
                  const value = await api(ctx, 'transfer.cleanParts', {
                    sessionId, hostId: mapping.hostId, remoteRoot: mapping.remoteRoot,
                  })
                  flash(value.removed === 0
                    ? '没有残留的传输片段'
                    : `已清理 ${value.removed} 个片段 · ${formatBytes(value.bytes)}`)
                })
              }}
            />
          )
        })}

        {state.conflicts.map((conflict) => (
          <div key={conflict.key} className="rs-conflict">
            <div className="rs-conflict-h"><Icon name="warn" size={12} />1 处冲突待处理</div>
            <p>
              <code style={{ fontFamily: 'var(--rs-mono)' }}>{conflict.rel}</code> 本地与远端都被修改过
              （本地 {sinceLabel(conflict.localMtimeMs)} / 远端 {sinceLabel(conflict.remoteMtimeMs)}）。
            </p>
            <div className="rs-acts">
              <Button size="sm" onClick={() => void run(`c-${conflict.key}`, () => api(ctx, 'sync.resolve', { sessionId, key: conflict.key, choice: 'local' }))}>保留本地</Button>
              <Button size="sm" onClick={() => void run(`c-${conflict.key}`, () => api(ctx, 'sync.resolve', { sessionId, key: conflict.key, choice: 'remote' }))}>保留远端</Button>
              <Button size="sm" variant="ghost" onClick={() => void run(`c-${conflict.key}`, () => api(ctx, 'sync.resolve', { sessionId, key: conflict.key, choice: 'skip' }))}>忽略</Button>
            </div>
          </div>
        ))}

        {state.queue.length > 0 ? (
          <div className="rs-card">
            <div className="rs-card-h">
              <Icon name="sync" size={12} /><b>传输队列</b>
              <span className="rs-badge">{state.queue.length}</span>
              <span style={{ flex: 1 }} />
              <Button size="sm" variant="ghost" onClick={() => void run('flush', () => api(ctx, 'sync.flush', { sessionId }))}>刷新</Button>
            </div>
            {[...state.queue].reverse().slice(0, 12).map((task) => (
              <div key={task.id} className="rs-qitem">
                <span className={`rs-qico${task.state === 'error' || task.state === 'conflict' ? ' off' : ' up'}`}>
                  <Icon name={task.state === 'done' ? 'check' : task.state === 'error' ? 'warn' : 'up'} size={11} />
                </span>
                <span className="rs-qname" title={task.rel}>{task.rel}</span>
                <span className="rs-qstate" style={{
                  color: task.state === 'error' || task.state === 'conflict'
                    ? 'var(--rs-err)'
                    : task.state === 'done' ? 'var(--rs-ok)' : undefined,
                }}>
                  {task.state === 'uploading' ? '上传中…'
                    : task.state === 'done' ? (task.note ?? `已上传 ${formatBytes(task.size ?? 0)}`)
                      : task.state === 'conflict' ? '冲突'
                        : task.state === 'error' ? (task.error ?? '失败')
                          : '排队中'}
                </span>
                {task.state === 'uploading' ? <span className="rs-qbar indeterminate" /> : null}
              </div>
            ))}
            <div className="rs-stat">
              <span>本次 <b>{state.stats.uploaded ?? 0}</b> 文件</span>
              <span><b>{formatBytes(state.stats.bytes ?? 0)}</b></span>
              <span className="rs-grow" />
              <span>SFTP · 复用 1 条连接</span>
            </div>
          </div>
        ) : state.mappings.length === 0 ? null : (
          <div className="rs-muted" style={{ padding: '2px 2px 8px' }}>队列为空 —— 改动会在这里出现。</div>
        )}

        <div style={{ height: '8px' }} />
      </div>
      {toast !== '' ? <div className="rs-toast">{toast}</div> : null}
    </>
  )
}
