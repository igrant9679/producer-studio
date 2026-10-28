// Caption tracks: captions made from transcripts, several tracks per project (one per language), the caption line
// editor's ops (retime, split, merge, word timings) and subtitle files in and out (SRT, WebVTT, ASS, LRC).
import { captionLines } from './captionLines'
import { createCaptionItem } from './factory'
import { clone, editable, findItem, findTrack, insertTrack, itemEnd, itemWords } from './ops'
import type { CaptionItem, CaptionStyle, Item, Project, Track, TranscriptWord } from './types'
import { EPS, round } from './util'

const touch = (p: Project): Project => {
  p.updatedAt = Date.now()
  return p
}

export function captionTracks(p: Project): Track[] {
  return p.tracks.filter((t) => t.kind === 'caption')
}

/** The caption track an action means: the one asked for, else the first shown, else the first. */
export function captionTrack(p: Project, trackId?: string): Track | undefined {
  const all = captionTracks(p)
  if (trackId) return all.find((t) => t.id === trackId)
  return all.find((t) => !t.hidden) ?? all[0]
}

/** A language code's name in English ("es" → "Spanish"), or the code itself. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code
  } catch {
    return code
  }
}

/** How a caption track is named in lists: "Captions · Spanish (es)". */
export function captionTrackLabel(t: Track): string {
  return t.language ? `${t.name} · ${languageName(t.language)} (${t.language})` : t.name
}

// ---------- captions from transcripts ----------

/**
 * The caption track captions made from speech belong on: one already made from a transcript, else one in the
 * transcript's language or with no language. A track in another language (an imported translation) isn't it.
 */
export function speechTrack(p: Project, language?: string): Track | undefined {
  const all = captionTracks(p)
  const base = (l?: string) => l?.toLowerCase().split('-')[0]
  return (
    all.find((t) => t.items.some((i) => i.type === 'caption' && !!i.words?.length)) ??
    all.find((t) => !t.language || !language || base(t.language) === base(language))
  )
}

/**
 * Generate captions from the transcripts of the given media items (default: every video/audio item that has a
 * transcript) onto one caption track: `trackId`, else the first caption track, else a new one. Other caption
 * tracks (other languages) are kept; the replaced one keeps its place, name and language.
 */
export function generateCaptions(p0: Project, opts: { itemIds?: string[]; style?: CaptionStyle; trackId?: string } = {}): Project {
  const p = clone(p0)
  const words: TranscriptWord[] = []
  let language: string | undefined
  const sources = p.tracks.flatMap((t) => (t.muted ? [] : t.items)).filter((i) => (i.type === 'video' || i.type === 'audio') && (!opts.itemIds || opts.itemIds.includes(i.id)))
  for (const it of sources) {
    if ((it.type === 'video' && it.muted) || (it.type === 'audio' && it.muted)) continue
    // a reversed clip's speech plays backwards (and not at all in the export), so it gets no captions
    if (it.type === 'video' && it.reverse && it.freezeAt === undefined) continue
    for (const w of itemWords(p, it.id)) {
      if (w.start < it.start - EPS || w.end > itemEnd(it) + 0.25) continue
      words.push({ w: w.w, start: w.start, end: Math.min(w.end, itemEnd(it)) })
    }
    const lang = 'assetId' in it ? p.assets[it.assetId]?.transcript?.language : undefined
    if (lang && lang !== 'und') language ??= lang
  }
  words.sort((a, b) => a.start - b.start)
  const existing = opts.trackId ? findTrack(p, opts.trackId) : speechTrack(p, language)
  const target = existing?.kind === 'caption' ? existing : undefined
  const style = opts.style ?? target?.captionStyle
  if (!words.length) {
    if (target) p.tracks = p.tracks.filter((t) => t !== target)
    return touch(p)
  }
  const track = target ?? insertTrack(p, 'caption')
  if (style) track.captionStyle = clone(style)
  if (!track.language && language) track.language = language
  track.items = captionLines(words, track.captionStyle!.maxWordsPerLine, 1 / p.fps)
  return touch(p)
}

/**
 * Break a caption track's lines again at `maxWords` words. Only lines made from a transcript (they carry word
 * timings) are re-broken; imported, typed and edited captions stay exactly as they are and nothing runs into them.
 */
