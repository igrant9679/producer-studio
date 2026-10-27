// Shared shell UI primitives: logo, dialogs, popover menus, tab strips, thumbnails, empty states, progress, hooks.
// Other screens build on these: Modal / ConfirmDialog for dialogs, Popover + MenuList for menus, Tabs + TabPanel
// for tab strips, RadioCards for card pickers, useEditGate for actions a viewer can't take.
import clsx from 'clsx'
import { Film, ImageOff, Loader2, X } from 'lucide-react'
import type { Workspace } from '@producer/core'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'
import { canEdit, currentWorkspace, onUserReset, useSession } from '../lib/session'

/** The tooltip on an action a viewer can't take: who can. */
export function viewOnlyTip(ws: Pick<Workspace, 'name'> | undefined): string {
  return `Only owners and editors of “${ws?.name ?? 'this space'}” can do this. You’re a viewer.`
}

export interface EditGate {
  /** The signed-in person may change things in the current space (owner or editor). */
  canEdit: boolean
  /** Why not, for a tooltip; undefined when they can. */
  tip?: string
  /** Spread on a write action's button: disabled, with the tooltip, for viewers. */
  props: { disabled?: boolean; 'data-tip'?: string }
}

/**
 * The one role check for write actions: viewers see them disabled with a tooltip saying who can. Combine with a
 * button's own `disabled` as `disabled={busy || !gate.canEdit}`, or spread `gate.props` when it has none.
 */
export function useEditGate(): EditGate {
  const ws = useSession(currentWorkspace)
  return useMemo(() => {
    const can = !ws || canEdit(ws)
    if (can) return { canEdit: true, props: {} }
    const tip = viewOnlyTip(ws)
    return { canEdit: false, tip, props: { disabled: true, 'data-tip': tip } }
  }, [ws])
}

/** Sets the browser tab title while the page is mounted. */
export function usePageTitle(title: string | undefined) {
  useEffect(() => {
    document.title = title ? `${title} · Producer Studio` : 'Producer Studio'
  }, [title])
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="ps-logo">
      <img src="/favicon.svg" alt="" />
      {!compact && (
        <span className="ps-logo-word">
          Producer <b>Studio</b>
        </span>
      )}
    </span>
  )
}

// ---------------- focus, Escape and dialogs ----------------
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), audio[controls], video[controls], [contenteditable]:not([contenteditable="false"]), [tabindex]'

/** Keyboard-reachable elements inside `root`, in DOM order. */
export function focusables(root: Element | null | undefined): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.tabIndex >= 0 && !el.closest('[inert], [hidden]'))
}

// Escape closes only the topmost open layer (a menu inside a dialog closes before the dialog).
type Layer = { onEscape: () => void; el?: Element | null }
const layers: Layer[] = []
function onLayerKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || e.defaultPrevented || !layers.length) return
  e.preventDefault()
  e.stopPropagation()
  layers[layers.length - 1].onEscape()
}

/**
 * Register an Escape-closable layer while `active`. Later layers sit on top, except that a layer whose element
 * (`ref`) holds another's sits under it (a dialog and one inside it, opened together). Returns a check for "is it
 * the topmost one right now".
 */
export function useEscapeLayer(onEscape: () => void, active = true, ref?: React.RefObject<Element>): () => boolean {
  const cb = useRef(onEscape)
  cb.current = onEscape
  const layer = useRef<Layer>()
  useEffect(() => {
    if (!active) return
    const l: Layer = { onEscape: () => cb.current(), el: ref?.current }
    layer.current = l
    if (!layers.length) document.addEventListener('keydown', onLayerKey)
    const under = l.el ? layers.findIndex((x) => x.el && l.el!.contains(x.el)) : -1
    if (under >= 0) layers.splice(under, 0, l)
    else layers.push(l)
    return () => {
      const i = layers.indexOf(l)
      if (i >= 0) layers.splice(i, 1)
      if (!layers.length) document.removeEventListener('keydown', onLayerKey)
      layer.current = undefined
    }
  }, [active])
  return useCallback(() => !!layer.current && layers[layers.length - 1] === layer.current, [])
}

