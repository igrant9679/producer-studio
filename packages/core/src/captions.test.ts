// Caption line editor and subtitle files (E-12): retime, split, merge, karaoke words; SRT, WebVTT, ASS and LRC in
// and out; several caption tracks with a language each.
import { describe, expect, it } from 'vitest'
import {
  addAsset,
  addCaptionTrack,
  addItem,
  captionFormatOf,
  captionLanguageOf,
  captionTrack,
  captionTracks,
  captionsToText,
  createProject,
  createVideoItem,
  evaluate,
  exportSrt,
  generateCaptions,
  importCaptions,
  mergeCaptions,
  moveCaption,
  parseCaptions,
  rechunkCaptions,
  retimeCaption,
  setCaptionLanguage,
  setCaptionText,
  setCaptionWord,
  showOnlyCaptionTrack,
  speechTrack,
  splitCaption,
  spreadCaptionWords,
  type Asset,
  type CaptionItem,
  type Project,
} from './index'

const talk: Asset = {
  id: 'a',
  kind: 'video',
  name: 'a.mp4',
  src: 'a.mp4',
  duration: 10,
  hasAudio: true,
  transcript: {
    language: 'en',
    engine: 'test',
    segments: [{ start: 0, end: 5, text: 'one two three four', words: [{ w: 'one', start: 0.5, end: 0.9 }, { w: 'two', start: 1.0, end: 1.4 }, { w: 'three', start: 1.5, end: 1.9 }, { w: 'four.', start: 2.0, end: 2.4 }] }],
  },
}

function captioned(): Project {
  let p = addAsset(createProject({ name: 'Talk' }), talk)
  p = addItem(p, createVideoItem(p.assets.a, 0))
  return generateCaptions(p)
}

const lines = (p: Project, trackId?: string) => captionTrack(p, trackId)!.items as CaptionItem[]

describe('caption line editor', () => {
  it('retimes a line by its edges, keeping the words where they are spoken and the line between its neighbours', () => {
    const q0 = captioned()
    const [line] = lines(q0)
    const q = retimeCaption(q0, line.id, { start: 0.3 })
    const moved = lines(q)[0]
    expect(moved.start).toBeCloseTo(0.3, 4)
    expect(moved.start + moved.words![0].start).toBeCloseTo(0.5, 4)
    // a start after a word drops it
    const later = lines(retimeCaption(q0, line.id, { start: 1.45 }))[0]
    expect(later.words!.map((w) => w.w)).toEqual(['three', 'four.'])
    expect(later.text).toBe('three four.')
    // never past the next line
    const two = rechunkCaptions(q0, captionTrack(q0)!.id, 2)
    const [a, b] = lines(two)
    const pushed = lines(retimeCaption(two, a.id, { end: 99 }))[0]
    expect(pushed.start + pushed.duration).toBeCloseTo(b.start, 4)
    expect(lines(retimeCaption(two, b.id, { start: 0 }))[1].start).toBeCloseTo(a.start + a.duration, 4)
  })

  it('moves a whole line, words and all', () => {
    const p = captioned()
    const [line] = lines(p)
    const q = moveCaption(p, line.id, 3)
    expect(lines(q)[0].start).toBe(3)
    expect(lines(q)[0].words).toEqual(line.words)
  })

  it('splits a timed line where the word is spoken and merges it back', () => {
    const p = captioned()
    const [line] = lines(p)
    const { project: q, rightId } = splitCaption(p, line.id, 2)
    const [l, r] = lines(q)
    expect([l.text, r.text]).toEqual(['one two', 'three four.'])
    expect(r.id).toBe(rightId)
    expect(r.start).toBeCloseTo(1.5, 4)
    expect(r.words![0].start).toBeCloseTo(0, 4)
    expect(l.start + l.duration).toBeCloseTo(r.start, 4)
    const back = lines(mergeCaptions(q, l.id))
    expect(back).toHaveLength(1)
    expect(back[0].text).toBe('one two three four.')
    expect(back[0].words!.map((w) => +(back[0].start + w.start).toFixed(3))).toEqual([0.5, 1, 1.5, 2])
    // there is nothing to split at the first word
    expect(splitCaption(p, line.id, 0).project).toBe(p)
  })

  it('splits an untimed line by its text', () => {
    const p = importCaptions(createProject(), '1\n00:00:00,000 --> 00:00:04,000\naa bb\n').project
    const [line] = lines(p)
    const q = splitCaption(p, line.id, 1).project
    expect(lines(q).map((c) => c.text)).toEqual(['aa', 'bb'])
    // two letters and a space of five on the left
    expect(lines(q)[1].start).toBeCloseTo((4 * 2) / 5, 3)
  })

  it('edits karaoke words: a typo keeps the timings, a word moves between its neighbours', () => {
    const p = captioned()
    const [line] = lines(p)
    const fixed = lines(setCaptionText(p, line.id, 'one too three four.'))[0]
    expect(fixed.words!.map((w) => w.w)).toEqual(['one', 'too', 'three', 'four.'])
    // a different number of words drops the timings
    expect(lines(setCaptionText(p, line.id, 'one two'))[0].words).toBeUndefined()
    const q = setCaptionWord(p, line.id, 1, { start: 0.1, end: 9 })
    const w = lines(q)[0].words!
    expect(w[1].start).toBeCloseTo(w[0].end, 4)
    expect(w[1].end).toBeCloseTo(w[2].start, 4)
    expect(lines(setCaptionWord(p, line.id, 1, { w: 'TWO' }))[0].text).toBe('one TWO three four.')
  })

  it('gives an imported line word timings to edit', () => {
    const p = importCaptions(createProject(), '1\n00:00:00,000 --> 00:00:02,000\nhi there\n').project
    const q = spreadCaptionWords(p, lines(p)[0].id)
    const w = lines(q)[0].words!
    expect(w.map((x) => x.w)).toEqual(['hi', 'there'])
    expect(w[1].end).toBeCloseTo(2, 3)
  })
})

