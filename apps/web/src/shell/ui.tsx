// Shared shell UI primitives: logo, modal, popover menus, thumbnails, empty states, progress, hooks.
import clsx from 'clsx'
import { Film, ImageOff, Loader2, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { create } from 'zustand'

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

export function Modal({ title, subtitle, onClose, children, footer, width = 560, className }: {
  title?: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
  className?: string
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={clsx('modal ps-modal', className)} style={{ maxWidth: `min(94vw, ${width}px)` }} role="dialog" aria-modal="true">
        {title !== undefined && (
          <div className="ps-modal-head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2>{title}</h2>
              {subtitle && <p>{subtitle}</p>}
            </div>
            <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
              <X size={16} />
            </button>
          </div>
        )}
        <div className="ps-modal-body">{children}</div>
        {footer && <div className="ps-modal-foot">{footer}</div>}
      </div>
    </div>
  )
}

export function useClickOutside(ref: React.RefObject<HTMLElement>, onOutside: () => void, active = true) {
  useEffect(() => {
    if (!active) return
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside()
    }
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onOutside()
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => {
      document.removeEventListener('mousedown', h)
      document.removeEventListener('keydown', k)
    }
  }, [ref, onOutside, active])
}

/** A trigger + absolutely positioned popover that closes on outside click / Escape. */
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
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex' }} onClick={(e) => e.stopPropagation()}>
      {trigger({ open, toggle: () => setOpen(!open) })}
      {open && (
        <div
          ref={popRef}
          className={clsx('ps-pop', className)}
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
  sep?: boolean
}

export function MenuList({ items, close }: { items: MenuItemDef[]; close: () => void }) {
  return (
    <div role="menu">
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="ps-menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={clsx('ps-menu-item', it.danger && 'danger')}
            disabled={it.disabled}
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

/** Load async data with loading / error / reload. Re-runs when deps change. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; loading: boolean; error: unknown; reload: () => void; setData: (u: T | ((d: T | undefined) => T)) => void } {
  const [data, setDataState] = useState<T>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>()
  const [tick, setTick] = useState(0)
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(undefined)
    fnRef
      .current()
      .then((d) => alive && setDataState(d))
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  const setData = useCallback((u: T | ((d: T | undefined) => T)) => setDataState((d) => (typeof u === 'function' ? (u as (d: T | undefined) => T)(d) : u)), [])
  return { data, loading, error, reload, setData }
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