let dialogN = 0

/**
 * A modal dialog, named by its title (or `label`) and described by its subtitle. Focus moves in on open (an
 * `autoFocus` element, else `initialFocus`, else the first control in the body, then the footer), Tab stays
 * inside, and focus goes back to what had it on close. Escape closes only the topmost dialog or menu.
 */
export function Modal({ title, subtitle, onClose, children, footer, width = 560, className, label, initialFocus, role = 'dialog' }: {
  title?: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children?: ReactNode
  footer?: ReactNode
  width?: number
  className?: string
  /** Accessible name when there is no visible title. */
  label?: string
  /** CSS selector inside the dialog for the element to focus first. */
  initialFocus?: string
  role?: 'dialog' | 'alertdialog'
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [ids] = useState(() => {
    const n = ++dialogN
    return { title: `ps-dlg-${n}-title`, desc: `ps-dlg-${n}-desc` }
  })
  // Captured while rendering: React focuses `autoFocus` children before any effect of ours runs. A menu item that
  // opened the dialog is gone by close time, so remember its menu button too.
  const [restore] = useState(() => {
    const el = typeof document !== 'undefined' ? (document.activeElement as HTMLElement | null) : null
    const menuRoot = el?.closest('.ps-popover-root')
    return { el, fallback: menuRoot ? focusables(menuRoot)[0] : undefined }
  })
  const isTop = useEscapeLayer(onClose, true, ref)

  useEffect(() => {
    const box = ref.current
    if (!box) return
    if (!box.contains(document.activeElement)) {
      const target = (initialFocus && box.querySelector<HTMLElement>(initialFocus)) || focusables(box.querySelector('.ps-modal-body'))[0] || focusables(box.querySelector('.ps-modal-foot'))[0] || box
      target.focus()
    }
    // focus that wanders out (a click on the page behind, a script) comes back to the topmost dialog
    const onFocusIn = (e: FocusEvent) => {
      if (!isTop() || box.contains(e.target as Node)) return
      ;(focusables(box)[0] ?? box).focus()
    }
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      const active = document.activeElement
      if (active && active !== document.body && !box.contains(active)) return
      const back = restore.el?.isConnected && restore.el !== document.body ? restore.el : restore.fallback?.isConnected ? restore.fallback : undefined
      back?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onKeyDown(e: React.KeyboardEvent) {
    // a dialog opened from inside this one traps its own Tab
    if (e.key !== 'Tab' || !ref.current || (e.target as Element).closest('[aria-modal="true"]') !== ref.current) return
    const f = focusables(ref.current)
    if (!f.length) {
      e.preventDefault()
      return
    }
    const first = f[0]
    const last = f[f.length - 1]
    const at = document.activeElement
    if (e.shiftKey && (at === first || at === ref.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && at === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        className={clsx('modal ps-modal', className)}
        style={{ maxWidth: `min(94vw, ${width}px)` }}
        role={role}
        aria-modal="true"
        aria-labelledby={title !== undefined ? ids.title : undefined}
        aria-label={title === undefined ? label : undefined}
        aria-describedby={subtitle ? ids.desc : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {title !== undefined && (
          <div className="ps-modal-head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 id={ids.title}>{title}</h2>
              {subtitle && <p id={ids.desc}>{subtitle}</p>}
            </div>
            <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        )}
        {children !== undefined && children !== null && children !== false && <div className="ps-modal-body">{children}</div>}
        {footer && <div className="ps-modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

/**
 * Yes/no confirmation. A destructive one (the default) opens with Cancel focused, so Enter or a stray Space
 * never deletes anything.
 */
export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onClose, busy, danger = true, children, width = 460 }: {
  title: ReactNode
  body?: ReactNode
  confirmLabel: ReactNode
  onConfirm: () => void
  onClose: () => void
  busy?: boolean
  danger?: boolean
  children?: ReactNode
  width?: number
}) {
  return (
    <Modal
      title={title}
      subtitle={body}
      onClose={onClose}
      width={width}
      role={danger ? 'alertdialog' : 'dialog'}
      footer={
        <>
          <button className="btn ghost" onClick={onClose} autoFocus={danger}>Cancel</button>
          <button className={danger ? 'btn danger' : 'btn primary'} onClick={onConfirm} disabled={busy} autoFocus={!danger}>
            {busy && <Spinner />} {confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  )
}

export function useClickOutside(ref: React.RefObject<HTMLElement>, onOutside: () => void, active = true) {
  useEscapeLayer(onOutside, active, ref)
  useEffect(() => {
    if (!active) return
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [ref, onOutside, active])
}

const MENU_ITEM = '[role^="menuitem"]:not(:disabled), a.ps-menu-item'
/** A menu's items that can take focus (some show only at phone width). */
const menuItems = (root: Element | null | undefined): HTMLElement[] =>
  Array.from(root?.querySelectorAll<HTMLElement>(MENU_ITEM) ?? []).filter((el) => getComputedStyle(el).display !== 'none')

/** Next index for an arrow / Home / End key in a row of `n`, or undefined for any other key. */
function rovingIndex(key: string, i: number, n: number): number | undefined {
  if (key === 'Home') return 0
  if (key === 'End') return n - 1
  if (key === 'ArrowRight' || key === 'ArrowDown') return (i + 1) % n
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (i - 1 + n) % n
  return undefined
}

/** Up / Down, Home and End move between a menu's items. */
function onMenuKeyDown(e: React.KeyboardEvent<HTMLElement>) {
  const target = e.target as HTMLElement
  if (!target.matches(MENU_ITEM) || e.key === 'ArrowLeft' || e.key === 'ArrowRight') return
  const items = menuItems(e.currentTarget)
  const next = rovingIndex(e.key, items.indexOf(target), items.length)
  if (next === undefined) return
  e.preventDefault()
  items[next]?.focus()
}

/**
 * A trigger + absolutely positioned popover that closes on outside click / Escape. Up / Down move through its menu
 * items, and closing it with focus inside gives focus back to the trigger.
 */
export function Popover({ trigger, children, align = 'left', className, style, open: openProp, onOpenChange }: {
  trigger: (p: { open: boolean; toggle: () => void }) => ReactNode
  children: ReactNode | ((close: () => void) => ReactNode)
  align?: 'left' | 'right'
  className?: string
  style?: React.CSSProperties
  open?: boolean
  onOpenChange?: (o: boolean) => void
}) {
  const [openState, setOpenState] = useState(false)
  const open = openProp ?? openState
  const setOpen = useCallback((o: boolean) => (onOpenChange ? onOpenChange(o) : setOpenState(o)), [onOpenChange])
  const ref = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [flip, setFlip] = useState<{ up?: boolean; side?: 'left' | 'right' }>({})
  const close = useCallback(() => setOpen(false), [setOpen])
  useClickOutside(ref, close, open)
  const wasOpen = useRef(false)
  // the focused item went away with the popover: focus the button that opened it
  useLayoutEffect(() => {
    if (wasOpen.current && !open && (!document.activeElement || document.activeElement === document.body)) focusables(ref.current)[0]?.focus()
    wasOpen.current = open
  }, [open])
  // Keep the popover on screen: open upwards near the bottom edge, swap sides near the left/right edges.
  useLayoutEffect(() => {
    if (!open) return setFlip({})
    const el = popRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const t = ref.current!.getBoundingClientRect()
    const next: { up?: boolean; side?: 'left' | 'right' } = {}
    if (style?.bottom === undefined && r.bottom > window.innerHeight - 8 && t.top - r.height - 6 > 8) next.up = true
    if (r.right > window.innerWidth - 8) next.side = 'right'
    else if (r.left < 8) next.side = 'left'
    if (next.up || next.side) setFlip(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const side = flip.side ?? align
  return (
    <div ref={ref} className="ps-popover-root" style={{ position: 'relative', display: 'inline-flex' }} onClick={(e) => e.stopPropagation()}>
      {trigger({ open, toggle: () => setOpen(!open) })}
      {open && (
        <div
          ref={popRef}
          className={clsx('ps-pop', className)}
          onKeyDown={onMenuKeyDown}
          style={{ top: 'calc(100% + 6px)', [side]: 0, ...style, ...(flip.side ? { [side === 'left' ? 'right' : 'left']: 'auto', [side]: 0 } : {}), ...(flip.up ? { top: 'auto', bottom: 'calc(100% + 6px)' } : {}) }}
        >
          {typeof children === 'function' ? children(close) : children}
        </div>
      )}
    </div>
  )
}

export interface MenuItemDef {
  label: string
  icon?: ReactNode
  sub?: string
  onClick?: () => void
  danger?: boolean
  disabled?: boolean
  /** Why it's disabled, shown as its tooltip (a viewer's "Only owners and editors…"). */
  tip?: string
  sep?: boolean
  className?: string
}

/** A menu (role="menu"). In a popover, its first item takes focus when it opens, unless focus is already in the popover. */
export function MenuList({ items, close, label }: { items: MenuItemDef[]; close: () => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const pop = ref.current?.closest('.ps-pop')
    if (!pop || pop.contains(document.activeElement)) return
    menuItems(ref.current)[0]?.focus()
  }, [])
  return (
    <div role="menu" aria-label={label} ref={ref}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="ps-menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={clsx('ps-menu-item', it.danger && 'danger', it.className)}
            disabled={it.disabled}
            data-tip={it.disabled && it.tip ? it.tip : undefined}
            onClick={() => {
              close()
              it.onClick?.()
            }}
          >
            {it.icon}
            <span style={{ flex: 1 }}>
              {it.label}
              {it.sub && <span className="ps-menu-sub">{it.sub}</span>}
            </span>
          </button>
        ),
      )}
    </div>
  )
}

// ---------------- tab strips and radio cards ----------------
export interface TabDef<T extends string> {
  id: T
  label: ReactNode
  icon?: ReactNode
  /** Shown after the label (a count badge). */
  extra?: ReactNode
}

const tabDomId = (strip: string, id: string) => `${strip}-tab-${id}`
const panelDomId = (strip: string, id: string) => `${strip}-panel-${id}`

/**
 * A tab strip (role="tablist"): one tab stop, arrow keys / Home / End move and select, and the selected tab names
 * the <TabPanel> it controls. `className` picks the look: `ps-tabs` (underline), `ps-seg` (segmented), or a chip
 * row with `tabClassName="chip"`.
 */
export function Tabs<T extends string>({ id, tabs, value, onChange, label, className = 'ps-tabs', tabClassName, style }: {
  id: string
  tabs: Array<TabDef<T>>
  value: T
  onChange: (t: T) => void
  label?: string
  className?: string
  tabClassName?: string
  style?: React.CSSProperties
}) {
  const refs = useRef(new Map<string, HTMLButtonElement>())
  function onKeyDown(e: React.KeyboardEvent) {
    const next = rovingIndex(e.key, Math.max(0, tabs.findIndex((t) => t.id === value)), tabs.length)
    const t = next === undefined ? undefined : tabs[next]
    if (!t) return
    e.preventDefault()
    onChange(t.id)
    refs.current.get(t.id)?.focus()
  }
  return (
    <div role="tablist" aria-label={label} className={className} style={style} onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const on = t.id === value
        return (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el)
              else refs.current.delete(t.id)
            }}
            type="button"
            role="tab"
            id={tabDomId(id, t.id)}
            aria-selected={on}
            aria-controls={on ? panelDomId(id, t.id) : undefined}
            tabIndex={on ? 0 : -1}
            className={clsx(tabClassName, on && (tabClassName === 'chip' ? 'active' : 'on'))}
            onClick={() => onChange(t.id)}
          >
            {t.icon}
            {t.label}
            {t.extra}
          </button>
        )
      })}
    </div>
  )
}

/** The panel for the selected tab of `<Tabs id={tabs}>`. */
export function TabPanel({ tabs, value, children, className, style }: { tabs: string; value: string; children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div role="tabpanel" id={panelDomId(tabs, value)} aria-labelledby={tabDomId(tabs, value)} className={className} style={style}>
      {children}
    </div>
  )
}

/**
 * Radio cards (a voice picker): the group is one tab stop, landing on the checked card (else the first); arrow keys
 * move and select. Controls inside a card (its Play button) are reachable only on the card holding the tab stop.
 */
export function RadioCards({ label, className, children, style }: { label: string; className?: string; children: ReactNode; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const radios = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])
    const stop = radios.find((r) => r.getAttribute('aria-checked') === 'true') ?? radios.find((r) => r.contains(document.activeElement)) ?? radios[0]
    for (const r of radios) {
      r.tabIndex = r === stop ? 0 : -1
      r.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea').forEach((el) => (el.tabIndex = r === stop ? 0 : -1))
    }
  })
  function onKeyDown(e: React.KeyboardEvent) {
    const target = e.target as HTMLElement
    if (target.getAttribute('role') !== 'radio') return
    const radios = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'))
    const next = rovingIndex(e.key, radios.indexOf(target), radios.length)
    if (next === undefined) return
    e.preventDefault()
    radios[next]?.focus()
    radios[next]?.click()
  }
  return (
    <div ref={ref} role="radiogroup" aria-label={label} className={className} style={style} onKeyDown={onKeyDown}>
      {children}
    </div>
  )
}

