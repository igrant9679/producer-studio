// Pure editing operations. Every op takes a project and returns a NEW project (the input is never mutated),
// so the editor can keep an undo stack of snapshots and the AI assistant can apply the same ops server-side.
import { createAudioItem, createCaptionItem, createTrack } from './factory'
import type {
  AnimProp,
  AudioItem,
  CaptionStyle,
  Item,
  Keyframe,
  Project,
  Track,
  TrackKind,
  Transcript,
  TranscriptWord,
  VideoItem,
} from './types'
import { EPS, round, uid } from './util'

export function clone<T>(v: T): T {
  return structuredClone(v)
}

function touch(p: Project): Project {
  p.updatedAt = Date.now()
  return p
}

export function itemEnd(it: Item): number {
  return it.start + it.duration
}

export function projectDuration(p: Project): number {
  let end = 0
  for (const t of p.tracks) for (const it of t.items) end = Math.max(end, itemEnd(it))
  return round(end, 4)
}

export interface Found {
  track: Track
  trackIndex: number
  item: Item
  index: number
}

export function findItem(p: Project, itemId: string): Found | null {
  for (let ti = 0; ti < p.tracks.length; ti++) {
    const track = p.tracks[ti]
    const index = track.items.findIndex((i) => i.id === itemId)
    if (index >= 0) return { track, trackIndex: ti, item: track.items[index], index }
  }
  return null
}

export function findTrack(p: Project, trackId: string): Track | undefined {
  return p.tracks.find((t) => t.id === trackId)
}

export function mainTrack(p: Project): Track | undefined {
  return p.tracks.find((t) => t.main)
}

function sortItems(track: Track) {
  track.items.sort((a, b) => a.start - b.start)
}

/** Which track kinds may hold which item types. */
export function acceptsItem(kind: TrackKind, type: Item['type']): boolean {
  switch (kind) {
    case 'video':
    case 'overlay':
      return type === 'video' || type === 'image' || type === 'shape' || type === 'text'
    case 'text':
      return type === 'text' || type === 'shape'
    case 'audio':
      return type === 'audio'
    case 'caption':
      return type === 'caption'
  }
}

function defaultKindFor(type: Item['type']): TrackKind {
  if (type === 'audio') return 'audio'
  if (type === 'caption') return 'caption'
  if (type === 'text') return 'text'
  return 'overlay'
}

function overlaps(track: Track, start: number, end: number, ignore: Set<string>): boolean {
  return track.items.some((i) => !ignore.has(i.id) && i.start < end - EPS && itemEnd(i) > start + EPS)
}

/**
 * Insert a new track of `kind`. Audio tracks go below all visual tracks; caption tracks on top; visual tracks
 * directly above `aboveIndex` (or on top of the visual stack).
 */
export function insertTrack(p: Project, kind: TrackKind, aboveIndex?: number): Track {
  const track = createTrack(kind)
  if (kind === 'audio') {
    const firstVisual = p.tracks.findIndex((t) => t.kind !== 'audio')
    p.tracks.splice(firstVisual < 0 ? p.tracks.length : firstVisual, 0, track)
  } else if (kind === 'caption') {
    p.tracks.push(track)
  } else {
    let idx = aboveIndex !== undefined ? aboveIndex + 1 : p.tracks.length
    // keep caption tracks on top
    while (idx > 0 && p.tracks[idx - 1]?.kind === 'caption') idx--
    p.tracks.splice(idx, 0, track)
  }
  return track
}

/** Pack the magnetic main track: items edge to edge in their current order starting at 0. */
export function packMain(p: Project) {
  const m = mainTrack(p)
  if (!m) return
  sortItems(m)
  let t = 0
  for (const it of m.items) {
    it.start = round(t, 4)
    t += it.duration
  }
}

/**
 * Place `item` on `trackId` at item.start. Main track: inserted at the nearest cut and the track re-packed.
 * Other tracks: if the slot is occupied (or the track can't hold the type) a new track is created above.
 * Returns the track the item landed on.
 */
