/**
 * Forward pane: the three tunnel shapes in one list (`ssh -L`, `-D`, `-R`).
 *
 * The panel mirrors what the manager enforces: a rule is "一端监听 → 另一端目标",
 * it binds loopback unless the user explicitly picks a public interface, and it
 * starts with the connection when `autoStart` is on. Anything bound off-loopback
 * gets a warning — that decision has consequences well beyond this panel, and for
 * a `-R` rule the consequence lands on a machine the user does not own.
 *
 * The kind picker is the first control because it changes what every field below
 * means: for `-L` the left port is here and the right one is on the server, for
 * `-R` exactly the opposite. Labels follow the kind instead of saying
 * "local/remote" and hoping the reader remembers which way the tunnel points.
 * @module dsh-remote-ssh/client/forward-view
 */
import { createElement as h, Fragment, useCallback, useEffect, useState } from 'react'
import { api, formatBytes, usePolling } from './state.js'
import { Button, Dot, Empty, Field, Icon, IconButton, Input, Seg, Select } from './ui.jsx'

/** Listen addresses, phrased from the side that actually binds. */
const BINDS_LOCAL = [
  { value: '127.0.0.1', label: '127.0.0.1（仅本机）' },
  { value: '::1', label: '::1（仅本机 IPv6）' },
  { value: '0.0.0.0', label: '0.0.0.0（暴露到局域网）' },
]

const BINDS_REMOTE = [
  { value: '127.0.0.1', label: '127.0.0.1（仅服务器本机）' },
  { value: '::1', label: '::1（仅服务器本机 IPv6）' },
  { value: '0.0.0.0', label: '0.0.0.0（服务器所有网卡）' },
]

const KINDS = [
  { value: 'local', label: '本地 -L' },
  { value: 'dynamic', label: '动态 -D' },
  { value: 'remote', label: '反向 -R' },
]

const AUTOSTART = [
  { value: 'on', label: '随连接启动' },
  { value: 'off', label: '手动启动' },
]

/** Short badge letter for a kind. */
const KIND_LETTER = { local: 'L', dynamic: 'D', remote: 'R' }

/** One-line explanation per kind, shown under the form. */
const KIND_HINT = {
  local: '本机程序连 localhost:本地端口，流量经 SSH 送到远端目标。远端地址从服务器的角度解析：服务只监听 127.0.0.1 时填 127.0.0.1 即可。',
  dynamic: '在本机开一个 SOCKS5 代理。浏览器或 curl 把代理指向它，目标地址由每次连接决定、在服务器上解析，适合访问服务器所在内网的多个服务。',
  remote: '反过来：让服务器监听一个端口，把连到该端口的流量送回本机。用于把本机的开发服务临时暴露给服务器。绑定非回环地址需要服务器开启 GatewayPorts。',
}

