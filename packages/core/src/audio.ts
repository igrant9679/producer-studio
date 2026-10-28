// Sound: the level every clip is heard at, worked out once for the preview (evaluate -> StageRenderer) and the export
// (compile -> HyperFrames volume lanes), so both play the same mix. A clip's level is its volume keyframes and fades
// times its track's volume. A transition between two clips crossfades their sound across the cut (equal power),
// playing source beyond each clip's edge where the source has it. A track set to duck under voice drops while a
// voiceover or a clip with a transcript is speaking. A soloed track silences every track that isn't soloed.
import { clone, editable, findItem, itemEnd, updateItem, updateTrack } from './ops'
import { clipLocalAt, clipSourceAt, localAtOffset, shiftRamp, shiftsPitch, sourceOffset, sourceRange, speedAt, syncAverageSpeed } from './speed'
import type { AudioItem, FrameAudio, Item, Keyframe, Project, Track, Transition, VideoItem } from './types'
import { EPS, clamp, round, sampleKeyframes } from './util'

/** The loudest a clip plays (+12 dB), in the preview as in the export. */
export const MAX_GAIN = 3.98

/** How far a ducked track drops by default (dB). */
export const DUCK_DEFAULT_DB = 12
/** Ducking: the drop starts this long before speech (s), holds this long after it, then recovers over RELEASE. */
export const DUCK_ATTACK = 0.25
export const DUCK_HOLD = 0.4
export const DUCK_RELEASE = 0.6

/** Loudness targets for the export (integrated LUFS, true peak -1.5 dBTP). */
export const LOUDNESS_TARGETS = [
  { id: 'youtube', label: 'YouTube −14', lufs: -14, hint: 'YouTube, Instagram, TikTok and most streaming sites' },
  { id: 'podcast', label: 'Podcast −16', lufs: -16, hint: 'Apple Podcasts, Spotify and other spoken word' },
  { id: 'broadcast', label: 'Broadcast −23', lufs: -23, hint: 'TV (EBU R128)' },
] as const

export type LoudnessTarget = (typeof LOUDNESS_TARGETS)[number]['id']

export function loudnessLufs(target: string | undefined): number | undefined {
  return LOUDNESS_TARGETS.find((x) => x.id === target)?.lufs
}

/** Tracks that can make sound. */
export function hasSound(t: Track): boolean {
  return t.kind === 'audio' || t.kind === 'video' || t.kind === 'overlay'
}

export function soloActive(p: Project): boolean {
  return p.tracks.some((t) => t.solo && hasSound(t))
}

/** Whether a track is heard: not muted, and soloed when any track is. */
export function trackAudible(p: Project, t: Track, solo = soloActive(p)): boolean {
  return hasSound(t) && !t.muted && (!solo || !!t.solo)
}

/** Clips that make sound: freeze frames and reversed clips are silent (the export can't play sound backwards). */
export function sounding(p: Project, it: Item): it is VideoItem | AudioItem {
  if (it.type === 'audio') return !it.muted
  if (it.type === 'video') return !it.muted && it.freezeAt === undefined && !it.reverse && p.assets[it.assetId]?.hasAudio !== false
  return false
}

/** A clip's own level at `lt` seconds into it: volume keyframes and fades (the line drawn on the clip). */
export function clipLevel(it: VideoItem | AudioItem, lt: number): number {
  let v = sampleKeyframes(it.keyframes?.volume, lt, it.volume)
  if (it.fadeIn > 0 && lt < it.fadeIn) v *= Math.max(0, lt) / it.fadeIn
  const rem = it.duration - lt
  if (it.fadeOut > 0 && rem < it.fadeOut) v *= Math.max(0, rem) / it.fadeOut
  return clamp(v, 0, MAX_GAIN)
}

/** Where a clip's sound plays: its own range, widened into the transitions on either side of it. */
export interface SoundSpan {
  item: VideoItem | AudioItem
  track: Track
  /** Timeline seconds. */
  start: number
  end: number
  /** Source seconds at `start`. */
  mediaStart: number
  /** Crossfade windows (timeline seconds): the sound rises across `xIn` and falls across `xOut`. */
  xIn?: { from: number; to: number }
  xOut?: { from: number; to: number }
}