export function rechunkCaptions(p0: Project, trackId: string, maxWords: number): Project {
  const p = clone(p0)
  const track = findTrack(p, trackId)
  if (!track || track.kind !== 'caption') return p0
  track.items.sort((a, b) => a.start - b.start)
  const items: Item[] = []
  let run: CaptionItem[] = []
  const flush = (until: number) => {
    // words a trim cut off the end stay off
    const words = run.flatMap((c) => c.words!.filter((w) => w.start < c.duration).map((w) => ({ w: w.w, start: round(c.start + w.start, 4), end: round(c.start + w.end, 4) })))
    if (words.length) items.push(...captionLines(words, maxWords, 1 / p.fps, until))
    run = []
  }
  for (const it of track.items) {
    if (it.type === 'caption' && it.words?.length) run.push(it)
    else {
      flush(it.start)
      items.push(it)
    }
  }
  flush(Infinity)
  track.items = items
  return touch(p)
}

// ---------- caption tracks ----------

/** A new, empty caption track (styled like `style`, or the canvas default), shown instead of the others. */
export function addCaptionTrack(p0: Project, opts: { language?: string; name?: string; style?: CaptionStyle } = {}): { project: Project; trackId: string } {
  const p = clone(p0)
  for (const t of captionTracks(p)) t.hidden = true
  const track = insertTrack(p, 'caption')
  if (opts.style) track.captionStyle = clone(opts.style)
  if (opts.name) track.name = opts.name
  if (opts.language) track.language = opts.language
  return { project: touch(p), trackId: track.id }
}

/**
 * Show one caption track in the video (preview and export burn-in) and hide the others; null hides them all.
 * The export burns in exactly the caption tracks that are shown.
 */
export function showOnlyCaptionTrack(p0: Project, trackId: string | null): Project {
  const tracks = captionTracks(p0)
  if (tracks.every((t) => !!t.hidden === (t.id !== trackId))) return p0
  const p = clone(p0)
  for (const t of captionTracks(p)) t.hidden = t.id !== trackId
  return touch(p)
}

export function setCaptionLanguage(p0: Project, trackId: string, language: string): Project {
  const p = clone(p0)
  const t = findTrack(p, trackId)
  if (!t || t.kind !== 'caption' || t.locked) return p0
  const code = language.trim()
  if (code) t.language = code
  else delete t.language
  return touch(p)
}

// ---------- the caption line editor ----------

function lineOf(p: Project, itemId: string): { track: Track; line: CaptionItem; index: number } | null {
  const f = findItem(p, itemId)
  if (!editable(f) || f.item.type !== 'caption') return null
  f.track.items.sort((a, b) => a.start - b.start)
  return { track: f.track, line: f.item, index: f.track.items.indexOf(f.item) }
}

/** Where a line may sit: after the line before it, before the line after it. */
function room(track: Track, index: number): { lo: number; hi: number } {
  const prev = track.items[index - 1]
  const next = track.items[index + 1]
  return { lo: prev ? itemEnd(prev) : 0, hi: next ? next.start : Infinity }
}

/** Word timings kept at the same moments when a line's start moves; words outside the line go. */
function rebase(line: CaptionItem, start: number, end: number) {
  if (!line.words) return
  const by = line.start - start
  const dur = end - start
  const had = line.words.length
  line.words = line.words
    .map((w) => ({ w: w.w, start: round(w.start + by, 4), end: round(w.end + by, 4) }))
    .filter((w) => w.end > EPS && w.start < dur - EPS)
    .map((w) => ({ w: w.w, start: Math.max(0, w.start), end: Math.min(dur, w.end) }))
  if (!line.words.length) line.words = undefined
  else if (line.words.length !== had) line.text = line.words.map((w) => w.w).join(' ')
}

/**
 * Set a line's start and/or end (timeline seconds). The words stay at the moments they're spoken; the line stays
 * between its neighbours and lasts at least a frame.
 */
export function retimeCaption(p0: Project, itemId: string, edges: { start?: number; end?: number }): Project {
  const p = clone(p0)
  const f = lineOf(p, itemId)
  if (!f) return p0
  const { line, track, index } = f
  const frame = 1 / p.fps
  const { lo, hi } = room(track, index)
  let end = Math.min(hi, edges.end ?? itemEnd(line))
  let start = Math.max(lo, Math.min(edges.start ?? line.start, end - frame))
  if (end - start < frame) end = Math.min(hi, start + frame)
  start = round(start, 4)
  end = round(end, 4)
  if (end - start < frame - EPS || (start === line.start && end === round(itemEnd(line), 4))) return p0
  rebase(line, start, end)
  line.start = start
  line.duration = round(end - start, 4)
  return touch(p)
}