const GRADS = [
  ['#ff5a5f', '#7950f2'],
  ['#35e0ff', '#3b5bdb'],
  ['#ffc24d', '#e8590c'],
  ['#3ddc97', '#0ca678'],
  ['#c2255c', '#ff5a5f'],
  ['#7950f2', '#35e0ff'],
]

export function gradientFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  const [a, b] = GRADS[h % GRADS.length]
  return `linear-gradient(135deg, ${a}33, ${b}55), linear-gradient(160deg, var(--thumb-a), var(--thumb-b))`
}

/** Thumbnail with graceful fallback (gradient + icon) when the image is missing or fails. */
export function Thumb({ src, seed = '', aspect, contain, children, icon, videoSrc, playing, className }: {
  src?: string
  seed?: string
  aspect?: number
  contain?: boolean
  children?: ReactNode
  icon?: ReactNode
  videoSrc?: string
  playing?: boolean
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [src])
  const [vidFailed, setVidFailed] = useState(false)
  return (
    <div className={clsx('ps-thumb', contain && 'contain', className)} style={{ aspectRatio: aspect ? String(aspect) : undefined, background: gradientFor(seed) }}>
      {(!src || failed) && <div className="ps-thumb-fallback">{icon ?? (failed ? <ImageOff size={22} /> : <Film size={24} />)}</div>}
      {src && !failed && <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} draggable={false} />}
      {videoSrc && playing && !vidFailed && <video src={videoSrc} muted autoPlay loop playsInline onError={() => setVidFailed(true)} />}
      {children}
    </div>
  )
}

