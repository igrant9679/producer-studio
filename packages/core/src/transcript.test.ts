// Transcript editing (E-11): cut words stay struck through and come back, captions follow, filler list, speakers.
import { describe, expect, it } from 'vitest'
import {
  addAsset,
  addItem,
  assignSpeaker,
  createProject,
  createVideoItem,
  cutNeighbour,
  cutSourceRanges,
  fillerList,
  fillerWordRanges,
  generateCaptions,
  itemEnd,
  itemWords,
  mainTrack,
  matchFillers,
  renameSpeaker,
  restoreCut,
  separateAudio,
  setFillerWords,
  speakerAt,
  speakersOf,
  struckWords,
  type Asset,
  type CaptionItem,
  type Project,
  type Transcript,
  type VideoItem,
} from './index'

const transcript: Transcript = {
  language: 'en',
  engine: 'test',
  segments: [
    {
      start: 0,
      end: 6,
      text: 'hello um world this is a test',
      words: [
        { w: 'hello', start: 0.2, end: 0.6 },
        { w: 'um', start: 0.8, end: 1.0 },
        { w: 'world', start: 1.1, end: 1.5 },
        { w: 'this', start: 3.0, end: 3.3 },
        { w: 'is', start: 3.4, end: 3.5 },
        { w: 'a', start: 3.6, end: 3.7 },
        { w: 'test.', start: 3.8, end: 4.2 },
      ],
    },
  ],
}

const talk: Asset = { id: 'a', kind: 'video', name: 'a.mp4', src: 'a.mp4', duration: 10, width: 1920, height: 1080, hasAudio: true, transcript }

function oneClip(): { p: Project; id: string } {
  let p = addAsset(createProject(), talk)
  const v = createVideoItem(p.assets.a, 0)
  p = addItem(p, v)
  return { p, id: v.id }
}

const main = (p: Project) => mainTrack(p)!.items as VideoItem[]
const caps = (p: Project) => p.tracks.find((t) => t.kind === 'caption')!.items as CaptionItem[]
const capText = (p: Project) => caps(p).map((c) => c.text).join(' ')
const heard = (p: Project) => main(p).flatMap((v) => itemWords(p, v.id).map((w) => w.w))

