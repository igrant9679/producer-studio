// Canvas view aids drawn around and over the stage: rulers, draggable guides, platform safe zones, the lines an
// object snaps to while it moves, and the small view bar that turns them on.
import { Ruler, X } from 'lucide-react'
import { useState } from 'react'
import { SAFE_ZONES, rulerStep, safeRect, type SafeZoneId } from './canvasSnap'
import { useCanvasView } from './canvasView'
import './canvas-tools.css'

type Axis = 'v' | 'h'

/** Lines the moving object lines up with (canvas px). */
export function SnapLines({ lines, scale }: { lines: { x: number[]; y: number[] }; scale: number }) {
  return (
    <>
      {lines.x.map((x) => (
        <div key={`x${x}`} className="cv-guide v" style={{ left: x * scale }} />
      ))}
      {lines.y.map((y) => (
        <div key={`y${y}`} className="cv-guide h" style={{ top: y * scale }} />
      ))}
    </>
  )
}

export function SafeZoneOverlay({ W, H, scale }: { W: number; H: number; scale: number }) {
  const zone = useCanvasView((s) => s.safeZone)
  if (!zone) return null
  const r = safeRect(zone, W, H)
  const name = SAFE_ZONES.find((z) => z.id === zone)!.name
  const px = (v: number) => v * scale
  return (
    <div className="cv-safe" aria-hidden="true">
      <div className="shade" style={{ left: 0, top: 0, right: 0, height: px(r.top) }} />
      <div className="shade" style={{ left: 0, top: px(r.bottom), right: 0, bottom: 0 }} />
      <div className="shade" style={{ left: 0, top: px(r.top), width: px(r.left), height: px(r.bottom - r.top) }} />
      <div className="shade" style={{ left: px(r.right), top: px(r.top), right: 0, height: px(r.bottom - r.top) }} />
      <div className="area" style={{ left: px(r.left), top: px(r.top), width: px(r.right - r.left), height: px(r.bottom - r.top) }}>
        <span>{name} safe area</span>
      </div>
    </div>
  )
}

