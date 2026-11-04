/**
 * Forward tab: local port forwarding rules (`ssh -L`).
 *
 * The panel mirrors the model the host enforces: a rule is `本地端口 → 远端
 * host:port`, it binds loopback unless the user explicitly picks a public
 * interface, and it starts with the connection when `autoStart` is on. Anything
 * bound off-loopback gets a warning, because that is a decision with consequences
 * well beyond this panel.
 * @module dsh-remote-ssh/client/forward-view
 */
import { createElement as h, useCallback, useEffect, useState } from 'react'
import { api, formatBytes, hostStore, refreshHosts, refreshStatuses, usePolling, useStore } from './state.js'
import { Banner, Button, Dot, Empty, Field, Icon, IconButton, Input, Select } from './ui.js'

const BINDS = [
  { value: '127.0.0.1', label: '127.0.0.1（仅本机）' },
  { value: '::1', label: '::1（仅本机 IPv6）' },
  { value: '0.0.0.0', label: '0.0.0.0（暴露到局域网）' },
]

const AUTOSTART = [
  { value: 'on', label: '随连接启动' },
  { value: 'off', label: '手动启动' },
]

/** State badge for one rule. */
function StateBadge({ rule }) {
  if (rule.state === 'listening') return h('span', { className: 'rs-badge ok' }, '监听中')
  if (rule.state === 'starting') return h('span', { className: 'rs-badge warn' }, '启动中')
  if (rule.state === 'error') return h('span', { className: 'rs-badge err' }, '启动失败')
  return h('span', { className: 'rs-badge' }, '未启动')
}

/** One rule: addresses on the first line, state and actions on the second. */
function RuleRow({ rule, busy, onStart, onStop, onEdit, onRemove, onCopy }) {
  const live = rule.state === 'listening'
  return h('div', { className: 'rs-frow' },
    h('div', { className: 'rs-frow-l' },
      h('span', { className: 'rs-path', title: `本地 ${rule.local}` }, rule.local),
      h(Icon, { name: 'chevron', size: 10, className: 'rs-fico' }),
      h('span', { className: 'rs-path', title: `远端 ${rule.target}` }, rule.target)),

    h('div', { className: 'rs-frow-r' },
      h(StateBadge, { rule }),
      live ? h('span', { className: 'rs-frow-meta' }, `${rule.connections} 连接 · ${formatBytes(rule.bytes)}`) : null,
      h('span', { style: { flex: 1 } }),
      live ? h(IconButton, { name: 'link', title: '复制本地地址', onClick: onCopy }) : null,
      h(IconButton, { name: 'edit', title: '编辑规则', onClick: onEdit }),
      live
        ? h(IconButton, { name: 'x', title: '停止', onClick: onStop })
        : h(Button, { size: 'sm', onClick: onStart, disabled: busy }, busy ? '启动中…' : '启动'),
      h(IconButton, { name: 'trash', title: '删除规则', onClick: onRemove })),

    rule.error !== undefined
      ? h('div', { className: 'rs-muted', style: { color: 'var(--rs-err)' } }, rule.error)
      : null,
    rule.exposed === true
      ? h('div', { className: 'rs-muted' }, `绑定 ${rule.bind}：同一网络内的其他机器也能连这个端口`)
      : null)
}

/** One host card: connection state, bulk actions, and its rules. */
function HostCard({ group, status, busyKey, onStartAll, onStopAll, ruleProps }) {
  const live = group.rules.filter((rule) => rule.state === 'listening').length
  return h('div', { className: 'rs-card' },
    h('div', { className: 'rs-card-h' },
      h(Dot, { status }),
      h('b', null, group.hostName),
      h('span', { className: 'rs-badge' }, `${live}/${group.rules.length}`),
      status !== 'connected' ? h('span', { className: 'rs-badge warn' }, '未连接') : null,
      h('span', { style: { flex: 1 } }),
      h(Button, { size: 'sm', onClick: onStartAll, disabled: busyKey }, '全部启动'),
      h(Button, { size: 'sm', variant: 'ghost', onClick: onStopAll, disabled: busyKey }, '全部停止')),

    group.rules.map((rule) => h(RuleRow, {
      key: rule.id,
      rule,
      busy: busyKey === `start-${rule.id}`,
      onStart: () => ruleProps.start(group, rule),
      onStop: () => ruleProps.stop(group, rule),
      onEdit: () => ruleProps.edit(group, rule),
      onRemove: () => ruleProps.remove(group, rule),
      onCopy: () => ruleProps.copy(rule),
    })))
}

