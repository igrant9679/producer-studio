// Speed (E-17): constant speed, speed ramps, the pitch toggle and smooth slow motion. How a clip's time maps to its
// source time is worked out here, once: the preview (evaluate, StageRenderer), the export (compile: HyperFrames' rate
// lane), trims, splits, linked sound, the transcript, captions and markers all read it, so they agree on which frame
// and which sound play when.
import { clone, editable, findItem, updateItem } from './ops'
import type { AnimProp, Asset, AudioItem, Item, Keyframe, Keyframes, Project, SmoothCopy, SpeedPoint, VideoItem } from './types'
import { EPS, clamp, round } from './util'

/** The speeds a clip can play at: HyperFrames' rate range, which its export renders. */
export const SPEED_MIN = 0.1
export const SPEED_MAX = 10

type Timed = VideoItem | AudioItem

const timed = (it: Item | undefined): it is Timed => !!it && (it.type === 'video' || it.type === 'audio')

/** The ramp a clip plays at, or null when it plays at its constant `speed`. Freeze frames and reversed clips don't ramp. */
export function rampOf(it: Item): SpeedPoint[] | null {
  if (!timed(it)) return null
  if (it.type === 'video' && (it.freezeAt !== undefined || it.reverse)) return null
  return it.speedRamp && it.speedRamp.length >= 2 ? it.speedRamp : null
}

// ---------- a ramp: points sorted by time, speeds above 0 ----------

/** The speed at `t`: held before the first point and after the last, even in ratio (log scale) between, as HyperFrames samples a rate lane. */
export function rampRate(pts: SpeedPoint[], t: number): number {
  const n = pts.length
  if (t <= pts[0].t) return pts[0].v
  if (t >= pts[n - 1].t) return pts[n - 1].v
  let i = 1
  while (pts[i].t < t) i++
  const a = pts[i - 1]
  const b = pts[i]
  const d = b.t - a.t
  return d <= 0 ? b.v : Math.exp(Math.log(a.v) + ((Math.log(b.v) - Math.log(a.v)) * (t - a.t)) / d)
}

/** How fast the log of the speed changes at `x` (per second), going forwards (or backwards) from it. */
function slope(pts: SpeedPoint[], x: number, forward: boolean): number {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const inside = forward ? a.t <= x && x < b.t : a.t < x && x <= b.t
    if (inside && b.t > a.t) return Math.log(b.v / a.v) / (b.t - a.t)
  }
  return 0
}

/** ∫ speed from u0 to u1 where the log of the speed is a straight line of slope k and the speed at u0 is r0. */
function piece(r0: number, k: number, len: number): number {
  return Math.abs(k * len) < 1e-12 ? r0 * len : (r0 * Math.expm1(k * len)) / k
}

/** Source seconds played between clip times x0 and x1 (x0 ≤ x1): the exact integral of the speed. */
export function rampIntegral(pts: SpeedPoint[], x0: number, x1: number): number {
  if (x1 <= x0) return 0
  const n = pts.length
  let sum = 0
  if (x0 < pts[0].t) sum += pts[0].v * (Math.min(x1, pts[0].t) - x0)
  for (let i = 0; i < n - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const u0 = Math.max(x0, a.t)
    const u1 = Math.min(x1, b.t)
    if (u1 <= u0 || b.t <= a.t) continue
    const k = Math.log(b.v / a.v) / (b.t - a.t)
    sum += piece(a.v * Math.exp(k * (u0 - a.t)), k, u1 - u0)
  }
  if (x1 > pts[n - 1].t) sum += pts[n - 1].v * (x1 - Math.max(x0, pts[n - 1].t))
  return sum
}