/** Move a line (words and all) to start at `start`, kept between its neighbours. */
export function moveCaption(p0: Project, itemId: string, start: number): Project {
  const p = clone(p0)
  const f = lineOf(p, itemId)
  if (!f) return p0
  const { lo, hi } = room(f.track, f.index)
  const to = round(Math.max(lo, Math.min(start, hi - f.line.duration)), 4)
  if (to < lo - EPS || to === f.line.start) return p0
  f.line.start = to
  return touch(p)
}

/** A line's words: its timed words, or the words of its text. */
export function captionTokens(line: CaptionItem): string[] {
  return line.words?.length ? line.words.map((w) => w.w) : line.text.split(/\s+/).filter(Boolean)
}

/**
 * Split a line before its word `at` (1 … words - 1). A line with word timings splits where that word is spoken;
 * one without splits in proportion to the text on each side.
 */
export function splitCaption(p0: Project, itemId: string, at: number): { project: Project; rightId?: string } {
  const p = clone(p0)
  const f = lineOf(p, itemId)
  if (!f) return { project: p0 }
  const { line, track, index } = f
  const tokens = captionTokens(line)
  if (at < 1 || at >= tokens.length) return { project: p0 }
  const frame = 1 / p.fps
  const leftText = tokens.slice(0, at).join(' ')
  const rightText = tokens.slice(at).join(' ')
  const local = line.words?.length ? line.words[at].start : (line.duration * leftText.length) / (leftText.length + rightText.length + 1)
  const cut = round(Math.max(frame, Math.min(line.duration - frame, local)), 4)
  if (cut < frame - EPS || line.duration - cut < frame - EPS) return { project: p0 }
  const right = createCaptionItem(round(line.start + cut, 4), round(line.duration - cut, 4), rightText, line.words?.slice(at).map((w) => ({ w: w.w, start: round(Math.max(0, w.start - cut), 4), end: round(Math.max(0, w.end - cut), 4) })))
  line.text = leftText
  line.duration = cut
  if (line.words) line.words = line.words.slice(0, at).map((w) => ({ ...w, end: Math.min(w.end, cut) }))
  track.items.splice(index + 1, 0, right)
  return { project: touch(p), rightId: right.id }
}

/** Join a line with the one after it on its track: one line from the start of the first to the end of the second. */
export function mergeCaptions(p0: Project, itemId: string): Project {
  const p = clone(p0)
  const f = lineOf(p, itemId)
  if (!f) return p0
  const { line, track, index } = f
  const next = track.items[index + 1]
  if (!next || next.type !== 'caption' || next.locked) return p0
  const by = next.start - line.start
  line.words = line.words?.length && next.words?.length ? [...line.words, ...next.words.map((w) => ({ w: w.w, start: round(w.start + by, 4), end: round(w.end + by, 4) }))] : undefined
  line.text = `${line.text} ${next.text}`.trim()
  line.duration = round(itemEnd(next) - line.start, 4)
  track.items.splice(index + 1, 1)
  return touch(p)
}

/**
 * New text for a line. A fix that keeps the number of words (a typo) keeps the word timings, so karaoke still
 * follows; a different number of words drops them (they no longer match).
 */
export function setCaptionText(p0: Project, itemId: string, text: string): Project {
  const p = clone(p0)
  const f = lineOf(p, itemId)
  if (!f || f.line.text === text) return p0
  const tokens = text.split(/\s+/).filter(Boolean)
  const words = f.line.words
  f.line.text = text
  f.line.words = words?.length && words.length === tokens.length ? words.map((w, i) => ({ ...w, w: tokens[i] })) : undefined
  return touch(p)
}

/**
 * Change one karaoke word: its text, or its start/end (seconds from the line's start). A word stays between its
 * neighbours, inside the line, and lasts at least 10 ms.
 */
export function setCaptionWord(p0: Project, itemId: string, index: number, patch: { w?: string; start?: number; end?: number }): Project {
  const p = clone(p0)
  const f = lineOf(p, itemId)
  const words = f?.line.words
  if (!f || !words?.[index]) return p0
  const min = 0.01
  const w = words[index]
  const lo = index > 0 ? words[index - 1].end : 0
  const hi = index < words.length - 1 ? words[index + 1].start : f.line.duration
  let start = patch.start ?? w.start
  let end = patch.end ?? w.end
  start = Math.max(lo, Math.min(start, hi - min))
  end = Math.max(start + min, Math.min(end, hi))
  const text = patch.w?.trim()
  const next = { w: text && !/\s/.test(text) ? text : w.w, start: round(start, 4), end: round(end, 4) }
  if (next.w === w.w && next.start === w.start && next.end === w.end) return p0
  words[index] = next
  f.line.text = words.map((x) => x.w).join(' ')
  return touch(p)
}

