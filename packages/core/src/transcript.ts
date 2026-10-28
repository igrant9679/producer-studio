// Transcript editing, Descript-style: words cut from a clip stay in the transcript struck through and can be
// restored; filler words from an editable list; speaker labels on the transcript.
import { captionsInsert } from './captionLines'
import { clone, editable, findItem, isEditable, itemEnd, packMain } from './ops'
import { rampOf, sourceRange } from './speed'
import type { AudioItem, Item, Project, Track, Transcript, TranscriptSegment, TranscriptWord, VideoItem } from './types'
import { EPS, round, uid } from './util'

type Media = VideoItem | AudioItem

const isMedia = (i: Item | undefined): i is Media => !!i && (i.type === 'video' || i.type === 'audio')
const srcEnd = (it: Media) => sourceRange(it).end
/** Plays its source forwards (not a freeze frame, not reversed). */
const forwards = (it: Media) => !(it.type === 'video' && (it.freezeAt !== undefined || it.reverse))

/**
 * The clip right after `itemId` on its track when it plays the same recording on from later in it, with nothing
 * between them: what lies between the two in the recording was cut (by a transcript edit, a trim, a pause removal).
 */
export function cutNeighbour(p: Project, itemId: string): Media | null {
  const f = findItem(p, itemId)
  if (!f || !isMedia(f.item) || !forwards(f.item)) return null
  const a = f.item
  const next = [...f.track.items].sort((x, y) => x.start - y.start).find((i) => i.start >= a.start + EPS && i.id !== a.id)
  if (!isMedia(next) || next.type !== a.type || next.assetId !== a.assetId || !forwards(next)) return null
  if (Math.abs(next.start - itemEnd(a)) > 0.01 || Math.abs(next.speed - a.speed) > EPS) return null
  // a cut out of a speed ramp has no one speed to play the restored words at
  if (rampOf(a) || rampOf(next)) return null
  return next.in > srcEnd(a) + 0.005 ? next : null
}

/** A word cut from between two pieces of a clip: its source times, and the timeline moment of the cut. */
export interface StruckWord extends TranscriptWord {
  srcStart: number
  srcEnd: number
  /** The pieces on either side of the cut. */
  leftId: string
  rightId: string
  /** The source range cut there (every struck word of the cut lies inside it). */
  gap: { start: number; end: number }
}

/** The words cut between `leftId` and the piece after it (see `cutNeighbour`), in source order. */
export function struckWords(p: Project, leftId: string): StruckWord[] {
  const right = cutNeighbour(p, leftId)
  const left = findItem(p, leftId)?.item as Media | undefined
  if (!right || !left) return []
  const tr = p.assets[left.assetId]?.transcript
  if (!tr) return []
  const gap = { start: srcEnd(left), end: right.in }
  const at = itemEnd(left)
  const out: StruckWord[] = []
  for (const seg of tr.segments)
    for (const w of seg.words) {
      const mid = (w.start + w.end) / 2
      if (mid < gap.start || mid >= gap.end) continue
      out.push({ w: w.w, start: at, end: at, srcStart: w.start, srcEnd: w.end, leftId, rightId: right.id, gap })
    }
  return out.sort((a, b) => a.srcStart - b.srcStart)
}

/** Linked items (separated audio) of `it` on other tracks. */
function partnersOf(p: Project, it: Item): Item[] {
  if (!it.linkId) return []
  return p.tracks.flatMap((t) => (t.locked ? [] : t.items.filter((o) => o.linkId === it.linkId && o.id !== it.id && !o.locked)))
}

/** What tells two pieces of a clip apart beyond where they sit: equal means they can be one clip again. */
function look(it: Item): string {
  const { id: _i, start: _s, duration: _d, linkId: _l, ...rest } = it as Item & Record<string, unknown>
  for (const k of ['in', 'phase', 'fadeIn', 'fadeOut', 'animations', 'transitionOut', 'name']) delete (rest as Record<string, unknown>)[k]
  return JSON.stringify(rest)
}