function blankForm(hostId) {
  return {
    hostId: hostId ?? '',
    kind: 'local',
    listenHost: '127.0.0.1',
    listenPort: '',
    targetHost: '127.0.0.1',
    targetPort: '',
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
  const exposedHint = rule.listenSide === 'remote'
    ? `服务器绑定 ${rule.listen.host}：服务器所在网络内的机器都能连这个端口，本机要一直在线`
    : `绑定 ${rule.listen.host}：同一网络内的其他机器也能连这个端口`
  return (
    <div className="rs-frow">
      <div className="rs-frow-l">
        <span className="rs-kind" title={KIND_HINT[rule.kind]}>{KIND_LETTER[rule.kind] ?? 'L'}</span>
        <span className="rs-path" title={`监听 ${rule.link}`}>{rule.link}</span>
        <span className="rs-arrow"><Icon name="up" size={11} /><Icon name="down" size={11} /></span>
        <span className="rs-path" title={`目标 ${rule.to}`}>{rule.to}</span>
        {rule.listenSide === 'remote' ? <span className="rs-badge">远端监听</span> : null}
      </div>

      <div className="rs-frow-r">
        {stateBadge(rule)}
        {live ? <span className="rs-qstate">{rule.connections} 连接 · {formatBytes(rule.bytes)}</span> : null}
        <span className="rs-grow" />
        {live ? <IconButton name="link" title="复制监听地址" onClick={onCopy} /> : null}
        {live
          ? <IconButton name="x" title="停止" onClick={onStop} />
          : <IconButton name="plug" title={busy ? '启动中…' : '启动'} onClick={onStart} disabled={busy} />}
        <IconButton name="edit" title="编辑" onClick={onEdit} />
        <IconButton name="trash" title="删除" onClick={onRemove} />
      </div>

      {rule.error !== undefined ? (
        <div className="rs-muted" style={{ color: 'var(--rs-err)' }}>{rule.error}</div>
      ) : null}
      {rule.exposed === true ? <div className="rs-muted">{exposedHint}</div> : null}
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
          kind: form.kind,
          listen: { host: form.listenHost, port: Number(form.listenPort) },
          target: form.kind === 'dynamic'
            ? { host: '', port: 0 }
            : { host: form.targetHost, port: Number(form.targetPort) },
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
      kind: rule.kind,
      listenHost: rule.listen.host,
      listenPort: String(rule.listen.port),
      targetHost: rule.target.host === '' ? '127.0.0.1' : rule.target.host,
      targetPort: rule.target.port === 0 ? '' : String(rule.target.port),
      autoStart: rule.autoStart === false ? 'off' : 'on',
    }),
    onRemove: () => {
      if (!window.confirm(`删除转发 ${rule.link} → ${rule.to}？`)) return
      void run(`del-${rule.id}`, () => api(ctx, 'forward.remove', { hostId: group.hostId, ruleId: rule.id }))
    },
    onCopy: async () => {
      const text = rule.kind === 'dynamic'
        ? `socks5://${rule.exposed ? rule.listen.host : '127.0.0.1'}:${rule.listen.port}`
        : (rule.exposed ? `${rule.listen.host}:${rule.listen.port}` : `localhost:${rule.listen.port}`)
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
  const ports = (list) => list.map((rule) => `:${rule.listen.port}`).join(' ')
  const remoteSide = exposed.filter((rule) => rule.listenSide === 'remote')
  const localSide = exposed.filter((rule) => rule.listenSide !== 'remote')

  const bindOptions = form?.kind === 'remote' ? BINDS_REMOTE : BINDS_LOCAL

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
        <Field label="类型">
          <Seg
            value={form.kind}
            onChange={(value) => setForm((current) => ({
              ...current,
              kind: value,
              // A `-R` rule binds on the server; keeping the previous choice would
              // silently mean something else, so fall back to that side's loopback.
              listenHost: current.listenHost === '0.0.0.0' && value === 'remote'
                ? '127.0.0.1'
                : current.listenHost,
            }))}
            options={KINDS}
          />
        </Field>
        <div className="rs-grid2 even">
          <Field label={form.kind === 'remote' ? '远端端口（服务器上监听）' : form.kind === 'dynamic' ? 'SOCKS5 端口' : '本地端口'}>
            <Input value={form.listenPort} onChange={(value) => setForm((current) => ({ ...current, listenPort: value.replace(/[^0-9]/g, '') }))} placeholder={form.kind === 'dynamic' ? '1080' : '6379'} />
          </Field>
          <Field label={form.kind === 'remote' ? '服务器绑定地址' : '绑定地址'}>
            <Select value={form.listenHost} onChange={(value) => setForm((current) => ({ ...current, listenHost: value }))} options={bindOptions} />
          </Field>
        </div>
        {form.kind === 'dynamic' ? null : (
          <div className="rs-grid2 even">
            <Field label={form.kind === 'remote' ? '本机目标地址' : '远端地址（远端视角）'}>
              <Input value={form.targetHost} onChange={(value) => setForm((current) => ({ ...current, targetHost: value }))} placeholder="127.0.0.1" />
            </Field>
            <Field label={form.kind === 'remote' ? '本机端口（转发目标）' : '远端端口'}>
              <Input value={form.targetPort} onChange={(value) => setForm((current) => ({ ...current, targetPort: value.replace(/[^0-9]/g, '') }))} placeholder={form.kind === 'remote' ? '3000' : '6379'} />
            </Field>
          </div>
        )}
        <Field label="启动方式">
          <Seg value={form.autoStart} onChange={(value) => setForm((current) => ({ ...current, autoStart: value }))} options={AUTOSTART} />
        </Field>
        <div className="rs-muted">{KIND_HINT[form.kind]}</div>
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
            <div className="rs-conflict-h"><Icon name="warn" size={12} />端口暴露在回环之外</div>
            {localSide.length > 0 ? (
              <p>{ports(localSide)} 正绑定在 0.0.0.0，同一网络内任何人都能访问远端服务。</p>
            ) : null}
            {remoteSide.length > 0 ? (
              <p>{ports(remoteSide)} 正监听在服务器的 0.0.0.0，服务器所在网络的任何人都能访问本机的服务。</p>
            ) : null}
          </div>
        ) : null}

        {formCard}

        {groups.length === 0
          ? (
            <Empty
              title="还没有转发规则"
              hint="把远端只监听 127.0.0.1 的 Redis、Postgres 或 dev server 映射到本机（本地 -L）；开一个 SOCKS5 代理访问服务器内网（动态 -D）；或者反过来把本机的服务暴露给服务器（反向 -R）。"
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
              <span>监听端 ⇄ 目标端</span>
              <span className="rs-grow" />
              <span>direct-tcpip / forwarded-tcpip</span>
            </div>
          </div>
        ))}

        <div style={{ height: '8px' }} />
      </div>
      {toast !== '' ? <div className="rs-toast">{toast}</div> : null}
    </>
  )
}
