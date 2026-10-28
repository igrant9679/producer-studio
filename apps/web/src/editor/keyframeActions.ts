// Keyframe actions shared by the properties panel and the shortcuts: previous / next keyframe and the keyframe clipboard.
import type { AnimProp, Item, KeyframeClip } from '@producer/core'
import { adjacentKeyframe, findItem } from '@producer/core'
import * as A from './actions'
import { useEditor } from './store'

let clip: KeyframeClip | null = null
const listeners = new Set<() => void>()

export function subscribeKeyframeClipboard(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
export const keyframeClipboard = () => clip
/** Copied keyframes stay available to paste onto any clip (another clip, another time). */
export function setKeyframeClipboard(c: KeyframeClip | null) {
  clip = c
  for (const fn of listeners) fn()
}

function selectedOne(): Item | undefined {
  const s = useEditor.getState()
  return s.selection.length === 1 ? findItem(s.project, s.selection[0])?.item : undefined
}

/** Move the playhead to the selected clip's previous (-1) or next (1) keyframe; false when there is none. */
export function jumpToKeyframe(dir: 1 | -1, prop?: AnimProp): boolean {
  const it = selectedOne()
  if (!it) return false
  const s = useEditor.getState()
  const t = adjacentKeyframe(it, s.playhead - it.start, dir, s.project.fps, prop)
  if (t === undefined) return false
  s.setPlaying(false)
  A.seek(it.start + t)
  return true
}
