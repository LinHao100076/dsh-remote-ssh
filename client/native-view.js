/**
 * The plugin's own entry in DSH's *native* right sidebar.
 *
 * better-sidebar is an optional peer: when it is installed, the four panels are
 * its tabs. When it is disabled or absent, the plugin still has to be reachable —
 * so it registers a page type with `sidebarRightTabs` and paints one workspace
 * panel holding the same four panes behind a local tab strip. Nothing here talks
 * to better-sidebar: the two entry points are independent, and this one ships
 * with DSH itself.
 *
 * Panes are mounted lazily and then kept alive with `hidden` rather than
 * unmounted — a terminal must not lose its socket (or its tmux attachment)
 * because the user looked at the file tree for a moment.
 * @module dsh-remote-ssh/client/native-view
 */
import { createElement as h, useCallback, useState } from 'react'
import { Icon } from './ui.js'
import { FilesPane } from './files-view.js'
import { ForwardPane } from './forward-view.js'
import { SyncPane } from './sync-view.js'
import { TerminalPane } from './terminal-view.js'

/** Tab id: one implementation id, one kind, one panel. */
export const KIND = 'dsh-remote-ssh'

/**
 * The four panes in strip order. `label` is the strip's text and `id` is the
 * local view key, not a better-sidebar tab id.
 */
export const VIEWS = [
  { id: 'files', label: '文件', icon: 'server', Pane: FilesPane },
  { id: 'terminal', label: '终端', icon: 'terminal', Pane: TerminalPane },
  { id: 'sync', label: '同步', icon: 'sync', Pane: SyncPane },
  { id: 'forward', label: '转发', icon: 'link', Pane: ForwardPane },
]

/**
 * Stand-in for the slot-provided hook so the component body can call one
 * unconditionally (a conditional `use…` call breaks React's hook order). The
 * same function identity every render keeps it a no-op rather than a new hook.
 */
const useNoTabInfo = () => undefined

/**
 * The workspace panel: a strip over the four panes, one of them visible.
 * @param {object} props - slot props: `ctx` and `sessionId` from our inject, plus
 *   the framework's `useTabInfo` when the seat provides it.
 */
export function RemoteWorkspace(props) {
  const { ctx, sessionId } = props
  const [active, setActive] = useState(VIEWS[0].id)
  const [visited, setVisited] = useState({ [VIEWS[0].id]: true })

  const useTabInfo = props.useTabInfo ?? useNoTabInfo
  const info = useTabInfo()
  const visible = info?.tab?.visible ?? true
  const hostId = info?.tab?.navigation?.params?.hostId

  const select = useCallback((id) => {
    setActive(id)
    setVisited((current) => (current[id] === true ? current : { ...current, [id]: true }))
  }, [])

  return h('div', { className: 'rs-root rs-workspace' },
    h('div', { className: 'rs-wtabs', role: 'tablist' },
      VIEWS.map((view) => h('button', {
        key: view.id,
        type: 'button',
        role: 'tab',
        'aria-selected': active === view.id,
        className: active === view.id ? 'rs-wtab on' : 'rs-wtab',
        title: view.label,
        onClick: () => select(view.id),
      },
      h(Icon, { name: view.icon, size: 12 }),
      h('span', null, view.label)))),
    h('div', { className: 'rs-wbody' },
      VIEWS.map((view) => (visited[view.id] !== true ? null : h('div', {
        key: view.id,
        className: 'rs-wpane',
        hidden: active !== view.id,
      }, h(view.Pane, {
        ctx,
        scope: { sessionId },
        tab: { meta: hostId === undefined ? {} : { hostId } },
        visible: visible && active === view.id,
        expanded: true,
        revealed: active === view.id,
      }))))))
}

/**
 * The header control that opens the panel: the entry point a profile without
 * better-sidebar would otherwise lack. Rendered by the conversation header slot.
 * @param {{open: () => void}} props - injected opener.
 */
export function RemoteHeaderButton({ open }) {
  return h('button', {
    type: 'button',
    className: 'rs-icon',
    title: '远程 SSH',
    'aria-label': '远程 SSH',
    onClick: () => open?.(),
  }, h(Icon, { name: 'server', size: 15 }))
}
