// Keyframe diamonds on a timeline clip: click to go to one, drag to move every keyframe at that time (frame by frame).
import type { Item } from '@producer/core'
import { editable, findItem, moveKeyframes } from '@producer/core'
import { Diamond } from 'lucide-react'
import * as A from './actions'
import { useEditor } from './store'

export function KeyframeDots({ item, times, zoom, locked }: { item: Item; times: number[]; zoom: number; locked: boolean }) {
  const down = (e: React.PointerEvent, t0: number) => {
    e.stopPropagation()
    const s0 = useEditor.getState()
    s0.select([item.id])
    A.seek(item.start + t0)
    if (e.button > 0 || locked || !editable(findItem(s0.project, item.id))) return
    e.preventDefault()
    const orig = s0.project
    const fps = orig.fps
    const x0 = e.clientX
    let moved = false
    const mv = (ev: PointerEvent) => {
      const dx = ev.clientX - x0
      if (!moved && Math.abs(dx) < 3) return
      moved = true
      const to = Math.max(0, Math.min(item.duration, Math.round((t0 + dx / zoom) * fps) / fps))
      const s = useEditor.getState()
      s.commit(moveKeyframes(orig, item.id, t0, to), 'Move keyframes', { coalesce: `kfdots:${item.id}` })
      A.seek(item.start + to)
    }
    const up = () => {
      window.removeEventListener('pointermove', mv)
      window.removeEventListener('pointerup', up)
      useEditor.getState().endCoalesce()
    }
    window.addEventListener('pointermove', mv)
    window.addEventListener('pointerup', up)
  }
  return (
    <>
      {times.map((t, i) => (
        <button
          key={i}
          tabIndex={-1}
          className="tl-kfdot"
          style={{ left: t * zoom, cursor: locked ? 'pointer' : 'ew-resize' }}
          title={`Keyframe at ${t.toFixed(2)}s${locked ? '' : ' · drag to move'}`}
          onPointerDown={(e) => down(e, t)}
        >
          <Diamond size={8} fill="currentColor" />
        </button>
      ))}
    </>
  )
}