export function EmptyState({ icon, title, body, action }: { icon: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ps-empty">
      <div className="ps-empty-icon">{icon}</div>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  )
}

export function CardSkeletons({ n = 6, aspect = 16 / 9 }: { n?: number; aspect?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} aria-hidden>
          <div className="skeleton" style={{ aspectRatio: String(aspect), borderRadius: 10 }} />
          <div className="skeleton" style={{ height: 12, width: '70%', marginTop: 12 }} />
          <div className="skeleton" style={{ height: 10, width: '40%', marginTop: 8 }} />
        </div>
      ))}
    </>
  )
}

export function Progress({ value }: { value: number }) {
  const indet = value < 0
  return (
    <div className={clsx('ps-progress', indet && 'indeterminate')} role="progressbar" aria-valuenow={indet ? undefined : Math.round(value * 100)}>
      <i style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }} />
    </div>
  )
}

export const Spinner = ({ size = 16 }: { size?: number }) => <Loader2 size={size} className="ps-spin" />

export function Soon({ label = 'Coming soon' }: { label?: string }) {
  return <span className="ps-soon">{label}</span>
}

export function Avatar({ name, color, size = 32 }: { name?: string; color?: string; size?: number }) {
  const init = (name ?? '?')
    .trim()
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
  return (
    <span className="ps-avatar" style={{ width: size, height: size, background: color || '#35e0ff', fontSize: size * 0.38 }}>
      {init || '?'}
    </span>
  )
}

