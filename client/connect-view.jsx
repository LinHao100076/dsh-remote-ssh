/**
 * The connect gate: what the panel shows before there is a live tunnel.
 *
 * Three states share one column, because they are the same question asked at
 * three moments — "which host, and how do I get in?":
 *
 * - no host at all  → the empty state with the new-connection button;
 * - connecting      → the step list, so a slow handshake does not look frozen;
 * - disconnected / failed → the host list plus the reason it failed.
 *
 * Password and key-passphrase hosts get their field *here* (issue #2: "没有地方
 * 可以输入密码了"). The secret is typed into a controlled input, handed to the
 * host half for the single attempt, and kept only in the client's memory map.
 * @module dsh-remote-ssh/client/connect-view
 */
import { createElement as h, useEffect, useState } from 'react'
import { api } from './state.js'
import { Button, Dot, Field, Icon, Input } from './ui.jsx'

/** Wire error codes → the sentence a person would say. */
const ERROR_TITLE = {
  'auth-failed': '认证失败',
  'bad-password': '需要密码',
  'key-invalid': '私钥不可用',
  'key-unreadable': '私钥无法读取',
  'no-agent': '未找到 ssh-agent',
  timeout: '连接超时',
  refused: '连接被拒绝',
  'dns-failed': '主机名无法解析',
  'host-key-changed': '主机指纹已变更',
}

/** Human label for an auth type. */
function authLabel(host) {
  if (host?.auth?.type === 'password') return '密码'
  if (host?.auth?.type === 'key') return `密钥 ${host.auth.keyPath ?? ''}`.trim()
  return 'ssh-agent'
}

/** One row in the host list. */
function HostRow({ item, status, current, onSelect }) {
  const tone = status?.status ?? 'disconnected'
  return (
    <button
      type="button"
      className="rs-hitem"
      aria-current={current}
      onClick={() => onSelect(item.id)}
    >
      <Icon name="server" size={14} className="rs-hico" />
      <span className="rs-htxt">
        <span className="rs-nm"><Dot status={tone} />{item.name}</span>
        <span className="rs-ad">{item.user}@{item.host}:{item.port}{item.proxyJump ? ` · jump ${item.proxyJump}` : ''}</span>
      </span>
      <span className="rs-r">
        {tone === 'connected' ? <span className="rs-badge ok">已连接</span> : null}
        <Icon name="chevron" size={12} />
      </span>
    </button>
  )
}

/**
 * @param {object} props - see the module comment.
 */
export function ConnectView({
  ctx, hosts, statuses, host, status, error, errorCode, onConnect, onSelect, onNew, onUsePassword, onCancel,
}) {
  const [password, setPassword] = useState('')
  const [configCount, setConfigCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    void api(ctx, 'hosts.sshConfig')
      .then((value) => { if (!cancelled) setConfigCount(value.hosts?.length ?? 0) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [ctx])

  useEffect(() => { setPassword('') }, [host?.id])

  const errorTitle = error === undefined || error === '' ? undefined : (ERROR_TITLE[errorCode] ?? '连接失败')
  const passwordHost = host?.auth?.type === 'password'
  const canSwitch = host !== undefined && !passwordHost && (errorCode === 'auth-failed' || errorCode === 'key-invalid')

  /* ── nothing configured yet ─────────────────────────────────────────── */

  if (hosts.length === 0) {
    return (
      <div className="rs-center">
        <div className="rs-big-ico"><Icon name="server" size={20} /></div>
        <h2>连接远程服务器</h2>
        <p>从 ~/.ssh/config 里挑一个 Host，或手动填写地址与认证方式。</p>
        <Button variant="primary" onClick={onNew}><Icon name="plus" size={13} />新建 SSH 连接</Button>
        <div className="rs-hintline">
          <Icon name="link" size={11} />
          {configCount > 0 ? `已从 ssh config 读取 ${configCount} 个 Host` : '未找到 ~/.ssh/config，可手动填写'}
        </div>
      </div>
    )
  }

  /* ── handshake in flight ────────────────────────────────────────────── */

  if (status === 'connecting') {
    return (
      <div className="rs-center">
        <div className="rs-big-ico"><Icon name="server" size={20} /></div>
        <h2>正在连接 {host?.name}</h2>
        <p>使用{authLabel(host)}认证，首次连接会记录主机指纹。</p>
        <div className="rs-steps">
          <div className="rs-step done">
            <span className="rs-mark"><Icon name="check" size={9} /></span>解析主机地址
          </div>
          <div className="rs-step now"><span className="rs-mark" />建立 SSH 通道 · {host?.user}@{host?.host}:{host?.port}</div>
          <div className="rs-step"><span className="rs-mark" />探测远端环境（uname / tmux）</div>
        </div>
        <Button size="sm" variant="ghost" onClick={onCancel}>取消</Button>
      </div>
    )
  }

  /* ── idle or failed ─────────────────────────────────────────────────── */

  const submit = () => {
    if (password === '') return
    onConnect(password)
  }

  return (
    <div className="rs-center">
      <div className={`rs-big-ico${error ? ' err' : ''}`}>
        <Icon name={error ? 'warn' : 'server'} size={20} />
      </div>
      <h2>{error ? errorTitle : host ? `连接 ${host.name}` : '选择远程主机'}</h2>
      <p>
        {error
          ? '检查地址、网络与认证方式；密码认证的主机可以直接在下面输入密码。'
          : host
            ? `${host.user}@${host.host}:${host.port} · ${authLabel(host)}`
            : '选择最近连接的主机，或新建一个。'}
      </p>

      {error ? (
        <div className="rs-err-box">
          <div className="rs-t"><Icon name="warn" size={12} />{errorTitle}</div>
          <code>{error}</code>
        </div>
      ) : null}

      <div className="rs-hostlist">
        {hosts.map((item) => (
          <HostRow
            key={item.id}
            item={item}
            status={statuses[item.id]}
            current={item.id === host?.id}
            onSelect={onSelect}
          />
        ))}
      </div>

      {host !== undefined ? (
        passwordHost ? (
          <div className="rs-cred">
            <Field label="密码（仅本次会话，不写入磁盘）">
              <Input
                type="password"
                value={password}
                onChange={setPassword}
                autoFocus
                placeholder="••••••••"
                onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
              />
            </Field>
            <div className="rs-rowacts">
              <Button variant="primary" onClick={submit} disabled={password === ''}>
                <Icon name="plug" size={13} />连接
              </Button>
              <Button onClick={onNew}><Icon name="plus" size={13} />新建</Button>
            </div>
          </div>
        ) : (
          <div className="rs-rowacts">
            <Button variant="primary" onClick={() => onConnect()}><Icon name="plug" size={13} />连接</Button>
            {canSwitch ? <Button onClick={onUsePassword}><Icon name="lock" size={13} />改用密码</Button> : null}
            <Button variant="ghost" onClick={onNew}><Icon name="plus" size={13} />新建</Button>
          </div>
        )
      ) : (
        <Button variant="primary" onClick={onNew}><Icon name="plus" size={13} />新建 SSH 连接</Button>
      )}

      <div className="rs-hintline">
        <Icon name="link" size={11} />
        {configCount > 0 ? `已从 ssh config 读取 ${configCount} 个 Host` : '也可以从 ~/.ssh/config 导入'}
      </div>
    </div>
  )
}
