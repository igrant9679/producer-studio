// Smart tools on the canvas (E-21): a clip's mask with handles (move, resize, rotate, a drawn path's corners),
// drawing a path mask corner by corner, and the chroma key eyedropper. It lies over the canvas while one of them is
// on, and takes the pointer so the clip underneath doesn't move; Escape (or a click off the mask) ends it.
import type { FrameLayer, ImageItem, Mask, MaskProp, VideoItem } from '@producer/core'
import { evaluate, findItem, maskAt, takesMask } from '@producer/core'
import clsx from 'clsx'
import { useEffect, useMemo } from 'react'
import { localTime } from './actions'
import { parseTransform } from './canvasActions'
import { useThrottledPlayhead } from './controls'
import { addDrawPoint, cancelDrawing, cancelPicking, finishDrawing, frameFraction, patchMask, pickKeyAt, undoDrawPoint, useSmart, writeMask } from './smartActions'
import { useEditor } from './store'

type Pictured = VideoItem | ImageItem

/** Screen place of a layer box inside the canvas box (px), as the selection overlay draws it. */
function screenGeo(layer: FrameLayer, scale: number) {
  const { rot, sx, sy } = parseTransform(layer.transform)
  return { cx: layer.box.cx * scale, cy: layer.box.cy * scale, w: layer.box.width * Math.abs(sx) * scale, h: layer.box.height * Math.abs(sy) * scale, rot, fx: Math.sign(sx) || 1, fy: Math.sign(sy) || 1 }
}

export function SmartCanvasOverlay({ scale, boxRef }: { scale: number; boxRef: React.RefObject<HTMLDivElement> }) {
  const maskEdit = useSmart((s) => s.maskEdit)
  const drawing = useSmart((s) => s.drawing)
  const picking = useSmart((s) => s.picking)
  const selection = useEditor((s) => s.selection)
  const project = useEditor((s) => s.project)
  const playing = useEditor((s) => s.playing)
  const playhead = useThrottledPlayhead()
  const id = drawing?.itemId ?? picking ?? maskEdit
  const item = id ? (findItem(project, id)?.item as Pictured | undefined) : undefined
  const layer = useMemo(() => (id ? evaluate(project, playhead).layers.find((l) => l.itemId === id) : undefined), [id, project, playhead])

  // the clip went away, or another one was selected: its handles go too
  useEffect(() => {
    if (maskEdit && (!selection.includes(maskEdit) || !takesMask(findItem(project, maskEdit)?.item) || !(findItem(project, maskEdit)?.item as Pictured).mask)) useSmart.setState({ maskEdit: null })
    if (drawing && !findItem(project, drawing.itemId)) cancelDrawing()
    if (picking && !findItem(project, picking)) cancelPicking()
  }, [maskEdit, drawing, picking, selection, project])

  // keys while drawing or picking (before the editor's shortcuts: Backspace must not delete the clip)
  useEffect(() => {
    if (!drawing && !picking && !maskEdit) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      const stop = () => {
        e.preventDefault()
        e.stopPropagation()
      }
      if (e.key === 'Escape') {
        stop()
        useSmart.setState({ drawing: null, picking: null, maskEdit: null })
      } else if (drawing && e.key === 'Enter') {
        stop()
        finishDrawing()
      } else if (drawing && (e.key === 'Backspace' || e.key === 'Delete')) {
        stop()
        undoDrawPoint()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [drawing, picking, maskEdit])

  if (!id || !item || playing) return null
  const canvasPt = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }
  }
  const hint = drawing
    ? `Drawing a mask: ${drawing.points.length} corner${drawing.points.length === 1 ? '' : 's'} · Enter to close · Esc to stop`
    : picking
      ? 'Click the colour to key out · Esc to stop'
      : 'Drag the mask or its handles · Esc when done'
  if (!layer) {
    return (
      <div className="cv-smart">
        <div className="cv-smart-hint" role="status">Move the playhead over the clip to {drawing ? 'draw its mask' : picking ? 'pick its colour' : 'edit its mask'}</div>
      </div>
    )
  }
  const g = screenGeo(layer, scale)
  const frame = (e: { clientX: number; clientY: number }) => frameFraction(layer, canvasPt(e))

  const onDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    if (e.button !== 0) return
    e.preventDefault()
    if (picking) {
      const [fx, fy] = frame(e)
      pickKeyAt(picking, fx, fy)
      return
    }
    if (drawing) {
      const pt = frame(e)
      const first = drawing.points[0]
      // a click on the first corner closes the shape
      if (first && drawing.points.length >= 3 && Math.hypot((pt[0] - first[0]) * g.w, (pt[1] - first[1]) * g.h) < 10) {
        finishDrawing()
        return
      }
      addDrawPoint([+pt[0].toFixed(4), +pt[1].toFixed(4)])
      return
    }
    // a click off the mask ends editing
    useSmart.setState({ maskEdit: null })
  }

  return (
    <div className={clsx('cv-smart', 'catch')} onPointerDown={onDown} onDoubleClick={(e) => (e.stopPropagation(), drawing && finishDrawing())} data-smart-overlay>
      <div className="cv-smart-hint" role="status">{hint}</div>
      <div className="cv-mask" style={{ left: g.cx, top: g.cy, width: g.w, height: g.h, transform: `translate(-50%,-50%) rotate(${g.rot}deg) scale(${g.fx}, ${g.fy})` }}>
        <svg viewBox={`0 0 ${Math.max(1, g.w)} ${Math.max(1, g.h)}`} preserveAspectRatio="none" aria-hidden>
          <rect className="cv-mask-box" x={0} y={0} width={g.w} height={g.h} />
          {drawing && <DrawnSoFar points={drawing.points} w={g.w} h={g.h} />}
          {!drawing && !picking && item.mask && <MaskHandles item={item} mask={maskAt(item, localTime(item, playhead))!} g={g} frame={frame} />}
        </svg>
      </div>
    </div>
  )
}

