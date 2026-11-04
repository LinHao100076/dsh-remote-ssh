/**
 * dsh-remote-ssh client half: two independent ways into the same four panes.
 *
 * - With better-sidebar installed, each pane is one of its tabs (id
 *   `dsh-remote-ssh:<pane>`), which is the integration that plugin users expect.
 * - Without it — the peer is optional, and disabling it used to make this plugin
 *   vanish from the sidebar entirely — the plugin registers a page type with
 *   DSH's own right sidebar (`sidebarRightTabs`) and paints one workspace panel
 *   behind a header button. Nothing in that path touches better-sidebar.
 *
 * The two are mutually exclusive per activation: the native entry is registered
 * first and handed over when better-sidebar's service arrives, so a profile with
 * both never shows two competing entries.
 *
 * All transport work happens in the host half. Styling is injected once from the
 * factory (xterm's own CSS included), which is the bundling convention for client
 * modules: no separate stylesheet URL is served.
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
import { KIND, RemoteHeaderButton, RemoteWorkspace } from './native-view.js'

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

/** The native workspace panel and its header opener (see `native-view.js`). */
export const NATIVE = { KIND, RemoteWorkspace, RemoteHeaderButton }

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
 * Register one better-sidebar tab.
 *
 * `registerTab` throws on a duplicate id, and both a hot reload and a second
 * mount can run `apply` again before the previous effects are disposed. Skipping
 * an id that is already registered keeps a reload from taking the panel down.
 */
function mountTab(ctx, service, descriptor) {
  if (typeof service.getTab === 'function' && service.getTab(descriptor.id) !== undefined) return
  ctx.effect(() => service.registerTab(descriptor))
}

/** Register the four pens as better-sidebar tabs. */
function registerTabs(ctx, service) {
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

/** Run a disposer, reporting rather than propagating a teardown failure. */
function releaseQuietly(dispose) {
  try {
    dispose()
  } catch (error) {
    console.error('[dsh-remote-ssh] releasing the native entry failed:', error)
  }
}

/**
 * Register the plugin in DSH's native right sidebar: a tab type, its body, and
 * the conversation-header button that opens it.
 *
 * Every declaration rides `slots.inject` because none of them is guaranteed to
 * exist when this plugin activates — the header and the slot ledger come from
 * other entries, and the callback re-runs if one is re-declared.
 * @param {object} ctx - client context.
 * @returns {() => void} a disposer for the whole native entry.
 */
function mountNative(ctx) {
  const disposers = []
  let released = false

  const release = () => {
    if (released) return
    released = true
    for (const dispose of disposers.splice(0).reverse()) releaseQuietly(dispose)
  }

  const service = (inner, name) => (typeof inner.get === 'function' ? inner.get(name) : inner[name])

  const seat = ctx.inject(['slots', 'sidebarRightTabs', 'sidebarRight'], (inner) => {
    if (released) return
    const slots = service(inner, 'slots')
    const tabs = service(inner, 'sidebarRightTabs')
    const column = service(inner, 'sidebarRight')
    if (slots === undefined || tabs === undefined || column === undefined) return

    if (typeof tabs.get !== 'function' || tabs.get(KIND) === undefined) {
      disposers.push(tabs.register({
        id: KIND,
        kind: KIND,
        priority: 'extension',
        title: () => '远程 SSH',
        guide: [{
          id: KIND,
          order: 60,
          title: () => '远程 SSH',
          description: () => 'SSH 终端、远端文件与端口转发',
        }],
      }))
    }

    disposers.push(slots.inject('sidebar.right.pane.tab', () => slots.register({
      name: 'sidebar.right.pane.tab',
      key: KIND,
      inject: (sessionId) => ({ ctx: inner, sessionId }),
    }, RemoteWorkspace)))

    disposers.push(slots.inject('conversation.session.header.utilities', () => slots.register({
      name: 'conversation.session.header.utilities',
      id: KIND,
      order: 30,
      registrant: 'dsh-remote-ssh',
      inject: () => ({ open: () => column.openTab(KIND) }),
    }, RemoteHeaderButton)))
  })

  // Outside an effect scope `ctx.inject` still returns its disposer; return both
  // halves so a handover tears down the seat and everything it registered.
  return () => {
    if (typeof seat === 'function') releaseQuietly(seat)
    release()
  }
}

/**
 * Mount the client half.
 * @param {object} ctx - client cordis context (services are injected lazily).
 */
export function apply(ctx) {
  injectStyles('dsh-remote-ssh/xterm', xtermCss)
  injectStyles('dsh-remote-ssh/panel', CSS)

  const present = typeof ctx.get === 'function' ? ctx.get('betterSidebar') : undefined
  if (present !== undefined) {
    registerTabs(ctx, present)
    return
  }

  // No better-sidebar (yet): the native entry carries the plugin on its own.
  // Every registration rides `ctx.effect`, so a reload or an uninstall releases
  // it instead of leaving a dead tab type behind.
  let disposeNative = () => {}
  ctx.effect(() => {
    disposeNative = mountNative(ctx)
    return disposeNative
  })

  // It may still activate later — activation order is not ours to choose. Hand
  // the entry over rather than showing both.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['betterSidebar'], (inner) => {
      const service = typeof inner.get === 'function' ? inner.get('betterSidebar') : inner.betterSidebar
      if (service === undefined) return
      disposeNative()
      registerTabs(ctx, service)
    })
    return
  }

  const service = ctx.get?.('betterSidebar')
  if (service !== undefined) registerTabs(ctx, service)
}
