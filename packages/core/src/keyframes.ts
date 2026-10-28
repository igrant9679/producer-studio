// Keyframe editing: move, ease, step between, copy and paste. Times are seconds from the item's start; two keyframes
// within half a frame of each other count as the same one (as setKeyframe and removeKeyframe treat them).
import { clone, editable, findItem } from './ops'
import type { AnimProp, Bezier, EaseName, Item, Keyframe, Keyframes, Project } from './types'
import { round } from './util'

/** The cubic-bezier each named ease is closest to: where the curve editor starts from a named ease. */
export const EASE_CURVES: Record<'linear' | 'easeIn' | 'easeOut' | 'easeInOut', Bezier> = {
  linear: [0, 0, 1, 1],
  easeIn: [0.32, 0, 0.67, 0],
  easeOut: [0.33, 1, 0.68, 1],
  easeInOut: [0.65, 0, 0.35, 1],
}

export const EASE_NAMES: Array<{ id: EaseName; name: string }> = [
  { id: 'linear', name: 'Linear' },
  { id: 'easeIn', name: 'Ease in' },
  { id: 'easeOut', name: 'Ease out' },
  { id: 'easeInOut', name: 'Ease in and out' },
  { id: 'hold', name: 'Hold' },
  { id: 'bezier', name: 'Custom curve' },
]

const VISUAL_PROPS: AnimProp[] = ['x', 'y', 'scale', 'rotation', 'opacity']

/** The properties of an item that can carry keyframes. */
export function animatableProps(it: Item): AnimProp[] {
  if (it.type === 'audio') return ['volume']
  if (it.type === 'caption') return []
  return it.type === 'video' ? [...VISUAL_PROPS, 'volume'] : VISUAL_PROPS
}

function kfsOf(it: Item): Keyframes {
  return 'keyframes' in it && it.keyframes ? it.keyframes : {}
}

const half = (fps: number) => 1 / (Math.max(1, fps) * 2)

/** Keyframe times inside the item (of one property, or of all), sorted and without repeats. */
export function keyframeTimes(it: Item, prop?: AnimProp): number[] {
  const kfs = kfsOf(it)
  const out = new Set<number>()
  for (const [k, list] of Object.entries(kfs) as Array<[AnimProp, Keyframe[]]>) {
    if (prop && k !== prop) continue
    for (const kf of list ?? []) if (kf.t >= -1e-3 && kf.t <= it.duration + 1e-3) out.add(round(kf.t, 4))
  }
  return [...out].sort((a, b) => a - b)
}

/** The nearest keyframe time before (dir -1) or after (dir 1) `localT`, more than half a frame away. */
export function adjacentKeyframe(it: Item, localT: number, dir: 1 | -1, fps: number, prop?: AnimProp): number | undefined {
  const h = half(fps)
  const times = keyframeTimes(it, prop)
  if (dir > 0) return times.find((t) => t > localT + h)
  for (let i = times.length - 1; i >= 0; i--) if (times[i] < localT - h) return times[i]
  return undefined
}

/** The keyframe of `prop` at `t` (within half a frame). */
export function keyframeAt(it: Item, prop: AnimProp, t: number, fps: number): Keyframe | undefined {
  const h = half(fps)
  return kfsOf(it)[prop]?.find((k) => Math.abs(k.t - t) < h)
}

function edit(p0: Project, itemId: string, fn: (kfs: Keyframes, it: Item, p: Project) => boolean): Project {
  const p = clone(p0)
  const f = findItem(p, itemId)
  if (!editable(f) || !('keyframes' in f.item)) return p0
  if (!fn(f.item.keyframes, f.item, p)) return p0
  p.updatedAt = Date.now()
  return p
}

/**
 * Move the keyframes at `fromT` (of `props`, or of every property) to `toT`, kept inside the item. A keyframe already
 * at `toT` is replaced by the one moved onto it.
 */
export function moveKeyframes(p0: Project, itemId: string, fromT: number, toT: number, props?: AnimProp[]): Project {
  return edit(p0, itemId, (kfs, it, p) => {
    const h = half(p.fps)
    const to = round(Math.max(0, Math.min(toT, it.duration)), 4)
    let moved = false
    for (const [k, list] of Object.entries(kfs) as Array<[AnimProp, Keyframe[]]>) {
      if (props && !props.includes(k)) continue
      const kf = list?.find((x) => Math.abs(x.t - fromT) < h)
      if (!kf) continue
      if (Math.abs(kf.t - to) < 1e-6) continue
      kfs[k] = list.filter((x) => x === kf || Math.abs(x.t - to) >= h)
      kf.t = to
      kfs[k]!.sort((a, b) => a.t - b.t)
      moved = true
    }
    return moved
  })
}