describe('subtitle files', () => {
  const SRT = '1\n00:00:01,000 --> 00:00:02,500\nHello <i>there</i>\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond\nline\n'

  it('knows a file by its name or what it holds, and its language from the name', () => {
    expect(captionFormatOf('WEBVTT\n\n00:01.000 --> 00:02.000\nx')).toBe('vtt')
    expect(captionFormatOf('[Script Info]\nTitle: x')).toBe('ass')
    expect(captionFormatOf('[00:01.00]hello')).toBe('lrc')
    expect(captionFormatOf(SRT)).toBe('srt')
    expect(captionFormatOf('', 'song.SSA')).toBe('ass')
    expect(captionLanguageOf('', 'talk.es.srt')).toBe('es')
    expect(captionLanguageOf('', 'talk.pt-BR.vtt')).toBe('pt-BR')
    expect(captionLanguageOf('WEBVTT\nLanguage: fr\n\n')).toBe('fr')
  })

  it('reads SRT, dropping markup', () => {
    expect(parseCaptions(SRT)).toEqual([
      { start: 1, end: 2.5, text: 'Hello there' },
      { start: 3, end: 4, text: 'Second line' },
    ])
  })

  it('reads WebVTT with cue settings, voices and karaoke timestamps', () => {
    const vtt = 'WEBVTT\n\nNOTE a comment\n\nintro\n00:01.000 --> 00:02.000 align:start\n<v Sam>Hi &amp; bye</v>\n\n00:00:03.000 --> 00:00:04.000\nOne <00:00:03.500>two\n'
    const cues = parseCaptions(vtt)
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([
      [1, 2, 'Hi & bye'],
      [3, 4, 'One two'],
    ])
    expect(cues[1].words).toEqual([{ w: 'One', start: 3, end: 3.5 }, { w: 'two', start: 3.5, end: 4 }])
  })

  it('reads ASS dialogue with commas, override tags and \\k karaoke syllables', () => {
    const ass = [
      '[Script Info]',
      'Title: x',
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      'Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,{\\an8}Hello, world\\Nagain',
      'Dialogue: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,{\\k50}Hel{\\k20}lo {\\k30}you',
    ].join('\n')
    const cues = parseCaptions(ass)
    expect(cues.map((c) => c.text)).toEqual(['Hello, world again', 'Hello you'])
    expect(cues[1].words).toEqual([{ w: 'Hello', start: 3, end: 3.7 }, { w: 'you', start: 3.7, end: 4 }])
  })

  it('reads LRC: a line lasts until the next, a blank stamp ends it, enhanced word stamps, offset', () => {
    const lrc = '[ti:Song]\n[offset:+500]\n[00:01.50]First line\n[00:03.00]<00:03.00>Two <00:03.40>words\n[00:05.00]\n[00:06.00]Last\n'
    const cues = parseCaptions(lrc)
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([
      [1, 2.5, 'First line'],
      [2.5, 4.5, 'Two words'],
      [5.5, 8.5, 'Last'],
    ])
    expect(cues[1].words!.map((w) => [w.w, w.start])).toEqual([
      ['Two', 2.5],
      ['words', 2.9],
    ])
  })

  it('writes every format, word timings when asked, and round-trips them', () => {
    const p = captioned()
    const srt = exportSrt(p)
    expect(srt).toContain('00:00:00,500 --> ')
    for (const fmt of ['srt', 'vtt', 'ass', 'lrc'] as const) {
      const text = captionsToText(p, fmt, { karaoke: true })
      const back = parseCaptions(text, fmt)
      expect(back.map((c) => c.text)).toEqual(lines(p).map((c) => c.text))
      expect(back[0].start).toBeCloseTo(lines(p)[0].start, 1)
      if (fmt !== 'srt') expect(back[0].words!.map((w) => w.w)).toEqual(['one', 'two', 'three', 'four.'])
    }
    const vtt = captionsToText(p, 'vtt', { karaoke: true })
    expect(vtt.startsWith('WEBVTT\nLanguage: en\n')).toBe(true)
    expect(vtt).toContain('<00:00:01.000>two')
    const ass = captionsToText(p, 'ass')
    expect(ass).toContain('PlayResX: 1920')
    expect(ass).toMatch(/Style: Default,Inter,\d+,&H00FFFFFF/)
    expect(ass).not.toContain('\\k')
  })

  it('writes just a range, timed from its start (a range export sidecar)', () => {
    const p = captioned()
    const srt = captionsToText(p, 'srt', { range: { start: 1, end: 2 } })
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:01,000\none two three four.\n')
    expect(captionsToText(p, 'srt', { range: { start: 8, end: 9 } })).toBe('')
  })
})

