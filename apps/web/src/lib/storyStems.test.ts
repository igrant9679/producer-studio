import { describe, expect, it } from 'vitest'
import { NARRATOR, buildStems, castOf, encodeWav, layoutStory, parseStory, trimSamples } from './storyStems'

describe('parseStory', () => {
  it('reads headings, [Name] and NAME: lines, and narration', () => {
    const l = parseStory('# Chapter 1\nThe rain had not stopped.\n[Maya] Are you coming?\nTOM: In a minute.\nNote: this is narration. Really.\n\n')
    expect(l.map((x) => [x.kind, x.character, x.text])).toEqual([
      ['heading', '', 'Chapter 1'],
      ['line', '', 'The rain had not stopped.'],
      ['line', 'Maya', 'Are you coming?'],
      ['line', 'Tom', 'In a minute.'],
      ['line', 'Note', 'this is narration. Really.'],
    ])
    expect(castOf(l)).toEqual([NARRATOR, 'Maya', 'Tom', 'Note'])
  })

  it('treats a "name" containing sentence punctuation as narration', () => {
    expect(parseStory('Wait. Listen: the door.')[0].character).toBe('')
  })
})

describe('stems', () => {
  const rate = 10
  const tone = (len: number, v: number) => new Float32Array(len).fill(v)

  it('lays lines out sequentially with gaps and builds aligned, full-length stems', () => {
    const lines = parseStory('# One\nNarration here.\n[Maya] Hi.\n# Two\n[Tom] Hey.')
    const ids = lines.filter((l) => l.kind === 'line').map((l) => l.id)
    const r = new Map([
      [ids[0], tone(5, 0.1)],
      [ids[1], tone(3, 0.2)],
      [ids[2], tone(4, 0.3)],
    ])
    // gap 100 ms = 1 sample, chapter gap 500 ms = 5 samples
    const lay = layoutStory(lines, r, rate, 100, 500)
    expect(lay.placed.map((p) => [p.character, p.start])).toEqual([
      [NARRATOR, 0],
      ['Maya', 6],
      ['Tom', 9 + 5 + 1],
    ])
    expect(lay.length).toBe(15 + 4)
    const { mix, stems } = buildStems(lay)
    expect(mix.length).toBe(19)
    expect([...stems.keys()]).toEqual([NARRATOR, 'Maya', 'Tom'])
    for (const s of stems.values()) expect(s.length).toBe(19)
    const maya = stems.get('Maya')!
    expect([...maya.slice(5, 10)].map((x) => +x.toFixed(2))).toEqual([0, 0.2, 0.2, 0.2, 0])
    // the mix is the sum of the stems
    for (let i = 0; i < mix.length; i++) expect(mix[i]).toBeCloseTo([...stems.values()].reduce((a, s) => a + s[i], 0))
  })

  it('skips lines that failed to render', () => {
    const lines = parseStory('A.\nB.')
    const lay = layoutStory(lines, new Map([[lines[1].id, tone(2, 0.5)]]), rate)
    expect(lay.placed).toHaveLength(1)
    expect(lay.placed[0].start).toBe(0)
  })
})

describe('encodeWav / trimSamples', () => {
  it('writes a valid 16-bit mono header', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1]), 24000)
    const v = new DataView(wav.buffer)
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF')
    expect(v.getUint32(24, true)).toBe(24000)
    expect(v.getUint32(40, true)).toBe(6)
    expect(v.getInt16(46, true)).toBe(0x7fff)
    expect(v.getInt16(48, true)).toBe(-0x8000)
  })
  it('trims by seconds', () => {
    expect(trimSamples(new Float32Array(100), 10, 2, 5).length).toBe(30)
  })
})