/**
 * The transition across the cut after `items[i]`: a visual clip's own, or, between two touching audio clips that are
 * the separated sound of two clips with a transition between them, that transition (so separated sound crossfades
 * as it did before it was separated, centred on the sound's own cut after a J or L cut).
 */
function transitionAfter(p: Project, items: Item[], i: number): Transition | undefined {
  const a = items[i]
  const b = items[i + 1]
  if (!a || !b || Math.abs(b.start - itemEnd(a)) >= 0.05) return undefined
  if (a.type !== 'audio') return 'transitionOut' in a ? a.transitionOut : undefined
  if (!a.linkId || !b.linkId || b.type !== 'audio') return undefined
  for (const t of p.tracks) {
    if (t.kind === 'audio') continue
    const k = t.items.findIndex((x) => x.linkId === a.linkId)
    const x = t.items[k]
    if (k >= 0 && t.items[k + 1]?.linkId === b.linkId && 'transitionOut' in x && Math.abs(t.items[k + 1].start - itemEnd(x)) < 0.05) return x.transitionOut
  }
  return undefined
}

/** The sound spans of one track's clips (heard or not: callers check the track). */
export function trackSpans(p: Project, track: Track): SoundSpan[] {
  const out: SoundSpan[] = []
  const items = track.items
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (!sounding(p, it)) continue
    const span: SoundSpan = { item: it, track, start: it.start, end: itemEnd(it), mediaStart: it.in }
    // the same windows evaluate() draws a picture transition in
    const prev = items[i - 1]
    const ptr = transitionAfter(p, items, i - 1)
    if (ptr && ptr.duration > 0) {
      const half = Math.min(ptr.duration / 2, prev.duration / 2, it.duration / 2)
      // sound before the clip's first frame only as far as the source has it
      span.start = Math.max(0, it.start - Math.min(half, -localAtOffset(it, -it.in)))
      span.xIn = { from: span.start, to: it.start + half }
    }
    const tr = transitionAfter(p, items, i)
    if (tr && tr.duration > 0) {
      const half = Math.min(tr.duration / 2, it.duration / 2, items[i + 1].duration / 2)
      const dur = p.assets[it.assetId]?.duration
      const after = dur !== undefined && Number.isFinite(dur) ? Math.max(0, localAtOffset(it, dur - it.in) - it.duration) : 0
      span.end = itemEnd(it) + Math.min(half, after)
      span.xOut = { from: itemEnd(it) - half, to: span.end }
    }
    span.mediaStart = Math.max(0, clipSourceAt(it, span.start - it.start))
    out.push(span)
  }
  return out
}

/** Every heard clip's sound span: visual tracks first, then audio tracks (the order the preview and export use). */
export function soundSpans(p: Project): SoundSpan[] {
  const solo = soloActive(p)
  const order = [...p.tracks.filter((t) => t.kind !== 'audio'), ...p.tracks.filter((t) => t.kind === 'audio')]
  return order.flatMap((t) => (trackAudible(p, t, solo) ? trackSpans(p, t) : []))
}

interface Speech {
  s: number
  e: number
}

/**
 * When someone is speaking (timeline seconds) between `from` and `to`: voiceovers, and the transcript lines of clips
 * that have one, on heard tracks that don't duck themselves.
 */
export function voiceIntervals(p: Project, from: number, to: number, solo = soloActive(p)): Speech[] {
  const out: Speech[] = []
  for (const track of p.tracks) {
    if (track.duck || !trackAudible(p, track, solo)) continue
    for (const it of track.items) {
      if (!sounding(p, it) || it.start > to || itemEnd(it) < from) continue
      if (it.type === 'audio' && it.tts) {
        out.push({ s: it.start, e: itemEnd(it) })
        continue
      }
      const segs = p.assets[it.assetId]?.transcript?.segments
      if (!segs?.length) continue
      const a = it.in
      const b = sourceRange(it).end
      for (const sg of segs) {
        if (sg.end <= a || sg.start >= b) continue
        const s = it.start + clipLocalAt(it, Math.max(a, sg.start))
        const e = it.start + clipLocalAt(it, Math.min(b, sg.end))
        if (e + DUCK_HOLD + DUCK_RELEASE >= from && s - DUCK_ATTACK <= to) out.push({ s, e })
      }
    }
  }
  return out
}