function placeItem(p: Project, item: Item, trackId: string | undefined): Track {
  let track = trackId ? findTrack(p, trackId) : undefined
  if (track && !acceptsItem(track.kind, item.type)) track = undefined
  if (track?.main) {
    sortItems(track)
    // insert before the first item whose midpoint is after the drop point
    const idx = track.items.findIndex((i) => i.start + i.duration / 2 > item.start)
    track.items.splice(idx < 0 ? track.items.length : idx, 0, item)
    packMain(p)
    return track
  }
  if (!track || overlaps(track, item.start, itemEnd(item), new Set([item.id]))) {
    // find an existing compatible non-main track with room, else create one
    const kind = track?.kind ?? defaultKindFor(item.type)
    const room = p.tracks.find((t) => !t.main && !t.locked && t.kind === kind && !overlaps(t, item.start, itemEnd(item), new Set([item.id])))
    if (room && !trackId) track = room
    else {
      const aboveIndex = track ? p.tracks.indexOf(track) : undefined
      track = insertTrack(p, kind, aboveIndex)
    }
  }
  track.items.push(item)
  sortItems(track)
  return track
}

export function addItem(p0: Project, item: Item, trackId?: string): Project {
  const p = clone(p0)
  const it = clone(item)
  it.start = Math.max(0, it.start)
  // A video/image with no track target and an empty main track goes to main.
  if (!trackId && (it.type === 'video' || it.type === 'image')) {
    const m = mainTrack(p)
    if (m) {
      if (m.items.length === 0) it.start = 0
      trackId = m.id
    }
  }
  placeItem(p, it, trackId)
  return touch(p)
}

export function addAsset(p0: Project, asset: Project['assets'][string]): Project {
  const p = clone(p0)
  p.assets[asset.id] = clone(asset)
  return touch(p)
}

export function updateItem<T extends Item>(p0: Project, itemId: string, patch: Partial<T>): Project {
  const p = clone(p0)
  const f = findItem(p, itemId)
  if (!f) return p0
  Object.assign(f.item, clone(patch))
  if (f.track.main) packMain(p)
  else sortItems(f.track)
  return touch(p)
}

export function updateTrack(p0: Project, trackId: string, patch: Partial<Track>): Project {
  const p = clone(p0)
  const t = findTrack(p, trackId)
  if (!t) return p0
  Object.assign(t, clone(patch))
  return touch(p)
}

export function updateProject(p0: Project, patch: Partial<Pick<Project, 'name' | 'width' | 'height' | 'fps' | 'background' | 'brand' | 'ai'>>): Project {
  return touch({ ...clone(p0), ...clone(patch) })
}

export function moveItem(p0: Project, itemId: string, to: { start: number; trackId?: string }): Project {
  const p = clone(p0)
  const f = findItem(p, itemId)
  if (!f || f.item.locked || f.track.locked) return p0
  const delta = to.start - f.item.start
  f.track.items.splice(f.index, 1)
  if (f.track.main) packMain(p)
  f.item.start = Math.max(0, round(to.start, 4))
  placeItem(p, f.item, to.trackId ?? f.track.id)
  // linked items (separated audio) follow the time change
  if (f.item.linkId) {
    for (const t of p.tracks)
      for (const it of t.items)
        if (it.id !== f.item.id && it.linkId === f.item.linkId && !t.main) it.start = Math.max(0, round(it.start + delta, 4))
  }
  pruneEmptyTracks(p)
  return touch(p)
}

/** Remove empty non-main tracks (CapCut collapses them). */
export function pruneEmptyTracks(p: Project) {
  p.tracks = p.tracks.filter((t) => t.main || t.items.length > 0)
}

function mediaSpan(p: Project, it: Item): { in: number; speed: number; max: number } | null {
  if (it.type !== 'video' && it.type !== 'audio') return null
  const asset = p.assets[it.assetId]
  const max = asset?.duration ?? Infinity
  return { in: it.in, speed: it.speed, max }
}

