/**
 * Forward pane: local port forwarding rules (`ssh -L`), content only.
 *
 * The panel mirrors the model the host enforces: a rule is `本地端口 → 远端
 * host:port`, it binds loopback unless the user explicitly picks a public
 * interface, and it starts with the connection when `autoStart` is on. Anything
 * bound off-loopback gets a warning — that decision has consequences well beyond
 * this panel.
 * @module dsh-remote-ssh/client/forward-view
 */
import { createElement as h, Fragment, useCallback, useEffect, useState } from 'react'
import { api, formatBytes, usePolling } from './state.js'
import { Button, Dot, Empty, Field, Icon, IconButton, Input, Seg, Select } from './ui.jsx'

const BINDS = [
  { value: '127.0.0.1', label: '127.0.0.1（仅本机）' },
  { value: '::1', label: '::1（仅本机 IPv6）' },
  { value: '0.0.0.0', label: '0.0.0.0（暴露到局域网）' },
]

const AUTOSTART = [
  { value: 'on', label: '随连接启动' },
  { value: 'off', label: '手动启动' },
]

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

/** State badge for one rule. */
function stateBadge(rule) {
  if (rule.state === 'listening') return <span className="rs-badge ok">监听中</span>
  if (rule.state === 'starting') return <span className="rs-badge warn">启动中</span>
  if (rule.state === 'error') return <span className="rs-badge err">启动失败</span>
  return <span className="rs-badge">未启动</span>
}

/** One rule: addresses on the first line, state and actions on the second. */
function RuleRow({ rule, busy, onStart, onStop, onEdit, onRemove, onCopy }) {
  const live = rule.state === 'listening'
  return (
    <div className="rs-frow">
      <div className="rs-frow-l">
        <span className="rs-path" title={`本地 ${rule.local}`}>{rule.local}</span>
        <span className="rs-arrow"><Icon name="up" size={11} /><Icon name="down" size={11} /></span>
        <span className="rs-path" title={`远端 ${rule.target}`}>{rule.target}</span>
      </div>

      <div className="rs-frow-r">
        {stateBadge(rule)}
        {live ? <span className="rs-qstate">{rule.connections} 连接 · {formatBytes(rule.bytes)}</span> : null}
        <span className="rs-grow" />
        {live ? <IconButton name="link" title="复制本地地址" onClick={onCopy} /> : null}
        {live
          ? <IconButton name="x" title="停止" onClick={onStop} />
          : <IconButton name="plug" title={busy ? '启动中…' : '启动'} onClick={onStart} disabled={busy} />}
        <IconButton name="edit" title="编辑" onClick={onEdit} />
        <IconButton name="trash" title="删除" onClick={onRemove} />
      </div>

      {rule.error !== undefined ? (
        <div className="rs-muted" style={{ color: 'var(--rs-err)' }}>{rule.error}</div>
      ) : null}
      {rule.exposed === true ? (
        <div className="rs-muted">绑定 {rule.bind}：同一网络内的其他机器也能连这个端口</div>
      ) : null}
    </div>
  )
}

/**
 * @param {object} props - `ctx`, `hostId`, `hosts`, `statuses`, `active`.
 */
