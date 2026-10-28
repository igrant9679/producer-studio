// Sound in the preview and the export (E-13 crossfades and J/L cuts, E-14 ducking, solo and track volume, E-15 volume
// keyframes): the levels evaluate() gives the preview are the levels the export's volume lanes play.
import { describe, expect, it } from 'vitest'
import {
  DUCK_ATTACK,
  DUCK_HOLD,
  DUCK_RELEASE,
  addAsset,
  addItem,
  compileToHyperFrames,
  createAudioItem,
  createProject,
  createVideoItem,
  evaluate,
  findItem,
  laneParts,
  itemEnd,
  laneAt,
  mainTrack,
  rollAudioEdge,
  separateAudio,
  setTrackSound,
  setVolumeKeyframes,
  soundSpans,
  updateItem,
  type Asset,
  type AudioItem,
  type Project,
  type VideoItem,
} from './index'

const video = (id: string, duration = 10, extra: Partial<Asset> = {}): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `${id}.mp4`, duration, width: 1920, height: 1080, hasAudio: true, ...extra })
const music = (id = 'm', duration = 120): Asset => ({ id, kind: 'audio', name: `${id}.mp3`, src: `${id}.mp3`, duration })

const opts = { assetPath: (id: string) => `assets/${id}`, runtimePath: 'runtime.js', gsapPath: 'gsap.min.js', fontFaceCss: '' }

interface Tag {
  /** The clip's id (a long lane's later parts carry -p2, -p3… on their element id). */
  id: string
  part: number
  start: number
  duration: number
  mediaStart: number
  volume: number
  track: number
  lane?: Array<{ t: number; v: number }>
}

function audioTags(p: Project): Tag[] {
  const html = compileToHyperFrames(p, opts)
  return [...html.matchAll(/<audio id="a-([^"]+)"[^>]*>/g)].map((m) => {
    const el = m[0]
    const num = (name: string) => Number(el.match(new RegExp(` ${name}="([-\\d.]+)"`))![1])
    const lane = el.match(/data-automation='([^']+)'/)
    const part = m[1].match(/-p(\d+)$/)
    return {
      id: part ? m[1].slice(0, -part[0].length) : m[1],
      part: part ? +part[1] : 1,
      start: num('data-start'),
      duration: num('data-duration'),
      mediaStart: num('data-media-start'),
      volume: num('data-volume'),
      track: num('data-track-index'),
      lane: lane ? JSON.parse(lane[1]).lanes[0].points : undefined,
    }
  })
}

/**
 * At every moment, each sound the export plays is at the source time and level the preview plays it at (the parts
 * of a long lane play the same sound, so their levels add up where they overlap).
 */
function expectExportMatchesPreview(p: Project, tolerance = 0.01, step = 0.037) {
  const tags = audioTags(p)
  const end = Math.max(...tags.map((x) => x.start + x.duration))
  const ids = [...new Set(tags.map((x) => x.id))]
  for (let t = 0; t < end; t += step) {
    const heard = evaluate(p, t).audio
    for (const id of ids) {
      const playing = tags.filter((x) => x.id === id && t >= x.start && t < x.start + x.duration - 1e-6)
      const a = heard.find((x) => x.itemId === id)
      expect(!!a, `${id} at ${t.toFixed(3)}`).toBe(playing.length > 0)
      if (!a) continue
      const level = playing.reduce((n, tag) => n + (tag.lane ? laneAt(tag.lane, t - tag.start) : tag.volume), 0)
      expect(Math.abs(level - a.volume), `${id} level at ${t.toFixed(3)}`).toBeLessThan(tolerance)
      for (const tag of playing) expect(tag.mediaStart + (t - tag.start) * a.speed).toBeCloseTo(a.mediaTime, 3)
    }
  }
  return tags
}

