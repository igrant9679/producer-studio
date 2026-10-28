// Small form controls for the editor panels (dense NLE styling, see editor.css).
import type { AnimProp, Item } from '@producer/core'
import { isSafeColor, removeKeyframe, setKeyframe } from '@producer/core'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Diamond } from 'lucide-react'
import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { localTime, readProp } from './actions'
import { useEditor } from './store'

export function Section({ title, children, right, defaultOpen = true }: { title: string; children: ReactNode; right?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = useId()
  return (
    <section className={clsx('ed-section', !open && 'closed')}>
      <header>
        <button type="button" className="ed-section-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <span>{title}</span>
        </button>
        <div className="row" style={{ gap: 4 }}>
          {right}
        </div>
      </header>
      {open && (
        <div className="ed-section-body" id={bodyId}>
          {children}
        </div>
      )}
    </section>
  )
}

const FieldIds = createContext<{ control: string; label: string } | null>(null)

/** The ids of the Field a control sits in: its label names the control. */
export function useFieldIds() {
  return useContext(FieldIds)
}

export function Field({ label, children, keyframe, className }: { label: ReactNode; children: ReactNode; keyframe?: ReactNode; className?: string }) {
  const id = useId()
  const ids = useMemo(() => ({ control: `${id}c`, label: `${id}l` }), [id])
  return (
    <div className={clsx('ed-field', className)}>
      <label id={ids.label} htmlFor={ids.control}>{label}</label>
      <div className="ed-field-ctl" role="group" aria-labelledby={ids.label}>
        <FieldIds.Provider value={ids}>{children}</FieldIds.Provider>
      </div>
      <div className="ed-field-kf">{keyframe}</div>
    </div>
  )
}

function fmtNum(v: number, step: number) {
  const places = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  return v.toFixed(places)
}

export function NumberInput({ value, onChange, step = 1, min, max, suffix, width = 58, label }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string; width?: number; label?: string }) {
  const field = useFieldIds()
  const [text, setText] = useState(fmtNum(value, step))
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setText(fmtNum(value, step))
  }, [value, step])
  const apply = () => {
    const v = parseFloat(text)
    if (Number.isFinite(v)) {
      let x = v
      if (min !== undefined) x = Math.max(min, x)
      if (max !== undefined) x = Math.min(max, x)
      onChange(x)
      useEditor.getState().endCoalesce()
      setText(fmtNum(x, step))
    } else setText(fmtNum(value, step))
  }
  return (
    <div className="ed-num" style={{ width }}>
      <input
        value={text}
        inputMode="decimal"
        aria-label={label}
        aria-labelledby={label ? undefined : field?.label}
        onFocus={(e) => {
          focused.current = true
          e.currentTarget.select()
        }}
        onBlur={() => {
          focused.current = false
          apply()
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const d = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1)
            let x = value + d
            if (min !== undefined) x = Math.max(min, x)
            if (max !== undefined) x = Math.min(max, x)
            onChange(x)
            setText(fmtNum(x, step))
          }
        }}
      />
      {suffix && <span>{suffix}</span>}
    </div>
  )
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  suffix,
  keyframe,
  disabled,
  display,
  neutral,
}: {
  label: ReactNode
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  suffix?: string
  keyframe?: ReactNode
  disabled?: boolean
  /** Maps the stored value to the displayed number (e.g. 0..1 -> %). */
  display?: { to: (v: number) => number; from: (v: number) => number; step?: number }
  /** What a double-click resets to (default 0 when it's in range): 1 for opacity, volume and scale. */
  neutral?: number
}) {
  const pct = ((value - min) / (max - min)) * 100
  const end = () => useEditor.getState().endCoalesce()
  const shown = display ? display.to(value) : value
  return (
    <Field label={label} keyframe={keyframe}>
      <SliderRange
        type="range"
        className="ed-range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        style={{ ['--pct' as string]: `${Math.max(0, Math.min(100, pct))}%` }}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onPointerUp={end}
        onKeyUp={end}
        onDoubleClick={() => {
          const n = neutral ?? 0
          if (min <= n && max >= n) onChange(n)
        }}
      />
      <NumberInput
        value={shown}
        step={display?.step ?? step}
        suffix={suffix}
        label={typeof label === 'string' ? `${label} value` : undefined}
        onChange={(v) => onChange(Math.max(min, Math.min(max, display ? display.from(v) : v)))}
      />
    </Field>
  )
}