export function ForwardPane({ ctx, hostId, hosts, statuses, active }) {
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

  useEffect(() => { void reload() }, [reload])
  usePolling(active === true, 2000, reload)

  const flash = (text) => {
    setToast(text)
    setTimeout(() => setToast(''), 2000)
  }

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

  const ruleProps = (group, rule) => ({
    busy: busy === `start-${rule.id}`,
    onStart: () => void run(`start-${rule.id}`, () => api(ctx, 'forward.start', { hostId: group.hostId, ruleId: rule.id })),
    onStop: () => void run(`stop-${rule.id}`, () => api(ctx, 'forward.stop', { hostId: group.hostId, ruleId: rule.id })),
    onEdit: () => setForm({
      id: rule.id,
      hostId: group.hostId,
      localPort: String(rule.localPort),
      remoteHost: rule.remoteHost,
      remotePort: String(rule.remotePort),
      bind: rule.bind,
      autoStart: rule.autoStart === false ? 'off' : 'on',
    }),
    onRemove: () => {
      if (!window.confirm(`删除转发 ${rule.local} → ${rule.target}？`)) return
      void run(`del-${rule.id}`, () => api(ctx, 'forward.remove', { hostId: group.hostId, ruleId: rule.id }))
    },
    onCopy: async () => {
      const text = rule.exposed ? `${rule.bind}:${rule.localPort}` : `localhost:${rule.localPort}`
      try {
        await navigator.clipboard.writeText(text)
        flash(`已复制 ${text}`)
      } catch {
        flash(text)
      }
    },
  })

  const rules = groups.flatMap((group) => group.rules)
  const listening = rules.filter((rule) => rule.state === 'listening').length
  const exposed = rules.filter((rule) => rule.exposed && rule.state === 'listening')

  const formCard = form === undefined ? null : (
    <div className="rs-card">
      <div className="rs-card-h"><b>{form.id === undefined ? '新建转发' : '编辑转发'}</b><span style={{ flex: 1 }} /></div>
      <div className="rs-card-b">
        <Field label="主机">
          <Select
            value={form.hostId}
            onChange={(value) => setForm((current) => ({ ...current, hostId: value }))}
            options={hosts.length === 0
              ? [{ value: '', label: '还没有主机' }]
              : hosts.map((item) => ({ value: item.id, label: `${item.name} (${item.user}@${item.host})` }))}
          />
        </Field>
        <div className="rs-grid2">
          <Field label="本地端口">
            <Input value={form.localPort} onChange={(value) => setForm((current) => ({ ...current, localPort: value.replace(/[^0-9]/g, '') }))} placeholder="6379" />
          </Field>
          <Field label="绑定地址">
            <Select value={form.bind} onChange={(value) => setForm((current) => ({ ...current, bind: value }))} options={BINDS} />
          </Field>
        </div>
        <div className="rs-grid2">
          <Field label="远端地址（远端视角）">
            <Input value={form.remoteHost} onChange={(value) => setForm((current) => ({ ...current, remoteHost: value }))} placeholder="127.0.0.1" />
          </Field>
          <Field label="远端端口">
            <Input value={form.remotePort} onChange={(value) => setForm((current) => ({ ...current, remotePort: value.replace(/[^0-9]/g, '') }))} placeholder="6379" />
          </Field>
        </div>
        <Field label="启动方式">
          <Seg value={form.autoStart} onChange={(value) => setForm((current) => ({ ...current, autoStart: value }))} options={AUTOSTART} />
        </Field>
        <div className="rs-muted">
          本地程序连 localhost:本地端口，流量经已建立的 SSH 连接送到远端地址。远端地址从服务器的角度解析：服务只监听 127.0.0.1 时填 127.0.0.1 即可。
        </div>
        <div className="rs-rowacts">
          <Button variant="primary" size="sm" onClick={save} disabled={busy === 'save'}>
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
        {error !== undefined ? <div className="rs-err-box"><div className="rs-t"><Icon name="warn" size={12} />转发操作失败</div><code>{error}</code></div> : null}
        {exposed.length > 0 ? (
          <div className="rs-conflict">
            <div className="rs-conflict-h"><Icon name="warn" size={12} />端口暴露在局域网</div>
            <p>{exposed.map((rule) => `:${rule.localPort}`).join(' ')} 正绑定在 0.0.0.0，同一网络内任何人都能访问远端服务。</p>
          </div>
        ) : null}

        {formCard}

        {groups.length === 0
          ? (
            <Empty
              title="还没有转发规则"
              hint="把远端只监听 127.0.0.1 的 Redis、Postgres 或 dev server 映射到本机：本地端口 6379 → 远端 127.0.0.1:6379，然后在本地照常连接。"
              action={(
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setForm(blankForm(hostId !== '' ? hostId : hosts[0]?.id))}
                  disabled={hosts.length === 0}
                >
                  {hosts.length === 0 ? '先在「设置」里添加主机' : '新建转发'}
                </Button>
              )}
            />
          )
          : (
            <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
              <Button size="sm" onClick={() => setForm(blankForm(hostId !== '' ? hostId : hosts[0]?.id))}>
                <Icon name="plus" size={11} />新建转发
              </Button>
              <span style={{ flex: 1 }} />
              <span className="rs-badge">{rules.length} 条规则</span>
              <span className="rs-badge ok">{listening} 监听中</span>
            </div>
          )}

        {groups.map((group) => (
          <div key={group.hostId} className="rs-card">
            <div className="rs-card-h">
              <Dot status={statuses?.[group.hostId]?.status ?? group.status ?? 'disconnected'} />
              <b>{group.hostName}</b>
              <span className="rs-badge">{group.rules.filter((rule) => rule.state === 'listening').length}/{group.rules.length}</span>
              <span style={{ flex: 1 }} />
              <Button size="sm" variant="ghost" onClick={() => void run(`all-${group.hostId}`, () => api(ctx, 'forward.startAll', { hostId: group.hostId }))}>全部启动</Button>
              <Button size="sm" variant="ghost" onClick={() => void run(`all-${group.hostId}`, () => api(ctx, 'forward.stopAll', { hostId: group.hostId }))}>停止</Button>
            </div>
            {group.rules.map((rule) => (
              <RuleRow key={rule.id} rule={rule} {...ruleProps(group, rule)} />
            ))}
            <div className="rs-stat">
              <span>本地端口 ⇄ 远端服务</span>
              <span className="rs-grow" />
              <span>direct-tcpip</span>
            </div>
          </div>
        ))}

        <div style={{ height: '8px' }} />
      </div>
      {toast !== '' ? <div className="rs-toast">{toast}</div> : null}
    </>
  )
}