/** Two 10 s clips on the main track with a 1 s crossfade at 10 s; the second starts 3 s into its source. */
function crossfade(over: Partial<VideoItem> = { in: 3 }): { p: Project; a: string; b: string } {
  let p = createProject()
  p = addAsset(p, video('x', 20))
  p = addAsset(p, video('y', 20))
  p = addItem(p, createVideoItem(p.assets.x, 0, { duration: 10, transitionOut: { type: 'crossfade', duration: 1 } }))
  p = addItem(p, createVideoItem(p.assets.y, 99, { duration: 10, ...over }))
  const [a, b] = mainTrack(p)!.items.map((i) => i.id)
  return { p, a, b }
}

describe('audio crossfades during transitions (E-13)', () => {
  it('both clips are heard across the transition, the outgoing falling as the incoming rises', () => {
    const { p, a, b } = crossfade()
    const level = (t: number, id: string) => evaluate(p, t).audio.find((x) => x.itemId === id)?.volume
    // before the transition: only the first clip, at full level
    expect(level(9, a)).toBe(1)
    expect(level(9, b)).toBeUndefined()
    // the incoming clip starts sounding half a transition early, from the source before its in-point
    expect(level(9.6, b)).toBeGreaterThan(0)
    expect(evaluate(p, 9.6).audio.find((x) => x.itemId === b)!.mediaTime).toBeCloseTo(2.6, 4)
    // equal power: at the cut both are at 0.707, their power adds up to one
    expect(level(10, a)).toBeCloseTo(Math.SQRT1_2, 2)
    expect(level(10, b)).toBeCloseTo(Math.SQRT1_2, 2)
    for (const t of [9.6, 9.8, 10.2, 10.4]) expect(level(t, a)! ** 2 + level(t, b)! ** 2).toBeCloseTo(1, 2)
    // the outgoing clip plays its source past its end until the transition is over
    expect(evaluate(p, 10.3).audio.find((x) => x.itemId === a)!.mediaTime).toBeCloseTo(10.3, 4)
    expect(level(10.5, a)).toBeUndefined()
    expect(level(10.5, b)).toBe(1)
  })

  it('a clip with no source before its in-point fades in from its first frame', () => {
    const { p, b } = crossfade({ in: 0 })
    expect(evaluate(p, 9.9).audio.find((x) => x.itemId === b)).toBeUndefined()
    const at = (t: number) => evaluate(p, t).audio.find((x) => x.itemId === b)!.volume
    expect(at(10.01)).toBeLessThan(0.1)
    expect(at(10.25)).toBeCloseTo(Math.sin(Math.PI / 4), 2)
  })

  it('a clip whose source ends with it fades out by the cut', () => {
    let { p, a } = crossfade()
    p = addAsset(p, video('x', 10))
    expect(evaluate(p, 10.1).audio.find((x) => x.itemId === a)).toBeUndefined()
    expect(evaluate(p, 9.99).audio.find((x) => x.itemId === a)!.volume).toBeLessThan(0.05)
  })

  it('the export plays the same crossfade, on two tracks so the overlap is not a lint warning', () => {
    const { p, a, b } = crossfade()
    const tags = expectExportMatchesPreview(p)
    const [ta, tb] = [tags.find((x) => x.id === a)!, tags.find((x) => x.id === b)!]
    expect(ta).toMatchObject({ start: 0, duration: 10.5, mediaStart: 0 })
    expect(tb).toMatchObject({ start: 9.5, mediaStart: 2.5 })
    expect(ta.track).not.toBe(tb.track)
  })

  it('separated sound crossfades like the clips it came from', () => {
    let { p, a, b } = crossfade()
    p = separateAudio(separateAudio(p, a), b)
    const sep = p.tracks.find((t) => t.kind === 'audio')!.items as AudioItem[]
    expect(sep).toHaveLength(2)
    const [sa, sb] = sep.map((x) => x.id)
    const heard = evaluate(p, 10).audio
    expect(heard.map((x) => x.itemId).sort()).toEqual([sa, sb].sort())
    expect(heard.find((x) => x.itemId === sa)!.volume).toBeCloseTo(Math.SQRT1_2, 2)
    expectExportMatchesPreview(p)
  })
})

