// Cubic-bezier curve editor for a keyframe's ease: drag the two control points (or focus one and use the arrow
// keys), type the four numbers, or start from a named ease.
import type { Bezier } from '@producer/core'
import { EASE_CURVES, cleanBezier, cubicBezier } from '@producer/core'
import { useRef } from 'react'
import { NumberInput } from './controls'

const SIZE = 132
const PAD = 22
/** y from -0.5 to 1.5 fits in the box (enough to see an overshoot). */
const Y_LO = -0.5
const Y_HI = 1.5

const px = (x: number) => PAD + x * (SIZE - 2 * PAD)
const py = (y: number) => PAD + ((Y_HI - y) / (Y_HI - Y_LO)) * (SIZE - 2 * PAD)

const PRESETS: Array<{ id: keyof typeof EASE_CURVES; name: string }> = [
  { id: 'linear', name: 'Linear' },
  { id: 'easeIn', name: 'In' },
  { id: 'easeOut', name: 'Out' },
  { id: 'easeInOut', name: 'In-out' },
]

export function CurveEditor({ value, onChange, onEnd }: { value: Bezier; onChange: (b: Bezier, drag?: boolean) => void; onEnd?: () => void }) {
  const svg = useRef<SVGSVGElement>(null)
  const [x1, y1, x2, y2] = value
  const path = Array.from({ length: 41 }, (_, i) => {
    const x = i / 40
    return `${i ? 'L' : 'M'}${px(x).toFixed(1)},${py(cubicBezier(value, x)).toFixed(1)}`
  }).join(' ')
  const set = (i: 0 | 1, x: number, y: number, drag?: boolean) => {
    const b: Bezier = [...value]
    b[i * 2] = x
    b[i * 2 + 1] = y
    onChange(cleanBezier(b), drag)
  }
  const down = (e: React.PointerEvent, i: 0 | 1) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as SVGElement).focus?.()
    const r = svg.current!.getBoundingClientRect()
    const k = r.width / SIZE || 1
    const mv = (ev: PointerEvent) => {
      const x = ((ev.clientX - r.left) / k - PAD) / (SIZE - 2 * PAD)
      const y = Y_HI - (((ev.clientY - r.top) / k - PAD) / (SIZE - 2 * PAD)) * (Y_HI - Y_LO)
      set(i, x, y, true)
    }
    const up = () => {
      window.removeEventListener('pointermove', mv)
      window.removeEventListener('pointerup', up)
      onEnd?.()
    }
    window.addEventListener('pointermove', mv)
    window.addEventListener('pointerup', up)
  }
  const key = (e: React.KeyboardEvent, i: 0 | 1) => {
    const d = e.shiftKey ? 0.1 : 0.01
    const x = value[i * 2]
    const y = value[i * 2 + 1]
    const moves: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }
    const m = moves[e.key]
    if (!m) return
    e.preventDefault()
    e.stopPropagation()
    set(i, x + m[0], y + m[1], true)
  }
  const handle = (i: 0 | 1) => {
    const x = value[i * 2]
    const y = value[i * 2 + 1]
    const ax = i === 0 ? 0 : 1
    const ay = i === 0 ? 0 : 1
    return (
      <g key={i}>
        <line x1={px(ax)} y1={py(ay)} x2={px(x)} y2={py(y)} className="cv-curve-arm" />
        <circle
          cx={px(x)}
          cy={py(y)}
          r={6}
          className="cv-curve-pt"
          tabIndex={0}
          role="slider"
          aria-label={`${i === 0 ? 'First' : 'Second'} control point`}
          aria-valuetext={`x ${x.toFixed(2)}, y ${y.toFixed(2)}`}
          aria-valuenow={y}
          aria-valuemin={-1}
          aria-valuemax={2}
          onPointerDown={(e) => down(e, i)}
          onKeyDown={(e) => key(e, i)}
          onKeyUp={() => onEnd?.()}
        />
      </g>
    )
  }
  return (
    <div className="cv-curve">
      <svg ref={svg} viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} role="group" aria-label="Ease curve">
        <rect x={px(0)} y={py(1)} width={px(1) - px(0)} height={py(0) - py(1)} className="cv-curve-box" />
        <line x1={px(0)} y1={py(0)} x2={px(1)} y2={py(1)} className="cv-curve-diag" />
        <path d={path} className="cv-curve-line" />
        {handle(0)}
        {handle(1)}
      </svg>
      <div className="cv-curve-side">
        <div className="cv-curve-nums">
          <NumberInput label="Point 1 x" value={x1} step={0.01} min={0} max={1} width={56} onChange={(v) => set(0, v, y1)} />
          <NumberInput label="Point 1 y" value={y1} step={0.01} min={-1} max={2} width={56} onChange={(v) => set(0, x1, v)} />
          <NumberInput label="Point 2 x" value={x2} step={0.01} min={0} max={1} width={56} onChange={(v) => set(1, v, y2)} />
          <NumberInput label="Point 2 y" value={y2} step={0.01} min={-1} max={2} width={56} onChange={(v) => set(1, x2, v)} />
        </div>
        <div className="cv-curve-presets" role="group" aria-label="Start from">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className="chip" onClick={() => onChange(EASE_CURVES[p.id])}>
              {p.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
