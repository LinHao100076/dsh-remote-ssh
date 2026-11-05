/**
 * Settings pane: the connection itself, in place, with no modal in the way.
 *
 * This is the answer to issue #2's first half — "没有地方可以输入密码了". A host
 * saved with password auth had nowhere to type the password after the page
 * reloaded, because the secret only ever lived in memory. Here the field is on
 * screen, next to the auth type it belongs to, and the value is handed to the
 * host half for the attempt without being written to the state file.
 *
 * The same form creates and edits, so "新建 SSH 连接" from the connect view and
 * "管理当前主机" from the header switcher land on one screen.
 * @module dsh-remote-ssh/client/settings-view
 */
import { createElement as h, Fragment, useEffect, useState } from 'react'
import { api } from './state.js'
import { Button, Field, Icon, Input, Select } from './ui.jsx'

const AUTH = [
  { value: 'agent', label: 'ssh-agent' },
  { value: 'key', label: '密钥文件' },
  { value: 'password', label: '密码' },
]

const BLANK = {
  name: '',
  host: '',
  port: '22',
  user: '',
  authType: 'agent',
  keyPath: '~/.ssh/id_ed25519',
  proxyJump: '',
  password: '',
  passphrase: '',
}

/** Stored row → form state (secrets are never stored, so they start empty). */
function fromHost(host) {
  return {
    name: host?.name ?? '',
    host: host?.host ?? '',
    port: String(host?.port ?? 22),
    user: host?.user ?? '',
    authType: host?.auth?.type ?? 'agent',
    keyPath: host?.auth?.keyPath ?? '~/.ssh/id_ed25519',
    proxyJump: host?.proxyJump ?? '',
    password: '',
    passphrase: '',
  }
}

/** Form state → persisted row (no secrets). */
function toRow(form, id) {
  return {
    id,
    name: form.name.trim() === '' ? form.host.trim() : form.name.trim(),
    host: form.host.trim(),
    port: Number(form.port) || 22,
    user: form.user.trim(),
    auth: {
      type: form.authType,
      keyPath: form.authType === 'key' ? form.keyPath.trim() : undefined,
    },
    proxyJump: form.proxyJump.trim() === '' ? undefined : form.proxyJump.trim(),
  }
}

/**
 * @param {object} props - `ctx`, `host`, `hosts`, `hostId`, `seed`, `creating`,
 *   `onSaved(row, secret)`, `onDeleted(id)`, `onConnect(row, password)`, `onCancelNew()`.
 */