/** How far into its drop a ducked track is at t: 0 none, 1 fully down. */
export function duckDepth(voices: Speech[], t: number): number {
  let k = 0
  for (const v of voices) {
    const held = v.e + DUCK_HOLD
    let x = 0
    if (t >= v.s && t <= held) x = 1
    else if (t < v.s && t > v.s - DUCK_ATTACK) x = (t - (v.s - DUCK_ATTACK)) / DUCK_ATTACK
    else if (t > held && t < held + DUCK_RELEASE) x = 1 - (t - held) / DUCK_RELEASE
    if (x > k) k = x
    if (k >= 1) break
  }
  return k
}

function duckFloor(track: Track): number {
  return 10 ** (-Math.max(0, track.duck ?? 0) / 20)
}

/** What a span is heard at, at timeline time t (`voices`: the speech around t, for a ducked track). */
export function spanGain(span: SoundSpan, t: number, voices?: Speech[]): number {
  const it = span.item
  let g = clipLevel(it, clamp(t - it.start, 0, it.duration))
  const x = (w: { from: number; to: number }) => clamp((t - w.from) / Math.max(EPS, w.to - w.from), 0, 1)
  if (span.xIn && t < span.xIn.to) g *= Math.sin((Math.PI / 2) * x(span.xIn))
  if (span.xOut && t > span.xOut.from) g *= Math.cos((Math.PI / 2) * x(span.xOut))
  g *= clamp(span.track.volume ?? 1, 0, MAX_GAIN)
  if (span.track.duck && voices?.length) g *= 1 - (1 - duckFloor(span.track)) * duckDepth(voices, t)
  return clamp(g, 0, MAX_GAIN)
}

/** The sound playing at t: each heard clip's source time and level. */
export function frameAudio(p: Project, t: number): FrameAudio[] {
  const out: FrameAudio[] = []
  const solo = soloActive(p)
  for (const span of soundSpans(p)) {
    if (t < span.start || t >= span.end) continue
    const voices = span.track.duck ? voiceIntervals(p, t - DUCK_HOLD - DUCK_RELEASE, t + DUCK_ATTACK, solo) : undefined
    const it = span.item
    const lt = t - it.start
    out.push({ itemId: it.id, assetId: it.assetId, mediaTime: Math.max(0, clipSourceAt(it, lt)), volume: spanGain(span, t, voices), speed: speedAt(it, lt), ...(shiftsPitch(it) ? { pitchShift: true } : {}) })
  }
  return out
}

/** Most points a volume lane holds (HyperFrames reads 512). */
const LANE_MAX = 500

/**
 * A span's level over its length as lane points (seconds from the span's start): sampled every 0.1 s, finer across
 * crossfades, with a point on every keyframe, fade edge and duck ramp so the straight lines between points are the
 * level the preview hears. Runs of one level shrink to their ends; a lane still too long is simplified.
 */
export function gainLane(p: Project, span: SoundSpan, solo = soloActive(p)): Array<{ t: number; v: number }> {
  const it = span.item
  const voices = span.track.duck ? voiceIntervals(p, span.start - DUCK_HOLD - DUCK_RELEASE, span.end + DUCK_ATTACK, solo) : undefined
  const times: number[] = []
  const len = span.end - span.start
  for (let k = 0; k * 0.1 < len - EPS; k++) times.push(k * 0.1)
  times.push(len)
  for (const w of [span.xIn, span.xOut]) if (w) for (let k = 0; w.from + k * 0.02 < w.to; k++) times.push(w.from + k * 0.02 - span.start)
  const at = (abs: number) => times.push(abs - span.start)
  for (const x of [it.start, itemEnd(it), it.start + it.fadeIn, itemEnd(it) - it.fadeOut]) at(x)
  for (const kf of it.keyframes?.volume ?? []) at(it.start + kf.t)
  for (const v of voices ?? []) for (const x of [v.s - DUCK_ATTACK, v.s, v.e + DUCK_HOLD, v.e + DUCK_HOLD + DUCK_RELEASE]) at(x)
  const ts = [...new Set(times.filter((t) => t >= -EPS && t <= len + EPS).map((t) => round(clamp(t, 0, len), 3)))].sort((a, b) => a - b)
  const pts = ts.map((t) => ({ t, v: round(spanGain(span, span.start + t, voices), 4) }))
  // drop the middle of runs at one level to keep the attribute small, and the samples on straight lines of a long one
  const out = pts.filter((q, i) => i === 0 || i === pts.length - 1 || !(pts[i - 1].v === q.v && pts[i + 1].v === q.v))
  return out.length > LANE_MAX ? simplify(out, 0.001) : out
}

