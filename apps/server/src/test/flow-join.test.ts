// Flowing scenes cut straight from one clip to the next, on the frame the next one starts from (a crossfade laid two
// near-identical moving pictures over each other: the blur the owner saw in the paper boat film, 26 Nov 2026); and the
// captions say the script's words at the times whisper heard them ("a wide, calm pond" was captioned "a wide compound").
import { beforeAll, describe, expect, it } from 'vitest'
import { createProject, type Asset, type ScriptScene, type Transcript, type VideoItem } from '@producer/core'
import { buildProducerTimeline, handOffAt, sceneLength, scriptWords, syntheticTranscript } from '../ai/produce'
import { setup } from './helpers'

beforeAll(async () => {
  await setup()
})

const voice = (id: string, seconds: number) => ({ asset: { id: `as_vo_${id}`, kind: 'audio' as const, name: id, src: '', duration: seconds, transcript: syntheticTranscript('Words here.', seconds) }, duration: seconds })
const clipAsset = (id: string, duration: number): Asset => ({ id, kind: 'video', name: id, src: '', duration, width: 1280, height: 720, fps: 24, hasAudio: false })
const scene = (id: string): ScriptScene => ({ id, title: id, headline: id, narration: 'Words here.', footage: [], visual: { kind: 'aiVideo', prompt: `shot ${id}`, assetId: `as_${id}` } })

describe('flowing scenes on the timeline', () => {
  // s01 6.0 s, s02 5.9 s, s03 (last) 6.3 s: the paper boat film's lengths
  const scenes = [scene('s01'), scene('s02'), scene('s03')]
  const voices = new Map([
    ['s01', voice('s01', 4.1)],
    ['s02', voice('s02', 4.0)],
    ['s03', voice('s03', 4.0)],
  ])
  const build = (clips: [number, number, number], flows?: Map<string, number>) =>
    buildProducerTimeline({
      project: createProject({ id: 'p_flow', name: 'Flow' }),
      brief: { title: 'Flow', audience: '', goal: '', tone: 'calm', template: 'studio-dark', voice: 'af_heart', aspect: '16:9', source: 'idea', cards: false, onScreenText: false, captions: false },
      scenes,
      footage: new Map(),
      voices,
      generated: new Map(scenes.map((s, i) => [s.id, clipAsset(`as_${s.id}`, clips[i])])),
      ...(flows ? { flows } : {}),
    })
  const pieces = (p: ReturnType<typeof build>) => p.tracks.find((t) => t.main)!.items.filter((i): i is VideoItem => i.type === 'video')
  const shownTo = (it: VideoItem) => it.in + it.duration * it.speed

  it('the scene lengths are what the clips were made for', () => {
    expect(scenes.map((s, i) => sceneLength(s, voices, i === 2))).toEqual([6, 5.9, 6.3])
    expect(handOffAt({ duration: 6.037 }, 6)).toBe(6)
    expect(handOffAt({ duration: 5.2 }, 6)).toBe(5.2)
  })

  it('without flowing scenes the scenes crossfade, as before', () => {
    const v = pieces(build([6.037, 6.037, 8]))
    expect(v.map((i) => i.transitionOut?.type)).toEqual(['crossfade', 'crossfade', undefined])
  })

  it('a scene the next one continues cuts straight to it, ending on the frame the next clip starts from', () => {
    // clips made now: each next clip starts on the frame at the scene before's cut
    const flows = new Map([
      ['s02', handOffAt({ duration: 6.037 }, 6)],
      ['s03', handOffAt({ duration: 6.037 }, 5.9)],
    ])
    const v = pieces(build([6.037, 6.037, 8], flows))
    expect(v.map((i) => i.transitionOut)).toEqual([undefined, undefined, undefined])
    expect(v.map((i) => [i.in, i.speed])).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
    ])
    expect(shownTo(v[0])).toBeCloseTo(6, 3)
    expect(shownTo(v[1])).toBeCloseTo(5.9, 3)
    // edge to edge: nothing held over the cut
    expect(v[1].start).toBeCloseTo(v[0].start + v[0].duration, 3)
  })

  it('clips made before the cut was handed on (from their last frame) end on it: started later, or a little faster', () => {
    // the paper boat film as it was made: s02 and s03 each start on the clip before's last frame (6.037 s)
    const v = pieces(build([6.037, 6.037, 8], new Map([['s02', 6.037], ['s03', 6.037]])))
    expect(v.map((i) => i.transitionOut)).toEqual([undefined, undefined, undefined])
    // s01 continues nothing: it starts 0.037 s in and plays to its last frame
    expect(v[0].in).toBeCloseTo(0.037, 3)
    expect(v[0].speed).toBe(1)
    expect(shownTo(v[0])).toBeCloseTo(6.037, 3)
    // s02 continues s01, so it keeps its first frame and plays 2% faster to reach its last
    expect(v[1].in).toBe(0)
    expect(v[1].speed).toBeCloseTo(6.037 / 5.9, 3)
    expect(shownTo(v[1])).toBeCloseTo(6.037, 2)
    // the scene lengths don't move
    expect(v[1].start).toBeCloseTo(6, 3)
    expect(v[2].start).toBeCloseTo(11.9, 3)
  })

  it('much longer than its scene, a clip that continues the one before starts later rather than racing', () => {
    const v = pieces(build([6.037, 8, 8], new Map([['s02', 6], ['s03', 8]])))
    expect(v[1].speed).toBe(1)
    expect(v[1].in).toBeCloseTo(2.1, 3)
    expect(shownTo(v[1])).toBeCloseTo(8, 3)
  })

  it('a clip shorter than its scene is slowed or held, still ending on the frame handed on', () => {
    const v = pieces(build([5, 6.037, 8], new Map([['s02', 5]])))
    expect(v[0].transitionOut).toBeUndefined()
    expect(v[0].speed).toBeCloseTo(5 / 6, 3)
    expect(shownTo(v[0])).toBeCloseTo(5, 2)
    // the scene after it, which nothing continues, crossfades as before
    expect(v[1].transitionOut?.type).toBe('crossfade')
  })
})