/** Empty form state. */
function blankForm(hostId) {
  return {
    hostId: hostId ?? '',
    localPort: '',
    remoteHost: '127.0.0.1',
    remotePort: '',
    bind: '127.0.0.1',
    autoStart: 'on',
  }
}

export function ForwardPane({ ctx, visible }) {
  const { hosts, statuses } = useStore(hostStore)
  const [groups, setGroups] = useState([])
  const [form, setForm] = useState(undefined)
  const [error, setError] = useState(undefined)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')

  const reload = useCallback(async () => {
    try {
      const value = await api(ctx, 'forward.list')
      setGroups(value.hosts ?? [])
    } catch (failure) {
      setError(failure.message)
    }
  }, [ctx])

  useEffect(() => { void refreshHosts(ctx).catch(() => {}); void reload() }, [ctx, reload])
  usePolling(visible === true, 1500, async () => { await reload(); await refreshStatuses(ctx) })

  const flash = (text) => {
    setToast(text)
    setTimeout(() => setToast(''), 2000)
  }

  /** Run one mutation with a busy key and a single error slot. */
  const run = async (key, fn) => {
    setBusy(key)
    setError(undefined)
    try {
      await fn()
      await reload()
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }

  const save = async () => {
    if (form === undefined) return
    setBusy('save')
    setError(undefined)
    try {
      await api(ctx, 'forward.save', {
        hostId: form.hostId,
        rule: {
          id: form.id,
          localPort: Number(form.localPort),
          remoteHost: form.remoteHost,
          remotePort: Number(form.remotePort),
          bind: form.bind,
          autoStart: form.autoStart !== 'off',
        },
      })
      setForm(undefined)
      flash('规则已保存')
      await reload()
    } catch (failure) {
      setError(failure.message)
    } finally {
      setBusy('')
    }
  }

  const ruleProps = {
    start: (group, rule) => run(`start-${rule.id}`, () => api(ctx, 'forward.start', { hostId: group.hostId, ruleId: rule.id })),
    stop: (group, rule) => run(`stop-${rule.id}`, () => api(ctx, 'forward.stop', { hostId: group.hostId, ruleId: rule.id })),
    edit: (group, rule) => setForm({
      id: rule.id,
      hostId: group.hostId,
      localPort: String(rule.localPort),
      remoteHost: rule.remoteHost,
      remotePort: String(rule.remotePort),
      bind: rule.bind,
      autoStart: rule.autoStart === false ? 'off' : 'on',
    }),
    remove: (group, rule) => {
      if (!window.confirm(`删除转发 ${rule.local} → ${rule.target}？`)) return
      void run(`del-${rule.id}`, () => api(ctx, 'forward.remove', { hostId: group.hostId, ruleId: rule.id }))
    },
    copy: async (rule) => {
      const text = rule.exposed ? `${rule.bind}:${rule.localPort}` : `localhost:${rule.localPort}`
      try {
        await navigator.clipboard.writeText(text)
        flash(`已复制 ${text}`)
      } catch {
        flash(text)
      }
    },
  }

  const rules = groups.flatMap((group) => group.rules)
  const listening = rules.filter((rule) => rule.state === 'listening').length
  const exposed = rules.filter((rule) => rule.exposed && rule.state === 'listening')

  const formCard = h('div', { className: 'rs-card' },
    h('div', { className: 'rs-card-h' }, h('b', null, form?.id === undefined ? '新建转发' : '编辑转发')),
    h('div', { className: 'rs-card-b' },
      h(Field, { label: '主机' }, h(Select, {
        value: form?.hostId ?? '',
        onChange: (value) => setForm((current) => ({ ...current, hostId: value })),
        options: hosts.length === 0
          ? [{ value: '', label: '还没有主机' }]
          : hosts.map((item) => ({ value: item.id, label: `${item.name} (${item.user}@${item.host})` })),
      })),
      h('div', { className: 'rs-grid2' },
        h(Field, { label: '本地端口' }, h(Input, {
          value: form?.localPort ?? '',
          onChange: (value) => setForm((current) => ({ ...current, localPort: value.replace(/[^0-9]/g, '') })),
          placeholder: '6379',
        })),
        h(Field, { label: '绑定地址' }, h(Select, {
          value: form?.bind ?? '127.0.0.1',
          onChange: (value) => setForm((current) => ({ ...current, bind: value })),
          options: BINDS,
        }))),
      h('div', { className: 'rs-grid2' },
        h(Field, { label: '远端地址（远端视角）' }, h(Input, {
          value: form?.remoteHost ?? '127.0.0.1',
          onChange: (value) => setForm((current) => ({ ...current, remoteHost: value })),
          placeholder: '127.0.0.1',
        })),
        h(Field, { label: '远端端口' }, h(Input, {
          value: form?.remotePort ?? '',
          onChange: (value) => setForm((current) => ({ ...current, remotePort: value.replace(/[^0-9]/g, '') })),
          placeholder: '6379',
        }))),
      h(Field, { label: '启动方式' }, h(Select, {
        value: form?.autoStart ?? 'on',
        onChange: (value) => setForm((current) => ({ ...current, autoStart: value })),
        options: AUTOSTART,
      })),
      h('div', { className: 'rs-muted' },
        '本地程序连 localhost:本地端口，流量经已建立的 SSH 连接送到远端地址。远端地址是从服务器的角度解析的：服务只监听 127.0.0.1 时填 127.0.0.1 即可。'),
      h('div', { style: { display: 'flex', gap: '6px' } },
        h(Button, { variant: 'primary', size: 'sm', onClick: save, disabled: busy === 'save' },
          busy === 'save' ? '保存中…' : '保存'),
        h(Button, { size: 'sm', onClick: () => setForm(undefined) }, '取消'))))

  return h('div', { className: 'rs-root', style: { position: 'relative' } },
    h('div', { className: 'rs-head' },
      h(Dot, { status: listening > 0 ? 'connected' : 'disconnected' }),
      h('div', { className: 'rs-grow' },
        h('div', { className: 'rs-host-name' }, '转发'),
        h('div', { className: 'rs-host-meta' }, `${rules.length} 条规则 · ${listening} 监听中`)),
      h(IconButton, { name: 'refresh', title: '刷新', onClick: reload }),
      h(IconButton, { name: 'plus', title: '新建转发', onClick: () => setForm(blankForm(hosts[0]?.id)) })),

    error !== undefined ? h(Banner, { tone: 'error' }, error) : null,

    exposed.length > 0
      ? h(Banner, null, `${exposed.map((rule) => `:${rule.localPort}`).join(' ')} 正绑定在 0.0.0.0，同一网络内任何人都能访问远端服务`)
      : null,

    h('div', { className: 'rs-scroll' },
      form === undefined ? null : formCard,

      groups.length === 0
        ? h(Empty, {
          title: '还没有转发规则',
          hint: '把远端只监听 127.0.0.1 的 Redis、Postgres 或 dev server 映射到本机：本地端口 6379 → 远端 127.0.0.1:6379，然后在本地照常连接。',
          action: h(Button, {
            variant: 'primary',
            size: 'sm',
            onClick: () => setForm(blankForm(hosts[0]?.id)),
            disabled: hosts.length === 0,
          }, hosts.length === 0 ? '先在「远程」里添加主机' : '新建转发'),
        })
        : null,

      groups.map((group) => h(HostCard, {
        key: group.hostId,
        group,
        status: statuses[group.hostId]?.status ?? group.status ?? 'disconnected',
        busyKey: busy,
        onStartAll: () => run(`all-${group.hostId}`, () => api(ctx, 'forward.startAll', { hostId: group.hostId })),
        onStopAll: () => run(`all-${group.hostId}`, () => api(ctx, 'forward.stopAll', { hostId: group.hostId })),
        ruleProps,
      })),

      h('div', { style: { height: '10px' } })),

    h('div', { className: 'rs-foot' },
      h('span', null, '本地端口 ⇄ 远端服务'),
      h('span', { className: 'rs-sep' }),
      h('span', null, `${listening} 监听中`),
      h('span', { style: { flex: 1 } }),
      h('span', null, 'direct-tcpip')),

    toast !== '' ? h('div', { className: 'rs-toast' }, toast) : null)
}