export function SettingsPane({
  ctx, host, hosts, hostId, seed, creating, onSaved, onDeleted, onConnect, onCancelNew,
}) {
  const [form, setForm] = useState(() => (creating ? { ...BLANK } : fromHost(host)))
  const [configHosts, setConfigHosts] = useState([])
  const [status, setStatus] = useState(undefined)
  const [busy, setBusy] = useState('')

  /* Re-seed when the selected host changes or "new" is requested. */
  useEffect(() => {
    setForm(creating ? { ...BLANK } : fromHost(host))
    setStatus(undefined)
  }, [hostId, seed, creating])

  useEffect(() => {
    let cancelled = false
    void api(ctx, 'hosts.sshConfig')
      .then((value) => { if (!cancelled) setConfigHosts(value.hosts ?? []) })
      .catch(() => setConfigHosts([]))
    return () => { cancelled = true }
  }, [ctx])

  const patch = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  const secret = () => {
    const value = {}
    if (form.password !== '') value.password = form.password
    if (form.passphrase !== '') value.passphrase = form.passphrase
    return value
  }

  const save = async (andConnect) => {
    setBusy(andConnect ? 'connect' : 'save')
    setStatus(undefined)
    try {
      const row = toRow(form, host?.id)
      const value = await api(ctx, 'hosts.save', { host: row })
      const typed = secret()
      setStatus({ tone: 'ok', text: '已保存' })
      if (andConnect === true) {
        const password = typed.password
        if (value.host.auth.type === 'password' && (password ?? '') === '') {
          // Nothing to connect with yet; the connect gate asks for it on screen.
          await onSaved(value.host, typed)
          return
        }
        const passwordOk = await onConnect(value.host, password)
        if (!passwordOk) setStatus({ tone: 'error', text: '已保存，但连接失败' })
      }
      await onSaved(value.host, typed)
    } catch (error) {
      setStatus({ tone: 'error', text: error.message })
    } finally {
      setBusy('')
    }
  }

  const test = async () => {
    setBusy('test')
    setStatus(undefined)
    try {
      const row = toRow(form, host?.id)
      const value = await api(ctx, 'hosts.connect', {
        draft: row,
        auth: {
          password: form.password === '' ? undefined : form.password,
          passphrase: form.passphrase === '' ? undefined : form.passphrase,
        },
      })
      setStatus({
        tone: 'ok',
        text: `连通 · ${value.info.kernel || 'Linux'} · tmux ${value.info.tmux ? '可用' : '未安装（会话不持久）'}`,
      })
    } catch (error) {
      setStatus({ tone: 'error', text: error.message })
    } finally {
      setBusy('')
    }
  }

  const importConfig = (alias) => {
    const found = configHosts.find((entry) => entry.alias === alias)
    if (found === undefined) return
    setForm((current) => ({
      ...current,
      name: current.name === '' ? alias : current.name,
      host: found.host ?? alias,
      port: String(found.port ?? 22),
      user: found.user ?? current.user,
      keyPath: found.identityFile ?? current.keyPath,
      proxyJump: found.proxyJump ?? current.proxyJump,
      authType: found.identityFile ? 'key' : current.authType,
    }))
  }

  const remove = async () => {
    if (host === undefined) return
    if (!window.confirm(`删除主机 ${host.name}？它下面的转发规则也会一起删掉。`)) return
    setBusy('delete')
    try {
      await api(ctx, 'hosts.delete', { hostId: host.id })
      await onDeleted(host.id)
    } catch (error) {
      setStatus({ tone: 'error', text: error.message })
    } finally {
      setBusy('')
    }
  }

  const editing = host !== undefined && creating !== true

  return (
    <div className="rs-scroll">
      <div className="rs-sect">{editing ? `连接 · ${host.name}` : '新建连接'}</div>

      {configHosts.length > 0 ? (
        <div className="rs-card">
          <div className="rs-card-b">
            <Field label={`从 ~/.ssh/config 导入（${configHosts.length} 个 Host）`}>
              <Select
                value=""
                onChange={importConfig}
                options={[
                  { value: '', label: '选择一个 Host…' },
                  ...configHosts.map((entry) => ({
                    value: entry.alias,
                    label: `${entry.alias} — ${entry.user ? `${entry.user}@` : ''}${entry.host}${entry.proxyJump ? ` (jump ${entry.proxyJump})` : ''}`,
                  })),
                ]}
              />
            </Field>
          </div>
        </div>
      ) : (
        <div className="rs-muted" style={{ marginBottom: '8px' }}>未找到 ~/.ssh/config，手动填写下面的字段。</div>
      )}

      <div className="rs-card">
        <div className="rs-card-b">
          <Field label="名称">
            <Input value={form.name} onChange={patch('name')} placeholder="prod-web-01" />
          </Field>
          <div className="rs-grid2">
            <Field label="主机">
              <Input value={form.host} onChange={patch('host')} placeholder="10.0.3.21" />
            </Field>
            <Field label="端口">
              <Input value={form.port} onChange={patch('port')} />
            </Field>
          </div>
          <div className="rs-grid2 wide">
            <Field label="用户">
              <Input value={form.user} onChange={patch('user')} placeholder="ubuntu" />
            </Field>
            <Field label="认证">
              <Select value={form.authType} onChange={patch('authType')} options={AUTH} />
            </Field>
          </div>

          {form.authType === 'key' ? (
            <>
              <Field label="私钥路径">
                <Input value={form.keyPath} onChange={patch('keyPath')} />
              </Field>
              <Field label="私钥 passphrase（仅本次会话，不写入磁盘）">
                <Input type="password" value={form.passphrase} onChange={patch('passphrase')} />
              </Field>
            </>
          ) : null}

          {form.authType === 'password' ? (
            <Field label="密码（仅本次会话，不写入磁盘）">
              <Input
                type="password"
                value={form.password}
                onChange={patch('password')}
                placeholder="••••••••"
                onKeyDown={(event) => { if (event.key === 'Enter') void save(true) }}
              />
            </Field>
          ) : null}

          <Field label="ProxyJump（可选，最多两跳）">
            <Input value={form.proxyJump} onChange={patch('proxyJump')} placeholder="例如 bastion.internal 或 ~/.ssh/config 里的 Host" />
          </Field>

          {status !== undefined ? (
            <div className="rs-muted" style={{ color: status.tone === 'ok' ? 'var(--rs-ok)' : 'var(--rs-err)', display: 'flex', gap: '5px', alignItems: 'center' }}>
              <Icon name={status.tone === 'ok' ? 'check' : 'warn'} size={12} />{status.text}
            </div>
          ) : null}

          <div className="rs-rowacts">
            <Button variant="primary" onClick={() => void save(true)} disabled={busy !== '' || form.host === '' || form.user === ''}>
              {busy === 'connect' ? '连接中…' : editing ? '保存并连接' : '创建并连接'}
            </Button>
            <Button onClick={() => void save(false)} disabled={busy !== '' || form.host === '' || form.user === ''}>
              {busy === 'save' ? '保存中…' : '仅保存'}
            </Button>
            <Button onClick={test} disabled={busy !== '' || form.host === ''}>{busy === 'test' ? '测试中…' : '测试连接'}</Button>
          </div>
        </div>
      </div>

      {editing ? (
        <>
          <div className="rs-sect">危险操作</div>
          <div className="rs-card">
            <div className="rs-card-b">
              <div className="rs-muted">
                删除后，这条主机的转发规则与选中状态一起消失；远端服务器上的文件不受影响。
              </div>
              <div>
                <Button size="sm" variant="danger" onClick={remove} disabled={busy !== ''}>
                  <Icon name="trash" size={11} />删除主机
                </Button>
              </div>
            </div>
          </div>
        </>
      ) : (
        <div style={{ marginTop: '8px' }}>
          <Button size="sm" variant="ghost" onClick={onCancelNew}>取消新建</Button>
        </div>
      )}

      <div style={{ height: '10px' }} />
    </div>
  )
}
