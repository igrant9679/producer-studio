// Canvas layout maths (pure): object bounds, snapping a moving box to edges / centres / guides / other objects,
// align and distribute, and the platform safe zones. All in canvas px with the origin at the top-left.

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface ObjBox extends Box {
  id: string
  cx: number
  cy: number
  /** Unrotated size and rotation (degrees) of the object itself. */
  w: number
  h: number
  rot: number
}

/** The axis-aligned bounds of a w × h box centred on (cx, cy) and rotated by `rot` degrees. */
export function objBox(id: string, cx: number, cy: number, w: number, h: number, rot: number): ObjBox {
  const r = (rot * Math.PI) / 180
  const c = Math.abs(Math.cos(r))
  const s = Math.abs(Math.sin(r))
  const hw = (w * c + h * s) / 2
  const hh = (w * s + h * c) / 2
  return { id, cx, cy, w, h, rot, left: cx - hw, right: cx + hw, top: cy - hh, bottom: cy + hh }
}

export function union(boxes: Box[]): Box | null {
  if (!boxes.length) return null
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  }
}

export interface SnapTargets {
  x: number[]
  y: number[]
}

/** Platform overlays: the share of the frame each app's buttons and captions cover (approximate; apps change). */
export const SAFE_ZONES = [
  { id: 'tiktok', name: 'TikTok', top: 0.08, bottom: 0.2, left: 0.05, right: 0.14 },
  { id: 'reels', name: 'Instagram Reels', top: 0.11, bottom: 0.2, left: 0.05, right: 0.12 },
  { id: 'shorts', name: 'YouTube Shorts', top: 0.08, bottom: 0.22, left: 0.05, right: 0.16 },
] as const

export type SafeZoneId = (typeof SAFE_ZONES)[number]['id']

/** The part of a W × H frame a platform's overlay leaves clear. */
export function safeRect(id: SafeZoneId, W: number, H: number): Box {
  const z = SAFE_ZONES.find((s) => s.id === id)!
  return { left: Math.round(W * z.left), top: Math.round(H * z.top), right: Math.round(W * (1 - z.right)), bottom: Math.round(H * (1 - z.bottom)) }
}

/**
 * What a moving object snaps to: the canvas edges and centre, the guides, the safe area's edges and every other
 * object's edges and centre.
 */
export function snapTargets(W: number, H: number, others: Box[], guides: { v: number[]; h: number[] } = { v: [], h: [] }, safe?: Box | null): SnapTargets {
  const x = [0, W / 2, W, ...guides.v]
  const y = [0, H / 2, H, ...guides.h]
  if (safe) {
    x.push(safe.left, safe.right)
    y.push(safe.top, safe.bottom)
  }
  for (const b of others) {
    x.push(b.left, (b.left + b.right) / 2, b.right)
    y.push(b.top, (b.top + b.bottom) / 2, b.bottom)
  }
  return { x, y }
}

function snapAxis(edges: number[], targets: number[], threshold: number): { d: number; at: number[] } {
  let best = threshold
  let d = 0
  let found = false
  for (const e of edges)
    for (const t of targets) {
      const dist = Math.abs(t - e)
      if (dist < best - 1e-9) {
        best = dist
        d = t - e
        found = true
      }
    }
  if (!found) return { d: 0, at: [] }
  // every target the snapped box now touches gets a line
  const at = [...new Set(targets.filter((t) => edges.some((e) => Math.abs(t - (e + d)) < 0.5)).map((t) => Math.round(t * 100) / 100))]
  return { d, at }
}

/**
 * Snap a box that is being dragged: the offset to add to it (per axis, 0 when nothing is within `threshold`) and
 * the lines it now lines up with.
 */
export function snapBox(b: Box, targets: SnapTargets, threshold: number): { dx: number; dy: number; lines: { x: number[]; y: number[] } } {
  const sx = snapAxis([b.left, (b.left + b.right) / 2, b.right], targets.x, threshold)
  const sy = snapAxis([b.top, (b.top + b.bottom) / 2, b.bottom], targets.y, threshold)
  return { dx: sx.d, dy: sy.d, lines: { x: sx.at, y: sy.at } }
}

export const shift = (b: Box, dx: number, dy: number): Box => ({ left: b.left + dx, right: b.right + dx, top: b.top + dy, bottom: b.bottom + dy })

export type AlignMode = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom'

/** How far each box moves to line up with `ref` (the selection's bounds, or the canvas for one object). */
export function alignBoxes(boxes: ObjBox[], mode: AlignMode, ref: Box): Map<string, { dx: number; dy: number }> {
  const out = new Map<string, { dx: number; dy: number }>()
  for (const b of boxes) {
    let dx = 0
    let dy = 0
    if (mode === 'left') dx = ref.left - b.left
    if (mode === 'right') dx = ref.right - b.right
    if (mode === 'hcenter') dx = (ref.left + ref.right) / 2 - (b.left + b.right) / 2
    if (mode === 'top') dy = ref.top - b.top
    if (mode === 'bottom') dy = ref.bottom - b.bottom
    if (mode === 'vcenter') dy = (ref.top + ref.bottom) / 2 - (b.top + b.bottom) / 2
    out.set(b.id, { dx, dy })
  }
  return out
}

/** Equal gaps between three or more boxes along an axis; the first and last stay where they are. */
export function distributeBoxes(boxes: ObjBox[], axis: 'x' | 'y'): Map<string, { dx: number; dy: number }> {
  const out = new Map<string, { dx: number; dy: number }>()
  if (boxes.length < 3) return out
  const lo = axis === 'x' ? 'left' : 'top'
  const hi = axis === 'x' ? 'right' : 'bottom'
  const sorted = [...boxes].sort((a, b) => (a[lo] + a[hi]) / 2 - (b[lo] + b[hi]) / 2)
  const span = Math.max(...sorted.map((b) => b[hi])) - Math.min(...sorted.map((b) => b[lo]))
  const total = sorted.reduce((n, b) => n + (b[hi] - b[lo]), 0)
  const gap = (span - total) / (sorted.length - 1)
  let at = sorted[0][lo]
  for (const b of sorted) {
    const d = at - b[lo]
    out.set(b.id, axis === 'x' ? { dx: d, dy: 0 } : { dx: 0, dy: d })
    at += b[hi] - b[lo] + gap
  }
  return out
}

/** Choose ruler label spacing (canvas px) so labels sit at least `minPx` screen pixels apart. */
export function rulerStep(scale: number, minPx = 56): number {
  for (const s of [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000]) if (s * scale >= minPx) return s
  return 5000
}
