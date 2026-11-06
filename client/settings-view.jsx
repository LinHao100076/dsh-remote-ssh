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

/** Every hop may have at most this many, same limit the host half enforces. */
const MAX_HOPS = 5

/**
 * Default credential method for a new jump hop.
 *
 * Keys and agents can be inherited from the target hop safely — they are the
 * same identity either way. A password cannot: typing the target's password
 * into a bastion is how you burn `MaxAuthTries` on the wrong machine, so a
 * password host starts its bastion on `agent` and the person has to choose.
 */
function jumpAuthDefault(host) {
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
  jumpHops: [],
}

/**
 * Split `[user@]host[:port]` out of a `ProxyJump` value.
 *
 * The client keeps its own copy of this tiny grammar instead of importing
 * `src/ssh/config.js`: that module reads `~/.ssh/config` through `node:fs`, and
 * a client bundle must never pull node builtins in.
 */
function splitJump(spec) {
  const text = String(spec ?? '').trim()
  if (text === '') return { host: '', port: '22', user: '' }
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

/** `ProxyJump a,b` → two hops, in traffic order. */
function splitChain(spec) {
  return String(spec ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => splitJump(part))
}

/** One stored hop → one editable hop (secrets are never stored, so they start empty). */
function hopFromRow(row, host) {
  return {
    host: row?.host ?? '',
    port: String(row?.port ?? 22),
    user: row?.user ?? '',
    authType: row?.auth?.type ?? jumpAuthDefault(host),
    keyPath: row?.auth?.keyPath ?? host?.auth?.keyPath ?? BLANK.keyPath,
    password: '',
    passphrase: '',
  }
}

/** A new hop: the target's user is a decent guess, the rest is blank. */
function blankHop(form) {
  return {
    host: '',
    port: '22',
    user: '',
    authType: jumpAuthDefault({ auth: { type: form.authType } }),
    keyPath: form.keyPath || BLANK.keyPath,
    password: '',
    passphrase: '',
  }
}

/** Stored row → form state. Handles the 0.6.1 single-hop shape and `ProxyJump`. */
function fromHost(host) {
  const stored = Array.isArray(host?.jump?.hops)
    ? host.jump.hops
    : (typeof host?.jump?.host === 'string' && host.jump.host !== ''
      ? [host.jump]
      : splitChain(host?.proxyJump))
  return {
    name: host?.name ?? '',
    host: host?.host ?? '',
    port: String(host?.port ?? 22),
    user: host?.user ?? '',
    authType: host?.auth?.type ?? 'agent',
    keyPath: host?.auth?.keyPath ?? '~/.ssh/id_ed25519',
    password: '',
    passphrase: '',
    jumpHops: stored.map((row) => hopFromRow(row, host)),
  }
}

/** `a:22 → b:2222`, the one line that answers "what does this host go through". */
function chainSummary(hops) {
  return hops
    .map((hop) => `${hop.host.trim() || '未填'}:${hop.port.trim() || '22'}`)
    .join(' → ')
}

/** Form state → persisted row (no secrets, no `proxyJump`: hops say it explicitly). */
function toRow(form, id) {
  const hops = form.jumpHops
    .filter((hop) => hop.host.trim() !== '')
    .map((hop) => ({
      host: hop.host.trim(),
      port: Number(hop.port) || 22,
      user: hop.user.trim() === '' ? undefined : hop.user.trim(),
      auth: {
        type: hop.authType,
        keyPath: hop.authType === 'key' ? hop.keyPath.trim() : undefined,
      },
    }))
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
    jump: hops.length === 0 ? undefined : { hops },
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

  const patchHop = (index, key) => (value) => setForm((current) => ({
    ...current,
    jumpHops: current.jumpHops.map((hop, at) => (at === index ? { ...hop, [key]: value } : hop)),
  }))

  const addHop = () => setForm((current) => (
    current.jumpHops.length >= MAX_HOPS
      ? current
      : { ...current, jumpHops: [...current.jumpHops, blankHop(current)] }
  ))

  const removeHop = (index) => setForm((current) => ({
    ...current,
    jumpHops: current.jumpHops.filter((_, at) => at !== index),
  }))

  /**
   * Move a hop up or down. Order is traffic order, so this is not cosmetic:
   * `a → b` and `b → a` are different networks, and only the second one might
   * have a route to the target.
   */
  const moveHop = (index, delta) => setForm((current) => {
    const to = index + delta
    if (to < 0 || to >= current.jumpHops.length) return current
    const jumpHops = [...current.jumpHops]
    const [moved] = jumpHops.splice(index, 1)
    jumpHops.splice(to, 0, moved)
    return { ...current, jumpHops }
  })

  const secret = () => {
    const value = {}
    if (form.password !== '') value.password = form.password
    if (form.passphrase !== '') value.passphrase = form.passphrase
    // One entry per hop, index-aligned; a blank stays blank so the host half
    // knows to ask instead of treating it as an empty password.
    const passwords = form.jumpHops.map((hop) => hop.password)
    const passphrases = form.jumpHops.map((hop) => hop.passphrase)
    if (passwords.some((item) => item !== '')) value.jumpPasswords = passwords
    if (passphrases.some((item) => item !== '')) value.jumpPassphrases = passphrases
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
        auth: secret(),
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
    // `ProxyJump a,b` arrives as a string; expand it here so the person sees and
    // can edit the two hops instead of a value they cannot reorder or re-credential.
    const hops = splitChain(found.proxyJump)
    setForm((current) => ({
      ...current,
      name: current.name === '' ? alias : current.name,
      host: found.host ?? alias,
      port: String(found.port ?? 22),
      user: found.user ?? current.user,
      keyPath: found.identityFile ?? current.keyPath,
      authType: found.identityFile ? 'key' : current.authType,
      jumpHops: hops.map((hop) => ({
        host: hop.host,
        port: hop.port,
        user: hop.user,
        authType: jumpAuthDefault({ auth: { type: found.identityFile ? 'key' : current.authType } }),
        keyPath: found.identityFile ?? current.keyPath,
        password: '',
        passphrase: '',
      })),
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

          <div className="rs-sect" style={{ marginTop: '10px' }}>跳板链路（可选）</div>

          {form.jumpHops.length === 0 ? (
            <div className="rs-card">
              <div className="rs-card-b">
                <div className="rs-muted">直连。要经过堡垒机时按流量顺序添加，最多 {MAX_HOPS} 跳。</div>
                <div>
                  <Button size="sm" onClick={addHop}>
                    <Icon name="plus" size={11} />添加跳板
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <div className="rs-card">
              <div className="rs-card-b">
                <div className="rs-muted" style={{ display: 'flex', justifyContent: 'space-between', gap: '6px' }}>
                  <span>{`${form.jumpHops.length} 跳`}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {chainSummary(form.jumpHops)}
                  </span>
                </div>

                {form.jumpHops.map((hop, index) => (
                  <div key={index} className="rs-card" style={{ marginTop: '2px' }}>
                    <div className="rs-card-b">
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px' }}>
                        <span className="rs-muted">{`第 ${index + 1} 跳${index === 0 ? '（最先连）' : ''}`}</span>
                        <span style={{ display: 'flex', gap: '2px' }}>
                          <Button size="sm" variant="ghost" onClick={() => moveHop(index, -1)} disabled={index === 0} title="上移">
                            <Icon name="up" size={11} />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => moveHop(index, 1)} disabled={index === form.jumpHops.length - 1} title="下移">
                            <Icon name="down" size={11} />
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => removeHop(index)} title="删除这一跳">
                            <Icon name="x" size={11} />
                          </Button>
                        </span>
                      </div>

                      <div className="rs-grid2">
                        <Field label="跳板主机">
                          <Input value={hop.host} onChange={patchHop(index, 'host')} placeholder="bastion.internal" />
                        </Field>
                        <Field label="端口">
                          <Input value={hop.port} onChange={patchHop(index, 'port')} />
                        </Field>
                      </div>
                      <div className="rs-grid2 wide">
                        <Field label="用户">
                          <Input value={hop.user} onChange={patchHop(index, 'user')} placeholder={form.user || 'ubuntu'} />
                        </Field>
                        <Field label="认证">
                          <Select value={hop.authType} onChange={patchHop(index, 'authType')} options={AUTH} />
                        </Field>
                      </div>

                      {hop.authType === 'key' ? (
                        <>
                          <Field label="私钥路径">
                            <Input value={hop.keyPath} onChange={patchHop(index, 'keyPath')} />
                          </Field>
                          <Field label="私钥 passphrase（仅本次会话，不写入磁盘）">
                            <Input type="password" value={hop.passphrase} onChange={patchHop(index, 'passphrase')} />
                          </Field>
                        </>
                      ) : null}

                      {hop.authType === 'password' ? (
                        <Field label="这一跳的密码（仅本次会话，不写入磁盘）">
                          <Input
                            type="password"
                            value={hop.password}
                            onChange={patchHop(index, 'password')}
                            placeholder="留空则连接时提问"
                          />
                        </Field>
                      ) : null}

                      {hop.authType === 'keyboard' ? (
                        <div className="rs-muted">连接时按这一跳服务器的提问输入，不需要提前填。</div>
                      ) : null}
                    </div>
                  </div>
                ))}

                <div className="rs-muted" style={{ marginTop: '2px' }}>
                  目标机的密码不会被拿去试跳板；每一跳各有自己的账号与凭据。
                </div>
                <div>
                  <Button size="sm" onClick={addHop} disabled={form.jumpHops.length >= MAX_HOPS}>
                    <Icon name="plus" size={11} />{form.jumpHops.length >= MAX_HOPS ? `最多 ${MAX_HOPS} 跳` : '再加一跳'}
                  </Button>
                </div>
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
