// Tone curve editor (the Colour tab's curves): drag a point, click the curve's box to add one, or focus a point and
// use the arrow keys (Shift: bigger steps); Delete removes it. The end points can move but not be removed.
import type { CurvePoints } from '@producer/core'
import { cleanCurve, evalCurve } from '@producer/core'
import { useRef, useState } from 'react'

const SIZE = 180
const PAD = 10
const px = (x: number) => PAD + x * (SIZE - 2 * PAD)
const py = (y: number) => PAD + (1 - y) * (SIZE - 2 * PAD)

export const STRAIGHT: CurvePoints = [
  [0, 0],
  [1, 1],
]

const pct = (v: number) => `${Math.round(v * 100)} %`

export function ToneCurve({ value, onChange, onEnd, color = 'var(--text)', label }: { value: CurvePoints | undefined; onChange: (pts: CurvePoints) => void; onEnd?: () => void; color?: string; label: string }) {
  const svg = useRef<SVGSVGElement>(null)
  const pts = value && value.length >= 2 ? value : STRAIGHT
  const [focus, setFocus] = useState<number | null>(null)
  const path = Array.from({ length: 65 }, (_, i) => `${i ? 'L' : 'M'}${px(i / 64).toFixed(1)},${py(evalCurve(pts, i / 64)).toFixed(1)}`).join(' ')

  /** Move point i, kept between its neighbours. */
  const move = (list: CurvePoints, i: number, x: number, y: number): CurvePoints => {
    const lo = i > 0 ? list[i - 1][0] + 0.01 : 0
    const hi = i < list.length - 1 ? list[i + 1][0] - 0.01 : 1
    const next = list.map((p) => [...p] as [number, number])
    next[i] = [Math.min(hi, Math.max(lo, x)), Math.min(1, Math.max(0, y))]
    return next
  }
  const at = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect()
    const k = r.width / SIZE || 1
    return { x: ((e.clientX - r.left) / k - PAD) / (SIZE - 2 * PAD), y: 1 - ((e.clientY - r.top) / k - PAD) / (SIZE - 2 * PAD) }
  }
  const drag = (start: CurvePoints, i: number) => {
    let cur = start
    const mv = (ev: PointerEvent) => {
      const p = at(ev)
      cur = move(cur, i, p.x, p.y)
      onChange(cur)
    }
    const up = () => {
      window.removeEventListener('pointermove', mv)
      window.removeEventListener('pointerup', up)
      onEnd?.()
    }
    window.addEventListener('pointermove', mv)
    window.addEventListener('pointerup', up)
  }
  const addAt = (x: number, y: number): { list: CurvePoints; i: number } => {
    const list = cleanCurve([...pts, [x, y]])
    return { list, i: list.findIndex((p) => Math.abs(p[0] - Math.min(1, Math.max(0, x))) < 1e-4) }
  }
  const downBox = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget && !(e.target as Element).classList.contains('tc-hit')) return
    e.preventDefault()
    const p = at(e)
    if (p.x <= 0.01 || p.x >= 0.99) return
    const { list, i } = addAt(p.x, p.y)
    onChange(list)
    setFocus(i)
    drag(list, i)
  }
  const downPoint = (e: React.PointerEvent, i: number) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.currentTarget as SVGElement).focus?.()
    setFocus(i)
    drag(pts, i)
  }
  const remove = (i: number) => {
    if (i === 0 || i === pts.length - 1) return
    onChange(pts.filter((_, j) => j !== i))
    setFocus(Math.max(0, i - 1))
  }
  const key = (e: React.KeyboardEvent, i: number) => {
    const d = e.shiftKey ? 0.1 : 0.01
    const moves: Record<string, [number, number]> = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation()
      return remove(i)
    }
    const m = moves[e.key]
    if (!m) return
    e.preventDefault()
    e.stopPropagation()
    onChange(move(pts, i, pts[i][0] + m[0], pts[i][1] + m[1]))
  }
  /** Keyboard: a new point in the middle of the widest gap, on the curve. */
  const addPoint = () => {
    let best = 0
    for (let i = 1; i < pts.length - 1; i++) if (pts[i + 1][0] - pts[i][0] > pts[best + 1][0] - pts[best][0]) best = i
    const x = (pts[best][0] + pts[best + 1][0]) / 2
    const { list, i } = addAt(x, evalCurve(pts, x))
    onChange(list)
    setFocus(i)
    requestAnimationFrame(() => svg.current?.querySelectorAll<SVGElement>('.tc-pt')[i]?.focus())
  }
  return (
    <div className="tc">
      <svg ref={svg} viewBox={`0 0 ${SIZE} ${SIZE}`} className="tc-box" role="group" aria-label={label} onPointerDown={downBox}>
        <rect x={px(0)} y={py(1)} width={px(1) - px(0)} height={py(0) - py(1)} className="tc-hit" />
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} className="tc-grid">
            <line x1={px(g)} y1={py(0)} x2={px(g)} y2={py(1)} />
            <line x1={px(0)} y1={py(g)} x2={px(1)} y2={py(g)} />
          </g>
        ))}
        <line x1={px(0)} y1={py(0)} x2={px(1)} y2={py(1)} className="tc-diag" />
        <path d={path} className="tc-line" style={{ stroke: color }} />
        {pts.map(([x, y], i) => (
          <circle
            key={i}
            cx={px(x)}
            cy={py(y)}
            r={5}
            className="tc-pt"
            tabIndex={0}
            role="slider"
            aria-label={i === 0 ? 'Black point' : i === pts.length - 1 ? 'White point' : `Point ${i}`}
            aria-valuetext={`input ${pct(x)}, output ${pct(y)}`}
            aria-valuenow={Math.round(y * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            data-focus={focus === i || undefined}
            onFocus={() => setFocus(i)}
            onPointerDown={(e) => downPoint(e, i)}
            onKeyDown={(e) => key(e, i)}
            onKeyUp={() => onEnd?.()}
          />
        ))}
      </svg>
      <div className="tc-side">
        <button type="button" className="btn sm" onClick={addPoint}>Add point</button>
        <button type="button" className="btn sm" disabled={focus === null || focus === 0 || focus === pts.length - 1} onClick={() => focus !== null && remove(focus)}>
          Remove point
        </button>
      </div>
    </div>
  )
}