describe('caption tracks and languages', () => {
  it('imports a second language as its own track, shown instead of the first, and regenerating leaves it alone', () => {
    const p = captioned()
    const en = captionTrack(p)!
    expect(en.language).toBe('en')
    const { project: q, trackId, count } = importCaptions(p, '1\n00:00:00,500 --> 00:00:02,400\nuno dos tres cuatro\n', { fileName: 'talk.es.srt' })
    expect(count).toBe(1)
    expect(captionTracks(q)).toHaveLength(2)
    const es = captionTracks(q).find((t) => t.id === trackId)!
    expect(es.language).toBe('es')
    expect(captionTrack(q)!.id).toBe(trackId)
    // only the shown track is drawn (and burned in)
    expect(evaluate(q, 1).layers.filter((l) => l.type === 'caption').map((l) => l.trackId)).toEqual([trackId])
    expect(speechTrack(q, 'en')!.id).toBe(en.id)
    const again = generateCaptions(q)
    expect(captionTracks(again).map((t) => t.id)).toEqual([en.id, trackId])
    expect(lines(again, trackId)[0].text).toBe('uno dos tres cuatro')
    // a file for each language
    expect(captionsToText(q, 'srt', { trackId: en.id })).toContain('one two')
    expect(captionsToText(q, 'srt')).toContain('uno dos')
  })

  it('shows one track or none, and names a language', () => {
    const p = captioned()
    const { project: q, trackId } = addCaptionTrack(p, { language: 'fr' })
    const en = captionTracks(q)[0].id
    expect(captionTracks(showOnlyCaptionTrack(q, en)).map((t) => !!t.hidden)).toEqual([false, true])
    expect(captionTracks(showOnlyCaptionTrack(q, null)).every((t) => t.hidden)).toBe(true)
    expect(showOnlyCaptionTrack(q, trackId)).toBe(q)
    expect(captionTracks(setCaptionLanguage(q, en, 'en-GB'))[0].language).toBe('en-GB')
    expect(captionTracks(setCaptionLanguage(q, en, ''))[0].language).toBeUndefined()
  })

  it('replaces a track from a file, keeping its style and language', () => {
    const p = captioned()
    const en = captionTrack(p)!
    const { project: q } = importCaptions(p, 'WEBVTT\n\n00:00.000 --> 00:01.000\nfixed\n', { trackId: en.id })
    expect(captionTracks(q)).toHaveLength(1)
    expect(captionTrack(q)!.captionStyle).toEqual(en.captionStyle)
    expect(captionTrack(q)!.language).toBe('en')
    expect(lines(q).map((c) => c.text)).toEqual(['fixed'])
  })
})