/** How the keyframe of `prop` at `t` eases into the next one; a curve goes with 'bezier'. */
export function setKeyframeEase(p0: Project, itemId: string, prop: AnimProp, t: number, easeName: EaseName, bezier?: Bezier): Project {
  return edit(p0, itemId, (kfs, _it, p) => {
    const kf = kfs[prop]?.find((x) => Math.abs(x.t - t) < half(p.fps))
    if (!kf) return false
    kf.ease = easeName
    if (easeName === 'bezier') kf.bezier = cleanBezier(bezier ?? kf.bezier ?? EASE_CURVES.easeInOut)
    else delete kf.bezier
    return true
  })
}

/** A curve with x inside 0..1 and y within -1..2 (enough for a strong overshoot), rounded for the document. */
export function cleanBezier(b: Bezier): Bezier {
  const x = (v: number) => round(Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)), 3)
  const y = (v: number) => round(Math.max(-1, Math.min(2, Number.isFinite(v) ? v : 0)), 3)
  return [x(b[0]), y(b[1]), x(b[2]), y(b[3])]
}

/** Keyframes copied from an item: times are relative to the first one copied. */
export interface KeyframeClip {
  keyframes: Keyframes
  /** From the first to the last keyframe copied (seconds). */
  span: number
}

/** Copy keyframes of `props` (default: every animated property), only those at `times` when given. */
export function copyKeyframes(it: Item, props?: AnimProp[], times?: number[], fps = 30): KeyframeClip | null {
  const h = half(fps)
  const picked: Array<[AnimProp, Keyframe[]]> = []
  for (const [k, list] of Object.entries(kfsOf(it)) as Array<[AnimProp, Keyframe[]]>) {
    if (props && !props.includes(k)) continue
    const keep = (list ?? []).filter((kf) => kf.t >= -1e-3 && kf.t <= it.duration + 1e-3 && (!times || times.some((t) => Math.abs(t - kf.t) < h)))
    if (keep.length) picked.push([k, keep])
  }
  if (!picked.length) return null
  const first = Math.min(...picked.flatMap(([, l]) => l.map((k) => k.t)))
  const last = Math.max(...picked.flatMap(([, l]) => l.map((k) => k.t)))
  const keyframes: Keyframes = {}
  for (const [k, l] of picked) keyframes[k] = l.map((kf) => ({ ...structuredClone(kf), t: round(kf.t - first, 4) }))
  return { keyframes, span: round(last - first, 4) }
}

/**
 * Paste copied keyframes into an item, the first at `atLocalT`. Only properties the item has are pasted; keyframes
 * already at a pasted time are replaced, and any that would land past the item's end are left out.
 */
export function pasteKeyframes(p0: Project, itemId: string, clip: KeyframeClip, atLocalT: number): Project {
  return edit(p0, itemId, (kfs, it, p) => {
    const h = half(p.fps)
    const allowed = new Set(animatableProps(it))
    let added = false
    for (const [k, list] of Object.entries(clip.keyframes) as Array<[AnimProp, Keyframe[]]>) {
      if (!allowed.has(k)) continue
      const cur = kfs[k] ?? []
      for (const src of list ?? []) {
        const t = round(Math.max(0, atLocalT) + src.t, 4)
        if (t > it.duration + 1e-6) continue
        const i = cur.findIndex((x) => Math.abs(x.t - t) < h)
        const kf = { ...structuredClone(src), t }
        if (i >= 0) cur[i] = kf
        else cur.push(kf)
        added = true
      }
      if (cur.length) kfs[k] = cur.sort((a, b) => a.t - b.t)
    }
    return added
  })
}

/** Remove every keyframe at `t` (within half a frame) of `props`, or of every property. */
export function removeKeyframesAt(p0: Project, itemId: string, t: number, props?: AnimProp[]): Project {
  return edit(p0, itemId, (kfs, _it, p) => {
    const h = half(p.fps)
    let removed = false
    for (const [k, list] of Object.entries(kfs) as Array<[AnimProp, Keyframe[]]>) {
      if (props && !props.includes(k)) continue
      const next = (list ?? []).filter((x) => Math.abs(x.t - t) >= h)
      if (next.length === list?.length) continue
      removed = true
      if (next.length) kfs[k] = next
      else delete kfs[k]
    }
    return removed
  })
}