/** Rulers along the top and left of the canvas, and the guides dragged out of them. */
export function CanvasRulers({ W, H, scale, boxRef }: { W: number; H: number; scale: number; boxRef: React.RefObject<HTMLDivElement> }) {
  const on = useCanvasView((s) => s.rulers)
  const guides = useCanvasView((s) => s.guides)
  const setGuides = useCanvasView((s) => s.setGuides)
  const [pending, setPending] = useState<{ axis: Axis; at: number | null; index?: number } | null>(null)
  if (!on) return null
  const step = rulerStep(scale)
  const limit = (axis: Axis) => (axis === 'v' ? W : H)

  const posOf = (axis: Axis, e: { clientX: number; clientY: number }) => {
    const r = boxRef.current!.getBoundingClientRect()
    return axis === 'v' ? (e.clientX - r.left) / scale : (e.clientY - r.top) / scale
  }
  /** Drag a new guide out of a ruler (index undefined) or an existing one; dropped off the canvas, it goes away. */
  const drag = (e: React.PointerEvent, axis: Axis, index?: number) => {
    if (e.button > 0) return
    e.preventDefault()
    e.stopPropagation()
    const inside = (v: number) => v >= 0 && v <= limit(axis)
    const at0 = index !== undefined ? guides[axis][index] : null
    setPending({ axis, at: at0, index })
    let last: number | null = at0
    const mv = (ev: PointerEvent) => {
      const v = Math.round(posOf(axis, ev))
      last = inside(v) ? v : null
      setPending({ axis, at: last, index })
    }
    const up = () => {
      window.removeEventListener('pointermove', mv)
      window.removeEventListener('pointerup', up)
      setPending(null)
      const g = useCanvasView.getState().guides
      const list = [...g[axis]]
      if (index !== undefined) list.splice(index, 1)
      if (last !== null) list.push(last)
      setGuides({ ...g, [axis]: list })
    }
    window.addEventListener('pointermove', mv)
    window.addEventListener('pointerup', up)
  }
  const keyGuide = (e: React.KeyboardEvent, axis: Axis, index: number) => {
    const g = useCanvasView.getState().guides
    const list = [...g[axis]]
    const d = e.shiftKey ? 10 : 1
    const back = axis === 'v' ? 'ArrowLeft' : 'ArrowUp'
    const fwd = axis === 'v' ? 'ArrowRight' : 'ArrowDown'
    if (e.key === back || e.key === fwd) list[index] = Math.max(0, Math.min(limit(axis), list[index] + (e.key === fwd ? d : -d)))
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      list.splice(index, 1)
      // focus moves back to the ruler the guide came from
      ;(boxRef.current?.querySelector(`.cv-ruler.${axis === 'v' ? 'left' : 'top'}`) as HTMLElement | null)?.focus()
    } else return
    e.preventDefault()
    e.stopPropagation()
    setGuides({ ...g, [axis]: list })
  }
  const keyRuler = (e: React.KeyboardEvent, axis: Axis) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    e.preventDefault()
    e.stopPropagation()
    const g = useCanvasView.getState().guides
    setGuides({ ...g, [axis]: [...g[axis], Math.round(limit(axis) / 2)] })
  }
  const labels = (len: number) => Array.from({ length: Math.floor(len / step) + 1 }, (_, i) => i * step)
  const minor = `${((step * scale) / 5).toFixed(2)}px`
  return (
    <>
      <div
        className="cv-ruler top"
        role="button"
        tabIndex={0}
        aria-label="Top ruler: drag down onto the canvas to add a horizontal guide, or press Enter to add one across the middle"
        style={{ width: W * scale, ['--minor' as string]: minor }}
        onPointerDown={(e) => drag(e, 'h')}
        onKeyDown={(e) => keyRuler(e, 'h')}
      >
        {labels(W).map((v) => (
          <span key={v} style={{ left: v * scale }}>{v}</span>
        ))}
      </div>
      <div
        className="cv-ruler left"
        role="button"
        tabIndex={0}
        aria-label="Left ruler: drag right onto the canvas to add a vertical guide, or press Enter to add one down the middle"
        style={{ height: H * scale, ['--minor' as string]: minor }}
        onPointerDown={(e) => drag(e, 'v')}
        onKeyDown={(e) => keyRuler(e, 'v')}
      >
        {labels(H).map((v) => (
          <span key={v} style={{ top: v * scale }}>{v}</span>
        ))}
      </div>
      {(['v', 'h'] as const).map((axis) =>
        guides[axis].map((at, i) => {
          if (pending && pending.axis === axis && pending.index === i) return null
          return (
            <div
              key={`${axis}${i}`}
              className={`cv-gline ${axis}`}
              style={axis === 'v' ? { left: at * scale } : { top: at * scale }}
              role="slider"
              tabIndex={0}
              aria-label={axis === 'v' ? 'Vertical guide' : 'Horizontal guide'}
              aria-orientation={axis === 'v' ? 'horizontal' : 'vertical'}
              aria-valuemin={0}
              aria-valuemax={limit(axis)}
              aria-valuenow={at}
              aria-valuetext={`${at} px`}
              title={`${at} px · drag to move, drag onto the ruler or press Delete to remove`}
              data-local-keys
              onPointerDown={(e) => drag(e, axis, i)}
              onKeyDown={(e) => keyGuide(e, axis, i)}
            />
          )
        }),
      )}
      {pending && pending.at !== null && (
        <div className={`cv-gline ${pending.axis} dragging`} style={pending.axis === 'v' ? { left: pending.at * scale } : { top: pending.at * scale }}>
          <b>{pending.at}</b>
        </div>
      )}
    </>
  )
}

/** Rulers and guides on or off, the safe-zone overlay, clear guides. */
export function CanvasViewBar() {
  const rulers = useCanvasView((s) => s.rulers)
  const zone = useCanvasView((s) => s.safeZone)
  const guides = useCanvasView((s) => s.guides)
  const v = useCanvasView.getState()
  const count = guides.v.length + guides.h.length
  return (
    <div className="cv-viewbar" role="toolbar" aria-label="Canvas view" onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" className={rulers ? 'on' : undefined} aria-pressed={rulers} aria-label="Rulers and guides" title="Rulers and guides (Shift R)" onClick={() => v.setRulers(!rulers)}>
        <Ruler size={14} />
      </button>
      <select aria-label="Safe zone overlay" title="Show where a platform's buttons and captions cover the video" value={zone ?? ''} onChange={(e) => v.setSafeZone((e.target.value || null) as SafeZoneId | null)}>
        <option value="">No safe zone</option>
        {SAFE_ZONES.map((z) => (
          <option key={z.id} value={z.id}>{z.name}</option>
        ))}
      </select>
      {rulers && count > 0 && (
        <button type="button" aria-label="Clear guides" title="Remove every guide" onClick={() => v.setGuides({ v: [], h: [] })}>
          <X size={13} /> <span>{count}</span>
        </button>
      )}
    </div>
  )
}