/** One <audio> element's worth of a span: timeline window, source start, and its lane (seconds from `start`). */
export interface LanePart {
  start: number
  end: number
  mediaStart: number
  points: Array<{ t: number; v: number }>
}

/** Parts of a long lane overlap this long (s), one fading out as the next fades in on the same sound. */
const JOIN = 0.02

/**
 * A span as one element, or, when its level changes more often than one lane holds (a long ducked track under a
 * lot of speech), as consecutive elements on the same sound that hand over with a 20 ms crossfade.
 */
export function laneParts(p: Project, span: SoundSpan, solo = soloActive(p)): LanePart[] {
  const pts = gainLane(p, span, solo)
  if (pts.length <= LANE_MAX) return [{ start: span.start, end: span.end, mediaStart: span.mediaStart, points: pts }]
  const voices = span.track.duck ? voiceIntervals(p, span.start - DUCK_HOLD - DUCK_RELEASE, span.end + DUCK_ATTACK, solo) : undefined
  const gain = (t: number) => round(spanGain(span, span.start + t, voices), 4)
  const parts: LanePart[] = []
  for (let i0 = 0; i0 < pts.length - 1; ) {
    const i1 = Math.min(pts.length - 1, i0 + LANE_MAX - 4)
    const t0 = pts[i0].t
    const t1 = pts[i1].t
    const last = i1 === pts.length - 1
    let local = pts.slice(i0, i1 + 1).map((q) => ({ t: round(q.t - t0, 3), v: q.v }))
    // after the first part: rise from silence over the join while the part before falls to it
    if (i0 > 0) local = [{ t: 0, v: 0 }, { t: JOIN, v: gain(t0 + JOIN) }, ...local.filter((q) => q.t > JOIN + EPS)]
    if (!last) local.push({ t: round(t1 - t0 + JOIN, 3), v: 0 })
    parts.push({ start: span.start + t0, end: span.start + t1 + (last ? 0 : JOIN), mediaStart: Math.max(0, clipSourceAt(span.item, span.start + t0 - span.item.start)), points: local })
    i0 = i1
  }
  return parts
}

/** Douglas–Peucker: the fewest points whose straight lines stay within `eps` of every dropped one. */
function simplify(pts: Array<{ t: number; v: number }>, eps: number): Array<{ t: number; v: number }> {
  const keep = new Array<boolean>(pts.length).fill(false)
  keep[0] = keep[pts.length - 1] = true
  const stack: Array<[number, number]> = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    let worst = eps
    let at = -1
    for (let i = a + 1; i < b; i++) {
      const span = pts[b].t - pts[a].t
      const line = span <= 0 ? pts[a].v : pts[a].v + ((pts[b].v - pts[a].v) * (pts[i].t - pts[a].t)) / span
      const d = Math.abs(pts[i].v - line)
      if (d > worst) {
        worst = d
        at = i
      }
    }
    if (at >= 0) {
      keep[at] = true
      stack.push([a, at], [at, b])
    }
  }
  return pts.filter((_, i) => keep[i])
}

/** The lane's level at `t` seconds into it, read as HyperFrames reads it (straight lines between points). */
export function laneAt(pts: Array<{ t: number; v: number }>, t: number): number {
  if (!pts.length) return 1
  if (t <= pts[0].t) return pts[0].v
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1]
      const b = pts[i]
      return b.t - a.t <= 0 ? b.v : a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t)
    }
  }
  return pts[pts.length - 1].v
}

// ---------- ops ----------

