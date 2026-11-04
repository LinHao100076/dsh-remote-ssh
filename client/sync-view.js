/**
 * Sync tab: mappings, policy, transfer queue, conflicts.
 *
 * The panel is deliberately opinionated about direction: the default is
 * push-only (local → remote) and `both` must be chosen per mapping. Conflicts
 * are shown with three explicit choices — keep local, take remote, ignore — and
 * nothing is overwritten until one is picked.
 * @module dsh-remote-ssh/client/sync-view
 */
import { createElement as h, Fragment, useCallback, useEffect, useState } from 'react'
import {
  api, formatBytes, hostStore, joinLocal, refreshHosts, refreshStatuses, sinceLabel, usePolling, useStore,
} from './state.js'
import { Banner, Button, Dot, Empty, Field, Icon, IconButton, Input, Select } from './ui.js'

const DIRECTIONS = [
  { value: 'push', label: '仅上传' },
  { value: 'pull', label: '仅下载' },
  { value: 'both', label: '双向' },
]

const POLICIES = [
  { value: 'save', label: '保存时上传' },
  { value: 'all', label: '所有变更' },
  { value: 'off', label: '关闭自动' },
]

function kindBadge(kind) {
  return kind === 'push' ? '仅上传' : kind === 'pull' ? '仅下载' : '双向'
}