/**
 * Trim an edge to timeline time `t`. Media items can't be extended past their source bounds.
 * Main-track trims ripple (the track re-packs).
 */
export function trimItem(p0: Project, itemId: string, edge: 'start' | 'end', t: number): Project {
  const p = clone(p0)
  const f = findItem(p, itemId)
  if (!f || f.item.locked) return p0
  const it = f.item
  const minDur = 1 / p.fps
  const span = mediaSpan(p, it)
  if (edge === 'end') {
    let dur = Math.max(minDur, t - it.start)
    if (span && (it.type === 'video' ? !(it as VideoItem).freezeAt : true)) dur = Math.min(dur, (span.max - span.in) / span.speed)
    it.duration = round(dur, 4)
  } else {
    const end = itemEnd(it)
    let start = Math.min(t, end - minDur)
    if (span) {
      // moving the start later advances `in`; earlier needs source headroom
      const deltaSrc = (start - it.start) * span.speed
      const newIn = span.in + deltaSrc
      if (newIn < 0) start = it.start - span.in / span.speed
      ;(it as VideoItem | AudioItem).in = round(Math.max(0, span.in + (start - it.start) * span.speed), 4)
    }
    start = Math.max(0, start)
    const shift = start - it.start
    it.start = round(start, 4)
    it.duration = round(end - start, 4)
    // keep keyframes anchored to the same absolute times
    if ('keyframes' in it && it.keyframes) shiftKeyframes(it.keyframes, -shift, it.duration)
    if (it.type === 'caption' && it.words) it.words = it.words.map((w) => ({ ...w, start: w.start - shift, end: w.end - shift })).filter((w) => w.end > 0)
  }
  if (f.track.main) packMain(p)
  return touch(p)
}

function shiftKeyframes(kfs: Partial<Record<AnimProp, Keyframe[]>>, by: number, maxT: number) {
  for (const k of Object.keys(kfs) as AnimProp[]) {
    const list = kfs[k]
    if (!list) continue
    kfs[k] = list.map((kf) => ({ ...kf, t: round(kf.t + by, 4) })).filter((kf) => kf.t >= -EPS && kf.t <= maxT + EPS)
  }
}

/** Split an item at timeline time t into two items. Returns the new project and the id of the right half. */
export function splitItem(p0: Project, itemId: string, t: number): { project: Project; rightId?: string } {
  const p = clone(p0)
  const f = findItem(p, itemId)
  if (!f || f.item.locked) return { project: p0 }
  const it = f.item
  const local = t - it.start
  if (local <= 1 / p.fps || local >= it.duration - 1 / p.fps) return { project: p0 }
  const right = clone(it)
  right.id = uid(it.id.split('_')[0] || 'i')
  right.start = round(t, 4)
  right.duration = round(it.duration - local, 4)
  it.duration = round(local, 4)
  if (it.type === 'video' || it.type === 'audio') {
    const r = right as VideoItem | AudioItem
    if (!(it.type === 'video' && it.freezeAt !== undefined)) r.in = round(it.in + local * it.speed, 4)
    r.fadeIn = 0
    ;(it as VideoItem | AudioItem).fadeOut = 0
  }
  if ('keyframes' in it && it.keyframes) {
    const full = clone(it.keyframes)
    shiftKeyframes(it.keyframes, 0, it.duration)
    ;(right as typeof it).keyframes = full
    shiftKeyframes((right as typeof it).keyframes, -local, right.duration)
  }
  if ('animations' in it && it.animations) {
    const r = right as typeof it
    it.animations = { ...it.animations, out: undefined }
    r.animations = { ...r.animations, in: undefined }
    ;(it as typeof it).transitionOut = undefined
  }
  if (it.type === 'caption' && it.words) {
    const words = it.words
    it.words = words.filter((w) => w.start < local)
    ;(right as typeof it).words = words.filter((w) => w.start >= local).map((w) => ({ ...w, start: w.start - local, end: w.end - local }))
  }
  f.track.items.splice(f.index + 1, 0, right)
  return { project: touch(p), rightId: right.id }
}