export function spaceColor(id: string): string {
  const cols = ['#ff5a5f', '#35e0ff', '#ffc24d', '#3ddc97', '#b197fc', '#ff8fab']
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 17 + id.charCodeAt(i)) >>> 0
  return cols[h % cols.length]
}

/**
 * Load async data with loading / error / reload. Re-runs when deps change. What it loaded belongs to the space that
 * was active then: after a space switch it reads as not loaded (no data, loading) until the new space's answer
 * arrives, and an error from the old space's load never shows under the new one.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; loading: boolean; error: unknown; reload: () => void; setData: (u: T | ((d: T | undefined) => T)) => void } {
  const ws = useSession((s) => s.workspaceId)
  const [state, setState] = useState<{ ws?: string; data?: T; error?: unknown; loading: boolean }>({ ws, loading: true })
  const [tick, setTick] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    let alive = true
    setState((s) => (s.ws === ws ? { ...s, error: undefined, loading: true } : { ws, loading: true }))
    fnRef
      .current()
      .then((d) => alive && setState({ ws, data: d, loading: false }))
      .catch((e) => alive && setState((s) => ({ ...(s.ws === ws ? s : { ws }), error: e, loading: false })))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ws, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  const setData = useCallback(
    (u: T | ((d: T | undefined) => T)) => setState((s) => ({ ...s, data: typeof u === 'function' ? (u as (d: T | undefined) => T)(s.data) : u })),
    [],
  )
  const current = state.ws === ws
  return { data: current ? state.data : undefined, loading: current ? state.loading : true, error: current ? state.error : undefined, reload, setData }
}

// ---- one shared audio player for voice samples / previews ----
interface AudioState {
  playing?: string
  loading?: string
  toggle: (key: string, url: string) => void
  stop: () => void
}
let audioEl: HTMLAudioElement | undefined
export const useAudioPreview = create<AudioState>((set, get) => ({
  toggle(key, url) {
    if (get().playing === key || get().loading === key) return get().stop()
    audioEl?.pause()
    audioEl = new Audio()
    audioEl.src = url
    set({ loading: key, playing: undefined })
    const el = audioEl
    el.onplaying = () => el === audioEl && set({ playing: key, loading: undefined })
    el.onended = () => el === audioEl && set({ playing: undefined, loading: undefined })
    el.onerror = () => {
      if (el !== audioEl) return
      set({ playing: undefined, loading: undefined })
      import('../lib/toast').then(({ useToasts }) => useToasts.getState().push('Audio preview is unavailable right now', 'error'))
    }
    el.play().catch(() => undefined)
  },
  stop() {
    audioEl?.pause()
    audioEl = undefined
    set({ playing: undefined, loading: undefined })
  },
}))

onUserReset(() => useAudioPreview.getState().stop())

/** Hidden file input helper. */
export function useFilePicker(accept: string, multiple: boolean, onFiles: (files: File[]) => void) {
  const ref = useRef<HTMLInputElement | null>(null)
  const cb = useRef(onFiles)
  cb.current = onFiles
  useEffect(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.style.display = 'none'
    input.onchange = () => {
      const files = Array.from(input.files ?? [])
      input.value = ''
      if (files.length) cb.current(files)
    }
    document.body.appendChild(input)
    ref.current = input
    return () => input.remove()
  }, [accept, multiple])
  return () => ref.current?.click()
}