/** Give a line without word timings some to start from: its words spread over the line by their length. */
export function spreadCaptionWords(p0: Project, itemId: string): Project {
  const p = clone(p0)
  const f = lineOf(p, itemId)
  if (!f || f.line.words?.length) return p0
  const tokens = f.line.text.split(/\s+/).filter(Boolean)
  if (!tokens.length) return p0
  const total = tokens.reduce((n, t) => n + t.length + 1, 0)
  let at = 0
  f.line.words = tokens.map((w) => {
    const len = (f.line.duration * (w.length + 1)) / total
    const out = { w, start: round(at, 4), end: round(at + len, 4) }
    at += len
    return out
  })
  f.line.text = tokens.join(' ')
  return touch(p)
}

// ---------- subtitle files ----------

export type CaptionFormat = 'srt' | 'vtt' | 'ass' | 'lrc'

export const CAPTION_FORMATS: ReadonlyArray<{ id: CaptionFormat; name: string; ext: string; mime: string }> = [
  { id: 'srt', name: 'SubRip (.srt)', ext: 'srt', mime: 'application/x-subrip' },
  { id: 'vtt', name: 'WebVTT (.vtt)', ext: 'vtt', mime: 'text/vtt' },
  { id: 'ass', name: 'Advanced SubStation (.ass)', ext: 'ass', mime: 'text/x-ssa' },
  { id: 'lrc', name: 'Lyrics (.lrc)', ext: 'lrc', mime: 'text/plain' },
]

/** One cue from a subtitle file: timeline seconds; word times are absolute too. */
export interface ParsedCaption {
  start: number
  end: number
  text: string
  words?: TranscriptWord[]
}

/** A subtitle file's format from its name, else from what it holds. */
export function captionFormatOf(text: string, fileName = ''): CaptionFormat {
  const ext = fileName.toLowerCase().match(/\.(srt|vtt|ass|ssa|lrc)$/)?.[1]
  if (ext) return ext === 'ssa' ? 'ass' : (ext as CaptionFormat)
  const head = text.replace(/^﻿/, '').trimStart()
  if (/^WEBVTT/.test(head)) return 'vtt'
  if (/^\[Script Info\]/im.test(head) || /^Dialogue:/m.test(head)) return 'ass'
  if (/^\[\d+:\d{1,2}(?:[.:]\d+)?\]/m.test(head) && !head.includes('-->')) return 'lrc'
  return 'srt'
}

/** The language a subtitle file names: "talk.es.srt" → "es", a WebVTT "Language: fr" header → "fr". */
export function captionLanguageOf(text: string, fileName = ''): string | undefined {
  const fromName = fileName.match(/[._-]([a-z]{2,3}(?:-[A-Za-z]{2,4})?)\.(?:srt|vtt|ass|ssa|lrc)$/i)?.[1]
  if (fromName) return fromName
  return text.replace(/^﻿/, '').match(/^WEBVTT[^\n]*\n(?:[^\n]+\n)*?Language:\s*([A-Za-z-]{2,12})/m)?.[1]
}

/** "01:02:03,456", "02:03.45", "1:02:03.45" (hours optional, any fraction): seconds. */
function clock(s: string): number | null {
  const m = s.trim().match(/^(?:(\d+):)?(\d+):(\d{1,2})(?:[.,:](\d{1,3}))?$/)
  if (!m) return null
  return (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3] + (m[4] ? +m[4] / 10 ** m[4].length : 0)
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' }
const decode = (s: string) => s.replace(/&(#\d+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCharCode(+e.slice(1)) : ENTITIES[e.toLowerCase()] ?? m))
const tidy = (s: string) => s.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, ' ').trim()

/** Timed pieces of text (each from its time to the next one's) as words; a piece of several words shares its time. */
function spread(pieces: Array<{ t: number; text: string }>, end: number): TranscriptWord[] {
  const words: TranscriptWord[] = []
  pieces.forEach((pc, i) => {
    const toks = pc.text.split(/\s+/).filter(Boolean)
    const until = Math.max(pc.t, pieces[i + 1]?.t ?? end)
    toks.forEach((w, k) => {
      const a = pc.t + ((until - pc.t) * k) / toks.length
      const b = pc.t + ((until - pc.t) * (k + 1)) / toks.length
      words.push({ w, start: round(a, 4), end: round(b, 4) })
    })
  })
  return words
}

function parseSrt(text: string): ParsedCaption[] {
  const out: ParsedCaption[] = []
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => l.trim())
    const ti = lines.findIndex((l) => l.includes('-->'))
    if (ti < 0) continue
    const [a, b] = lines[ti].split('-->')
    const start = clock(a.trim().split(/\s+/)[0])
    const end = clock(b.trim().split(/\s+/)[0])
    const body = tidy(decode(lines.slice(ti + 1).join('\n').replace(/<[^>]+>/g, '').replace(/\{\\[^}]*\}/g, '')))
    if (start === null || end === null || !body) continue
    out.push({ start, end, text: body })
  }
  return out
}