/** The range input of a Slider: its Field's label is its name. */
function SliderRange(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const field = useFieldIds()
  return <input id={field?.control} {...props} />
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: { value: T; options: Array<{ value: T; label: ReactNode; title?: string }>; onChange: (v: T) => void; size?: 'sm' | 'md' }) {
  const field = useFieldIds()
  return (
    <div className={clsx('ed-seg', size)} role="group" aria-labelledby={field?.label}>
      {options.map((o) => (
        <button key={o.value} title={o.title} aria-label={o.title} aria-pressed={o.value === value} className={clsx(o.value === value && 'on')} onClick={() => onChange(o.value)} type="button">
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  const field = useFieldIds()
  const own = useId()
  return (
    <label className="ed-toggle">
      <input type="checkbox" role="switch" checked={checked} id={field && !label ? field.control : undefined} aria-labelledby={field ? (label ? `${field.label} ${own}` : field.label) : undefined} onChange={(e) => onChange(e.target.checked)} />
      <span className="track">
        <span className="knob" />
      </span>
      {label && <span className="lbl" id={own}>{label}</span>}
    </label>
  )
}

function toHex(c: string): string | null {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c
  if (/^#[0-9a-f]{3}$/i.test(c)) return '#' + c.slice(1).split('').map((x) => x + x).join('')
  const m = c.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
  if (m) return '#' + [m[1], m[2], m[3]].map((n) => (+n).toString(16).padStart(2, '0')).join('')
  return null
}

export function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const field = useFieldIds()
  const hex = toHex(value) ?? '#000000'
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <div className="ed-color">
      <label className="sw" style={{ background: value }}>
        <input type="color" value={hex} aria-labelledby={field?.label} onChange={(e) => onChange(e.target.value)} onBlur={() => useEditor.getState().endCoalesce()} />
      </label>
      <input
        className="hex"
        id={field?.control}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          // a hex, rgb()/hsl() with numbers only, or a colour name; anything else snaps back
          if (isSafeColor(text)) onChange(text.trim())
          else setText(value)
        }}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
    </div>
  )
}

/** Playhead value that updates immediately while paused and ~6×/s during playback (cheap re-renders). */
export function useThrottledPlayhead(): number {
  const [t, setT] = useState(() => useEditor.getState().playhead)
  useEffect(() => {
    let last = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const unsub = useEditor.subscribe((s, prev) => {
      if (s.playhead === prev.playhead) return
      const now = performance.now()
      clearTimeout(timer)
      if (!s.playing || now - last > 160) {
        last = now
        setT(s.playhead)
      } else timer = setTimeout(() => setT(useEditor.getState().playhead), 170)
    })
    return () => {
      unsub()
      clearTimeout(timer)
    }
  }, [])
  return t
}

/** ◇ toggle: add/remove a keyframe for `prop` at the playhead. */
export function KeyframeToggle({ item, prop }: { item: Item; prop: AnimProp }) {
  const playhead = useThrottledPlayhead()
  if (!('keyframes' in item)) return null
  const kfs = item.keyframes[prop] ?? []
  const fps = useEditor.getState().project.fps
  const lt = localTime(item, playhead)
  const inside = playhead >= item.start && playhead <= item.start + item.duration
  const at = kfs.find((k) => Math.abs(k.t - lt) < 1 / (fps * 2))
  const click = () => {
    const s = useEditor.getState()
    if (!inside) {
      s.setPlayhead(item.start)
    }
    const t = inside ? lt : 0
    const p = at ? removeKeyframe(s.project, item.id, prop, at.t) : setKeyframe(s.project, item.id, prop, t, readProp(item, prop, s.playhead))
    s.commit(p, at ? 'Remove keyframe' : 'Add keyframe')
  }
  return (
    <button
      type="button"
      className={clsx('ed-kf', at && 'on', !at && kfs.length > 0 && 'has')}
      title={at ? 'Remove keyframe at playhead' : kfs.length ? 'Add keyframe at playhead (property is animated)' : 'Add keyframe at playhead'}
      onClick={click}
    >
      <Diamond size={11} fill={at ? 'currentColor' : 'none'} />
    </button>
  )
}

const ITEMS = '[role="menuitem"]:not(:disabled), [role="menuitemradio"]:not(:disabled)'
const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'

/**
 * A pop-up menu (or, with role "dialog", a small popover). Opening it moves focus to its first item; the arrow keys,
 * Home and End move between items; Escape or Tab closes it and focus returns to where it was.
 */
export function Menu({ open, onClose, children, className, style, role = 'menu', label }: { open: boolean; onClose: () => void; children: ReactNode; className?: string; style?: React.CSSProperties; role?: 'menu' | 'dialog'; label?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first = ref.current?.querySelector<HTMLElement>(role === 'menu' ? ITEMS : FOCUSABLE)
    ;(first ?? ref.current)?.focus({ preventScroll: true })
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close.current()
    }
    // Escape with focus somewhere else on the page (the menu's own keys handle it inside)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close.current()
    const id = setTimeout(() => window.addEventListener('pointerdown', onDown), 0)
    window.addEventListener('keydown', onKey)
    const box = ref.current
    return () => {
      clearTimeout(id)
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
      // closed from inside (an item, Escape): focus goes back to what opened it; a click elsewhere keeps its focus
      const at = document.activeElement
      if (opener?.isConnected && (!at || at === document.body || box?.contains(at))) opener.focus({ preventScroll: true })
    }
  }, [open, role])
  if (!open) return null
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (role !== 'menu') return
    const items = [...(ref.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])]
    if (!items.length) return
    const at = items.indexOf(document.activeElement as HTMLElement)
    const go = (i: number) => {
      e.preventDefault()
      e.stopPropagation()
      items[(i + items.length) % items.length].focus()
    }
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at < 0 ? items.length - 1 : at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
  }
  return (
    <div ref={ref} className={clsx('ed-menu', className)} style={style} role={role} aria-label={label} tabIndex={-1} onKeyDown={onKeyDown}>
      {children}
    </div>
  )
}

export function MenuItem({ icon, label, kbd, onClick, disabled, danger, active }: { icon?: ReactNode; label: ReactNode; kbd?: string; onClick: () => void; disabled?: boolean; danger?: boolean; active?: boolean }) {
  const choice = active !== undefined
  return (
    <button
      type="button"
      role={choice ? 'menuitemradio' : 'menuitem'}
      aria-checked={choice ? active : undefined}
      tabIndex={-1}
      className={clsx('ed-menu-item', danger && 'danger', active && 'active')}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="ic">{icon}</span>
      <span className="lb">{label}</span>
      {kbd && <span className="kb">{kbd}</span>}
    </button>
  )
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="ed-empty">
      {icon && <div className="ic">{icon}</div>}
      <div className="t">{title}</div>
      {children && <div className="d">{children}</div>}
    </div>
  )
}