/** A track's sound settings: volume (1 = as mixed), solo, and how far it ducks under voice (dB; 0 or absent = off). */
export function setTrackSound(p0: Project, trackId: string, patch: Partial<Pick<Track, 'volume' | 'solo' | 'duck'>>): Project {
  const t = p0.tracks.find((x) => x.id === trackId)
  if (!t || !hasSound(t)) return p0
  const next: Partial<Track> = { ...patch }
  if (next.volume !== undefined) next.volume = round(clamp(next.volume, 0, MAX_GAIN), 3)
  if (next.duck !== undefined) next.duck = round(clamp(next.duck, 0, 40), 1)
  return updateTrack(p0, trackId, next)
}

/** Replace a clip's volume keyframes (sorted, inside the clip, values kept to 0..MAX_GAIN); none left removes the lane. */
export function setVolumeKeyframes(p0: Project, itemId: string, list: Keyframe[]): Project {
  const f = findItem(p0, itemId)
  if (!editable(f) || (f.item.type !== 'video' && f.item.type !== 'audio')) return p0
  const it = f.item
  const kfs = list
    .map((k) => ({ ...k, t: round(clamp(k.t, 0, it.duration), 4), value: round(clamp(k.value, 0, MAX_GAIN), 4) }))
    .sort((a, b) => a.t - b.t)
  const keyframes = { ...(it.keyframes ?? {}) }
  if (kfs.length) keyframes.volume = kfs
  else delete keyframes.volume
  return updateItem<AudioItem>(p0, itemId, { keyframes })
}

/** Source-safe range an audio clip's edge may move to (timeline seconds), ignoring its neighbours. */
function edgeRange(p: Project, it: AudioItem, edge: 'start' | 'end'): [number, number] {
  const minDur = 1 / p.fps
  const max = p.assets[it.assetId]?.duration ?? Infinity
  if (edge === 'end') return [it.start + minDur, it.start + localAtOffset(it, Math.max(0, max - it.in))]
  return [Math.max(0, it.start + localAtOffset(it, -it.in)), itemEnd(it) - minDur]
}

function trimOne(it: AudioItem, edge: 'start' | 'end', t: number) {
  if (edge === 'end') {
    it.duration = round(t - it.start, 4)
    syncAverageSpeed(it)
    return
  }
  const shift = t - it.start
  it.in = round(Math.max(0, it.in + sourceOffset(it, shift)), 4)
  it.start = round(t, 4)
  it.duration = round(it.duration - shift, 4)
  // keyframes and a speed ramp stay on the same moments of the sound
  for (const list of Object.values(it.keyframes ?? {})) for (const kf of list ?? []) kf.t = round(kf.t - shift, 4)
  if (it.speedRamp) it.speedRamp = shiftRamp(it.speedRamp, -shift)
  syncAverageSpeed(it)
}

/**
 * J and L cuts: move one edge of an audio clip on its own, leaving its linked video where it is, so the sound leads
 * (J) or trails (L) the picture. When the next or previous audio clip touches that edge, its edge rolls with it
 * (the cut between the two sounds moves, nothing overlaps and no gap opens). Both stay inside their source.
 */
export function rollAudioEdge(p0: Project, itemId: string, edge: 'start' | 'end', t: number): Project {
  const f0 = findItem(p0, itemId)
  if (!editable(f0) || f0.item.type !== 'audio') return p0
  const p = clone(p0)
  const f = findItem(p, itemId)!
  const it = f.item as AudioItem
  const items = f.track.items
  const nb = items[f.index + (edge === 'end' ? 1 : -1)]
  const other = edge === 'end' ? 'start' : 'end'
  const touching = nb?.type === 'audio' && !nb.locked && Math.abs(edge === 'end' ? nb.start - itemEnd(it) : itemEnd(nb) - it.start) < 0.05
  let [lo, hi] = edgeRange(p, it, edge)
  if (touching) {
    const [a, b] = edgeRange(p, nb as AudioItem, other)
    lo = Math.max(lo, a)
    hi = Math.min(hi, b)
  } else if (nb) {
    if (edge === 'end') hi = Math.min(hi, Math.max(nb.start, itemEnd(it)))
    else lo = Math.max(lo, Math.min(itemEnd(nb), it.start))
  }
  if (hi < lo) return p0
  const c = clamp(t, lo, hi)
  trimOne(it, edge, c)
  if (touching) trimOne(nb as AudioItem, other, c)
  p.updatedAt = Date.now()
  return p
}