/** The clip time at which `off` source seconds (from clip time 0; negative: before it) have played. */
export function rampSolve(pts: SpeedPoint[], off: number): number {
  if (Math.abs(off) < 1e-15) return 0
  const forward = off > 0
  let x = 0
  let rem = Math.abs(off)
  const marks = forward ? pts.map((q) => q.t) : pts.map((q) => q.t).reverse()
  for (const m of marks) {
    if (forward ? m <= x : m >= x) continue
    const got = forward ? rampIntegral(pts, x, m) : rampIntegral(pts, m, x)
    if (got >= rem) break
    rem -= got
    x = m
  }
  // inside one piece now: the log of the speed is a straight line from x on
  const r0 = rampRate(pts, x)
  const k = slope(pts, x, forward) * (forward ? 1 : -1)
  const dx = Math.abs(k) < 1e-12 ? rem / r0 : Math.log1p((rem * k) / r0) / k
  return forward ? x + dx : x - dx
}

// ---------- a clip's time and its source ----------

/** A clip's speed at `local` seconds into it. */
export function speedAt(it: Timed, local: number): number {
  const r = rampOf(it)
  return r ? rampRate(r, local) : it.speed
}

/** Source seconds a forwards clip plays from its first frame to `local` (negative before it: a transition's pre-roll). */
export function sourceOffset(it: Timed, local: number): number {
  const r = rampOf(it)
  if (!r) return local * it.speed
  return local >= 0 ? rampIntegral(r, 0, local) : -rampIntegral(r, local, 0)
}

/** The clip time at which a forwards clip has played `offset` source seconds (the inverse of `sourceOffset`). */
export function localAtOffset(it: Timed, offset: number): number {
  const r = rampOf(it)
  return r ? rampSolve(r, offset) : offset / it.speed
}

/** How much of its source a clip plays (seconds). */
export function sourceSpan(it: Timed): number {
  return sourceOffset(it, it.duration)
}

/** Source time a clip shows `local` seconds into it, also outside it (the frames a transition plays past its edges). */
export function clipSourceAt(it: Timed, local: number): number {
  if (it.type === 'video' && it.freezeAt !== undefined) return it.freezeAt
  if (it.type === 'video' && it.reverse) return it.in + (it.duration - local) * it.speed
  return it.in + sourceOffset(it, local)
}

/** Seconds into a clip at which it shows source time `src` (freeze frames: never, NaN). */
export function clipLocalAt(it: Timed, src: number): number {
  if (it.type === 'video' && it.freezeAt !== undefined) return NaN
  if (it.type === 'video' && it.reverse) return it.duration - (src - it.in) / it.speed
  return localAtOffset(it, src - it.in)
}

/** The source range a clip plays: [in, in + span]. */
export function sourceRange(it: Timed): { start: number; end: number } {
  return { start: it.in, end: it.in + (it.type === 'video' && it.reverse ? it.duration * it.speed : sourceSpan(it)) }
}

/** The ramp `by` seconds later in the clip (a trim at the start moves it the other way): the same speed on the same frames. */
export function shiftRamp(pts: SpeedPoint[] | undefined, by: number): SpeedPoint[] | undefined {
  return pts?.map((q) => ({ t: round(q.t + by, 4), v: q.v }))
}

/** After a trim or a split, `speed` is the ramp's average again (what the clip badge and the assistant read). */
export function syncAverageSpeed(it: Item) {
  if (!timed(it) || !rampOf(it) || it.duration <= EPS) return
  it.speed = round(sourceSpan(it) / it.duration, 4)
}

// ---------- presets and the editor's view of a ramp ----------

/** A ramp's shape: speeds at fractions 0..1 of the clip's length. */
export type RampShape = SpeedPoint[]

export interface RampPreset {
  id: 'rampUp' | 'rampDown' | 'montage' | 'hero' | 'bullet'
  name: string
  hint: string
  shape: RampShape
}