const noKeyframes = (it: Item) => !('keyframes' in it) || !it.keyframes || Object.values(it.keyframes).every((k) => !k?.length)

/** `b` folded into `a`, which now runs `extra` seconds longer before b's own length (the restored stretch). */
function fold(track: Track, a: Item, b: Item, extra: number) {
  a.duration = round(a.duration + extra + b.duration, 4)
  const A = a as Media
  const B = b as Media
  A.fadeOut = B.fadeOut
  if ('transitionOut' in b) (a as VideoItem).transitionOut = (b as VideoItem).transitionOut
  if ('animations' in a && a.animations && 'animations' in b) a.animations = { ...a.animations, out: (b as VideoItem).animations?.out }
  track.items = track.items.filter((i) => i !== b)
}

/**
 * Bring back a stretch of the recording cut between `leftId` and the piece after it: `range` (source seconds, inside
 * the cut; absent: all of it). It goes back where it was cut, everything after it on the track moves on (with linked
 * audio), and the captions over it get their words back. Restoring all of a cut joins the two pieces into one clip
 * again when nothing else tells them apart.
 */
export function restoreCut(p0: Project, leftId: string, range?: { start: number; end: number }): Project {
  const f = findItem(p0, leftId)
  const right0 = cutNeighbour(p0, leftId)
  if (!editable(f) || !right0 || !isEditable(p0, right0.id)) return p0
  const a0 = f.item as Media
  const gap = { start: srcEnd(a0), end: right0.in }
  const tol = a0.speed / p0.fps
  let s = Math.max(gap.start, range?.start ?? gap.start)
  let e = Math.min(gap.end, range?.end ?? gap.end)
  // a range within a frame of an edge of the cut reaches it
  if (s - gap.start < tol) s = gap.start
  if (gap.end - e < tol) e = gap.end
  if (e - s < tol) return p0
  const len = round((e - s) / a0.speed, 4)
  const at = itemEnd(a0)

  const p = clone(p0)
  const track = p.tracks[f.trackIndex]
  const a = track.items.find((i) => i.id === leftId) as Media
  const b = track.items.find((i) => i.id === right0.id) as Media
  const pa = partnersOf(p, a)
  const pb = partnersOf(p, b)
  // make room: what starts at the cut or later moves on, on this track and wherever it is linked
  const moved = new Set<Item>()
  for (const it of track.items)
    if (it.start >= at - EPS) {
      moved.add(it)
      for (const o of partnersOf(p, it)) if (o.start >= at - EPS) moved.add(o)
    }
  for (const it of moved) it.start = round(it.start + len, 4)

  let piece: Media = a
  const whole = s === gap.start && e === gap.end
  const trackOf = (x: Item) => p.tracks.find((t) => t.items.includes(x))
  const pairs = pa.length === pb.length && pa.every((x, i) => look(x) === look(pb[i]) && trackOf(x) === trackOf(pb[i]))
  if (whole && look(a) === look(b) && noKeyframes(a) && noKeyframes(b) && pairs && pb.every(noKeyframes) && pa.every(noKeyframes)) {
    // the cut is gone: one clip again
    fold(track, a, b, len)
    pa.forEach((x, i) => fold(trackOf(x)!, x, pb[i], len))
  } else if (s === gap.start) {
    a.duration = round(a.duration + len, 4)
    a.fadeOut = 0
    for (const x of pa) x.duration = round(x.duration + len, 4)
  } else if (e === gap.end) {
    b.start = round(at, 4)
    b.in = round(b.in - (e - s), 4)
    b.duration = round(b.duration + len, 4)
    b.fadeIn = 0
    for (const x of pb) {
      if (!isMedia(x)) continue
      x.start = round(x.start - len, 4)
      x.in = round(x.in - (e - s), 4)
      x.duration = round(x.duration + len, 4)
      x.fadeIn = 0
    }
    piece = b
  } else {
    // from the middle of a cut: a piece of its own between the two
    const n = clone(a)
    n.id = uid(a.id.split('_')[0] || 'i')
    n.start = round(at, 4)
    n.in = round(s, 4)
    n.duration = len
    n.fadeIn = 0
    n.fadeOut = 0
    if ('keyframes' in n) n.keyframes = {}
    if ('transitionOut' in n) n.transitionOut = undefined
    if ('animations' in n && n.animations) n.animations = {}
    n.linkId = pa.length ? uid('l') : undefined
    track.items.splice(track.items.indexOf(a) + 1, 0, n)
    for (const x of pa) {
      if (!isMedia(x)) continue
      const m = clone(x)
      m.id = uid(x.id.split('_')[0] || 'i')
      m.start = round(at, 4)
      m.in = round(x.in + (s - a.in), 4)
      m.duration = len
      m.fadeIn = 0
      m.fadeOut = 0
      m.linkId = n.linkId
      const t = trackOf(x)!
      t.items.splice(t.items.indexOf(x) + 1, 0, m)
    }
    piece = n
  }
  for (const t of p.tracks) t.items.sort((x, y) => x.start - y.start)
  if (track.main) packMain(p)
  // the captions over the cut get the restored words (timeline times) back
  const tr = p.assets[piece.assetId]?.transcript
  const words: TranscriptWord[] = []
  if (tr)
    for (const seg of tr.segments)
      for (const w of seg.words) {
        const mid = (w.start + w.end) / 2
        if (mid < s || mid >= e) continue
        words.push({ w: w.w, start: round(at + Math.max(0, w.start - s) / a0.speed, 4), end: round(at + Math.min(e - s, w.end - s) / a0.speed, 4) })
      }
  captionsInsert(p, at, len, words)
  p.updatedAt = Date.now()
  return p
}