/** A clip at 0..10 and a clip at 10..20 on the main track, both separated onto one audio track. */
function linkedPair() {
  let p = createProject()
  p = addAsset(p, video('x', 30))
  p = addAsset(p, video('y', 30))
  p = addItem(p, createVideoItem(p.assets.x, 0, { duration: 10, in: 5 }))
  p = addItem(p, createVideoItem(p.assets.y, 99, { duration: 10, in: 5 }))
  const [va, vb] = mainTrack(p)!.items.map((i) => i.id)
  p = separateAudio(separateAudio(p, va), vb)
  const [aa, ab] = p.tracks.find((t) => t.kind === 'audio')!.items.map((i) => i.id)
  return { p, va, vb, aa, ab }
}

describe('J and L cuts (E-13)', () => {
  const item = (p: Project, id: string) => findItem(p, id)!.item as AudioItem

  it('a J cut: the next sound starts early under the picture, the cut between the sounds rolls', () => {
    const { p: p0, va, vb, aa, ab } = linkedPair()
    const p = rollAudioEdge(p0, ab, 'start', 8.5)
    expect(item(p, ab)).toMatchObject({ start: 8.5, duration: 11.5, in: 3.5 })
    expect(item(p, aa)).toMatchObject({ start: 0, duration: 8.5, in: 5 })
    // the pictures don't move
    expect(findItem(p, va)!.item).toMatchObject({ start: 0, duration: 10 })
    expect(findItem(p, vb)!.item).toMatchObject({ start: 10, duration: 10 })
    // the second clip's sound plays from 8.5 s, from the source just before its picture's
    expect(evaluate(p, 9).audio.map((x) => x.itemId)).toEqual([ab])
    expect(evaluate(p, 9).audio[0].mediaTime).toBeCloseTo(4, 4)
  })

  it('an L cut: the sound trails into the next picture', () => {
    const { p: p0, aa, ab } = linkedPair()
    const p = rollAudioEdge(p0, aa, 'end', 12)
    expect(item(p, aa)).toMatchObject({ start: 0, duration: 12 })
    expect(item(p, ab)).toMatchObject({ start: 12, duration: 8, in: 7 })
  })

  it('stays inside both sources, and a clip with no neighbour stops at the next clip', () => {
    const { p: p0, aa, ab } = linkedPair()
    // the second clip's source has 5 s before its in-point
    expect(item(rollAudioEdge(p0, ab, 'start', 1), ab).start).toBe(5)
    let p = rollAudioEdge(p0, aa, 'end', 9)
    p = updateItem<AudioItem>(p, ab, { start: 11 })
    // a gap now: the end only grows up to the next clip
    expect(item(rollAudioEdge(p, aa, 'end', 15), aa).duration).toBe(11)
  })

  it('keeps volume keyframes on the same moment of the sound', () => {
    const { p: p0, ab } = linkedPair()
    let p = setVolumeKeyframes(p0, ab, [{ t: 2, value: 0.5 }])
    p = rollAudioEdge(p, ab, 'start', 9)
    expect(item(p, ab).keyframes.volume).toEqual([{ t: 3, value: 0.5 }])
  })
})

