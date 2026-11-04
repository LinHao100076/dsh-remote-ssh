/**
 * Tiny presentational kit: icons, buttons, fields, empty states, banner, modal.
 *
 * No component library dependency on purpose — the bundle must stay small and
 * every primitive must follow the host's theme tokens, which is exactly what the
 * `rs-*` stylesheet already does.
 * @module dsh-remote-ssh/client/ui
 */
import { createElement as h } from 'react'

/** Icon geometry: each entry is a list of `[tag, attrs]` children. */
const ICONS = {
  folder: [['path', { d: 'M3 7a2 2 0 0 1 2-2h3.6l1.7 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  file: [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['path', { d: 'M14 3v5h5' }]],
  chevron: [['path', { d: 'M9 6l6 6-6 6' }]],
  server: [['rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }], ['rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }], ['path', { d: 'M7 7.5h.01M7 16.5h.01' }]],
  refresh: [['path', { d: 'M21 12a9 9 0 1 1-3-6.7L21 8' }], ['path', { d: 'M21 3v5h-5' }]],
  up: [['path', { d: 'M12 19V5M6 11l6-6 6 6' }]],
  down: [['path', { d: 'M12 5v14M6 13l6 6 6-6' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  x: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  warn: [['path', { d: 'M12 3l9 16H3z' }], ['path', { d: 'M12 9v5M12 17h.01' }]],
  check: [['path', { d: 'M20 6L9 17l-5-5' }]],
  terminal: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M7 9l3 3-3 3M13 15h4' }]],
  sync: [['path', { d: 'M20 11a8 8 0 0 0-13.7-4.6L3 9' }], ['path', { d: 'M3 4v5h5' }], ['path', { d: 'M4 13a8 8 0 0 0 13.7 4.6L21 15' }], ['path', { d: 'M21 20v-5h-5' }]],
  plug: [['path', { d: 'M9 3v6M15 3v6' }], ['path', { d: 'M6 9h12v3a6 6 0 0 1-12 0z' }], ['path', { d: 'M12 18v3' }]],
  trash: [['path', { d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13' }]],
  folderPlus: [['path', { d: 'M3 7a2 2 0 0 1 2-2h3.6l1.7 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }], ['path', { d: 'M12 11v5M9.5 13.5h5' }]],
  link: [['path', { d: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5' }], ['path', { d: 'M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19' }]],
  save: [['path', { d: 'M5 3h11l3 3v15H5z' }], ['path', { d: 'M8 3v6h7V3M8 21v-6h8v6' }]],
  edit: [['path', { d: 'M4 20h4L20 8l-4-4L4 16z' }]],
  eye: [['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
}

/**
 * One line icon.
 * @param {{name: string, size?: number, className?: string}} props - icon props.
 */
export function Icon({ name, size = 14, className = '' }) {
  const children = (ICONS[name] ?? ICONS.file).map(([tag, attrs], index) => h(tag, { key: index, ...attrs }))
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    className,
    'aria-hidden': 'true',
  }, children)
}

/** Square icon-only button. */
export function IconButton({ name, title, onClick, disabled, size = 14 }) {
  return h('button', {
    type: 'button',
    className: 'rs-icon',
    title,
    onClick,
    disabled,
  }, h(Icon, { name, size }))
}

/** Text button. */
export function Button({ children, onClick, variant, size, disabled, title, type = 'button', style }) {
  const className = ['rs-btn', variant, size].filter(Boolean).join(' ')
  return h('button', { type, className, onClick, disabled, title, style }, children)
}

/** Labelled form row. */
export function Field({ label, children }) {
  return h('div', { className: 'rs-field' }, h('label', null, label), children)
}

/** Text input bound to a value/setter pair. */
export function Input({ value, onChange, placeholder, type = 'text', disabled }) {
  return h('input', {
    className: 'rs-input',
    value: value ?? '',
    type,
    placeholder,
    disabled,
    onChange: (event) => onChange(event.target.value),
  })
}

/** Select bound to a value/setter pair. */
export function Select({ value, onChange, options, disabled }) {
  return h('select', {
    className: 'rs-select',
    value,
    disabled,
    onChange: (event) => onChange(event.target.value),
  }, options.map((option) => h('option', { key: option.value, value: option.value }, option.label)))
}

/** Centered empty state with an optional action. */
export function Empty({ title, hint, action }) {
  return h('div', { className: 'rs-empty' },
    h('h3', null, title),
    hint ? h('p', null, hint) : null,
    action ?? null)
}

/** Inline warning/error strip. */
export function Banner({ children, tone }) {
  const className = tone === 'error' ? 'rs-notice' : 'rs-banner'
  return h('div', { className }, h(Icon, { name: 'warn', size: 12 }), h('span', null, children))
}

/** Modal dialog (rendered inside the panel, so it stays scoped to the tab). */
export function Modal({ title, children, footer, onClose }) {
  return h('div', {
    className: 'rs-modal-bg',
    onClick: (event) => { if (event.target === event.currentTarget) onClose?.() },
  }, h('div', { className: 'rs-modal' },
    h('div', { className: 'rs-modal-h' },
      h('span', { style: { flex: 1 } }, title),
      h(IconButton, { name: 'x', title: '关闭', onClick: onClose })),
    h('div', { className: 'rs-modal-b' }, children),
    footer ? h('div', { className: 'rs-modal-f' }, footer) : null))
}

/** Status dot with an accessible label. */
export function Dot({ status }) {
  const cls = status === 'connected' ? 'rs-dot on'
    : status === 'connecting' ? 'rs-dot warn'
      : status === 'error' ? 'rs-dot err'
        : 'rs-dot'
  return h('span', { className: cls, title: status })
}