/** Split every unlocked item under the playhead (Ctrl+B with nothing selected splits the selection or main). */
export function splitAt(p0: Project, t: number, itemIds?: string[]): Project {
  let p = p0
  const targets = itemIds ?? p0.tracks.flatMap((tr) => tr.items.filter((i) => i.start < t && itemEnd(i) > t).map((i) => i.id))
  for (const id of targets) p = splitItem(p, id, t).project
  return p
}

export function deleteItems(p0: Project, ids: string[], opts: { ripple?: boolean } = {}): Project {
  const p = clone(p0)
  const set = new Set(ids)
  for (const t of p.tracks) {
    if (t.locked) continue
    const removed = t.items.filter((i) => set.has(i.id))
    t.items = t.items.filter((i) => !set.has(i.id))
    if (opts.ripple && !t.main && removed.length) {
      // close the gap left by each removed item on that track
      for (const r of removed.sort((a, b) => b.start - a.start)) {
        for (const i of t.items) if (i.start >= itemEnd(r) - EPS) i.start = round(i.start - r.duration, 4)
      }
    }
  }
  packMain(p)
  pruneEmptyTracks(p)
  return touch(p)
}

export function duplicateItems(p0: Project, ids: string[]): { project: Project; newIds: string[] } {
  let p = p0
  const newIds: string[] = []
  for (const id of ids) {
    const f = findItem(p, id)
    if (!f) continue
    const copy = clone(f.item)
    copy.id = uid(f.item.id.split('_')[0] || 'i')
    copy.start = itemEnd(f.item)
    copy.linkId = undefined
    p = addItem(p, copy, f.track.id)
    newIds.push(copy.id)
  }
  return { project: p, newIds }
}

/** Paste clipboard items at time t, keeping their relative offsets. */
export function pasteItems(p0: Project, items: Item[], t: number): { project: Project; newIds: string[] } {
  if (!items.length) return { project: p0, newIds: [] }
  const base = Math.min(...items.map((i) => i.start))
  let p = p0
  const newIds: string[] = []
  for (const src of items) {
    const it = clone(src)
    it.id = uid(src.id.split('_')[0] || 'i')
    it.start = round(t + (src.start - base), 4)
    it.linkId = undefined
    p = addItem(p, it)
    newIds.push(it.id)
  }
  return { project: p, newIds }
}

export function setKeyframe(p0: Project, itemId: string, prop: AnimProp, localT: number, value: number, easeName?: Keyframe['ease']): Project {
  const p = clone(p0)
  const f = findItem(p, itemId)
  if (!f || !('keyframes' in f.item)) return p0
  const kfs = (f.item.keyframes[prop] ??= [])
  const t = round(Math.max(0, Math.min(localT, f.item.duration)), 4)
  const existing = kfs.find((k) => Math.abs(k.t - t) < 1 / (p.fps * 2))
  if (existing) {
    existing.value = value
    if (easeName) existing.ease = easeName
  } else kfs.push({ t, value, ease: easeName ?? 'easeInOut' })
  kfs.sort((a, b) => a.t - b.t)
  return touch(p)
}

export function removeKeyframe(p0: Project, itemId: string, prop: AnimProp, localT: number): Project {
  const p = clone(p0)
  const f = findItem(p, itemId)
  if (!f || !('keyframes' in f.item)) return p0
  const kfs = f.item.keyframes[prop]
  if (!kfs) return p0
  f.item.keyframes[prop] = kfs.filter((k) => Math.abs(k.t - localT) >= 1 / (p.fps * 2))
  if (!f.item.keyframes[prop]!.length) delete f.item.keyframes[prop]
  return touch(p)
}

