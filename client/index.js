/**
 * dsh-remote-ssh client half: one tab, one panel, five panes.
 *
 * Two entry points, one experience:
 *
 * - better-sidebar installed → a single tab titled "远程 SSH" (issue #1 asked
 *   for exactly that: the four separate tabs made the sidebar feel like four
 *   plugins). `Workspace` renders inside it.
 * - better-sidebar absent or disabled → the same `Workspace` in DSH's own right
 *   sidebar, opened from a conversation-header button. Nothing in this path
 *   touches better-sidebar.
 *
 * The two are mutually exclusive per activation: the native entry is registered
 * first and handed over when better-sidebar's service arrives later, so a
 * profile with both never shows two competing entries.
 *
 * Styling is injected once from the factory (xterm's own CSS included), which is
 * the bundling convention for client modules: no separate stylesheet URL is
 * served.
 * @module dsh-remote-ssh/client
 */
import { createElement as h } from 'react'
import xtermCss from '@xterm/xterm/css/xterm.css'
import { CSS } from './styles.js'
import { Icon } from './ui.jsx'
import { KIND, RemoteHeaderButton, Workspace } from './workspace.jsx'
import { ConnectView } from './connect-view.jsx'
import { FilesPane } from './files-view.jsx'
import { ForwardPane } from './forward-view.jsx'
import { SettingsPane } from './settings-view.jsx'
import { SyncPane } from './sync-view.jsx'
import { TerminalPane } from './terminal-view.jsx'

/** The one better-sidebar tab. */
export const TABS = { remote: KIND }

/**
 * Panes, exposed so the render test can mount them without a side-bar.
 * `connect` is the gate the workspace shows before there is a tunnel.
 */
export const PANES = {
  files: FilesPane,
  terminal: TerminalPane,
  sync: SyncPane,
  forward: ForwardPane,
  settings: SettingsPane,
  connect: ConnectView,
}

/** The native workspace panel and its header opener (see `workspace.jsx`). */
export const NATIVE = { KIND, RemoteWorkspace: Workspace, RemoteHeaderButton }

/** Inject a stylesheet once per document. */
function injectStyles(id, css) {
  if (document.getElementById(id) !== null) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = css
  document.head.append(style)
}

/** Tab icon factory (host theme colour, size adapts to the strip). */
function tabIcon(name) {
  return (size) => h(Icon, { name, size: size ?? 16 })
}

/**
 * Register the single better-sidebar tab.
 *
 * `registerTab` throws on a duplicate id, and both a hot reload and a second
 * mount can run `apply` again before the previous effects are disposed. Skipping
 * an id that is already registered keeps a reload from taking the panel down.
 */
function mountTab(ctx, service) {
  if (typeof service.getTab === 'function' && service.getTab(KIND) !== undefined) return
  ctx.effect(() => service.registerTab({
    id: KIND,
    title: () => '远程 SSH',
    description: '远端文件、终端、同步与端口转发',
    icon: tabIcon('server'),
    order: 46,
    component: (props) => h(Workspace, props),
  }))
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
    }, Workspace)))

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
    mountTab(ctx, present)
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
      mountTab(ctx, service)
    })
    return
  }

  const service = ctx.get?.('betterSidebar')
  if (service !== undefined) mountTab(ctx, service)
}
