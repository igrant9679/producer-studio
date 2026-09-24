// Small form controls for the editor panels (dense NLE styling, see editor.css).
import type { AnimProp, Item } from '@producer/core'
import { removeKeyframe, setKeyframe } from '@producer/core'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Diamond } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { localTime, readProp } from './actions'
import { useEditor } from './store'

export function Section({ title, children, right, defaultOpen = true }: { title: string; children: ReactNode; right?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={clsx('ed-section', !open && 'closed')}>
      <header onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{title}</span>
        <div className="spacer" />
        <div onClick={(e) => e.stopPropagation()} className="row" style={{ gap: 4 }}>
          {right}
        </div>
      </header>
      {open && <div className="ed-section-body">{children}</div>}
    </section>
  )
}

export function Field({ label, children, keyframe, className }: { label: ReactNode; children: ReactNode; keyframe?: ReactNode; className?: string }) {
  return (
    <div className={clsx('ed-field', className)}>
      <label>{label}</label>
      <div className="ed-field-ctl">{children}</div>
      <div className="ed-field-kf">{keyframe}</div>
    </div>
  )
}

function fmtNum(v: number, step: number) {
  const places = step >= 1 ? 0 : step >= 0.1 ? 1 : 2
  return v.toFixed(places)
}

export function NumberInput({ value, onChange, step = 1, min, max, suffix, width = 58 }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; suffix?: string; width?: number }) {
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
}) {
  const pct = ((value - min) / (max - min)) * 100
  const end = () => useEditor.getState().endCoalesce()
  const shown = display ? display.to(value) : value
  return (
    <Field label={label} keyframe={keyframe}>
      <input
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
          // double-click resets to the neutral value when 0 is in range
          if (min <= 0 && max >= 0) onChange(0)
        }}
      />
      <NumberInput
        value={shown}
        step={display?.step ?? step}
        suffix={suffix}
        onChange={(v) => onChange(Math.max(min, Math.min(max, display ? display.from(v) : v)))}
      />
    </Field>
  )
}

export function Segmented<T extends string>({ value, options, onChange, size = 'md' }: { value: T; options: Array<{ value: T; label: ReactNode; title?: string }>; onChange: (v: T) => void; size?: 'sm' | 'md' }) {
  return (
    <div className={clsx('ed-seg', size)}>
      {options.map((o) => (
        <button key={o.value} title={o.title} className={clsx(o.value === value && 'on')} onClick={() => onChange(o.value)} type="button">
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="ed-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track">
        <span className="knob" />
      </span>
      {label && <span className="lbl">{label}</span>}
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
  const hex = toHex(value) ?? '#000000'
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <div className="ed-color">
      <label className="sw" style={{ background: value }}>
        <input type="color" value={hex} onChange={(e) => onChange(e.target.value)} onBlur={() => useEditor.getState().endCoalesce()} />
      </label>
      <input
        className="hex"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (toHex(text) || text.startsWith('rgb')) onChange(text)
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

export function Menu({ open, onClose, children, className, style }: { open: boolean; onClose: () => void; children: ReactNode; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const id = setTimeout(() => window.addEventListener('pointerdown', onDown), 0)
    window.addEventListener('keydown', onKey)
    return () => {
      clearTimeout(id)
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div ref={ref} className={clsx('ed-menu', className)} style={style}>
      {children}
    </div>
  )
}

export function MenuItem({ icon, label, kbd, onClick, disabled, danger, active }: { icon?: ReactNode; label: ReactNode; kbd?: string; onClick: () => void; disabled?: boolean; danger?: boolean; active?: boolean }) {
  return (
    <button type="button" className={clsx('ed-menu-item', danger && 'danger', active && 'active')} disabled={disabled} onClick={onClick}>
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
