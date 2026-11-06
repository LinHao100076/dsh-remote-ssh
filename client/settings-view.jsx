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
  { value: 'keyboard', label: '键盘交互 / 2FA' },
]

/**
 * Default credential method for a jump hop.
 *
 * Keys and agents can be inherited from the target hop safely — they are the
 * same identity either way. A password cannot: typing the target's password
 * into a bastion is how you burn `MaxAuthTries` on the wrong machine, so a
 * password host starts with `agent` and the person has to choose.
 */
function jumpAuthDefault(host) {
  if (host?.jump?.auth !== undefined) return host.jump.auth.type
  if (host?.auth?.type === 'password' || host?.auth?.type === 'keyboard') return 'agent'
  return host?.auth?.type ?? 'agent'
}

const BLANK = {
  name: '',
  host: '',
  port: '22',
  user: '',
  authType: 'agent',
  keyPath: '~/.ssh/id_ed25519',
  password: '',
  passphrase: '',
  jumpHost: '',
  jumpPort: '22',
  jumpUser: '',
  jumpAuthType: 'agent',
  jumpKeyPath: '~/.ssh/id_ed25519',
  jumpPassword: '',
  jumpPassphrase: '',
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
    password: '',
    passphrase: '',
    jumpHost: host?.jump?.host ?? host?.proxyJump ?? '',
    jumpPort: String(host?.jump?.port ?? 22),
    jumpUser: host?.jump?.user ?? '',
    jumpAuthType: jumpAuthDefault(host),
    jumpKeyPath: host?.jump?.auth?.keyPath ?? host?.auth?.keyPath ?? '~/.ssh/id_ed25519',
    jumpPassword: '',
    jumpPassphrase: '',
  }
}

/**
 * Split `[user@]host[:port]` out of a `ProxyJump` value.
 *
 * The client keeps its own copy of this tiny grammar instead of importing
 * `src/ssh/config.js`: that module reads `~/.ssh/config` through `node:fs`, and
 * a client bundle must never pull node builtins in. A comma-separated value is
 * returned as one opaque hop on purpose — the host half is where the "multi-hop
 * is not supported yet" message belongs, and it has the wording.
 */
function splitJump(spec) {
  const text = String(spec ?? '').trim()
  if (text === '' || text.includes(',')) return { host: text, port: '22', user: '' }
  const at = text.lastIndexOf('@')
  const user = at >= 0 ? text.slice(0, at) : ''
  let rest = at >= 0 ? text.slice(at + 1) : text
  let port = '22'
  const colon = rest.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(rest.slice(colon + 1))) {
    port = rest.slice(colon + 1)
    rest = rest.slice(0, colon)
  }
  return { host: rest, port, user }
}

/** Form state → persisted row (no secrets). */
function toRow(form, id) {
  const jumpHost = form.jumpHost.trim()
  // A comma keeps the legacy `proxyJump` field: the pool parses it and refuses
  // with "只支持一跳" instead of silently dialling a hostname with a comma in it.
  const chained = jumpHost.includes(',')
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
    proxyJump: chained ? jumpHost : undefined,
    jump: jumpHost === '' || chained
      ? undefined
      : {
        host: jumpHost,
        port: Number(form.jumpPort) || 22,
        user: form.jumpUser.trim() === '' ? undefined : form.jumpUser.trim(),
        auth: {
          type: form.jumpAuthType,
          keyPath: form.jumpAuthType === 'key' ? form.jumpKeyPath.trim() : undefined,
        },
      },
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
    if (form.jumpPassword !== '') value.jumpPassword = form.jumpPassword
    if (form.jumpPassphrase !== '') value.jumpPassphrase = form.jumpPassphrase
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
        if (value.host.auth.type === 'password' && (typed.password ?? '') === '') {
          // Nothing to connect with yet; the connect gate asks for it on screen.
          await onSaved(value.host, typed)
          return
        }
        const passwordOk = await onConnect(value.host, typed)
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
          jumpPassword: form.jumpPassword === '' ? undefined : form.jumpPassword,
          jumpPassphrase: form.jumpPassphrase === '' ? undefined : form.jumpPassphrase,
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
    const jump = splitJump(found.proxyJump)
    setForm((current) => ({
      ...current,
      name: current.name === '' ? alias : current.name,
      host: found.host ?? alias,
      port: String(found.port ?? 22),
      user: found.user ?? current.user,
      keyPath: found.identityFile ?? current.keyPath,
      jumpHost: jump.host,
      jumpPort: jump.port,
      jumpUser: jump.user,
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
                placeholder="输入密码"
                onKeyDown={(event) => { if (event.key === 'Enter') void save(true) }}
              />
            </Field>
          ) : null}

          {form.authType === 'keyboard' ? (
            <div className="rs-muted" style={{ marginTop: '-2px' }}>
              连接时按服务器的提问逐条输入（密码、验证码都可以）。留空即可 —— 有密码就顺手填上，能省一次提问。
            </div>
          ) : null}

          <Field label="跳板主机（可选）">
            <Input value={form.jumpHost} onChange={patch('jumpHost')} placeholder="留空即直连，例如 bastion.internal" />
          </Field>

          {form.jumpHost.trim() === '' ? null : (
            <div className="rs-card" style={{ marginTop: '2px' }}>
              <div className="rs-card-b">
                <div className="rs-muted" style={{ marginBottom: '2px' }}>
                  跳板这一跳有自己的账号与凭据。目标机的密码不会被拿去试跳板。
                </div>
                <div className="rs-grid2">
                  <Field label="跳板端口">
                    <Input value={form.jumpPort} onChange={patch('jumpPort')} />
                  </Field>
                  <Field label="跳板用户">
                    <Input value={form.jumpUser} onChange={patch('jumpUser')} placeholder={form.user || 'ubuntu'} />
                  </Field>
                </div>
                <Field label="跳板认证">
                  <Select value={form.jumpAuthType} onChange={patch('jumpAuthType')} options={AUTH} />
                </Field>
                {form.jumpAuthType === 'key' ? (
                  <Field label="跳板私钥">
                    <Input value={form.jumpKeyPath} onChange={patch('jumpKeyPath')} />
                  </Field>
                ) : null}
                {form.jumpAuthType === 'password' ? (
                  <Field label="跳板密码（仅本次会话，不写入磁盘）">
                    <Input type="password" value={form.jumpPassword} onChange={patch('jumpPassword')} placeholder="留空则连接时提问" />
                  </Field>
                ) : null}
                {form.jumpAuthType === 'keyboard' ? (
                  <div className="rs-muted">跳板连接时按服务器提问输入，不需要提前填。</div>
                ) : null}
              </div>
            </div>
          )}

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
