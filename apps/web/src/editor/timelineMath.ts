// Pure timeline geometry: px <-> time, ruler ticks, snapping, row layout. Unit-tested in timelineMath.test.ts.
import type { Project, Track } from '@producer/core'
import { snapTime } from '@producer/core'

export const HEADER_W = 176
export const RULER_H = 28
export const ROW_GAP = 6
export const ROWS_TOP = 10
/** Snap distance in screen pixels. */
export const SNAP_PX = 8

export const timeToPx = (t: number, zoom: number) => t * zoom
export const pxToTime = (px: number, zoom: number) => px / zoom

export function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v
}

const STEPS = [1 / 30, 2 / 30, 5 / 30, 10 / 30, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]

/** Major tick interval (seconds) so labels are at least `minPx` apart, plus minor subdivisions. */
export function tickStep(zoom: number, minPx = 72, fps = 30): { major: number; minor: number } {
  const frame = 1 / fps
  const steps = STEPS.map((s) => (s < 0.5 ? Math.max(frame, Math.round(s / frame) * frame) : s))
  const major = steps.find((s) => s * zoom >= minPx) ?? steps[steps.length - 1]
  let div = 5
  if (major === 2 || major === 120 || major === 600) div = 4
  if (major === 15 || major === 30 || major === 60 || major === 1800) div = 6
  if (major < 0.5) div = Math.max(1, Math.round(major / frame))
  const minor = major / div
  return { major, minor: minor * zoom < 6 ? major : minor }
}

/** Ruler label for time t given the major step: frames when zoomed in, m:ss otherwise. */
export function rulerLabel(t: number, major: number, fps = 30): string {
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  const base = `${m}:${String(s).padStart(2, '0')}`
  if (major < 1) {
    const f = Math.round((t - Math.floor(t)) * fps)
    return f === 0 ? base : `${f}f`
  }
  return base
}

/** Snap a time to the nearest point within SNAP_PX screen pixels. */
export function snapAt(t: number, points: number[], zoom: number, px = SNAP_PX): { t: number; snapped: boolean; at?: number } {
  const r = snapTime(t, points, px / zoom)
  return { t: r.t, snapped: r.snapped, at: r.snapped ? r.t : undefined }
}

/**
 * Snap a moving span [start, start+duration]: whichever edge is closer to a snap point wins.
 * Returns the adjusted start and the time of the guide line.
 */
export function snapSpan(start: number, duration: number, points: number[], zoom: number, px = SNAP_PX): { start: number; at?: number } {
  const a = snapTime(start, points, px / zoom)
  const b = snapTime(start + duration, points, px / zoom)
  const da = a.snapped ? Math.abs(a.t - start) : Infinity
  const db = b.snapped ? Math.abs(b.t - (start + duration)) : Infinity
  if (da === Infinity && db === Infinity) return { start }
  if (da <= db) return { start: a.t, at: a.t }
  return { start: b.t - duration, at: b.t }
}

/** Zoom that fits `duration` seconds into `width` px (with a little tail room). */
export function fitZoom(duration: number, width: number, min = 4, max = 600): number {
  if (duration <= 0 || width <= 0) return 80
  return clamp((width - 40) / (duration * 1.04), min, max)
}

/** Slider position 0..1 <-> zoom (log scale). */
export function zoomToSlider(z: number, min = 4, max = 600) {
  return Math.log(z / min) / Math.log(max / min)
}
export function sliderToZoom(v: number, min = 4, max = 600) {
  return min * (max / min) ** clamp(v, 0, 1)
}

export function trackHeight(t: Track): number {
  if (t.main) return 68
  switch (t.kind) {
    case 'video':
    case 'overlay':
      return 52
    case 'audio':
      return 46
    case 'text':
    case 'caption':
      return 34
  }
}

export interface Row {
  track: Track
  /** Index in project.tracks (stacking order). */
  index: number
  top: number
  height: number
}

/** Rows in display order: highest stacking index on top (captions/text), audio at the bottom. */
export function layoutRows(p: Project): { rows: Row[]; height: number } {
  const rows: Row[] = []
  let y = ROWS_TOP
  for (let i = p.tracks.length - 1; i >= 0; i--) {
    const t = p.tracks[i]
    const h = trackHeight(t)
    rows.push({ track: t, index: i, top: y, height: h })
    y += h + ROW_GAP
  }
  return { rows, height: y }
}

export type DropTarget = { type: 'row'; row: Row } | { type: 'gap'; gap: number; y: number }

/**
 * What a vertical drag position (content y) points at: a row, or the gap above display row `gap`
 * (gap === rows.length is below the last row). Gap zones are the few pixels around row boundaries.
 */
export function dropTargetAt(y: number, rows: Row[], edge = 4): DropTarget | null {
  if (!rows.length) return null
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    if (y < r.top + edge) return { type: 'gap', gap: i, y: r.top - ROW_GAP / 2 }
    if (y < r.top + r.height - edge) return { type: 'row', row: r }
  }
  const last = rows[rows.length - 1]
  return { type: 'gap', gap: rows.length, y: last.top + last.height + ROW_GAP / 2 }
}

/**
 * Convert a display gap into `insertTrack`'s `aboveIndex` for a visual track: the new track goes directly
 * above the stacking index returned. Visual tracks never go below the main track.
 */
export function gapToAboveIndex(gap: number, rows: Row[], mainIndex: number): number {
  // gap k sits above display row k, i.e. directly above stacking index rows[k].index
  const below = rows[gap]
  const above = gap > 0 ? rows[gap - 1] : undefined
  let aboveIndex = below ? below.index : above ? above.index - 1 : -1
  if (aboveIndex < mainIndex) aboveIndex = mainIndex
  return aboveIndex
}

/** Items (by id) whose clip rectangles intersect a marquee rectangle in content coords. */
export function marqueeHits(
  rect: { x0: number; y0: number; x1: number; y1: number },
  rows: Row[],
  zoom: number,
): string[] {
  const x0 = Math.min(rect.x0, rect.x1)
  const x1 = Math.max(rect.x0, rect.x1)
  const y0 = Math.min(rect.y0, rect.y1)
  const y1 = Math.max(rect.y0, rect.y1)
  const out: string[] = []
  for (const r of rows) {
    if (r.top > y1 || r.top + r.height < y0) continue
    for (const it of r.track.items) {
      const a = it.start * zoom
      const b = (it.start + it.duration) * zoom
      if (b >= x0 && a <= x1) out.push(it.id)
    }
  }
  return out
}

/** Frame-accurate timecode HH:MM:SS:FF at the project fps (hours only when needed). */
export function timecode(sec: number, fps: number): string {
  const s = Math.max(0, sec)
  const totalFrames = Math.floor(s * fps + 1e-6)
  const f = totalFrames % fps
  const whole = Math.floor(totalFrames / fps)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const ss = whole % 60
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${h ? `${p2(h)}:` : ''}${p2(m)}:${p2(ss)}:${p2(f)}`
}

/** Short duration label for clip badges: "4.2s" / "1:05". */
export function shortDuration(sec: number): string {
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  return `${m}:${String(Math.round(sec % 60)).padStart(2, '0')}`
}
