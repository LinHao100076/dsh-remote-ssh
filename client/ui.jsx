/**
 * Tiny presentational kit: line icons, buttons, fields, segmented control.
 *
 * No component library on purpose — the bundle must stay small and every
 * primitive has to follow the host's theme tokens, which the `rs-*` stylesheet
 * already does. Geometry is copied from `ui/prototype.html` so the panel and the
 * mock read as the same product.
 * @module dsh-remote-ssh/client/ui
 */
import { createElement as h } from 'react'

/** Icon geometry: each entry is a list of `[tag, attrs]` children. */
const ICONS = {
  server: [['rect', { x: 3, y: 4, width: 18, height: 7, rx: 2 }], ['rect', { x: 3, y: 13, width: 18, height: 7, rx: 2 }], ['path', { d: 'M7 7.5h.01M7 16.5h.01' }]],
  folder: [['path', { d: 'M3 7a2 2 0 0 1 2-2h3.6l1.7 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
  file: [['path', { d: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z' }], ['path', { d: 'M14 3v5h5' }]],
  chevron: [['path', { d: 'M9 6l6 6-6 6' }]],
  chevronDown: [['path', { d: 'M6 9l6 6 6-6' }]],
  terminal: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ['path', { d: 'M7 9l3 3-3 3M13 15h4' }]],
  sync: [['path', { d: 'M20 11a8 8 0 0 0-13.7-4.6L3 9' }], ['path', { d: 'M3 4v5h5' }], ['path', { d: 'M4 13a8 8 0 0 0 13.7 4.6L21 15' }], ['path', { d: 'M21 20v-5h-5' }]],
  cog: [['circle', { cx: 12, cy: 12, r: 3 }], ['path', { d: 'M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10 3.05V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z' }]],
  refresh: [['path', { d: 'M21 12a9 9 0 1 1-3-6.7L21 8' }], ['path', { d: 'M21 3v5h-5' }]],
  up: [['path', { d: 'M12 19V5M6 11l6-6 6 6' }]],
  levelUp: [['path', { d: 'M9 14L4 9l5-5' }], ['path', { d: 'M4 9h9a6 6 0 0 1 0 12h-2' }]],
  down: [['path', { d: 'M12 5v14M6 13l6 6 6-6' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  x: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
  warn: [['path', { d: 'M12 3l9 16H3z' }], ['path', { d: 'M12 9v5M12 17h.01' }]],
  check: [['path', { d: 'M20 6L9 17l-5-5' }]],
  lock: [['rect', { x: 4, y: 10, width: 16, height: 10, rx: 2 }], ['path', { d: 'M8 10V7a4 4 0 0 1 8 0v3' }]],
  power: [['path', { d: 'M12 3v9' }], ['path', { d: 'M7.5 6.5a7 7 0 1 0 9 0' }]],
  ext: [['path', { d: 'M14 4h6v6M20 4l-8 8' }], ['path', { d: 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5' }]],
  link: [['path', { d: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5' }], ['path', { d: 'M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19' }]],
  search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'M20 20l-4-4' }]],
  trash: [['path', { d: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13' }]],
  folderPlus: [['path', { d: 'M3 7a2 2 0 0 1 2-2h3.6l1.7 2H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }], ['path', { d: 'M12 11v5M9.5 13.5h5' }]],
  edit: [['path', { d: 'M4 20h4L20 8l-4-4L4 16z' }]],
  eye: [['path', { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' }], ['circle', { cx: 12, cy: 12, r: 3 }]],
  plug: [['path', { d: 'M9 3v6M15 3v6' }], ['path', { d: 'M6 9h12v3a6 6 0 0 1-12 0z' }], ['path', { d: 'M12 18v3' }]],
}

/**
 * One line icon.
 * @param {{name: string, size?: number, className?: string}} props - icon props.
 */
export function Icon({ name, size = 14, className = '' }) {
  const children = ICONS[name] ?? ICONS.file
  return h('svg', {
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    className: `ic ${className}`.trim(),
    'aria-hidden': 'true',
  }, children.map(([tag, attrs], index) => h(tag, { key: index, ...attrs })))
}

/** Square icon-only button. */
export function IconButton({ name, title, onClick, disabled, size = 14 }) {
  return h('button', {
    type: 'button',
    className: 'rs-icon',
    title,
    'aria-label': title,
    onClick,
    disabled,
  }, h(Icon, { name, size }))
}

/** Text button. */
export function Button({ children, onClick, variant, size, disabled, title, type = 'button', className = '' }) {
  return h('button', {
    type,
    className: ['rs-btn', variant, size, className].filter(Boolean).join(' '),
    onClick,
    disabled,
    title,
  }, children)
}

/** Labelled form row. */
export function Field({ label, children }) {
  return h('div', { className: 'rs-field' }, h('label', null, label), children)
}

/** Text input bound to a value/setter pair. */
export function Input({ value, onChange, placeholder, type = 'text', disabled, autoFocus, onKeyDown }) {
  return h('input', {
    className: 'rs-input',
    value: value ?? '',
    type,
    placeholder,
    disabled,
    autoFocus,
    onKeyDown,
    autoComplete: type === 'password' ? 'current-password' : undefined,
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

/** Two-or-three choice segmented control. */
export function Seg({ value, onChange, options }) {
  return h('div', { className: 'rs-seg' },
    options.map((option) => h('button', {
      key: option.value,
      type: 'button',
      'aria-selected': option.value === value,
      onClick: () => onChange(option.value),
    }, option.label)))
}

/** Status dot; `pulse` marks an in-flight connection attempt. */
export function Dot({ status, pulse }) {
  const tone = status === 'connected' ? 'on'
    : status === 'connecting' ? 'warn'
      : status === 'error' ? 'err'
        : ''
  return h('span', { className: `rs-dot ${tone}${pulse ? ' pulse' : ''}`.trim(), title: status })
}

/** Centered empty state with an optional action. */
export function Empty({ title, hint, action }) {
  return h('div', { className: 'rs-empty' },
    h('h3', null, title),
    hint ? h('p', null, hint) : null,
    action ?? null)
}