function parseVtt(text: string): ParsedCaption[] {
  const out: ParsedCaption[] = []
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n')
    const ti = lines.findIndex((l) => l.includes('-->'))
    if (ti < 0 || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue
    const [a, b] = lines[ti].split('-->')
    const start = clock(a.trim())
    const end = clock(b.trim().split(/\s+/)[0])
    if (start === null || end === null) continue
    const payload = lines.slice(ti + 1).join('\n')
    // inline timestamps (<00:00:01.500>) time the words after them: karaoke
    const parts = payload.split(/<(\d[\d:.]*)>/)
    const pieces: Array<{ t: number; text: string }> = []
    for (let i = 0; i < parts.length; i += 2) {
      const at = i === 0 ? start : clock(parts[i - 1])
      const piece = tidy(decode(parts[i].replace(/<[^>]+>/g, '')))
      if (piece && at !== null) pieces.push({ t: at, text: piece })
    }
    const body = pieces.map((x) => x.text).join(' ')
    if (!body) continue
    out.push({ start, end, text: body, ...(pieces.length > 1 ? { words: spread(pieces, end) } : {}) })
  }
  return out
}

function parseAss(text: string): ParsedCaption[] {
  const out: ParsedCaption[] = []
  let fields = ['layer', 'start', 'end', 'style', 'name', 'marginl', 'marginr', 'marginv', 'effect', 'text']
  let inEvents = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line)
      continue
    }
    if (!inEvents) continue
    if (/^format:/i.test(line)) {
      fields = line.slice(7).split(',').map((f) => f.trim().toLowerCase())
      continue
    }
    if (!/^dialogue:/i.test(line)) continue
    const rest = line.slice(9).trim()
    const vals: string[] = []
    let from = 0
    for (let i = 0; i < fields.length - 1; i++) {
      const comma = rest.indexOf(',', from)
      if (comma < 0) break
      vals.push(rest.slice(from, comma))
      from = comma + 1
    }
    vals.push(rest.slice(from))
    const get = (f: string) => vals[fields.indexOf(f)] ?? ''
    const start = clock(get('start'))
    const end = clock(get('end'))
    if (start === null || end === null) continue
    const body = get('text').replace(/\\[Nn]/g, ' ').replace(/\\h/g, ' ')
    // {\k50} (centiseconds) times the syllable after it
    const pieces: Array<{ t: number; text: string }> = []
    let t = start
    let karaoke = false
    for (const m of body.matchAll(/((?:\{[^}]*\})*)([^{]*)/g)) {
      if (!m[0]) continue
      const k = m[1].match(/\\[kK][fo]?(\d+)/)
      const piece = decode(m[2])
      if (k) karaoke = true
      if (piece) pieces.push({ t, text: piece })
      if (k) t += +k[1] / 100
    }
    const plain = tidy(pieces.map((x) => x.text).join(''))
    if (!plain) continue
    let words: TranscriptWord[] | undefined
    if (karaoke) {
      // syllables join into the words they spell
      words = []
      let cur: TranscriptWord | null = null
      pieces.forEach((pc, i) => {
        const until = pieces[i + 1]?.t ?? end
        const chunks = pc.text.split(/(\s+)/)
        for (const ch of chunks) {
          if (!ch) continue
          if (/^\s+$/.test(ch)) {
            if (cur) words!.push(cur)
            cur = null
          } else if (cur) {
            cur.w += ch
            cur.end = until
          } else cur = { w: ch, start: pc.t, end: until }
        }
      })
      if (cur) words.push(cur)
      words = words.map((w) => ({ w: w.w, start: round(w.start, 4), end: round(Math.max(w.end, w.start + 0.01), 4) }))
    }
    out.push({ start, end, text: plain, ...(words?.length ? { words } : {}) })
  }
  return out
}