export const RAMP_PRESETS: readonly RampPreset[] = [
  { id: 'rampUp', name: 'Ramp up', hint: 'Starts slow and speeds up', shape: [{ t: 0, v: 0.5 }, { t: 1, v: 2 }] },
  { id: 'rampDown', name: 'Ramp down', hint: 'Starts fast and slows down', shape: [{ t: 0, v: 2 }, { t: 1, v: 0.5 }] },
  { id: 'montage', name: 'Montage', hint: 'Fast, a slow moment, fast again', shape: [{ t: 0, v: 1 }, { t: 0.25, v: 2.5 }, { t: 0.45, v: 0.6 }, { t: 0.55, v: 0.6 }, { t: 0.75, v: 2.5 }, { t: 1, v: 1 }] },
  { id: 'hero', name: 'Hero', hint: 'Rushes in, slows right down for the moment, rushes out', shape: [{ t: 0, v: 2 }, { t: 0.35, v: 2 }, { t: 0.45, v: 0.3 }, { t: 0.6, v: 0.3 }, { t: 0.7, v: 2 }, { t: 1, v: 2 }] },
  { id: 'bullet', name: 'Bullet', hint: 'Bullet time: nearly stops in the middle', shape: [{ t: 0, v: 1.5 }, { t: 0.35, v: 1.5 }, { t: 0.45, v: 0.15 }, { t: 0.65, v: 0.15 }, { t: 0.75, v: 1.5 }, { t: 1, v: 1.5 }] },
]

/** Most points a ramp keeps (HyperFrames reads 512 per lane). */
export const RAMP_MAX_POINTS = 64

/** A shape cleaned up: inside 0..1, sorted, one point per moment, speeds in range, ends at 0 and 1. */
export function normalizeShape(shape: RampShape): RampShape {
  const pts = shape
    .filter((q) => Number.isFinite(q.t) && Number.isFinite(q.v))
    .map((q) => ({ t: round(clamp(q.t, 0, 1), 4), v: round(clamp(q.v, SPEED_MIN, SPEED_MAX), 3) }))
    .sort((a, b) => a.t - b.t)
  const out: RampShape = []
  for (const q of pts) {
    if (out.length && Math.abs(out[out.length - 1].t - q.t) < 1e-4) out[out.length - 1] = q
    else out.push(q)
  }
  if (!out.length) return out
  if (out[0].t > 0) out.unshift({ t: 0, v: out[0].v })
  if (out[out.length - 1].t < 1) out.push({ t: 1, v: out[out.length - 1].v })
  return out.slice(0, RAMP_MAX_POINTS)
}

/** The clip's ramp as the editor shows it: its points inside the clip, as fractions, with the speed at each end. */
export function rampShape(it: Timed): RampShape | null {
  const r = rampOf(it)
  if (!r || it.duration <= EPS) return null
  const inner = r.filter((q) => q.t > EPS && q.t < it.duration - EPS).map((q) => ({ t: round(q.t / it.duration, 4), v: q.v }))
  return [{ t: 0, v: round(rampRate(r, 0), 3) }, ...inner, { t: 1, v: round(rampRate(r, it.duration), 3) }]
}

/** The preset a clip's ramp is (null: none, or one changed by hand). */
export function rampPresetOf(it: Timed): RampPreset['id'] | null {
  const s = rampShape(it)
  if (!s) return null
  const same = (a: RampShape, b: RampShape) => a.length === b.length && a.every((q, i) => Math.abs(q.t - b[i].t) < 2e-3 && Math.abs(q.v - b[i].v) < 2e-3)
  return RAMP_PRESETS.find((x) => same(x.shape, s))?.id ?? null
}

/** The slowest a clip plays (its ramp's lowest speed inside it, or its speed). */
export function slowestSpeed(it: Timed): number {
  const r = rampOf(it)
  if (!r) return it.speed
  let low = Math.min(rampRate(r, 0), rampRate(r, it.duration))
  for (const q of r) if (q.t > 0 && q.t < it.duration) low = Math.min(low, q.v)
  return low
}

// ---------- changing the speed ----------

/**
 * Give a clip a new speed (constant or ramped), keeping its source range (as much of it as the source has). Every
 * clip-relative time moves with the frame it was on: keyframes, fades, in/out animations, a split piece's phase.
 * The clip's linked sound (or picture) playing the same range alongside it gets the same speed, so they stay together.
 */
