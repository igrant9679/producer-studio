// Freeze frames (E-24): a hold of any length, at the end of a clip, and the length of one already made.
import { clone, editable, findItem, freezeFrame, itemEnd, packMain } from './ops'
import type { Project } from './types'
import { EPS, round } from './util'

export const FREEZE_MIN = 0.1
export const FREEZE_MAX = 30

/** Hold the last frame of a video clip for `holdSec`, right after it. */
export function freezeAtEnd(p0: Project, itemId: string, holdSec = 2): Project {
  const f = findItem(p0, itemId)
  if (!editable(f) || f.item.type !== 'video' || f.item.freezeAt !== undefined) return p0
  // half a frame before the end: too near the edge to cut, so the hold goes after the clip, showing its last frame
  return freezeFrame(p0, itemId, itemEnd(f.item) - 0.5 / p0.fps, holdSec)
}

/** Change how long a freeze frame holds. Later clips on its track move with its end (the main track re-packs). */
export function setFreezeHold(p0: Project, itemId: string, holdSec: number): Project {
  const f = findItem(p0, itemId)
  if (!editable(f) || f.item.type !== 'video' || f.item.freezeAt === undefined || !(holdSec > 0)) return p0
  const hold = round(Math.min(FREEZE_MAX, Math.max(FREEZE_MIN, holdSec)), 4)
  const by = hold - f.item.duration
  if (Math.abs(by) < EPS) return p0
  const p = clone(p0)
  const g = findItem(p, itemId)!
  const end = itemEnd(g.item)
  g.item.duration = hold
  if (g.track.main) packMain(p)
  else {
    const links = new Set<string>()
    for (const i of g.track.items)
      if (i !== g.item && i.start >= end - EPS) {
        i.start = round(i.start + by, 4)
        if (i.linkId) links.add(i.linkId)
      }
    for (const t of p.tracks) if (t !== g.track) for (const i of t.items) if (i.linkId && links.has(i.linkId)) i.start = Math.max(0, round(i.start + by, 4))
  }
  p.updatedAt = Date.now()
  return p
}