/** Detach a video's audio onto an audio track as a linked item; mutes the video. */
export function separateAudio(p0: Project, itemId: string): Project {
  const f = findItem(p0, itemId)
  if (!f || f.item.type !== 'video') return p0
  const v = f.item
  const asset = p0.assets[v.assetId]
  if (!asset || asset.hasAudio === false) return p0
  const linkId = v.linkId ?? uid('l')
  const audio = createAudioItem(asset, v.start, { in: v.in, speed: v.speed, duration: v.duration, volume: v.volume, fadeIn: v.fadeIn, fadeOut: v.fadeOut, linkId, name: `${v.name ?? asset.name} audio` })
  let p = updateItem<VideoItem>(p0, itemId, { muted: true, linkId })
  const audioTrack = p.tracks.find((t) => t.kind === 'audio' && !overlaps(t, audio.start, itemEnd(audio), new Set()))
  p = addItem(p, audio, audioTrack?.id)
  return p
}

/** Insert a freeze frame of `holdSec` at timeline time t on a video item (splits and inserts a held segment). */
export function freezeFrame(p0: Project, itemId: string, t: number, holdSec = 2): Project {
  const f = findItem(p0, itemId)
  if (!f || f.item.type !== 'video') return p0
  const v = f.item
  const srcTime = v.in + (t - v.start) * v.speed
  const { project: split, rightId } = splitItem(p0, itemId, t)
  const p = clone(split)
  const freeze: VideoItem = { ...clone(v), id: uid('v'), start: t, duration: holdSec, freezeAt: round(srcTime, 4), fadeIn: 0, fadeOut: 0, animations: {}, transitionOut: undefined, keyframes: {} }
  const track = findTrack(p, f.track.id)!
  const insertAt = rightId ? track.items.findIndex((i) => i.id === rightId) : track.items.length
  if (!track.main) for (const i of track.items) if (i.start >= t - EPS) i.start = round(i.start + holdSec, 4)
  track.items.splice(insertAt < 0 ? track.items.length : insertAt, 0, freeze)
  if (track.main) packMain(p)
  else sortItems(track)
  return touch(p)
}

export function setAspect(p0: Project, width: number, height: number): Project {
  const p = clone(p0)
  const sx = width / p.width
  const sy = height / p.height
  for (const t of p.tracks)
    for (const it of t.items) {
      if (it.type === 'text' || it.type === 'shape') {
        it.transform.x = round(it.transform.x * sx, 2)
        it.transform.y = round(it.transform.y * sy, 2)
      }
      if (it.type === 'text') it.style.boxWidth = Math.round(Math.min(it.style.boxWidth, width * 0.9))
    }
  p.width = width
  p.height = height
  return touch(p)
}

/** Times an edit should snap to: playhead, item edges, keyframes, markers. */
export function snapPoints(p: Project, exclude: Set<string>, playhead?: number): number[] {
  const pts = new Set<number>([0])
  if (playhead !== undefined) pts.add(round(playhead, 4))
  for (const t of p.tracks)
    for (const it of t.items) {
      if (exclude.has(it.id)) continue
      pts.add(round(it.start, 4))
      pts.add(round(itemEnd(it), 4))
    }
  return [...pts].sort((a, b) => a - b)
}

export function snapTime(t: number, points: number[], threshold: number): { t: number; snapped: boolean } {
  let best = t
  let bestD = threshold
  for (const s of points) {
    const d = Math.abs(s - t)
    if (d < bestD) {
      best = s
      bestD = d
    }
  }
  return { t: best, snapped: best !== t }
}

// ---------- transcript-driven editing ----------

