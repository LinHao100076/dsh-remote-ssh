/**
 * dsh-remote-ssh client half.
 *
 * Registers four sidebar tabs with `ctx.betterSidebar` and nothing else: all
 * transport work happens in the host half. Registration runs inside
 * `ctx.inject(['betterSidebar'], …)`, so a profile without better-sidebar loads
 * this plugin without errors and simply shows no tabs — rather than leaving the
 * whole plugin row pending on a missing service.
 *
 * Styling is injected once from the factory (xterm's own CSS included), which is
 * the bundling convention for client modules: no separate stylesheet URL is
 * served.
 * @module dsh-remote-ssh/client
 */
import { createElement as h } from 'react'
import xtermCss from '@xterm/xterm/css/xterm.css'
import { CSS } from './styles.js'
import { Icon } from './ui.js'
import { FilesPane } from './files-view.js'
import { ForwardPane } from './forward-view.js'
import { SyncPane } from './sync-view.js'
import { TerminalPane } from './terminal-view.js'

/** Tab type ids, prefixed with the package name to stay collision-free. */
export const TABS = {
  files: 'dsh-remote-ssh:files',
  terminal: 'dsh-remote-ssh:terminal',
  sync: 'dsh-remote-ssh:sync',
  forward: 'dsh-remote-ssh:forward',
}

/**
 * Panel components, exposed so the render test can mount them without a real
 * side-bar. Registering a tab is the only production use.
 */
export const PANES = {
  files: FilesPane,
  terminal: TerminalPane,
  sync: SyncPane,
  forward: ForwardPane,
}

/** Inject a stylesheet once per document. */
function injectStyles(id, css) {
  if (document.getElementById(id) !== null) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = css
  document.head.append(style)
}

/** Tab icon factory (20px box, host theme colour). */
function tabIcon(name) {
  return (size) => h(Icon, { name, size: size ?? 16 })
}

/**
 * Register one tab and return nothing.
 *
 * `registerTab` throws on a duplicate id, and both a hot reload and a second
 * mount can run `apply` again before the previous effects are disposed. Skipping
 * an id that is already registered keeps a reload from taking the panel down.
 */
function mountTab(ctx, service, descriptor) {
  if (typeof service.getTab === 'function' && service.getTab(descriptor.id) !== undefined) return
  ctx.effect(() => service.registerTab(descriptor))
}

/**
 * Mount the client half.
 * @param {object} ctx - client cordis context (services are injected lazily).
 */
export function apply(ctx) {
  injectStyles('dsh-remote-ssh/xterm', xtermCss)
  injectStyles('dsh-remote-ssh/panel', CSS)

  const register = (service) => {
    mountTab(ctx, service, {
      id: TABS.files,
      title: () => '远程',
      description: '远端文件树、上传下载、连接管理',
      icon: tabIcon('server'),
      order: 46,
      component: (props) => h(FilesPane, props),
    })

    mountTab(ctx, service, {
      id: TABS.terminal,
      title: () => '远程终端',
      description: 'SSH 终端，有 tmux 时自动接管会话',
      icon: tabIcon('terminal'),
      order: 47,
      component: (props) => h(TerminalPane, props),
    })

    mountTab(ctx, service, {
      id: TABS.sync,
      title: () => '同步',
      description: '路径映射、自动上传、冲突处理',
      icon: tabIcon('sync'),
      order: 48,
      component: (props) => h(SyncPane, props),
    })

    mountTab(ctx, service, {
      id: TABS.forward,
      title: () => '转发',
      description: '本地端口转发，把远端服务映射到本机',
      icon: tabIcon('link'),
      order: 49,
      component: (props) => h(ForwardPane, props),
    })
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['betterSidebar'], (inner) => register(inner.betterSidebar))
    return
  }
  // Older loaders without scoped injection: register if the service is already up.
  const service = ctx.get?.('betterSidebar')
  if (service !== undefined) register(service)
}
