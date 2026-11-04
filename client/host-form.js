/**
 * Connection form: manual fields, ssh-config import, test-connect, save.
 *
 * Passwords and key passphrases typed here go into the in-memory `secretStore`
 * only — never into the state file, never to the server.
 * @module dsh-remote-ssh/client/host-form
 */
import { createElement as h, useEffect, useState } from 'react'
import { api, secretStore, connectHost } from './state.js'
import { Button, Field, Input, Select, Modal, Icon } from './ui.js'

/** Build the persisted host row from form state (no secrets). */
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

export function HostForm({ ctx, host, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: host?.name ?? '',
    host: host?.host ?? '',
    port: String(host?.port ?? 22),
    user: host?.user ?? '',
    authType: host?.auth?.type ?? 'agent',
    keyPath: host?.auth?.keyPath ?? '~/.ssh/id_ed25519',
    proxyJump: host?.proxyJump ?? '',
    password: '',
    passphrase: '',
  })
  const [configHosts, setConfigHosts] = useState([])
  const [status, setStatus] = useState(undefined)
  const [busy, setBusy] = useState('')
  const patch = (key) => (value) => setForm((current) => ({ ...current, [key]: value }))

  useEffect(() => {
    api(ctx, 'hosts.sshConfig')
      .then((value) => setConfigHosts(value.hosts ?? []))
      .catch(() => setConfigHosts([]))
  }, [ctx])

  /** Remember the secret for this session, keyed like the eventual host id. */
  const rememberSecret = (row) => {
    if (form.password !== '' || form.passphrase !== '') {
      secretStore.set(row.id ?? `draft:${row.host}:${row.user}`, {
        password: form.password,
        passphrase: form.passphrase,
      })
    }
  }

  const save = async () => {
    setBusy('save')
    setStatus(undefined)
    try {
      const row = toRow(form, host?.id)
      const value = await api(ctx, 'hosts.save', { host: row })
      rememberSecret(value.host)
      onSaved?.(value.host)
      onClose?.()
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
        auth: { password: form.password, passphrase: form.passphrase },
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

  return h(Modal, {
    title: host === undefined ? '新建 SSH 连接' : `编辑 ${host.name}`,
    onClose,
    footer: [
      h(Button, { key: 'test', onClick: test, disabled: busy !== '' }, busy === 'test' ? '测试中…' : '测试连接'),
      h('span', { key: 'gap', style: { flex: 1 } }),
      h(Button, { key: 'cancel', onClick: onClose }, '取消'),
      h(Button, { key: 'save', variant: 'primary', onClick: save, disabled: busy !== '' }, busy === 'save' ? '保存中…' : '保存'),
    ],
  },
  configHosts.length > 0
    ? h(Field, { label: `从 ~/.ssh/config 导入（${configHosts.length} 个 Host）` },
      h(Select, {
        value: '',
        onChange: importConfig,
        options: [{ value: '', label: '选择一个 Host…' }, ...configHosts.map((entry) => ({
          value: entry.alias,
          label: `${entry.alias} — ${entry.user ? `${entry.user}@` : ''}${entry.host}${entry.proxyJump ? ` (jump ${entry.proxyJump})` : ''}`,
        }))],
      }))
    : h('div', { className: 'rs-muted' }, '未找到 ~/.ssh/config，手动填写下面的字段。'),

  h(Field, { label: '名称' }, h(Input, { value: form.name, onChange: patch('name'), placeholder: 'prod-web-01' })),
  h('div', { className: 'rs-grid2' },
    h(Field, { label: '主机' }, h(Input, { value: form.host, onChange: patch('host'), placeholder: '10.0.3.21' })),
    h(Field, { label: '端口' }, h(Input, { value: form.port, onChange: patch('port') }))),
  h('div', { className: 'rs-grid2' },
    h(Field, { label: '用户' }, h(Input, { value: form.user, onChange: patch('user'), placeholder: 'ubuntu' })),
    h(Field, { label: '认证' }, h(Select, {
      value: form.authType,
      onChange: patch('authType'),
      options: [
        { value: 'agent', label: 'ssh-agent' },
        { value: 'key', label: '密钥文件' },
        { value: 'password', label: '密码' },
      ],
    }))),

  form.authType === 'key'
    ? h(Field, { label: '私钥路径' }, h(Input, { value: form.keyPath, onChange: patch('keyPath') }))
    : null,
  form.authType === 'key'
    ? h(Field, { label: '私钥 passphrase（仅本次会话，不写入磁盘）' }, h(Input, { value: form.passphrase, onChange: patch('passphrase'), type: 'password' }))
    : null,
  form.authType === 'password'
    ? h(Field, { label: '密码（仅本次会话，不写入磁盘）' }, h(Input, { value: form.password, onChange: patch('password'), type: 'password' }))
    : null,
  h(Field, { label: 'ProxyJump（可选，最多两跳）' }, h(Input, { value: form.proxyJump, onChange: patch('proxyJump'), placeholder: 'bastion.internal' })),

  status === undefined
    ? null
    : h('div', {
      className: 'rs-muted',
      style: { color: status.tone === 'ok' ? 'var(--rs-ok)' : 'var(--rs-err)', display: 'flex', gap: '5px', alignItems: 'center' },
    }, h(Icon, { name: status.tone === 'ok' ? 'check' : 'warn', size: 12 }), status.text))
}

/** Re-export for the settings tab, which reuses the same connect helper. */
export { connectHost }