/** Words of a video/audio item's transcript mapped into timeline time (only words inside the item). */
export function itemWords(p: Project, itemId: string): Array<TranscriptWord & { srcStart: number; srcEnd: number }> {
  const f = findItem(p, itemId)
  if (!f || (f.item.type !== 'video' && f.item.type !== 'audio')) return []
  const it = f.item
  const tr = p.assets[it.assetId]?.transcript
  if (!tr) return []
  const srcEnd = it.in + it.duration * it.speed
  const out: Array<TranscriptWord & { srcStart: number; srcEnd: number }> = []
  for (const seg of tr.segments)
    for (const w of seg.words) {
      if (w.end <= it.in || w.start >= srcEnd) continue
      out.push({ w: w.w, srcStart: w.start, srcEnd: w.end, start: round(it.start + (w.start - it.in) / it.speed, 4), end: round(it.start + (w.end - it.in) / it.speed, 4) })
    }
  return out
}

/**
 * Cut the given SOURCE-time ranges out of an item (transcript editing / silence removal).
 * The item is split around each range and the pieces removed; the main track ripples, other tracks close gaps.
 */
export function cutSourceRanges(p0: Project, itemId: string, ranges: Array<{ start: number; end: number }>): Project {
  const f = findItem(p0, itemId)
  if (!f || (f.item.type !== 'video' && f.item.type !== 'audio')) return p0
  const it0 = f.item
  const trackId = f.track.id
  const sorted = [...ranges].filter((r) => r.end - r.start > 0.01).sort((a, b) => b.start - a.start) // right to left keeps earlier times valid
  let p = p0
  let ids = [itemId]
  for (const r of sorted) {
    // find the piece containing this range (source time)
    const pieceId = ids.find((id) => {
      const x = findItem(p, id)?.item as VideoItem | AudioItem | undefined
      return x && r.start < x.in + x.duration * x.speed && r.end > x.in
    })
    if (!pieceId) continue
    const piece = findItem(p, pieceId)!.item as VideoItem | AudioItem
    const tStart = Math.max(piece.start, piece.start + (r.start - piece.in) / piece.speed)
    const tEnd = Math.min(itemEnd(piece), piece.start + (r.end - piece.in) / piece.speed)
    let midId = pieceId
    const a = splitItem(p, pieceId, tStart)
    if (a.rightId) {
      p = a.project
      midId = a.rightId
      ids.push(a.rightId)
    }
    const b = splitItem(p, midId, tEnd)
    if (b.rightId) {
      p = b.project
      ids.push(b.rightId)
    }
    p = deleteItems(p, [midId], { ripple: true })
    ids = ids.filter((id) => id !== midId)
  }
  void it0
  void trackId
  return p
}

/** Remove pauses longer than minGap seconds from a media item using its transcript word gaps or detected silences. */
export function removeSilences(p0: Project, itemId: string, minGap = 0.6, pad = 0.12): Project {
  const f = findItem(p0, itemId)
  if (!f || (f.item.type !== 'video' && f.item.type !== 'audio')) return p0
  const asset = p0.assets[f.item.assetId]
  let gaps: Array<{ start: number; end: number }> = []
  if (asset?.silences?.length) gaps = asset.silences
  else if (asset?.transcript) {
    const words = asset.transcript.segments.flatMap((s) => s.words)
    for (let i = 0; i < words.length - 1; i++) gaps.push({ start: words[i].end, end: words[i + 1].start })
  }
  const cuts = gaps.filter((g) => g.end - g.start >= minGap).map((g) => ({ start: g.start + pad, end: g.end - pad }))
  return cutSourceRanges(p0, itemId, cuts)
}

const FILLERS = new Set(['um', 'uh', 'erm', 'er', 'ah', 'hmm', 'mm', 'uhm', 'like,', 'um,', 'uh,'])

export function fillerWordRanges(transcript: Transcript): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  for (const seg of transcript.segments)
    for (const w of seg.words) if (FILLERS.has(w.w.toLowerCase().replace(/[.!?]$/, ''))) out.push({ start: w.start, end: w.end })
  return out
}

// ---------- captions ----------

