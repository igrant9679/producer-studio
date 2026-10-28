// Review playback (E-8): JKL shuttle, in and out points with loop, preview speed, proxy or full-quality preview.
// Kept out of the document and its undo history: it is how this person is watching, not part of the edit.
import { create } from 'zustand'
import { toast } from '../lib/toast'
import { useEditor } from './store'

/** Preview speeds offered in the playback menu. */
export const PREVIEW_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const
/** The fastest a repeated J or L shuttles. */
export const MAX_SHUTTLE = 8

export interface TransportState {
  /** J/L shuttle: direction and multiple (1 plays normally, -2 plays backwards at double speed). */
  shuttle: number
  /** Preview speed (0.5–2×), multiplied into the shuttle. */
  speed: number
  inPoint?: number
  outPoint?: number
  /** Playback goes round in to out (the whole video without them). */
  loop: boolean
  /** Preview plays the original files instead of the small editing copies. */
  fullQuality: boolean
}

export const useTransport = create<TransportState>(() => ({ shuttle: 1, speed: 1, loop: false, fullQuality: false }))

const T = () => useTransport.getState()
const E = () => useEditor.getState()

/** Playhead seconds per second: negative plays backwards. */
export const playRate = (t: TransportState = T()) => t.shuttle * t.speed

/** The part to loop or export: in to out, either end defaulting to the start or the end. Undefined without either. */
export function inOutRange(t: TransportState = T(), end = projectEnd()): { from: number; to: number } | undefined {
  if (t.inPoint === undefined && t.outPoint === undefined) return undefined
  const from = Math.max(0, Math.min(t.inPoint ?? 0, end))
  const to = Math.min(end, t.outPoint ?? end)
  return to - from > 1e-3 ? { from, to } : undefined
}

function projectEnd(): number {
  let end = 0
  for (const tr of E().project.tracks) for (const it of tr.items) end = Math.max(end, it.start + it.duration)
  return end
}

/** L: play forward; again while playing forward, faster (2×, 4×, 8×). From backwards it turns forward at 1×. */
export function shuttleForward() {
  const s = E()
  const t = T()
  const next = s.playing && t.shuttle > 0 ? Math.min(MAX_SHUTTLE, t.shuttle * 2) : 1
  useTransport.setState({ shuttle: next })
  if (!s.playing) startPlaying()
}

/** J: play backwards; again, faster. */
export function shuttleBack() {
  const s = E()
  const t = T()
  if (!s.playing && s.playhead <= 0) return
  const next = s.playing && t.shuttle < 0 ? Math.max(-MAX_SHUTTLE, t.shuttle * 2) : -1
  useTransport.setState({ shuttle: next })
  if (!s.playing) startPlaying()
}

/** K: stop (and back to normal speed for the next play). */
export function shuttleStop() {
  useTransport.setState({ shuttle: 1 })
  E().setPlaying(false)
}

function startPlaying() {
  const s = E()
  const end = projectEnd()
  // forward from the very end starts again, as Space does
  if (playRate() > 0 && s.playhead >= end - 1 / s.project.fps) s.setPlayhead(0)
  s.setPlaying(true)
}

export function markIn(t = E().playhead) {
  const out = T().outPoint
  useTransport.setState({ inPoint: t, outPoint: out !== undefined && out <= t ? undefined : out })
}

export function markOut(t = E().playhead) {
  const inn = T().inPoint
  if (t <= 0) return toast('Move the playhead past the start to set an out point')
  useTransport.setState({ outPoint: t, inPoint: inn !== undefined && inn >= t ? undefined : inn })
}

export function clearInOut() {
  useTransport.setState({ inPoint: undefined, outPoint: undefined })
}

export function setLoop(loop: boolean) {
  useTransport.setState({ loop })
}

export function setPreviewSpeed(speed: number) {
  useTransport.setState({ speed: Math.min(2, Math.max(0.5, speed)) })
}

export function setFullQuality(fullQuality: boolean) {
  useTransport.setState({ fullQuality })
}

/** The editor's transport keys: J K L shuttle, I and O mark in and out, Alt+X clears them. True when handled. */
export function transportKey(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.shiftKey) return false
  if (e.altKey) {
    if (e.code !== 'KeyX') return false
    clearInOut()
    return true
  }
  const k = e.key.toLowerCase()
  if (k === 'j') shuttleBack()
  else if (k === 'k') shuttleStop()
  else if (k === 'l') shuttleForward()
  else if (k === 'i') markIn()
  else if (k === 'o') markOut()
  else return false
  return true
}

/** Another project opened:its own in and out points, normal playback. Speed, loop and quality stay. */
export function resetTransportFor() {
  useTransport.setState({ shuttle: 1, inPoint: undefined, outPoint: undefined })
}

/**
 * Where the playhead goes after advancing `dt` seconds of wall time, and whether playback carries on. Plays at the
 * shuttle and preview speed; with loop on, wraps between in and out (the whole video without them); otherwise stops
 * at either end.
 */
export function advance(playhead: number, dt: number, end: number, t: TransportState = T()): { t: number; playing: boolean } {
  const rate = playRate(t)
  let next = playhead + dt * rate
  if (t.loop) {
    const r = inOutRange(t, end) ?? { from: 0, to: end }
    if (r.to - r.from > 1e-3) {
      const outside = playhead < r.from - 1e-3 || playhead > r.to + 1e-3
      if (rate > 0) next = outside ? r.from : next >= r.to ? r.from + (next - r.to) : next
      else next = outside ? r.to : next <= r.from ? r.to - (r.from - next) : next
      return { t: Math.max(r.from, Math.min(next, r.to)), playing: true }
    }
  }
  if (next >= end) return { t: end, playing: false }
  if (next <= 0 && rate < 0) return { t: 0, playing: false }
  return { t: Math.max(0, next), playing: true }
}

/** What the canvas's media should do: play natively forward at the rate, or hold still while the playhead scrubs back. */
export function rendererTransport(playing: boolean, t: TransportState = T()): { playing: boolean; rate: number } {
  const rate = playRate(t)
  return { playing: playing && rate > 0, rate: Math.abs(rate) }
}

/** The media variant the preview asks for: the editing copy ("proxy"), or the original with full quality on. */
export function previewVariant<K extends string>(kind: K, t: TransportState = T()): K | 'media' {
  return kind === 'proxy' && t.fullQuality ? 'media' : kind
}