/** LRC times are mm:ss.xx (some write mm:ss:xx). */
const lrcClock = (s: string) => clock(s.replace(/^(\d+:\d{1,2}):(\d{1,3})$/, '$1.$2'))

function parseLrc(text: string): ParsedCaption[] {
  let offset = 0
  const marks: Array<{ t: number; body: string }> = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const off = line.match(/^\[offset:\s*([+-]?\d+)\]/i)
    if (off) offset = +off[1] / 1000
    const stamps = [...line.matchAll(/\[(\d+:\d{1,2}(?:[.:]\d{1,3})?)\]/g)]
    if (!stamps.length || stamps[0].index !== 0) continue
    const body = line.replace(/\[(\d+:\d{1,2}(?:[.:]\d{1,3})?)\]/g, '')
    for (const s of stamps) {
      const t = lrcClock(s[1])
      if (t !== null) marks.push({ t, body })
    }
  }
  marks.sort((a, b) => a.t - b.t)
  const out: ParsedCaption[] = []
  marks.forEach((m, i) => {
    // a timestamp with no words clears the line before it
    const parts = m.body.split(/<(\d+:\d{1,2}(?:[.:]\d{1,3})?)>/)
    const pieces: Array<{ t: number; text: string }> = []
    for (let k = 0; k < parts.length; k += 2) {
      const at = k === 0 ? m.t : lrcClock(parts[k - 1])
      const piece = tidy(parts[k])
      if (piece && at !== null) pieces.push({ t: at, text: piece })
    }
    const body = pieces.map((x) => x.text).join(' ')
    if (!body) return
    const next = marks[i + 1]?.t
    const words = pieces.length > 1 ? spread(pieces, next ?? pieces[pieces.length - 1].t + 2) : undefined
    const end = next ?? Math.max(m.t + 3, words?.[words.length - 1]?.end ?? 0)
    out.push({ start: m.t, end, text: body, ...(words ? { words } : {}) })
  })
  return out.map((c) => ({ ...c, start: Math.max(0, c.start - offset), end: Math.max(0, c.end - offset), words: c.words?.map((w) => ({ ...w, start: Math.max(0, w.start - offset), end: Math.max(0, w.end - offset) })) }))
}

/** The cues of a subtitle file (SRT, WebVTT, ASS/SSA or LRC; `format` absent: detected). */
export function parseCaptions(text: string, format: CaptionFormat = captionFormatOf(text)): ParsedCaption[] {
  const clean = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  const cues = format === 'vtt' ? parseVtt(clean) : format === 'ass' ? parseAss(clean) : format === 'lrc' ? parseLrc(clean) : parseSrt(clean)
  return cues.filter((c) => c.end > c.start).sort((a, b) => a.start - b.start)
}

/**
 * Caption items from cues, one track's worth: overlapping cues are cut back so each ends where the next begins
 * (a caption track holds one line at a time), and every line lasts at least `minDur`.
 */
function linesFromCues(cues: ParsedCaption[], minDur: number): CaptionItem[] {
  const out: CaptionItem[] = []
  cues.forEach((c, i) => {
    const start = round(Math.max(c.start, out.length ? itemEnd(out[out.length - 1]) : 0), 3)
    const end = Math.min(c.end, cues[i + 1]?.start ?? Infinity)
    if (end - start < minDur) return
    const words = c.words?.map((w) => ({ w: w.w, start: round(Math.max(0, w.start - start), 4), end: round(Math.max(0, Math.min(w.end, end) - start), 4) }))
    out.push(createCaptionItem(start, round(end - start, 3), c.text, words))
  })
  return out
}

/**
 * Captions from a subtitle file onto a caption track: `trackId` replaces that track's lines (its style, name and
 * language stay), otherwise a new track takes them and is shown instead of the others.
 */
