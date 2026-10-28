// Review comments on the timeline ruler and the canvas (E-22). A mark per open thread at its time: clicking it goes
// there and opens the thread in the Comments panel. On the canvas, a thread's point shows as a pin around its moment,
// and the panel's "Point at the frame" picks a point with a click.
import { commentMarks, threadsOf } from '@producer/core'
import { useMemo } from 'react'
import { tipProps } from '../../lib/tooltip'
import { clock, CommentPins } from '../../shell/components/CommentThreads'
import * as A from '../actions'
import { useThrottledPlayhead } from '../controls'
import { useEditor } from '../store'
import { useComments } from './comments'
import './collab.css'

export function openThread(id: string, at: number) {
  useComments.getState().set({ activeId: id })
  useEditor.setState({ activeLeftTab: 'comments', leftCollapsed: false, playing: false })
  A.seek(at)
}

export function CommentMarks({ zoom }: { zoom: number }) {
  const list = useComments((s) => s.list)
  const activeId = useComments((s) => s.activeId)
  const marks = useMemo(() => commentMarks(list), [list])
  const byId = useMemo(() => new Map(list.map((c) => [c.id, c])), [list])
  if (!marks.length) return null
  return (
    <div className="ed-cm-marks" role="group" aria-label="Comments on the timeline" onPointerDown={(e) => e.stopPropagation()}>
      {marks.map((m) => {
        const c = byId.get(m.id)!
        const label = `Comment by ${c.author.name} at ${clock(m.at)}${m.count > 1 ? `, ${m.count - 1} repl${m.count === 2 ? 'y' : 'ies'}` : ''}`
        return (
          <button
            key={m.id}
            type="button"
            className={`ed-cm-mark${m.id === activeId ? ' on' : ''}`}
            style={{ left: m.at * zoom, background: c.author.color }}
            {...tipProps(`${c.author.name} · ${clock(m.at)}`, c.body.length > 140 ? `${c.body.slice(0, 140)}…` : c.body, undefined, 'bottom')}
            aria-label={label}
            onClick={() => openThread(m.id, m.at)}
          >
            {m.count > 1 ? m.count : ''}
          </button>
        )
      })}
    </div>
  )
}

/** Mounted over the canvas stage (same box as the picture). */
export function CanvasCommentPins() {
  const list = useComments((s) => s.list)
  const picking = useComments((s) => s.picking)
  const point = useComments((s) => s.point)
  const time = useThrottledPlayhead()
  const threads = useMemo(() => threadsOf(list), [list])
  if (!picking && !point && !threads.some((t) => t.x !== undefined)) return null
  return <CommentPins threads={threads} time={time} picking={picking} point={point} onPick={(p) => useComments.getState().set({ point: p, picking: false })} />
}
