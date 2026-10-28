// Timeline markers and beat detection (E-6). Markers live on the project (`markers`, by time); edits snap to them
// (`snapPoints`). Beat markers come from a music clip's waveform peaks, the data every clip record already carries.
import { findItem, itemEnd } from './ops'
import type { Marker, Project } from './types'
import { EPS, round, uid } from './util'

/** The project's markers, earliest first. */
export function markersOf(p: Project): Marker[] {
  return [...(p.markers ?? [])].sort((a, b) => a.t - b.t)
}

function withMarkers(p0: Project, markers: Marker[]): Project {
  return { ...p0, markers: [...markers].sort((a, b) => a.t - b.t), updatedAt: Date.now() }
}

/** Add a marker at timeline time `t`; one already within half a frame of it is returned instead of a second. */
export function addMarker(p0: Project, t: number, opts: { name?: string; beat?: boolean } = {}): { project: Project; id: string } {
  const at = round(Math.max(0, t), 4)
  const near = (p0.markers ?? []).find((m) => Math.abs(m.t - at) < 0.5 / p0.fps)
  if (near) return { project: p0, id: near.id }
  const m: Marker = { id: uid('mk'), t: at, ...(opts.name ? { name: opts.name } : {}), ...(opts.beat ? { beat: true } : {}) }
  return { project: withMarkers(p0, [...(p0.markers ?? []), m]), id: m.id }
}

/** Rename or move a marker. An empty name clears it; a moved beat marker becomes an ordinary one. */
export function updateMarker(p0: Project, id: string, patch: { t?: number; name?: string }): Project {
  const cur = (p0.markers ?? []).find((m) => m.id === id)
  if (!cur) return p0
  const next: Marker = { ...cur }
  if (patch.t !== undefined) {
    next.t = round(Math.max(0, patch.t), 4)
    if (Math.abs(next.t - cur.t) > EPS) delete next.beat
  }
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 120)
    if (name) next.name = name
    else delete next.name
  }
  return withMarkers(p0, (p0.markers ?? []).map((m) => (m.id === id ? next : m)))
}

export function removeMarkers(p0: Project, ids: string[]): Project {
  const drop = new Set(ids)
  const left = (p0.markers ?? []).filter((m) => !drop.has(m.id))
  if (left.length === (p0.markers ?? []).length) return p0
  return withMarkers(p0, left)
}

/** The first marker after `t` (dir 1) or before it (dir -1), skipping one at `t` itself. */
export function nextMarker(p: Project, t: number, dir: 1 | -1): Marker | undefined {
  const half = 0.5 / p.fps
  const list = markersOf(p)
  return dir > 0 ? list.find((m) => m.t > t + half) : [...list].reverse().find((m) => m.t < t - half)
}

/**
 * Beat (onset) times in seconds from a peak envelope: `values` peaks (times `scale` gives 0..1), `rate` per second.
 * A beat is a jump in loudness well above the jumps around it, at most one per `minGap` seconds (the stronger wins).
 */
export function detectBeats(values: ArrayLike<number>, rate: number, opts: { scale?: number; minGap?: number } = {}): number[] {
  const n = values.length
  if (n < 4 || !(rate > 0)) return []
  const scale = opts.scale ?? 1
  const x = Float64Array.from({ length: n }, (_, k) => (values[k] ?? 0) * scale)
  // onset strength: how far a peak rises over the ~0.1 s before it
  const back = Math.max(1, Math.round(rate * 0.1))
  const onset = new Float64Array(n)
  for (let k = 1; k < n; k++) {
    let sum = 0
    const from = Math.max(0, k - back)
    for (let j = from; j < k; j++) sum += x[j]
    onset[k] = Math.max(0, x[k] - sum / (k - from))
  }
  // adaptive threshold over about a second either side
  const win = Math.max(2, Math.round(rate))
  const minGap = opts.minGap ?? 0.25
  const reach = Math.max(1, Math.round((rate * minGap) / 2))
  const found: Array<{ k: number; s: number }> = []
  for (let k = 1; k < n; k++) {
    const s = onset[k]
    if (s < 0.04) continue
    let sum = 0
    let sq = 0
    let c = 0
    for (let j = Math.max(0, k - win); j <= Math.min(n - 1, k + win); j++) {
      sum += onset[j]
      sq += onset[j] * onset[j]
      c++
    }
    const mean = sum / c
    const sd = Math.sqrt(Math.max(0, sq / c - mean * mean))
    if (s < mean + 0.5 * sd) continue
    let peak = true
    for (let j = Math.max(0, k - reach); j <= Math.min(n - 1, k + reach) && peak; j++) if (onset[j] > s || (onset[j] === s && j < k)) peak = false
    if (peak) found.push({ k, s })
  }
  const kept: number[] = []
  for (const f of found.sort((a, b) => b.s - a.s)) if (kept.every((k) => Math.abs(k - f.k) >= rate * minGap - EPS)) kept.push(f.k)
  return kept.sort((a, b) => a - b).map((k) => round(k / rate, 4))
}

/**
 * Replace the beat markers over a clip with ones detected from its waveform: the clip record's peaks, or fuller ones
 * passed in. Returns the project and how many beats were found (0 leaves the project as it was).
 */
export function addBeatMarkers(p0: Project, itemId: string, peaks?: { values: ArrayLike<number>; rate: number; scale?: number }): { project: Project; count: number } {
  const f = findItem(p0, itemId)
  if (!f || (f.item.type !== 'audio' && f.item.type !== 'video')) return { project: p0, count: 0 }
  const it = f.item
  if (it.type === 'video' && it.freezeAt !== undefined) return { project: p0, count: 0 }
  const asset = p0.assets[it.assetId]
  const values = peaks?.values ?? asset?.waveform
  const rate = peaks?.rate ?? asset?.waveformRate ?? 50
  if (!values?.length) return { project: p0, count: 0 }
  const reversed = it.type === 'video' && !!it.reverse
  const srcEnd = it.in + it.duration * it.speed
  const times = detectBeats(values, rate, { scale: peaks?.scale })
    .filter((s) => s >= it.in - EPS && s < srcEnd - EPS)
    .map((s) => round(it.start + (reversed ? srcEnd - s : s - it.in) / it.speed, 4))
    .filter((t) => t >= it.start - EPS && t <= itemEnd(it) + EPS)
  if (!times.length) return { project: p0, count: 0 }
  const kept = (p0.markers ?? []).filter((m) => !(m.beat && m.t >= it.start - EPS && m.t <= itemEnd(it) + EPS))
  const half = 0.5 / p0.fps
  const added = times.filter((t) => !kept.some((m) => Math.abs(m.t - t) < half)).map((t): Marker => ({ id: uid('mk'), t, beat: true }))
  return { project: withMarkers(p0, [...kept, ...added]), count: times.length }
}