function retime(p0: Project, itemId: string, next: (it: Timed, span: number) => { speed: number; speedRamp?: SpeedPoint[]; duration: number }): Project {
  const f = findItem(p0, itemId)
  if (!editable(f) || !timed(f.item)) return p0
  const it = f.item
  if (it.type === 'video' && it.freezeAt !== undefined) return p0
  const max = p0.assets[it.assetId]?.duration
  const span = Math.min(sourceRange(it).end - it.in, max !== undefined ? Math.max(0, max - it.in) : Infinity)
  const n = next(it, span)
  const partners = it.linkId
    ? p0.tracks.flatMap((t) => (t.locked ? [] : t.items)).filter((o): o is Timed => o.id !== it.id && o.linkId === it.linkId && timed(o) && !o.locked && o.assetId === it.assetId && Math.abs(o.start - it.start) < 1e-3 && Math.abs(o.in - it.in) < 1e-3 && Math.abs(o.duration - it.duration) < 1e-3 && !(o.type === 'video' && (o.freezeAt !== undefined || o.reverse)))
    : []
  let p = p0
  for (const x of [it, ...partners]) p = updateItem<VideoItem>(p, x.id, retimePatch(x, n) as Partial<VideoItem>)
  return p
}

function retimePatch(it: Timed, n: { speed: number; speedRamp?: SpeedPoint[]; duration: number }): Partial<Timed> {
  const nu = { ...it, speed: n.speed, speedRamp: n.speedRamp, duration: n.duration } as Timed
  // the frame at x seconds into the clip before is at map(x) after
  const map = (x: number) => localAtOffset(nu, sourceOffset(it, x))
  const at = (t: number) => round(clamp(map(t), 0, n.duration), 4)
  const fromEnd = (len: number) => round(clamp(n.duration - map(it.duration - len), 0, n.duration), 4)
  const keyframes: Keyframes = {}
  for (const [prop, list] of Object.entries(it.keyframes ?? {}) as Array<[AnimProp, Keyframe[]]>) keyframes[prop] = list.map((kf) => ({ ...kf, t: round(map(kf.t), 4) }))
  const patch: Partial<VideoItem> = { speed: n.speed, speedRamp: n.speedRamp, duration: round(n.duration, 4), fadeIn: at(it.fadeIn), fadeOut: fromEnd(it.fadeOut), keyframes }
  if (it.type === 'video') {
    const a = it.animations ?? {}
    patch.animations = { ...a, ...(a.in ? { in: { ...a.in, duration: at(a.in.duration) } } : {}), ...(a.out ? { out: { ...a.out, duration: fromEnd(a.out.duration) } } : {}) }
    const k = n.duration / Math.max(EPS, it.duration)
    if (it.phase) patch.phase = { offset: round(it.phase.offset * k, 4), length: round(it.phase.length * k, 4) }
  }
  return patch
}

/**
 * Change a video or audio clip's speed to a constant `speed` (a ramp it had is gone). The clip keeps its source range
 * and every clip-relative time stays on its frame (see `retime`). A clip made longer on an overlay track moves to a
 * free track (see `unstack` in ops).
 */
export function setItemSpeed(p0: Project, itemId: string, speed: number): Project {
  if (!(speed > 0)) return p0
  const to = round(speed, 3)
  return retime(p0, itemId, (_it, span) => ({ speed: to, speedRamp: undefined, duration: span / to }))
}

/**
 * Give a clip a speed ramp: `shape` is speeds at fractions of the clip's length (a preset's, or drawn), null for no
 * ramp (the clip then plays at its average speed, keeping its length). The clip keeps its source range, so its length
 * becomes that range over the shape's average speed.
 */
export function setSpeedRamp(p0: Project, itemId: string, shape: RampShape | null): Project {
  const it = findItem(p0, itemId)?.item
  if (!timed(it) || (it.type === 'video' && (it.freezeAt !== undefined || it.reverse))) return p0
  if (!shape) {
    if (!it.speedRamp) return p0
    return retime(p0, itemId, (x, span) => {
      const speed = round(clamp(span / Math.max(EPS, x.duration), SPEED_MIN, SPEED_MAX), 3)
      return { speed, speedRamp: undefined, duration: span / speed }
    })
  }
  const s = normalizeShape(shape)
  if (s.length < 2) return p0
  const mean = rampIntegral(s, 0, 1)
  return retime(p0, itemId, (_x, span) => {
    const duration = span / mean
    const speedRamp = s.map((q) => ({ t: round(q.t * duration, 4), v: q.v }))
    // the rounded points, so the length plays exactly the source range
    const d = rampSolve(speedRamp, span)
    return { speed: round(span / d, 4), speedRamp, duration: d }
  })
}