describe('struck words', () => {
  it('a cut leaves its words between the two pieces, struck, and restoring brings the clip back whole', () => {
    const { p: p0, id } = oneClip()
    const p = cutSourceRanges(p0, id, [{ start: 0.8, end: 1.0 }])
    expect(heard(p)).not.toContain('um')
    expect(cutNeighbour(p, id)?.id).toBe(main(p)[1].id)
    const struck = struckWords(p, id)
    expect(struck.map((w) => w.w)).toEqual(['um'])
    expect(struck[0].start).toBeCloseTo(0.8, 3)

    const back = restoreCut(p, id)
    // nothing tells the pieces apart any more: one clip again, as long as before
    expect(main(back)).toHaveLength(1)
    expect(main(back)[0].id).toBe(id)
    expect(main(back)[0].duration).toBeCloseTo(10, 3)
    expect(heard(back)).toEqual(heard(p0))
  })

  it('restores part of a cut: from its start, its end or its middle', () => {
    const { p: p0, id } = oneClip()
    // "um world" cut together
    const p = cutSourceRanges(p0, id, [{ start: 0.8, end: 1.5 }])
    expect(struckWords(p, id).map((w) => w.w)).toEqual(['um', 'world'])
    const total = (q: Project) => main(q).reduce((n, v) => n + v.duration, 0)

    const first = restoreCut(p, id, { start: 0.8, end: 1.0 })
    expect(heard(first)).toEqual(['hello', 'um', 'this', 'is', 'a', 'test.'])
    expect(total(first)).toBeCloseTo(total(p) + 0.2, 3)
    expect(struckWords(first, id).map((w) => w.w)).toEqual(['world'])

    const last = restoreCut(p, id, { start: 1.1, end: 1.5 })
    expect(heard(last)).toEqual(['hello', 'world', 'this', 'is', 'a', 'test.'])
    expect(struckWords(last, id).map((w) => w.w)).toEqual(['um'])

    // in the middle: a piece of its own, the rest of the cut still struck on both sides
    const mid = restoreCut(p, id, { start: 1.02, end: 1.08 })
    expect(main(mid)).toHaveLength(3)
    expect(main(mid)[1].in).toBeCloseTo(1.02, 3)
    expect(total(mid)).toBeCloseTo(total(p) + 0.06, 3)
  })

  it('a clip changed after the cut (an effect on one piece) restores without joining', () => {
    const { p: p0, id } = oneClip()
    const p = cutSourceRanges(p0, id, [{ start: 0.8, end: 1.0 }])
    const right = main(p)[1]
    const changed = structuredClone(p)
    ;(mainTrack(changed)!.items[1] as VideoItem).opacity = 0.5
    const back = restoreCut(changed, id)
    expect(main(back)).toHaveLength(2)
    expect(main(back)[1].id).toBe(right.id)
    expect(heard(back)).toEqual(heard(p0))
  })

  it('separated audio comes back with its video and stays in sync', () => {
    const { p: p0, id } = oneClip()
    const p1 = separateAudio(p0, id)
    const p = cutSourceRanges(p1, id, [{ start: 0.8, end: 1.0 }])
    const back = restoreCut(p, id)
    const audio = back.tracks.filter((t) => t.kind === 'audio').flatMap((t) => t.items)
    expect(audio).toHaveLength(1)
    expect(audio[0].duration).toBeCloseTo(main(back)[0].duration, 3)
    expect(audio[0].start).toBeCloseTo(main(back)[0].start, 3)
  })

  it('a locked piece is not restored into', () => {
    const { p: p0, id } = oneClip()
    const p = structuredClone(cutSourceRanges(p0, id, [{ start: 0.8, end: 1.0 }]))
    mainTrack(p)!.items[1].locked = true
    expect(restoreCut(p, id)).toBe(p)
  })
})

describe('captions follow transcript edits', () => {
  it('cutting words takes them out of the caption lines and closes up the lines after', () => {
    const { p: p0, id } = oneClip()
    const p = generateCaptions(p0)
    const before = caps(p)
    const later = before.find((c) => c.text.startsWith('this'))!
    const q = cutSourceRanges(p, id, [{ start: 0.8, end: 1.0 }])
    expect(capText(q)).toBe('hello world this is a test.')
    const moved = caps(q).find((c) => c.text.startsWith('this'))!
    expect(moved.start).toBeCloseTo(later.start - 0.2, 3)
    // the words stay on what is said: "world" is now spoken 0.2 s earlier
    const line = caps(q).find((c) => c.text.includes('world'))!
    const world = line.words!.find((w) => w.w === 'world')!
    expect(line.start + world.start).toBeCloseTo(0.9, 3)
  })

  it('a line wholly inside the cut goes', () => {
    const { p: p0, id } = oneClip()
    const p = generateCaptions(p0)
    const q = cutSourceRanges(p, id, [{ start: 2.9, end: 4.3 }])
    expect(capText(q)).toBe('hello um world')
  })

  it('restoring puts the words back into the line they were cut from', () => {
    const { p: p0, id } = oneClip()
    const p = generateCaptions(p0)
    const cut = cutSourceRanges(p, id, [{ start: 0.8, end: 1.0 }])
    const back = restoreCut(cut, id)
    expect(caps(back).map((c) => [c.text, +c.start.toFixed(2)])).toEqual(caps(p).map((c) => [c.text, +c.start.toFixed(2)]))
  })

  it('an imported caption track only makes room: no English words land in it', () => {
    const { p: p0, id } = oneClip()
    let p = structuredClone(p0)
    const t = { id: 't_es', kind: 'caption' as const, name: 'Captions', language: 'es', captionStyle: generateCaptions(p0).tracks.find((x) => x.kind === 'caption')!.captionStyle, items: [{ id: 'c_es', type: 'caption' as const, start: 3, duration: 1.5, text: 'esto es una prueba' }] }
    p.tracks.push(t)
    p = cutSourceRanges(p, id, [{ start: 0.8, end: 1.0 }])
    expect(caps(p)[0].start).toBeCloseTo(2.8, 3)
    const back = restoreCut(p, id)
    expect(caps(back).map((c) => c.text)).toEqual(['esto es una prueba'])
    expect(caps(back)[0].start).toBeCloseTo(3, 3)
  })
})