export function SyncPane({ ctx, scope, visible }) {
  const sessionId = scope?.sessionId ?? 'default'
  const { hosts, statuses } = useStore(hostStore)
  const [state, setState] = useState({ mappings: [], queue: [], conflicts: [], stats: {} })
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

  useEffect(() => { void refreshHosts(ctx).catch(() => {}); void reload() }, [ctx, reload])
  usePolling(visible === true, 2000, reload)

  const flash = (text) => {
    setToast(text)
    setTimeout(() => setToast(''), 2000)
  }

  const run = async (key, fn) => {
    setBusy(key)
    setError(undefined)
    try {
      const value = await fn()
      if (value !== undefined) setState(value)
      return value
    } catch (failure) {
      setError(failure.message)
      return undefined
    } finally {
      setBusy('')
    }
  }

  const startAdd = async () => {
    setForm({ hostId: hosts[0]?.id ?? '', localRoot: '', remoteRoot: '', direction: 'push', policy: 'save' })
    try {
      const cwd = await api(ctx, 'session.cwd', { sessionId })
      setForm((current) => ({ ...current, localRoot: cwd.cwd ?? '' }))
    } catch {
      // The field stays empty; the user can type a path.
    }
  }

  const submit = async () => {
    if (form === undefined) return
    const value = await run('save', () => api(ctx, 'sync.save', { sessionId, mapping: form }))
    if (value !== undefined) {
      setForm(undefined)
      flash('映射已保存，开始监听')
    }
  }

  const patchMapping = async (mapping, patch) => {
    const merged = { ...mapping, ...patch }
    await run(`map-${mapping.id}`, () => api(ctx, 'sync.save', { sessionId, mapping: merged }))
  }

  const pushAll = async (mapping) => {
    if (!window.confirm(`把 ${mapping.localRoot} 的全部文件推送到 ${mapping.remoteRoot}？`)) return
    setBusy(`push-${mapping.id}`)
    setError(undefined)
    try {
      const value = await api(ctx, 'sync.pushAll', { sessionId, mappingId: mapping.id })
      setState(value.state)
      flash(`已推送 ${value.files} 个文件 · ${formatBytes(value.bytes)}`)
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }

  const resolve = async (conflict, choice) => {
    await run(`conflict-${conflict.key}`, () => api(ctx, 'sync.resolve', {
      sessionId, key: conflict.key, choice,
    }))
  }

  const pull = async (mapping, rel) => {
    await run(`pull-${rel}`, () => api(ctx, 'sync.pull', { sessionId, mappingId: mapping.id, rel }))
    flash(`已下载 ${rel}`)
  }

  /* ── render ──────────────────────────────────────────────────────── */

  if (state.mappings.length === 0 && form === undefined) {
    return h('div', { className: 'rs-root', style: { position: 'relative' } },
      h('div', { className: 'rs-head' },
        h(Dot, { status: 'disconnected' }),
        h('div', { className: 'rs-grow' }, h('div', { className: 'rs-host-name' }, '同步'),
          h('div', { className: 'rs-host-meta' }, '本地工作区 ⇄ 远端目录'))),
      h('div', { className: 'rs-body' },
        h(Empty, {
          title: '还没有路径映射',
          hint: '建立映射后，dsh 改动的文件会在保存时自动上传；远端被改过时不会覆盖，而是报冲突。',
          action: h(Button, { variant: 'primary', onClick: startAdd, disabled: hosts.length === 0 }, hosts.length === 0 ? '先添加主机' : '新建映射'),
        })),
      error !== undefined ? h(Banner, { tone: 'error' }, error) : null,
      toast !== '' ? h('div', { className: 'rs-toast' }, toast) : null)
  }

  return h('div', { className: 'rs-root', style: { position: 'relative' } },
    h('div', { className: 'rs-head' },
      h(Dot, { status: state.mappings.some((item) => statuses[item.hostId]?.status === 'connected') ? 'connected' : 'disconnected' }),
      h('div', { className: 'rs-grow' },
        h('div', { className: 'rs-host-name' }, '同步'),
        h('div', { className: 'rs-host-meta' },
          `${state.mappings.length} 个映射 · 待上传 ${state.queue.filter((task) => task.state === 'queued' || task.state === 'uploading').length} · 冲突 ${state.conflicts.length}`)),
      h(IconButton, { name: 'refresh', title: '刷新', onClick: reload }),
      h(IconButton, { name: 'plus', title: '新建映射', onClick: startAdd })),

    error !== undefined ? h(Banner, { tone: 'error' }, error) : null,

    h('div', { className: 'rs-scroll' },
      form === undefined
        ? null
        : h('div', { className: 'rs-card' },
          h('div', { className: 'rs-card-h' }, h('b', null, '新建映射')),
          h('div', { className: 'rs-card-b' },
            h(Field, { label: '主机' }, h(Select, {
              value: form.hostId,
              onChange: (value) => setForm((current) => ({ ...current, hostId: value })),
              options: hosts.length === 0
                ? [{ value: '', label: '还没有主机' }]
                : hosts.map((item) => ({ value: item.id, label: `${item.name} (${item.user}@${item.host})` })),
            })),
            h(Field, { label: '本地目录（工作区）' }, h(Input, {
              value: form.localRoot,
              onChange: (value) => setForm((current) => ({ ...current, localRoot: value })),
              placeholder: 'C:/work/app',
            })),
            h(Field, { label: '远端目录（绝对路径）' }, h(Input, {
              value: form.remoteRoot,
              onChange: (value) => setForm((current) => ({ ...current, remoteRoot: value })),
              placeholder: '/srv/app',
            })),
            h('div', { className: 'rs-grid2' },
              h(Field, { label: '方向' }, h(Select, {
                value: form.direction,
                onChange: (value) => setForm((current) => ({ ...current, direction: value })),
                options: DIRECTIONS,
              })),
              h(Field, { label: '策略' }, h(Select, {
                value: form.policy,
                onChange: (value) => setForm((current) => ({ ...current, policy: value })),
                options: POLICIES,
              }))),
            h('div', { className: 'rs-muted' }, '默认排除 node_modules / .git / dist / 构建产物与日志。删除本地文件不会删除远端文件。'),
            h('div', { style: { display: 'flex', gap: '6px' } },
              h(Button, { variant: 'primary', size: 'sm', onClick: submit, disabled: busy === 'save' }, busy === 'save' ? '保存中…' : '保存'),
              h(Button, { size: 'sm', onClick: () => setForm(undefined) }, '取消')))),

      state.mappings.map((mapping) => {
        const host = hosts.find((item) => item.id === mapping.hostId)
        const status = statuses[mapping.hostId]?.status ?? 'disconnected'
        return h('div', { key: mapping.id, className: 'rs-card' },
          h('div', { className: 'rs-card-h' },
            h(Dot, { status }),
            h('b', null, host?.name ?? '主机已删除'),
            h('span', { className: 'rs-badge' }, kindBadge(mapping.direction)),
            mapping.watching === true
              ? h('span', { className: 'rs-badge ok' }, '监听中')
              : h('span', { className: 'rs-badge' }, '未监听'),
            mapping.conflicts > 0 ? h('span', { className: 'rs-badge warn' }, `${mapping.conflicts} 冲突`) : null,
            h('span', { style: { flex: 1 } }),
            h(IconButton, {
              name: 'trash',
              title: '删除映射',
              onClick: () => {
                if (window.confirm('删除该映射？未上传的改动不会回滚。')) {
                  void run(`del-${mapping.id}`, () => api(ctx, 'sync.remove', { sessionId, mappingId: mapping.id }))
                }
              },
            })),
          h('div', { className: 'rs-card-b' },
            h('div', { className: 'rs-map-row' },
              h('span', { className: 'rs-path', title: mapping.localRoot }, mapping.localRoot),
              h(Icon, { name: 'sync', size: 12, className: 'rs-fico' }),
              h('span', { className: 'rs-path', title: mapping.remoteRoot }, mapping.remoteRoot)),
            h('div', { className: 'rs-grid2' },
              h(Field, { label: '方向' }, h(Select, {
                value: mapping.direction,
                onChange: (value) => void patchMapping(mapping, { direction: value }),
                options: DIRECTIONS,
              })),
              h(Field, { label: '策略' }, h(Select, {
                value: mapping.policy,
                onChange: (value) => void patchMapping(mapping, { policy: value }),
                options: POLICIES,
              }))),
            h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
              h(Button, {
                size: 'sm',
                onClick: () => pushAll(mapping),
                disabled: busy === `push-${mapping.id}`,
              }, busy === `push-${mapping.id}` ? '推送中…' : '全量推送'),
              h(Button, {
                size: 'sm',
                onClick: () => {
                  const rel = window.prompt('要下载的映射内相对路径（例如 src/app/main.ts）')
                  if (rel !== null && rel.trim() !== '') void pull(mapping, rel.trim())
                },
              }, '下载单个'),
              h('span', { style: { flex: 1 } }),
              mapping.pending > 0 ? h('span', { className: 'rs-badge warn' }, `${mapping.pending} 待上传`) : null)))
      }),

      state.conflicts.length > 0
        ? h('div', { className: 'rs-card' },
          h('div', { className: 'rs-card-h' }, h(Icon, { name: 'warn', size: 12 }), h('b', null, `${state.conflicts.length} 处冲突待处理`)),
          state.conflicts.map((conflict) => h('div', { key: conflict.key, style: { padding: '7px 9px', borderBottom: '1px solid var(--rs-line)' } },
            h('div', { className: 'rs-map-row' },
              h('span', { className: 'rs-path', title: conflict.rel }, conflict.rel)),
            h('div', { className: 'rs-muted', style: { margin: '4px 0 6px' } },
              `本地 ${sinceLabel(conflict.localMtimeMs)} / ${formatBytes(conflict.localSize)} · 远端 ${sinceLabel(conflict.remoteMtimeMs)} / ${formatBytes(conflict.remoteSize)}`),
            h('div', { style: { display: 'flex', gap: '6px' } },
              h(Button, { size: 'sm', onClick: () => void resolve(conflict, 'local') }, '保留本地'),
              h(Button, { size: 'sm', onClick: () => void resolve(conflict, 'remote') }, '保留远端'),
              h(Button, { size: 'sm', variant: 'ghost', onClick: () => void resolve(conflict, 'skip') }, '忽略')))))
        : null,

      state.queue.length > 0
        ? h('div', { className: 'rs-card' },
          h('div', { className: 'rs-card-h' }, h(Icon, { name: 'sync', size: 12 }), h('b', null, '传输队列'),
            h('span', { style: { flex: 1 } }),
            h('span', { className: 'rs-muted' }, `${state.stats.uploaded ?? 0} 已上传 · ${formatBytes(state.stats.bytes ?? 0)}`)),
          [...state.queue].reverse().slice(0, 12).map((task) => h('div', { key: task.id, className: 'rs-q' },
            h('span', { className: 'rs-qname', title: task.rel }, task.rel),
            h('span', { className: 'rs-qstate', style: {
              color: task.state === 'error' || task.state === 'conflict'
                ? 'var(--rs-err)'
                : task.state === 'done' ? 'var(--rs-ok)' : 'var(--rs-fg3)',
            } }, task.state === 'uploading' ? '上传中…'
              : task.state === 'done' ? (task.note ?? `已上传 ${formatBytes(task.size ?? 0)}`)
                : task.state === 'conflict' ? '冲突'
                  : task.state === 'error' ? (task.error ?? '失败')
                    : '排队中'))))
        : h('div', { className: 'rs-empty', style: { padding: '18px' } }, '队列为空 —— 改动会在这里出现'),
      h('div', { style: { height: '10px' } })),

    h('div', { className: 'rs-foot' },
      h('span', null, `本地 → 远端`),
      h('span', { className: 'rs-sep' }),
      h('span', null, `已上传 ${state.stats.uploaded ?? 0} · ${formatBytes(state.stats.bytes ?? 0)}`),
      h('span', { style: { flex: 1 } }),
      state.stats.failed > 0 ? h('span', { style: { color: 'var(--rs-err)' } }, `${state.stats.failed} 失败`) : null,
      h('span', null, 'SFTP')),
    toast !== '' ? h('div', { className: 'rs-toast' }, toast) : null)
}