describe('ducking under voice (E-14)', () => {
  /** Music 0..20 on a ducked track; a voiceover 5..8 on another track. */
  function ducked(db = 12) {
    let p = createProject()
    p = addAsset(p, music())
    p = addAsset(p, music('vo', 10))
    p = addItem(p, createAudioItem(p.assets.m, 0, { duration: 20 }))
    const musicTrack = p.tracks.find((t) => t.kind === 'audio')!
    p = setTrackSound(p, musicTrack.id, { duck: db })
    p = addItem(p, createAudioItem(p.assets.vo, 5, { duration: 3, tts: { text: 'Hello there', voice: 'v', speed: 1 } }))
    expect(p.tracks.filter((t) => t.kind === 'audio')).toHaveLength(2)
    const m = musicTrack.items[0].id
    return { p, m, musicTrack: musicTrack.id }
  }
  const at = (p: Project, id: string, t: number) => evaluate(p, t).audio.find((x) => x.itemId === id)!.volume

  it('drops the music by the set amount while the voiceover speaks, and brings it back after', () => {
    const { p, m } = ducked()
    const floor = 10 ** (-12 / 20)
    expect(at(p, m, 2)).toBe(1)
    expect(at(p, m, 5 - DUCK_ATTACK / 2)).toBeCloseTo(1 - (1 - floor) / 2, 3)
    expect(at(p, m, 6.5)).toBeCloseTo(floor, 4)
    // held a moment after the last word, then released
    expect(at(p, m, 8 + DUCK_HOLD / 2)).toBeCloseTo(floor, 4)
    expect(at(p, m, 8 + DUCK_HOLD + DUCK_RELEASE + 0.1)).toBe(1)
    // the voice itself isn't ducked
    expect(evaluate(p, 6).audio.find((x) => x.itemId !== m)!.volume).toBe(1)
  })

  it('follows the transcript of a recording: only its spoken lines duck the music', () => {
    let { p, m } = ducked()
    p = { ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.filter((i) => i.type !== 'audio' || !i.tts) })) }
    const transcript = { language: 'en', engine: 'test', segments: [{ start: 12, end: 14, text: 'hi', words: [] }] }
    p = addAsset(p, video('rec', 30, { transcript }))
    // the recording plays source 10..20 from 0 s: the line at source 12..14 is heard at 2..4 s
    p = addItem(p, createVideoItem(p.assets.rec, 0, { in: 10, duration: 10 }))
    expect(at(p, m, 3)).toBeLessThan(0.3)
    expect(at(p, m, 6)).toBe(1)
    expect(at(p, m, 9)).toBe(1)
  })

  it('a muted or un-soloed voice ducks nothing', () => {
    const { p, m } = ducked()
    const voTrack = p.tracks.find((t) => t.kind === 'audio' && t.items.some((i) => i.type === 'audio' && i.tts))!
    expect(at(setTrackSound({ ...p, tracks: p.tracks.map((t) => (t.id === voTrack.id ? { ...t, muted: true } : t)) }, voTrack.id, {}), m, 6.5)).toBe(1)
  })

  it('the export ducks at the same moments, by the same amount', () => {
    const { p } = ducked(18)
    const tags = expectExportMatchesPreview(p)
    expect(tags.some((x) => x.lane)).toBe(true)
  })

  it('a long ducked track plays in parts that each fit the lane HyperFrames reads, and still matches the preview', () => {
    let p = createProject()
    p = addAsset(p, music('m', 1200))
    p = addItem(p, createAudioItem(p.assets.m, 0, { duration: 600 }))
    const mt = p.tracks.find((t) => t.kind === 'audio')!
    p = setTrackSound(p, mt.id, { duck: 12 })
    // a 10-minute recording with a line every 3 s
    const segments = Array.from({ length: 200 }, (_, i) => ({ start: i * 3, end: i * 3 + 1.4, text: 'line', words: [] }))
    p = addAsset(p, video('rec', 600, { transcript: { language: 'en', engine: 'test', segments } }))
    p = addItem(p, createVideoItem(p.assets.rec, 0, { duration: 600 }))
    const span = soundSpans(p).find((s) => s.track.id === mt.id)!
    const parts = laneParts(p, span)
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) expect(part.points.length).toBeLessThanOrEqual(500)
    // consecutive parts overlap by 20 ms and cover the whole clip
    expect(parts[0].start).toBe(0)
    expect(parts.at(-1)!.end).toBe(600)
    for (let i = 1; i < parts.length; i++) expect(parts[i - 1].end - parts[i].start).toBeCloseTo(0.02, 6)
    const tags = expectExportMatchesPreview(p, 0.01, 0.1731)
    const mine = tags.filter((x) => x.id === span.item.id)
    expect(mine.map((x) => x.part)).toEqual(parts.map((_, i) => i + 1))
    // across each hand-over the two parts add up to the level the preview plays
    for (const part of parts.slice(1))
      for (let t = part.start; t <= part.start + 0.02; t += 0.004) {
        const sum = mine.filter((x) => t >= x.start && t < x.start + x.duration).reduce((n, x) => n + laneAt(x.lane!, t - x.start), 0)
        expect(Math.abs(sum - evaluate(p, t).audio.find((x) => x.itemId === span.item.id)!.volume)).toBeLessThan(0.01)
      }
  }, 30_000)
})