export function importCaptions(
  p0: Project,
  text: string,
  opts: { format?: CaptionFormat; fileName?: string; trackId?: string; language?: string; name?: string; style?: CaptionStyle } = {},
): { project: Project; trackId?: string; count: number } {
  const cues = parseCaptions(text, opts.format ?? captionFormatOf(text, opts.fileName))
  const lines = linesFromCues(cues, 1 / p0.fps)
  if (!lines.length) return { project: p0, count: 0 }
  let p: Project
  let trackId = opts.trackId
  const target = trackId ? findTrack(p0, trackId) : undefined
  if (target?.kind === 'caption' && !target.locked) p = clone(p0)
  else ({ project: p, trackId } = addCaptionTrack(p0, { style: opts.style, name: opts.name }))
  const track = findTrack(p, trackId!)!
  track.items = lines
  const lang = opts.language ?? captionLanguageOf(text, opts.fileName)
  if (lang) track.language = lang
  return { project: touch(p), trackId, count: lines.length }
}

/** Parse SRT into caption items on a new caption track that replaces the caption tracks there were. */
export function importSrt(p0: Project, srt: string): Project {
  const p = clone(p0)
  p.tracks = p.tracks.filter((t) => t.kind !== 'caption')
  const track = insertTrack(p, 'caption')
  track.items = parseCaptions(srt, 'srt').map((c) => createCaptionItem(round(c.start, 3), round(Math.max(0.2, c.end - c.start), 3), c.text))
  return touch(p)
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function stamp(s: number, format: CaptionFormat): string {
  const cs = format === 'ass' || format === 'lrc'
  const unit = cs ? 100 : 1000
  const n = Math.round(Math.max(0, s) * unit)
  const frac = n % unit
  const whole = Math.floor(n / unit)
  const h = Math.floor(whole / 3600)
  const m = Math.floor((whole % 3600) / 60)
  const sec = whole % 60
  if (format === 'lrc') return `${pad(Math.floor(whole / 60))}:${pad(sec)}.${pad(frac)}`
  if (format === 'ass') return `${h}:${pad(m)}:${pad(sec)}.${pad(frac)}`
  return `${pad(h)}:${pad(m)}:${pad(sec)}${format === 'srt' ? ',' : '.'}${pad(frac, 3)}`
}

/** "#rrggbb" (or #rgb, #rrggbbaa, rgb(), rgba()) as an ASS colour, &HAABBGGRR; anything else is white. */
function assColor(c: string, alpha = 0): string {
  let [r, g, b, a] = [255, 255, 255, alpha]
  const v = c.trim()
  const hex = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1]
  const rgb = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)$/i)
  if (hex) {
    const full = hex.length === 3 ? hex.split('').map((x) => x + x).join('') : hex
    ;[r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
    if (full.length === 8) a = 255 - parseInt(full.slice(6, 8), 16)
  } else if (rgb) {
    ;[r, g, b] = [rgb[1], rgb[2], rgb[3]].map(Number)
    if (rgb[4] !== undefined) a = Math.round(255 * (1 - Math.min(1, +rgb[4])))
  }
  const h = (n: number) => Math.max(0, Math.min(255, n)).toString(16).toUpperCase().padStart(2, '0')
  return `&H${h(a)}${h(b)}${h(g)}${h(r)}`
}

function assHeader(p: Project, track: Track): string {
  const cs = track.captionStyle
  const st = cs?.style
  const size = Math.round(st?.fontSize ?? 56)
  const marginV = Math.max(0, Math.round(p.height * (1 - (cs?.position ?? 0.86)) - size * 0.6))
  const boxed = !!st?.background
  const style = [
    'Default',
    (st?.fontFamily ?? 'Inter').replace(/,/g, ' '),
    size,
    assColor(st?.color ?? '#ffffff'),
    assColor(cs?.highlightColor ?? '#ffe14d'),
    assColor((boxed ? st?.background?.color : st?.stroke?.color) ?? '#000000'),
    assColor(st?.shadow?.color ?? st?.background?.color ?? '#000000', boxed ? Math.round(255 * (1 - (st?.background?.opacity ?? 1))) : 128),
    (st?.fontWeight ?? 400) >= 600 ? -1 : 0,
    st?.italic ? -1 : 0,
    st?.underline ? -1 : 0,
    0,
    100,
    100,
    Math.round(st?.letterSpacing ?? 0),
    0,
    boxed ? 3 : 1,
    boxed ? Math.round((st?.background?.padding ?? 10) / 2) : Math.round(st?.stroke?.width ?? 0),
    st?.shadow ? Math.round(Math.max(Math.abs(st.shadow.x), Math.abs(st.shadow.y), 1)) : 0,
    2,
    40,
    40,
    marginV,
    1,
  ].join(',')
  return [
    '[Script Info]',
    `Title: ${(p.name || 'Captions').replace(/\n/g, ' ')}`,
    'ScriptType: v4.00+',
    `PlayResX: ${p.width}`,
    `PlayResY: ${p.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: ${style}`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ].join('\n')
}