/** Apply a named ramp preset. */
export function applyRampPreset(p0: Project, itemId: string, id: RampPreset['id']): Project {
  const preset = RAMP_PRESETS.find((x) => x.id === id)
  return preset ? setSpeedRamp(p0, itemId, preset.shape) : p0
}

/** Keep the voice's pitch at any speed (the default), or let it follow the speed; a linked sound alongside follows. */
export function setPitchShift(p0: Project, itemId: string, shift: boolean): Project {
  const f = findItem(p0, itemId)
  if (!editable(f) || !timed(f.item)) return p0
  let p = updateItem<AudioItem>(p0, itemId, { pitchShift: shift || undefined })
  if (f.item.linkId)
    for (const t of p0.tracks) for (const o of t.items) if (o.id !== itemId && o.linkId === f.item.linkId && timed(o) && o.assetId === f.item.assetId) p = updateItem<AudioItem>(p, o.id, { pitchShift: shift || undefined })
  return p
}

/** Whether a clip's sound changes pitch with its speed: set to, and not at 1×. */
export function shiftsPitch(it: Timed): boolean {
  return !!it.pitchShift && (!!rampOf(it) || Math.abs(it.speed - 1) > 1e-4)
}

// ---------- the export ----------

/**
 * The rate lane HyperFrames plays a ramped clip's element by: speeds at seconds from timeline time `from` (the
 * element's start), the speed at `from` first. Null for a clip at a constant speed (data-playback-rate covers it).
 */
export function rateLane(it: Timed, from: number): Array<{ t: number; v: number }> | null {
  const r = rampOf(it)
  if (!r) return null
  const off = it.start - from
  const at = (t: number) => ({ t: round(t, 4), v: round(clamp(rampRate(r, t - off), SPEED_MIN, SPEED_MAX), 6) })
  const out = [at(0)]
  for (const q of r) {
    const t = q.t + off
    if (t <= 1e-4) continue
    // HyperFrames integrates a lane with trapezoids, 48 to a segment: a steep change gets points in between (on
    // the same curve) so its sum stays within a fraction of a millisecond of the preview's exact one
    const prev = out[out.length - 1]
    const steps = Math.min(16, Math.ceil(Math.abs(Math.log(rampRate(r, t - off) / prev.v)) / 0.35))
    for (let k = 1; k < steps; k++) out.push(at(prev.t + ((t - prev.t) * k) / steps))
    if (round(t, 4) > out[out.length - 1].t) out.push(at(t))
  }
  return out
}

/**
 * How the export makes a pitch-shifted copy of a clip's sound over timeline `start`..`end`: source slices, each
 * resampled to play in `len` timeline seconds (a constant speed is one slice; a ramp steps its speed every slice).
 */
export function varispeedSlices(it: Timed, start: number, end: number, maxSlices = 240): Array<{ from: number; to: number; len: number }> {
  const len = Math.max(0, end - start)
  const n = rampOf(it) ? Math.max(1, Math.min(maxSlices, Math.ceil(len / 0.1))) : 1
  const step = len / n
  const out: Array<{ from: number; to: number; len: number }> = []
  for (let i = 0; i < n; i++) {
    const a = start + i * step
    out.push({ from: Math.max(0, clipSourceAt(it, a - it.start)), to: Math.max(0, clipSourceAt(it, a + step - it.start)), len: step })
  }
  return out
}

// ---------- smooth slow motion ----------

/** Smooth copies are made at no more than this frame rate. */
export const SMOOTH_MAX_FPS = 120

