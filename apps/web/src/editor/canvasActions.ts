// Canvas actions on the selection: object bounds at the playhead, align and distribute, and group moves.
import type { FrameLayer, Project } from '@producer/core'
import { editable, evaluate, findItem } from '@producer/core'
import * as A from './actions'
import { alignBoxes, distributeBoxes, objBox, union, type AlignMode, type ObjBox } from './canvasSnap'
import { useEditor } from './store'

const TRANSFORM_RE = /rotate\(([-\d.e]+)deg\) scale\(([-\d.e]+), ([-\d.e]+)\)/

export function parseTransform(t: string) {
  const m = t.match(TRANSFORM_RE)
  return m ? { rot: +m[1], sx: +m[2], sy: +m[3] } : { rot: 0, sx: 1, sy: 1 }
}

/** Height of a layer drawn at its content's height (text): the renderer's element in the canvas has it. */
export function layerHeight(layer: FrameLayer): number {
  if (layer.box.height > 0) return layer.box.height
  const el = typeof document !== 'undefined' ? (document.querySelector(`.cv-stage [data-ps-layer="${layer.itemId}"]`) as HTMLElement | null) : null
  return el?.offsetHeight ?? 0
}

/** Bounds of the visual objects on screen at time t (captions aside), in canvas px. */
export function layerBoxes(p: Project, t: number): ObjBox[] {
  return evaluate(p, t)
    .layers.filter((l) => l.type !== 'caption')
    .map((l) => {
      const { rot, sx, sy } = parseTransform(l.transform)
      return objBox(l.itemId, l.box.cx, l.box.cy, l.box.width * Math.abs(sx), layerHeight(l) * Math.abs(sy), rot)
    })
}

/** The selected objects that can move (on screen now, unlocked, not captions). */
export function movableSelection(p = useEditor.getState().project, t = useEditor.getState().playhead): ObjBox[] {
  const ids = new Set(useEditor.getState().selection)
  return layerBoxes(p, t).filter((b) => ids.has(b.id) && editable(findItem(p, b.id)))
}

/** Move items by canvas px (each through its keyframes when it is animated). */
export function moveBy(p0: Project, deltas: Map<string, { dx: number; dy: number }>, playhead: number): Project {
  let p = p0
  for (const [id, { dx, dy }] of deltas) {
    const it = findItem(p, id)?.item
    if (!it || !('transform' in it)) continue
    if (Math.abs(dx) > 1e-6) p = A.writeProp(p, id, 'x', Math.round(A.readProp(it, 'x', playhead) + dx), playhead)
    const it2 = findItem(p, id)!.item
    if (Math.abs(dy) > 1e-6) p = A.writeProp(p, id, 'y', Math.round(A.readProp(it2, 'y', playhead) + dy), playhead)
  }
  return p
}

const ALIGN_LABEL: Record<AlignMode, string> = { left: 'Align left', hcenter: 'Align centre', right: 'Align right', top: 'Align top', vcenter: 'Align middle', bottom: 'Align bottom' }

/** Line the selection up with its own bounds; one object lines up with the canvas. */
export function alignSelection(mode: AlignMode) {
  const s = useEditor.getState()
  const boxes = movableSelection()
  if (!boxes.length) return
  const ref = boxes.length === 1 ? { left: 0, top: 0, right: s.project.width, bottom: s.project.height } : union(boxes)!
  const p = moveBy(s.project, alignBoxes(boxes, mode, ref), s.playhead)
  if (p !== s.project) s.commit(p, boxes.length === 1 ? `${ALIGN_LABEL[mode]} to canvas` : ALIGN_LABEL[mode])
}

/** Equal spacing between three or more selected objects. */
export function distributeSelection(axis: 'x' | 'y') {
  const s = useEditor.getState()
  const boxes = movableSelection()
  if (boxes.length < 3) return
  const p = moveBy(s.project, distributeBoxes(boxes, axis), s.playhead)
  if (p !== s.project) s.commit(p, axis === 'x' ? 'Distribute horizontally' : 'Distribute vertically')
}