function DrawnSoFar({ points, w, h }: { points: Array<[number, number]>; w: number; h: number }) {
  const pts = points.map(([x, y]) => `${x * w},${y * h}`).join(' ')
  return (
    <>
      {points.length > 1 && <polygon className="cv-draw-line" points={pts} />}
      {points.map(([x, y], i) => (
        <circle key={i} className={clsx('cv-draw-pt', i === 0 && 'first')} cx={x * w} cy={y * h} r={i === 0 ? 5 : 4} />
      ))}
    </>
  )
}

type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w'

function MaskHandles({ item, mask, g, frame }: { item: Pictured; mask: Mask; g: ReturnType<typeof screenGeo>; frame: (e: { clientX: number; clientY: number }) => [number, number] }) {
  // the mask on screen, in px of the clip's box
  const mx = mask.x * g.w
  const my = mask.y * g.h
  const mw = mask.width * g.w
  const mh = mask.height * g.h

  /** A pointer's place relative to the mask's centre, unrotated, in screen px of the box. */
  const local = (f: [number, number], m = mask) => {
    const dx = (f[0] - m.x) * g.w
    const dy = (f[1] - m.y) * g.h
    const a = (-m.rotation * Math.PI) / 180
    return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a), dx, dy }
  }

  const drag = (e: React.PointerEvent, onMove: (ev: PointerEvent, f: [number, number]) => void) => {
    e.stopPropagation()
    e.preventDefault()
    const move = (ev: PointerEvent) => onMove(ev, frame(ev))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      useEditor.getState().endCoalesce()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const orig = () => useEditor.getState().project
  const write = (values: Partial<Record<MaskProp, number>>, label: string, base: ReturnType<typeof orig>) => writeMask(item.id, values, label, `maskdrag:${item.id}`, base)

  const startMove = (e: React.PointerEvent) => {
    const base = orig()
    const f0 = frame(e)
    const m0 = mask
    drag(e, (_ev, f) => write({ maskX: +(m0.x + f[0] - f0[0]).toFixed(4), maskY: +(m0.y + f[1] - f0[1]).toFixed(4) }, 'Move mask', base))
  }

  const startResize = (e: React.PointerEvent, h: Handle) => {
    const base = orig()
    const m0 = mask
    drag(e, (_ev, f) => {
      const l = local(f, m0)
      const v: Partial<Record<MaskProp, number>> = {}
      if (h !== 'n' && h !== 's') v.maskWidth = +Math.max(0.01, (2 * Math.abs(l.x)) / g.w).toFixed(4)
      if (h !== 'e' && h !== 'w') v.maskHeight = +Math.max(0.01, (2 * Math.abs(l.y)) / g.h).toFixed(4)
      write(v, 'Resize mask', base)
    })
  }

  const startRotate = (e: React.PointerEvent) => {
    const base = orig()
    const m0 = mask
    drag(e, (ev, f) => {
      const l = local(f, m0)
      let r = (Math.atan2(l.dy, l.dx) * 180) / Math.PI + 90
      if (r > 180) r -= 360
      if (ev.shiftKey) r = Math.round(r / 15) * 15
      write({ maskRotation: +r.toFixed(2) }, 'Rotate mask', base)
    })
  }

  const startPoint = (e: React.PointerEvent, i: number) => {
    const m0 = mask
    drag(e, (_ev, f) => {
      const l = local(f, m0)
      const pts = (m0.points ?? []).map((p) => [...p] as [number, number])
      pts[i] = [Math.max(-1, Math.min(1, +(l.x / Math.max(1, mw)).toFixed(4))), Math.max(-1, Math.min(1, +(l.y / Math.max(1, mh)).toFixed(4)))]
      patchMask(item.id, { points: pts }, 'Move mask corner', `maskpt:${item.id}`)
    })
  }

  const outline =
    mask.shape === 'ellipse' ? (
      <ellipse className="cv-mask-outline" cx={0} cy={0} rx={mw / 2} ry={mh / 2} onPointerDown={startMove} />
    ) : mask.shape === 'path' ? (
      <path className="cv-mask-outline" d={`${(mask.points ?? []).map(([x, y], i) => `${i ? 'L' : 'M'}${x * mw} ${y * mh}`).join(' ')} Z`} onPointerDown={startMove} />
    ) : (
      <rect className="cv-mask-outline" x={-mw / 2} y={-mh / 2} width={mw} height={mh} rx={mask.radius * Math.min(mw, mh) * 0.5} onPointerDown={startMove} />
    )
  const corners: Array<[Handle, number, number]> = [
    ['nw', -mw / 2, -mh / 2],
    ['ne', mw / 2, -mh / 2],
    ['sw', -mw / 2, mh / 2],
    ['se', mw / 2, mh / 2],
    ['n', 0, -mh / 2],
    ['s', 0, mh / 2],
    ['e', mw / 2, 0],
    ['w', -mw / 2, 0],
  ]
  return (
    <g transform={`translate(${mx} ${my}) rotate(${mask.rotation})`} data-mask-handles>
      {outline}
      {mask.shape === 'path' && <rect className="cv-mask-box" x={-mw / 2} y={-mh / 2} width={mw} height={mh} />}
      <line className="cv-mask-box" x1={0} y1={-mh / 2} x2={0} y2={-mh / 2 - 22} />
      <circle className="cv-mask-h rot" cx={0} cy={-mh / 2 - 22} r={5} onPointerDown={startRotate} data-handle="rotate">
        <title>Rotate the mask (Shift: 15° steps)</title>
      </circle>
      {corners.map(([h, x, y]) => (
        <rect key={h} className={clsx('cv-mask-h', h.length === 2 ? 'corner' : 'side')} x={x - 4.5} y={y - 4.5} width={9} height={9} rx={2} onPointerDown={(e) => startResize(e, h)} data-handle={h}>
          <title>Resize the mask</title>
        </rect>
      ))}
      {mask.shape === 'path' &&
        (mask.points ?? []).map(([x, y], i) => (
          <circle key={`p${i}`} className="cv-mask-h pt" cx={x * mw} cy={y * mh} r={4.5} onPointerDown={(e) => startPoint(e, i)} data-handle={`point-${i}`}>
            <title>Move this corner</title>
          </circle>
        ))}
    </g>
  )
}