describe('solo and track volume (E-14)', () => {
  function mix() {
    let p = createProject()
    p = addAsset(p, video('x', 10))
    p = addAsset(p, music())
    p = addItem(p, createVideoItem(p.assets.x, 0, { duration: 10 }))
    p = addItem(p, createAudioItem(p.assets.m, 0, { duration: 10, volume: 0.8 }))
    const main = mainTrack(p)!
    const musicTrack = p.tracks.find((t) => t.kind === 'audio')!
    return { p, main, musicTrack, v: main.items[0].id, m: musicTrack.items[0].id }
  }

  it('a soloed track is the only one heard, in the preview and the export', () => {
    const { p: p0, musicTrack, m } = mix()
    const p = setTrackSound(p0, musicTrack.id, { solo: true })
    expect(evaluate(p, 1).audio.map((x) => x.itemId)).toEqual([m])
    expect(audioTags(p).map((x) => x.id)).toEqual([m])
    // muting beats solo
    const q = { ...p, tracks: p.tracks.map((t) => (t.id === musicTrack.id ? { ...t, muted: true } : t)) }
    expect(evaluate(q, 1).audio).toEqual([])
  })

  it("a track's volume scales every clip on it, up to +12 dB", () => {
    const { p: p0, musicTrack, m } = mix()
    const p = setTrackSound(p0, musicTrack.id, { volume: 0.5 })
    expect(evaluate(p, 1).audio.find((x) => x.itemId === m)!.volume).toBeCloseTo(0.4, 4)
    expect(audioTags(p).find((x) => x.id === m)!.volume).toBeCloseTo(0.4, 3)
    expect(setTrackSound(p0, musicTrack.id, { volume: 9 }).tracks.find((t) => t.id === musicTrack.id)!.volume).toBe(3.98)
    expectExportMatchesPreview(p)
  })

  it('only tracks with sound take sound settings', () => {
    let p = createProject()
    p = addItem(p, { id: 'c', type: 'caption', start: 0, duration: 1, text: 'x' })
    const cap = p.tracks.find((t) => t.kind === 'caption')!
    expect(setTrackSound(p, cap.id, { solo: true })).toBe(p)
  })
})

describe('volume keyframes and fades on the clip (E-15)', () => {
  it('a rubber band of keyframes plays the same in the preview and the export', () => {
    let p = createProject()
    p = addAsset(p, music())
    p = addItem(p, createAudioItem(p.assets.m, 1, { duration: 8, fadeIn: 1, fadeOut: 2 }))
    const id = p.tracks.find((t) => t.kind === 'audio')!.items[0].id
    p = setVolumeKeyframes(p, id, [{ t: 6, value: 0.2 }, { t: 2, value: 1.5 }, { t: 4, value: 1.5, ease: 'easeInOut' }])
    const it = findItem(p, id)!.item as AudioItem
    expect(it.keyframes.volume!.map((k) => k.t)).toEqual([2, 4, 6])
    expect(itemEnd(it)).toBe(9)
    expectExportMatchesPreview(p)
    // no keyframes left: the lane goes, the clip plays at its volume
    p = setVolumeKeyframes(p, id, [])
    expect((findItem(p, id)!.item as AudioItem).keyframes.volume).toBeUndefined()
  })

  it('keyframes stay inside the clip and inside the gain range', () => {
    let p = createProject()
    p = addAsset(p, music())
    p = addItem(p, createAudioItem(p.assets.m, 0, { duration: 4 }))
    const id = p.tracks.find((t) => t.kind === 'audio')!.items[0].id
    p = setVolumeKeyframes(p, id, [{ t: -1, value: -2 }, { t: 9, value: 20 }])
    expect((findItem(p, id)!.item as AudioItem).keyframes.volume).toEqual([{ t: 0, value: 0 }, { t: 4, value: 3.98 }])
  })
})