/** Lines of a track inside `range` (if given), moved so the range starts at 0 and cut to fit it. */
function linesIn(track: Track, range?: { start: number; end: number }): CaptionItem[] {
  const lines = track.items.filter((i): i is CaptionItem => i.type === 'caption' && i.text.trim() !== '').sort((a, b) => a.start - b.start)
  if (!range) return lines
  const out: CaptionItem[] = []
  for (const c of lines) {
    const a = Math.max(c.start, range.start)
    const b = Math.min(itemEnd(c), range.end)
    if (b - a <= EPS) continue
    const by = c.start - a
    const words = c.words?.map((w) => ({ w: w.w, start: w.start + by, end: w.end + by })).filter((w) => w.end > EPS && w.start < b - a - EPS)
    out.push({ ...c, start: a - range.start, duration: b - a, words: words?.length ? words : undefined })
  }
  return out
}

/**
 * A caption track as a subtitle file: SRT, WebVTT, ASS (styled like the track) or LRC. `trackId` absent: the shown
 * track (see `captionTrack`). `karaoke` writes the word timings too (WebVTT inline timestamps, ASS \k, enhanced
 * LRC). `range` (timeline seconds) keeps only that part, timed from its start, for a range export's sidecar file.
 * Empty when there is nothing to write.
 */
export function captionsToText(p: Project, format: CaptionFormat, opts: { trackId?: string; karaoke?: boolean; range?: { start: number; end: number } } = {}): string {
  const track = captionTrack(p, opts.trackId)
  if (!track) return ''
  const lines = linesIn(track, opts.range)
  if (!lines.length) return ''
  const timed = (c: CaptionItem) => !!opts.karaoke && !!c.words?.length
  if (format === 'srt') return lines.map((c, i) => `${i + 1}\n${stamp(c.start, 'srt')} --> ${stamp(itemEnd(c), 'srt')}\n${c.text}\n`).join('\n')
  if (format === 'vtt') {
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/-->/g, '--&gt;')
    const body = (c: CaptionItem) => (timed(c) ? c.words!.map((w, i) => (i === 0 && w.start <= EPS ? esc(w.w) : `<${stamp(c.start + w.start, 'vtt')}>${esc(w.w)}`)).join(' ') : esc(c.text))
    const head = track.language ? `WEBVTT\nLanguage: ${track.language}\n` : 'WEBVTT\n'
    return `${head}\n${lines.map((c) => `${stamp(c.start, 'vtt')} --> ${stamp(itemEnd(c), 'vtt')}\n${body(c)}\n`).join('\n')}`
  }
  if (format === 'ass') {
    const esc = (s: string) => s.replace(/[{}]/g, '').replace(/\n/g, '\\N')
    const body = (c: CaptionItem) => {
      if (!timed(c)) return esc(c.text)
      // each word lasts until the next one starts (a silent lead-in first)
      const words = c.words!
      const lead = Math.round(words[0].start * 100)
      const parts = words.map((w, i) => `{\\k${Math.max(1, Math.round(((words[i + 1]?.start ?? c.duration) - w.start) * 100))}}${esc(w.w)}`)
      return (lead > 0 ? `{\\k${lead}}` : '') + parts.join(' ')
    }
    return `${assHeader(p, track)}\n${lines.map((c) => `Dialogue: 0,${stamp(c.start, 'ass')},${stamp(itemEnd(c), 'ass')},Default,,0,0,0,,${body(c)}`).join('\n')}\n`
  }
  // LRC: a line shows until the next; a blank stamp clears one that ends before the next starts
  const out: string[] = []
  if (p.name) out.push(`[ti:${p.name.replace(/[[\]\n]/g, ' ')}]`)
  lines.forEach((c, i) => {
    const text = c.text.replace(/\n/g, ' ')
    const body = timed(c) ? c.words!.map((w) => `<${stamp(c.start + w.start, 'lrc')}>${w.w}`).join(' ') : text
    out.push(`[${stamp(c.start, 'lrc')}]${body}`)
    const next = lines[i + 1]
    if (!next || next.start - itemEnd(c) > 0.05) out.push(`[${stamp(itemEnd(c), 'lrc')}]`)
  })
  return out.join('\n') + '\n'
}

/** The shown caption track as SRT (see `captionsToText`). */
export function exportSrt(p: Project, trackId?: string): string {
  return captionsToText(p, 'srt', { trackId })
}