describe('captions say the script’s words', () => {
  const heardAs = (words: Array<[string, number, number]>): Transcript => ({ language: 'en', engine: 'whisper', segments: [{ start: 0, end: words[words.length - 1][2] + 0.2, text: words.map((w) => w[0]).join(' '), words: words.map(([w, start, end]) => ({ w, start, end })) }] })

  it('a misheard word takes the script’s words, on the time it was heard at', () => {
    const heard = heardAs([
      ['into', 1.0, 1.2],
      ['a', 1.2, 1.3],
      ['wide', 1.3, 1.6],
      ['compound.', 1.7, 2.4],
      ['The', 2.6, 2.7],
      ['sun', 2.7, 3.0],
    ])
    const out = scriptWords('into a wide, calm pond. The sun', heard)
    const words = out.segments.flatMap((s) => s.words)
    expect(words.map((w) => w.w)).toEqual(['into', 'a', 'wide,', 'calm', 'pond.', 'The', 'sun'])
    // heard as said: the same times
    expect(words[0]).toEqual({ w: 'into', start: 1.0, end: 1.2 })
    expect(words[5]).toEqual({ w: 'The', start: 2.6, end: 2.7 })
    // "calm pond" heard as one word: they share its time, up to the next word
    expect(words[3].start).toBe(1.7)
    expect(words[4].start).toBeGreaterThan(words[3].start)
    expect(words[4].end).toBeLessThanOrEqual(2.6)
    for (let i = 1; i < words.length; i++) expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].start)
    expect(out.engine).toBe('whisper')
    expect(out.segments[0].text).toBe('into a wide, calm pond. The sun')
  })

  it('heard right, nothing changes; a word whisper dropped at the start gets the time before the next', () => {
    const heard = heardAs([
      ['Ship', 0.1, 0.4],
      ['faster.', 0.5, 0.9],
    ])
    expect(scriptWords('Ship faster.', heard).segments[0].words).toEqual(heard.segments[0].words)
    const dropped = scriptWords('Now ship faster.', heardAs([
      ['ship', 0.6, 0.9],
      ['faster.', 1.0, 1.4],
    ]))
    const w = dropped.segments[0].words
    expect(w.map((x) => x.w)).toEqual(['Now', 'ship', 'faster.'])
    expect(w[0].start).toBe(0)
    expect(w[0].end).toBeLessThanOrEqual(0.6)
    expect(w[1].start).toBe(0.6)
  })
})
