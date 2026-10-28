// Caption lines from timed words, and caption tracks following edits to the speech under them: a transcript cut
// takes its words out of the captions and closes the gap, a restore opens it again and puts the words back.
import { createCaptionItem } from './factory'
import type { CaptionItem, Item, Project, TranscriptWord } from './types'
import { EPS, round } from './util'

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
 * Caption items for timed words (timeline seconds), at most `maxWords` a line; no line runs past `until`. A line that
 * would last less than `minDur` (words timed at the same moment) joins the next, so no caption is shorter than a frame.
 */
export function captionLines(words: TranscriptWord[], maxWords: number, minDur: number, until = Infinity): CaptionItem[] {
  const lines: TranscriptWord[][] = []
  for (const line of chunkWords(words, maxWords)) {
    const last = lines[lines.length - 1]
    if (last && line[0].start - last[0].start < minDur) last.push(...line)
    else lines.push([...line])
  }
  if (lines.length > 1 && until - lines[lines.length - 1][0].start < minDur) lines[lines.length - 2].push(...lines.pop()!)
  return lines.map((line, i) => {
    const start = line[0].start
    const nextStart = lines[i + 1]?.[0].start ?? until
    const end = Math.max(Math.min(Math.max(line[line.length - 1].end + 0.15, start + 0.6), nextStart), start + minDur)
    return createCaptionItem(round(start, 4), round(end - start, 4), line.map((w) => w.w).join(' '), line.map((w) => ({ w: w.w, start: round(w.start - start, 4), end: round(w.end - start, 4) })))
  })
}

const absWords = (c: CaptionItem): TranscriptWord[] => (c.words ?? []).map((w) => ({ w: w.w, start: c.start + w.start, end: c.start + w.end }))

/**
 * Timeline span [t0, t1) was cut and what came after it moved back by its length: every unlocked caption track
 * follows. Lines inside the span go, lines over it lose the words spoken in it, later lines move back. Mutates `p`.
 */
export function captionsCut(p: Project, t0: number, t1: number) {
  const d = t1 - t0
  if (!(d > EPS)) return
  const frame = 1 / p.fps
  for (const track of p.tracks) {
    if (track.kind !== 'caption' || track.locked) continue
    const out: Item[] = []
    for (const it of track.items) {
      const end = it.start + it.duration
      if (it.locked || end <= t0 + EPS) out.push(it)
      else if (it.start >= t1 - EPS) {
        it.start = round(it.start - d, 4)
        out.push(it)
      } else if (it.type === 'caption') {
        const start = Math.min(it.start, t0)
        const until = end > t1 ? end - d : t0
        if (until - start < frame - EPS) continue
        if (it.words?.length) {
          // a word belongs to the side holding its midpoint
          const kept = absWords(it)
            .filter((w) => (w.start + w.end) / 2 < t0 || (w.start + w.end) / 2 >= t1)
            .map((w) => (w.start >= t0 ? { w: w.w, start: Math.max(t0, w.start - d), end: Math.max(t0, w.end - d) } : { ...w, end: Math.min(w.end, t0) }))
          if (!kept.length) continue
          it.words = kept.map((w) => ({ w: w.w, start: round(w.start - start, 4), end: round(Math.max(w.start, w.end) - start, 4) }))
          it.text = kept.map((w) => w.w).join(' ')
        }
        it.start = round(start, 4)
        it.duration = round(until - start, 4)
        out.push(it)
      } else out.push(it)
    }
    track.items = out
  }
}

/**
 * Timeline span [t, t + len) was opened at `t` (restored speech) and what came after it moved on by `len`: caption
 * tracks follow. Tracks made from a transcript (lines with word timings) get `words` (timeline times) as captions,
 * joined into the line they were cut from; other tracks (imported, typed, another language) only make room. Mutates `p`.
 */
export function captionsInsert(p: Project, t: number, len: number, words: TranscriptWord[]) {
  if (!(len > EPS)) return
  const frame = 1 / p.fps
  for (const track of p.tracks) {
    if (track.kind !== 'caption' || track.locked) continue
    const fromSpeech = track.items.some((i) => i.type === 'caption' && !!i.words?.length)
    let over: CaptionItem | undefined
    for (const it of track.items) {
      if (it.locked) continue
      if (it.start >= t - EPS) it.start = round(it.start + len, 4)
      else if (it.start + it.duration > t + EPS) {
        if (fromSpeech && it.type === 'caption' && it.words?.length) over = it
        else it.duration = round(it.duration + len, 4)
      }
    }
    if (!fromSpeech || (!words.length && !over)) {
      if (over) over.duration = round(over.duration + len, 4)
      continue
    }
    let pool = words
    if (over) {
      const abs = absWords(over)
      pool = [...abs.filter((w) => w.start < t), ...words, ...abs.filter((w) => w.start >= t).map((w) => ({ w: w.w, start: w.start + len, end: w.end + len }))]
      track.items = track.items.filter((i) => i !== over)
    }
    const first = pool[0]?.start ?? t
    const until = Math.min(...track.items.filter((i) => i.start >= first - EPS).map((i) => i.start), Infinity)
    const lines = captionLines(pool, track.captionStyle?.maxWordsPerLine ?? 7, frame, until)
    // the line keeps the moment it started at
    if (over && lines.length) {
      const l = lines[0]
      const shift = l.start - over.start
      if (shift > 0) {
        l.start = round(over.start, 4)
        l.duration = round(l.duration + shift, 4)
        l.words = l.words?.map((w) => ({ ...w, start: round(w.start + shift, 4), end: round(w.end + shift, 4) }))
      }
    }
    track.items.push(...lines)
    track.items.sort((a, b) => a.start - b.start)
  }
}