// ---------- filler words ----------

/** The filler list a project starts with: the sounds on; words that are often meant ("like", "you know") off. */
export const DEFAULT_FILLER_WORDS: ReadonlyArray<{ w: string; on: boolean }> = [
  { w: 'um', on: true },
  { w: 'uh', on: true },
  { w: 'uhm', on: true },
  { w: 'erm', on: true },
  { w: 'er', on: true },
  { w: 'ah', on: true },
  { w: 'hmm', on: true },
  { w: 'mm', on: true },
  { w: 'like', on: false },
  { w: 'you know', on: false },
  { w: 'I mean', on: false },
  { w: 'sort of', on: false },
  { w: 'kind of', on: false },
  { w: 'basically', on: false },
  { w: 'actually', on: false },
]

export function fillerList(p: Project): Array<{ w: string; on: boolean }> {
  return p.fillerWords ?? DEFAULT_FILLER_WORDS.map((f) => ({ ...f }))
}

/** A word as the filler list compares it: lower case, no punctuation. */
export const fillerKey = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}' ]/gu, '').replace(/\s+/g, ' ').trim()

/** A new filler list for the project (entries trimmed, no repeats, at most 100). */
export function setFillerWords(p0: Project, list: Array<{ w: string; on: boolean }>): Project {
  const seen = new Set<string>()
  const clean = list
    .map((f) => ({ w: f.w.trim().replace(/\s+/g, ' ').slice(0, 60), on: !!f.on }))
    .filter((f) => {
      const k = fillerKey(f.w)
      if (!k || seen.has(k)) return false
      seen.add(k)
      return true
    })
    .slice(0, 100)
  const p = clone(p0)
  p.fillerWords = clean
  p.updatedAt = Date.now()
  return p
}

/**
 * Where filler words and phrases occur in a run of words: index ranges [from, to] (inclusive), longest phrase
 * first, never overlapping. `phrases` are the entries to look for ("um", "you know").
 */