/** Break timed words into caption lines of at most `maxWords` words / 42 chars, split on pauses and punctuation. */
export function chunkWords(words: TranscriptWord[], maxWords: number): TranscriptWord[][] {
  const lines: TranscriptWord[][] = []
  let cur: TranscriptWord[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const prev = cur[cur.length - 1]
    const chars = cur.reduce((n, x) => n + x.w.length + 1, 0)
    const pause = prev ? w.start - prev.end > 0.5 : false
    if (cur.length && (cur.length >= maxWords || chars + w.w.length > 42 || pause)) {
      lines.push(cur)
      cur = []
    }
    cur.push(w)
    if (/[.!?]$/.test(w.w) && cur.length >= Math.min(3, maxWords)) {
      lines.push(cur)
      cur = []
    }
  }
  if (cur.length) lines.push(cur)
  return lines
}

/**
 * Generate a caption track from the transcripts of the given media items (default: every video/audio item that has
 * a transcript). Existing caption tracks are replaced.
 */
export function generateCaptions(p0: Project, opts: { itemIds?: string[]; style?: CaptionStyle } = {}): Project {
  const p = clone(p0)
  const words: TranscriptWord[] = []
  const sources = p.tracks.flatMap((t) => (t.muted ? [] : t.items)).filter((i) => (i.type === 'video' || i.type === 'audio') && (!opts.itemIds || opts.itemIds.includes(i.id)))
  for (const it of sources) {
    if ((it.type === 'video' && it.muted) || (it.type === 'audio' && it.muted)) continue
    for (const w of itemWords(p, it.id)) {
      if (w.start < it.start - EPS || w.end > itemEnd(it) + 0.25) continue
      words.push({ w: w.w, start: w.start, end: Math.min(w.end, itemEnd(it)) })
    }
  }
  words.sort((a, b) => a.start - b.start)
  const existing = p.tracks.find((t) => t.kind === 'caption')
  const style = opts.style ?? existing?.captionStyle
  p.tracks = p.tracks.filter((t) => t.kind !== 'caption')
  if (!words.length) return touch(p)
  const track = insertTrack(p, 'caption')
  if (style) track.captionStyle = clone(style)
  const lines = chunkWords(words, track.captionStyle!.maxWordsPerLine)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const start = line[0].start
    const nextStart = lines[i + 1]?.[0].start ?? Infinity
    const end = Math.min(Math.max(line[line.length - 1].end + 0.15, start + 0.6), nextStart)
    track.items.push(createCaptionItem(round(start, 4), round(end - start, 4), line.map((w) => w.w).join(' '), line.map((w) => ({ w: w.w, start: round(w.start - start, 4), end: round(w.end - start, 4) }))))
  }
  return touch(p)
}

/** Parse SRT into caption items on a new caption track. */
export function importSrt(p0: Project, srt: string): Project {
  const p = clone(p0)
  const toSec = (ts: string) => {
    const m = ts.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/)
    return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : 0
  }
  p.tracks = p.tracks.filter((t) => t.kind !== 'caption')
  const track = insertTrack(p, 'caption')
  for (const block of srt.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n').filter(Boolean)
    const timing = lines.find((l) => l.includes('-->'))
    if (!timing) continue
    const [a, b] = timing.split('-->')
    const text = lines.slice(lines.indexOf(timing) + 1).join(' ').trim()
    if (!text) continue
    const start = toSec(a)
    track.items.push(createCaptionItem(round(start, 3), round(Math.max(0.2, toSec(b) - start), 3), text))
  }
  return touch(p)
}

export function exportSrt(p: Project): string {
  const track = p.tracks.find((t) => t.kind === 'caption')
  if (!track) return ''
  const fmt = (s: number) => {
    const ms = Math.round(s * 1000)
    const h = Math.floor(ms / 3600000)
    const m = Math.floor((ms % 3600000) / 60000)
    const sec = Math.floor((ms % 60000) / 1000)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
  }
  return track.items
    .filter((i) => i.type === 'caption')
    .map((c, i) => `${i + 1}\n${fmt(c.start)} --> ${fmt(itemEnd(c))}\n${(c as { text: string }).text}\n`)
    .join('\n')
}