describe('filler words', () => {
  const words = ['So', 'um,', 'you', 'know,', 'I', 'like', 'it.', 'You', 'know?'].map((w) => ({ w }))

  it('matches words and phrases, ignoring case and punctuation', () => {
    expect(matchFillers(words, ['um', 'you know'])).toEqual([[1, 1], [2, 3], [7, 8]])
    expect(matchFillers(words, ['like'])).toEqual([[5, 5]])
    expect(matchFillers(words, [])).toEqual([])
  })

  it('a project starts with the sounds on and the ambiguous words off; the list can be edited', () => {
    const p = createProject()
    const list = fillerList(p)
    expect(list.find((f) => f.w === 'um')?.on).toBe(true)
    expect(list.find((f) => f.w === 'like')?.on).toBe(false)
    const q = setFillerWords(p, [...list, { w: '  so  ', on: true }, { w: 'UM', on: false }, { w: '', on: true }])
    expect(fillerList(q).filter((f) => f.w === 'so')).toHaveLength(1)
    // a repeat (any case) and an empty entry are dropped
    expect(fillerList(q)).toHaveLength(list.length + 1)
  })

  it('removes only the phrases switched on', () => {
    expect(fillerWordRanges(transcript, ['um'])).toEqual([{ start: 0.8, end: 1.0 }])
    expect(fillerWordRanges(transcript, ['world', 'this is'])).toEqual([{ start: 1.1, end: 1.5 }, { start: 3.0, end: 3.5 }])
    // without a list: the built-in sounds, as before
    expect(fillerWordRanges(transcript)).toEqual([{ start: 0.8, end: 1.0 }])
  })
})

describe('speakers', () => {
  it('assigns a range of words to a speaker, splitting segments at its edges, and renames', () => {
    const tr = assignSpeaker(transcript, 3.0, 4.2, 'Sam')
    expect(tr.segments.map((s) => [s.text, s.speaker])).toEqual([
      ['hello um world', undefined],
      ['this is a test.', 'Sam'],
    ])
    // the pieces still cover the segment they came from
    expect(tr.segments[0].start).toBe(0)
    expect(tr.segments[1].end).toBe(6)
    expect(speakerAt(tr, 3.4)).toBe('Sam')
    const both = assignSpeaker(tr, 0, 1.5, 'Alex')
    expect(speakersOf(both)).toEqual(['Alex', 'Sam'])
    const renamed = renameSpeaker(both, 'Sam', 'Samira')
    expect(speakersOf(renamed)).toEqual(['Alex', 'Samira'])
    // a blank name changes nothing
    expect(renameSpeaker(both, 'Sam', '  ')).toBe(both)
    // the transcript given is never changed
    expect(transcript.segments).toHaveLength(1)
  })

  it('cut neighbours need the same recording, played on from later', () => {
    let p = addAsset(createProject(), talk)
    const v1 = createVideoItem(p.assets.a, 0)
    const v2 = { ...createVideoItem(p.assets.a, 0), in: 0 }
    p = addItem(p, v1)
    p = addItem(p, v2, mainTrack(p)!.id)
    // the same recording from the top again is a repeat, not a cut
    expect(cutNeighbour(p, v1.id)).toBeNull()
    expect(itemEnd(main(p)[0])).toBeCloseTo(10, 3)
  })
})