export function matchFillers(words: ReadonlyArray<{ w: string }>, phrases: readonly string[]): Array<[number, number]> {
  const lists = [...new Set(phrases.map(fillerKey).filter(Boolean))].map((f) => f.split(' ')).sort((a, b) => b.length - a.length)
  const keys = words.map((w) => fillerKey(w.w))
  const out: Array<[number, number]> = []
  for (let i = 0; i < keys.length; i++) {
    const hit = lists.find((ph) => ph.every((t, k) => keys[i + k] === t))
    if (!hit) continue
    out.push([i, i + hit.length - 1])
    i += hit.length - 1
  }
  return out
}

const FILLERS = new Set(['um', 'uh', 'erm', 'er', 'ah', 'hmm', 'mm', 'uhm', 'like,', 'um,', 'uh,'])

/**
 * Source-time ranges of a transcript's filler words: the `phrases` given (see `matchFillers`), or, without them,
 * the sounds (um, uh…) and a "like," set off by a comma.
 */
export function fillerWordRanges(transcript: Transcript, phrases?: readonly string[]): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  if (phrases) {
    const words = transcript.segments.flatMap((s) => s.words)
    for (const [a, b] of matchFillers(words, phrases)) out.push({ start: words[a].start, end: words[b].end })
    return out
  }
  for (const seg of transcript.segments)
    for (const w of seg.words) if (FILLERS.has(w.w.toLowerCase().replace(/[.!?]$/, ''))) out.push({ start: w.start, end: w.end })
  return out
}

// ---------- speakers ----------

/** The speaker of the segment holding source time t (undefined: none named). */
export function speakerAt(tr: Transcript, t: number): string | undefined {
  return tr.segments.find((s) => t >= s.start - EPS && t < s.end + EPS)?.speaker
}

/** The speakers a transcript names, in order of first appearance. */
export function speakersOf(tr: Transcript): string[] {
  return [...new Set(tr.segments.map((s) => s.speaker).filter((s): s is string => !!s))]
}

/** Every segment of `from` is now `to`'s (a rename, or two labels made one). */
export function renameSpeaker(tr: Transcript, from: string, to: string): Transcript {
  const name = to.trim().slice(0, 120)
  if (!name || name === from) return tr
  return { ...tr, segments: tr.segments.map((s) => (s.speaker === from ? { ...s, speaker: name } : s)) }
}

/**
 * The words spoken between source times start and end are `speaker`'s: segments are split at the edges of the
 * range, so only those words change hands. A blank speaker takes the label off.
 */
export function assignSpeaker(tr: Transcript, start: number, end: number, speaker: string): Transcript {
  const name = speaker.trim().slice(0, 120)
  const inside = (w: TranscriptWord) => (w.start + w.end) / 2 >= start - EPS && (w.start + w.end) / 2 <= end + EPS
  const segments: TranscriptSegment[] = []
  for (const seg of tr.segments) {
    if (!seg.words.some(inside)) {
      segments.push(seg)
      continue
    }
    // runs of words inside / outside the range, each its own segment
    const from = segments.length
    let run: TranscriptWord[] = []
    let runIn = inside(seg.words[0])
    const flush = () => {
      if (!run.length) return
      const s: TranscriptSegment = { start: run[0].start, end: run[run.length - 1].end, text: run.map((w) => w.w).join(' '), words: run }
      const who = runIn ? name : seg.speaker
      if (who) s.speaker = who
      segments.push(s)
      run = []
    }
    for (const w of seg.words) {
      if (inside(w) !== runIn) {
        flush()
        runIn = inside(w)
      }
      run.push(w)
    }
    flush()
    // the pieces still cover the whole of the segment they came from
    segments[from].start = Math.min(segments[from].start, seg.start)
    segments[segments.length - 1].end = Math.max(segments[segments.length - 1].end, seg.end)
  }
  return { ...tr, segments }
}