/**
 * The frame rate a smooth copy of a clip needs so that at its slowest the export still gets a new frame for every
 * frame it renders (never above SMOOTH_MAX_FPS); 0 when the clip isn't slowed or its file already has the frames.
 */
export function smoothFps(p: Project, it: Item): number {
  if (it.type !== 'video' || it.freezeAt !== undefined || it.reverse) return 0
  const slow = slowestSpeed(it)
  if (slow >= 1 - 1e-3) return 0
  const have = p.assets[it.assetId]?.fps ?? 30
  const need = Math.min(SMOOTH_MAX_FPS, Math.ceil(p.fps / slow))
  return need > have * 1.05 ? need : 0
}

/** The source range a smooth copy covers: the clip's, with a second either side for trims and transitions. */
export function smoothRange(p: Project, it: VideoItem): { from: number; to: number } {
  const r = sourceRange(it)
  const dur = p.assets[it.assetId]?.duration ?? Infinity
  return { from: round(Math.max(0, r.start - 1), 3), to: round(Math.min(dur, r.end + 1), 3) }
}

/** The smooth copy a clip's picture plays from: made, in the project, and covering what the clip plays. */
export function smoothSource(p: Project, it: Item): { assetId: string; from: number } | null {
  if (it.type !== 'video' || !it.smooth?.assetId || it.freezeAt !== undefined || it.reverse) return null
  const a = p.assets[it.smooth.assetId]
  if (!a || a.kind !== 'video') return null
  const r = sourceRange(it)
  return r.start >= it.smooth.from - 1e-3 && r.end <= it.smooth.to + 1e-3 ? { assetId: it.smooth.assetId, from: it.smooth.from } : null
}

/** Where a clip's smooth copy stands: none, being made, in use, or made for a range the clip no longer fits in. */
export function smoothState(p: Project, it: Item): 'none' | 'making' | 'ready' | 'stale' {
  if (it.type !== 'video' || !it.smooth) return 'none'
  if (!it.smooth.assetId) return it.smooth.jobId ? 'making' : 'none'
  return smoothSource(p, it) ? 'ready' : 'stale'
}

/** Mark a clip's smooth copy as being made by job `jobId` (or forget it: null). */
export function setSmoothJob(p0: Project, itemId: string, s: Pick<SmoothCopy, 'from' | 'to' | 'fps' | 'jobId'> | null): Project {
  const f = findItem(p0, itemId)
  if (!editable(f) || f.item.type !== 'video') return p0
  return updateItem<VideoItem>(p0, itemId, { smooth: s ? { from: s.from, to: s.to, fps: s.fps, jobId: s.jobId } : undefined })
}

/**
 * The smooth copy is made: the clip (and every piece split from it since, which carries the same job) plays its
 * picture from `asset`. Its sound stays the source's.
 */
export function applySmoothCopy(p0: Project, jobId: string, asset: Asset): Project {
  const p = clone(p0)
  let used = false
  for (const t of p.tracks)
    for (const it of t.items)
      if (it.type === 'video' && it.smooth?.jobId === jobId) {
        it.smooth = { from: it.smooth.from, to: it.smooth.to, fps: it.smooth.fps, assetId: asset.id }
        used = true
      }
  if (!used) return p0
  p.assets[asset.id] = asset
  p.updatedAt = Date.now()
  return p
}

/** Clips waiting on a smooth copy, by job. */
export function pendingSmoothJobs(p: Project): string[] {
  const out = new Set<string>()
  for (const t of p.tracks) for (const it of t.items) if (it.type === 'video' && it.smooth?.jobId && !it.smooth.assetId) out.add(it.smooth.jobId)
  return [...out]
}

/** A smooth copy's job failed or was stopped: the clips waiting on it go back to their source. */
export function dropSmoothJob(p0: Project, jobId: string): Project {
  if (!pendingSmoothJobs(p0).includes(jobId)) return p0
  const p = clone(p0)
  for (const t of p.tracks) for (const it of t.items) if (it.type === 'video' && it.smooth?.jobId === jobId) delete it.smooth
  p.updatedAt = Date.now()
  return p
}
