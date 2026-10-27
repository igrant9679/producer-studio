import { describe, expect, it } from 'vitest'
import {
  addAsset,
  addItem,
  clone,
  compileToHyperFrames,
  createAudioItem,
  createCaptionItem,
  createProject,
  createTextItem,
  createVideoItem,
  cutSourceRanges,
  deleteItems,
  evaluate,
  findItem,
  freezeFrame,
  generateCaptions,
  isSafeColor,
  itemEnd,
  itemWords,
  safeColor,
  textBackgroundCss,
  importSrt,
  exportSrt,
  mainTrack,
  moveItem,
  projectDuration,
  removeSilences,
  round,
  separateAudio,
  presetCanvasSize,
  setAspect,
  setCanvasSize,
  setKeyframe,
  splitAt,
  splitItem,
  trimItem,
  updateItem,
  type AudioItem,
  type Asset,
  type CaptionItem,
  type Project,
  type VideoItem,
} from './index'

const asset = (id: string, duration = 10): Asset => ({
  id,
  kind: 'video',
  name: `${id}.mp4`,
  src: `${id}.mp4`,
  duration,
  width: 1920,
  height: 1080,
  hasAudio: true,
  transcript: {
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
  },
})

function twoClips(): Project {
  let p = createProject()
  p = addAsset(p, asset('a'))
  p = addAsset(p, asset('b', 6))
  p = addItem(p, createVideoItem(p.assets.a, 0))
  p = addItem(p, createVideoItem(p.assets.b, 999))
  return p
}

describe('main track', () => {
  it('packs clips edge to edge', () => {
    const p = twoClips()
    const m = mainTrack(p)!
    expect(m.items.map((i) => [i.start, i.duration])).toEqual([
      [0, 10],
      [10, 6],
    ])
    expect(projectDuration(p)).toBe(16)
  })

  it('ripples when a clip is deleted', () => {
    const p = twoClips()
    const first = mainTrack(p)!.items[0].id
    const q = deleteItems(p, [first])
    expect(mainTrack(q)!.items[0].start).toBe(0)
    expect(projectDuration(q)).toBe(6)
  })

  it('does not mutate the input project', () => {
    const p = twoClips()
    const snapshot = JSON.stringify(p)
    splitItem(p, mainTrack(p)!.items[0].id, 4)
    expect(JSON.stringify(p)).toBe(snapshot)
  })
})

describe('split and trim', () => {
  it('splits a clip and advances the right half source offset', () => {
    const p = twoClips()
    const id = mainTrack(p)!.items[0].id
    const { project, rightId } = splitItem(p, id, 4)
    const left = findItem(project, id)!.item as VideoItem
    const right = findItem(project, rightId!)!.item as VideoItem
    expect(left.duration).toBe(4)
    expect(right.start).toBe(4)
    expect(right.in).toBe(4)
    expect(right.duration).toBe(6)
  })

  it('cannot extend a trim past the source end', () => {
    const p = twoClips()
    const id = mainTrack(p)!.items[1].id
    const q = trimItem(p, id, 'end', 100)
    expect(findItem(q, id)!.item.duration).toBe(6)
  })

  it('trims the start and moves `in` forward', () => {
    const p = twoClips()
    const id = mainTrack(p)!.items[0].id
    const q = trimItem(p, id, 'start', 2)
    const v = findItem(q, id)!.item as VideoItem
    expect(v.in).toBe(2)
    expect(v.start).toBe(0) // main track re-packs
    expect(v.duration).toBe(8)
  })
})

describe('overlays', () => {
  it('puts overlapping text on separate tracks', () => {
    let p = twoClips()
    p = addItem(p, createTextItem(1))
    p = addItem(p, createTextItem(2))
    const textTracks = p.tracks.filter((t) => t.kind === 'text')
    expect(textTracks.length).toBe(2)
  })

  it('moves linked separated audio with its video', () => {
    let p = createProject()
    p = addAsset(p, asset('a'))
    p = addItem(p, createVideoItem(p.assets.a, 2), undefined)
    // put a second video on an overlay track so it can move freely
    const v = createVideoItem(p.assets.a, 3)
    p = addItem(p, v, 'nope')
    p = separateAudio(p, v.id)
    const audio = p.tracks.find((t) => t.kind === 'audio')!.items[0]
    const before = audio.start
    p = moveItem(p, v.id, { start: 5 })
    const after = findItem(p, audio.id)!.item.start
    expect(after - before).toBeCloseTo(2, 3)
  })
})

describe('linked audio on the main track', () => {
  it('follows its clip when the main track repacks', () => {
    let p = twoClips()
    const [first, second] = mainTrack(p)!.items.map((i) => i.id)
    p = separateAudio(p, second)
    const audioId = p.tracks.find((t) => t.kind === 'audio')!.items[0].id
    expect(findItem(p, audioId)!.item.start).toBe(10)
    p = deleteItems(p, [first])
    expect(findItem(p, second)!.item.start).toBe(0)
    expect(findItem(p, audioId)!.item.start).toBe(0)
  })
})

describe('transcript editing', () => {
  it('cuts a source range and ripples the main track', () => {
    const p = twoClips()
    const id = mainTrack(p)!.items[0].id
    const q = cutSourceRanges(p, id, [{ start: 1.6, end: 2.9 }])
    expect(projectDuration(q)).toBeCloseTo(16 - 1.3, 3)
  })

  it('generates captions from transcript words', () => {
    const p = generateCaptions(twoClips())
    const caps = p.tracks.find((t) => t.kind === 'caption')!
    expect(caps.items.length).toBeGreaterThan(0)
    expect((caps.items[0] as { text: string }).text.startsWith('hello')).toBe(true)
  })

  it('round-trips SRT', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond line\n'
    const p = importSrt(createProject(), srt)
    expect(exportSrt(p)).toContain('00:00:01,000 --> 00:00:02,500')
  })
})

describe('evaluate', () => {
  it('returns the active layer with correct media time', () => {
    const p = twoClips()
    const f = evaluate(p, 12)
    expect(f.layers).toHaveLength(1)
    expect(f.layers[0].mediaTime).toBeCloseTo(2, 5)
    expect(f.audio).toHaveLength(1)
  })

  it('renders both clips during a crossfade', () => {
    let p = twoClips()
    const first = mainTrack(p)!.items[0].id
    p = updateItem<VideoItem>(p, first, { transitionOut: { type: 'crossfade', duration: 1 } })
    const f = evaluate(p, 10)
    expect(f.layers).toHaveLength(2)
    const incoming = f.layers.find((l) => l.itemId !== first)!
    expect(incoming.opacity).toBeGreaterThan(0.3)
    expect(incoming.opacity).toBeLessThan(0.7)
  })

  it('interpolates keyframes', () => {
    let p = twoClips()
    const id = mainTrack(p)!.items[0].id
    p = setKeyframe(p, id, 'opacity', 0, 0, 'linear')
    p = setKeyframe(p, id, 'opacity', 2, 1, 'linear')
    expect(evaluate(p, 1).layers[0].opacity).toBeCloseTo(0.5, 3)
  })

  it('freeze frame holds a source time', () => {
    const p0 = twoClips()
    const id = mainTrack(p0)!.items[0].id
    const p = freezeFrame(p0, id, 3, 2)
    expect(projectDuration(p)).toBe(18)
    const a = evaluate(p, 3.5).layers[0].mediaTime
    const b = evaluate(p, 4.5).layers[0].mediaTime
    expect(a).toBeCloseTo(3, 3)
    expect(b).toBeCloseTo(3, 3)
  })
})

describe('canvas size', () => {
  it('scales the layout uniformly from 1080p to 4K', () => {
    let p = twoClips()
    p = addItem(p, createTextItem(0, 'heading', { transform: { x: 100, y: -200, scale: 1, rotation: 0 } }))
    p = importSrt(p, '1\n00:00:01,000 --> 00:00:02,000\nHi\n')
    const text = p.tracks.flatMap((t) => t.items).find((i) => i.type === 'text')!
    const q = setCanvasSize(p, 3840, 2160)
    const t2 = findItem(q, text.id)!.item as typeof text & { style: { fontSize: number; boxWidth: number } }
    expect(q.width).toBe(3840)
    expect(t2.transform.x).toBe(200)
    expect(t2.transform.y).toBe(-400)
    expect(t2.style.fontSize).toBe((text as typeof t2).style.fontSize * 2)
    const cap = q.tracks.find((t) => t.kind === 'caption')!.captionStyle!
    expect(cap.style.fontSize).toBe(p.tracks.find((t) => t.kind === 'caption')!.captionStyle!.style.fontSize * 2)
  })

  it('keeps sizes when switching aspect at the same short side', () => {
    const p = addItem(twoClips(), createTextItem(0, 'heading'))
    const size = presetCanvasSize('9:16', 1080)
    expect(size).toEqual({ width: 1080, height: 1920 })
    const q = setAspect(p, size.width, size.height)
    const before = p.tracks.flatMap((t) => t.items).find((i) => i.type === 'text') as { style: { fontSize: number } }
    const after = q.tracks.flatMap((t) => t.items).find((i) => i.type === 'text') as { style: { fontSize: number } }
    expect(after.style.fontSize).toBe(before.style.fontSize)
    expect(presetCanvasSize('16:9', 2160)).toEqual({ width: 3840, height: 2160 })
  })

  it('compiles a 1080p project to a natively scaled 4K composition', () => {
    const html = compileToHyperFrames(twoClips(), { assetPath: (id) => `assets/${id}.mp4`, runtimePath: 'runtime.js', gsapPath: 'gsap.min.js', fontFaceCss: '', outputWidth: 3840, outputHeight: 2160 })
    expect(html).toContain('data-width="3840" data-height="2160"')
    expect(html).toContain('transform: scale(2.000000, 2.000000)')
    expect(html).toContain("getElementById('stage')")
  })
})

describe('compile', () => {
  it('emits timed media and a registered timeline', () => {
    const p = twoClips()
    const html = compileToHyperFrames(p, { assetPath: (id) => `assets/${id}.mp4`, runtimePath: 'runtime.js', gsapPath: 'gsap.min.js', fontFaceCss: '' })
    expect(html).toContain('data-composition-id="main"')
    expect(html).toContain('data-media-start="0"')
    expect(html).toContain("window.__timelines['main']")
    expect((html.match(/<audio /g) ?? []).length).toBe(2)
  })
})

describe('colours from the document', () => {
  it('accepts plain colours and refuses anything that could close a declaration or tag', () => {
    for (const ok of ['#fff', '#ffe14d', '#0b183080', 'rgba(0,0,0,.75)', 'rgb(1 2 3 / 50%)', 'hsl(200deg 50% 40%)', 'transparent', 'red']) expect(isSafeColor(ok)).toBe(true)
    for (const bad of ['rgb(1,2,3)"><img src=x onerror=alert(1)>', 'rgb(0,0,0)}</style><script>alert(1)</script>', 'red;background:url(//x)', 'expression(alert(1))', '', 42, undefined])
      expect(isSafeColor(bad)).toBe(false)
    expect(safeColor('rgb(1,2,3)"><img src=x>', '#000000')).toBe('#000000')
  })

  it('never puts a caption highlight into markup unchecked', () => {
    let p = addItem(addAsset(createProject(), asset('a')), createVideoItem(asset('a'), 0))
    p = generateCaptions(p)
    const track = p.tracks.find((t) => t.kind === 'caption')!
    track.captionStyle = { ...track.captionStyle!, mode: 'karaoke', highlightColor: 'rgb(1,2,3)"><img src=x onerror=alert(1)>' }
    const html = evaluate(p, 0.3).layers.find((l) => l.text)?.text?.html ?? ''
    expect(html).toContain('<span style="color:#ffe14d">')
    expect(html).not.toContain('<img')
  })

  it('keeps a hostile project background out of the export page', () => {
    const p = { ...twoClips(), background: 'rgb(0,0,0)}</style><script>alert(1)</script>' }
    const html = compileToHyperFrames(p, { assetPath: (id) => `assets/${id}.mp4`, runtimePath: 'runtime.js', gsapPath: 'gsap.min.js', fontFaceCss: '' })
    expect(html).not.toContain('alert(1)</script>')
    expect(html).toContain('background: #000000;')
  })

  it('draws a text background from rgb() as well as hex', () => {
    expect(textBackgroundCss({ background: { color: '#336699', opacity: 0.5, radius: 4, padding: 10 } } as never)).toContain('rgba(51,102,153,0.5)')
    const css = textBackgroundCss({ background: { color: 'rgb(10,20,30)', opacity: 0.5, radius: 4, padding: 10 } } as never)
    expect(css).toContain('color-mix(in srgb, rgb(10,20,30) 50%, transparent)')
    expect(css).not.toContain('NaN')
  })
})

// ---------- timeline ops keep every piece in step ----------

/** Every separated audio clip has exactly one video, and the two start, end and play the same source range. */
function expectInSync(p: Project) {
  const items = p.tracks.flatMap((t) => t.items)
  const audio = items.filter((i): i is AudioItem => i.type === 'audio' && !!i.linkId)
  expect(audio.length).toBeGreaterThan(0)
  const span = (i: AudioItem | VideoItem) => ({ start: round(i.start, 4), end: round(itemEnd(i), 4), in: round(i.in, 4) })
  for (const a of audio) {
    const videos = items.filter((i): i is VideoItem => i.type === 'video' && i.linkId === a.linkId)
    expect(videos).toHaveLength(1)
    expect(span(a)).toEqual(span(videos[0]))
  }
  for (const v of items.filter((i): i is VideoItem => i.type === 'video' && !!i.linkId && i.freezeAt === undefined))
    expect(audio.filter((a) => a.linkId === v.linkId)).toHaveLength(1)
}

/** A 1 s clip, then a 10 s clip at 1 s whose audio is separated onto an audio track. */
function separated() {
  let p = createProject()
  p = addAsset(p, asset('x', 1))
  p = addAsset(p, asset('a'))
  p = addItem(p, createVideoItem(p.assets.x, 0))
  p = addItem(p, createVideoItem(p.assets.a, 999))
  const [first, clip] = mainTrack(p)!.items.map((i) => i.id)
  return { p: separateAudio(p, clip), first, clip }
}

const audioOf = (p: Project) => p.tracks.filter((t) => t.kind === 'audio').flatMap((t) => t.items) as AudioItem[]

describe('separated audio stays with its video (EDT-2)', () => {
  it('a split cuts the audio too, and deleting a clip before moves both halves together', () => {
    const { p: p0, first, clip } = separated()
    let p = splitItem(p0, clip, 5).project
    expectInSync(p)
    p = deleteItems(p, [first])
    expectInSync(p)
    expect(audioOf(p).map((a) => [a.start, a.duration])).toEqual([
      [0, 4],
      [4, 6],
    ])
  })

  it('splitting everything under the playhead cuts each piece once', () => {
    const { p: p0, first } = separated()
    let p = splitAt(p0, 5)
    expect(audioOf(p)).toHaveLength(2)
    p = deleteItems(p, [first])
    expectInSync(p)
  })

  it('a transcript cut takes the words out of the audio as well', () => {
    const { p: p0, clip } = separated()
    const p = cutSourceRanges(p0, clip, [{ start: 1.6, end: 2.9 }])
    expectInSync(p)
    const audio = audioOf(p)
    expect(audio.reduce((n, a) => n + a.duration, 0)).toBeCloseTo(10 - 1.3, 3)
    for (const a of audio) expect(a.in + a.duration * a.speed <= 1.6 + 1e-3 || a.in >= 2.9 - 1e-3).toBe(true)
  })

  it('cutting words from the separated audio cuts its video as well', () => {
    const { p: p0 } = separated()
    const p = cutSourceRanges(p0, audioOf(p0)[0].id, [{ start: 1.6, end: 2.9 }])
    expectInSync(p)
    expect(projectDuration(p)).toBeCloseTo(11 - 1.3, 3)
  })

  it('a transcript cut on an overlay clip closes up its audio with it', () => {
    let p = createProject()
    p = addAsset(p, asset('a'))
    p = addItem(p, createVideoItem(p.assets.a, 0))
    const v = createVideoItem(p.assets.a, 2)
    p = addItem(p, v, 'nope')
    p = separateAudio(p, v.id)
    p = cutSourceRanges(p, v.id, [{ start: 1.6, end: 2.9 }])
    expectInSync(p)
    expect(audioOf(p).reduce((n, a) => n + a.duration, 0)).toBeCloseTo(10 - 1.3, 3)
  })

  it('a freeze frame holds the picture and the rest of the audio waits for the rest of the clip', () => {
    const { p: p0, first, clip } = separated()
    let p = freezeFrame(p0, clip, 4, 2)
    expectInSync(p)
    expect(audioOf(p).map((a) => [a.start, round(itemEnd(a), 4)])).toEqual([
      [1, 4],
      [6, 13],
    ])
    p = deleteItems(p, [first])
    expectInSync(p)
  })

  it('a freeze frame on an overlay clip moves its audio too', () => {
    let p = createProject()
    p = addAsset(p, asset('a'))
    p = addItem(p, createVideoItem(p.assets.a, 0))
    const v = createVideoItem(p.assets.a, 2)
    p = addItem(p, v, 'nope')
    p = separateAudio(p, v.id)
    p = freezeFrame(p, v.id, 5, 2)
    expectInSync(p)
    expect(audioOf(p).map((a) => a.start)).toEqual([2, 7])
  })

  it("a ripple delete on the audio track leaves a clip's audio with its clip", () => {
    let p = createProject()
    p = addAsset(p, asset('x', 1))
    p = addAsset(p, asset('a'))
    p = addAsset(p, { ...asset('m', 1), kind: 'audio' })
    p = addItem(p, createVideoItem(p.assets.x, 0))
    p = addItem(p, createVideoItem(p.assets.a, 999))
    p = addItem(p, createAudioItem(p.assets.m, 0))
    p = separateAudio(p, mainTrack(p)!.items[1].id)
    const tracks = p.tracks.filter((t) => t.kind === 'audio')
    expect(tracks).toHaveLength(1) // the music and the separated audio share a track
    p = deleteItems(p, [tracks[0].items[0].id], { ripple: true })
    expectInSync(p)
  })

  it('moves the audio of a document split before this fix only once', () => {
    // older splits gave both video pieces the audio's link, and each piece moved the audio again
    let p = createProject()
    p = addAsset(p, asset('x', 1))
    p = addAsset(p, asset('a'))
    p = addItem(p, createVideoItem(p.assets.x, 0))
    p = addItem(p, createVideoItem(p.assets.x, 999))
    p = addItem(p, createVideoItem(p.assets.a, 999))
    const [first, , clip] = mainTrack(p)!.items.map((i) => i.id)
    p = clone(separateAudio(p, clip))
    const m = mainTrack(p)!
    const v = m.items[2] as VideoItem
    m.items.push({ ...clone(v), id: 'v_legacy', start: 7, duration: 5, in: 5 })
    v.duration = 5
    const audioId = audioOf(p)[0].id
    p = deleteItems(p, [first])
    expect(findItem(p, audioId)!.item.start).toBe(1)
  })
})

describe('keyframed animation survives splits and trims (EDT-7)', () => {
  const opacityAt = (p: Project, t: number) => evaluate(p, t).layers.find((l) => l.type === 'video')?.opacity ?? 0
  const times = Array.from({ length: 40 }, (_, i) => i * 0.25)
  function fadeIn() {
    let p = twoClips()
    const id = mainTrack(p)!.items[0].id
    p = setKeyframe(p, id, 'opacity', 0, 0)
    p = setKeyframe(p, id, 'opacity', 4, 1)
    return { p, id }
  }

  it('a fade-in split in the middle looks the same at every moment', () => {
    const { p, id } = fadeIn()
    expect(opacityAt(p, 1)).toBeCloseTo(0.0625, 4)
    const q = splitItem(p, id, 2).project
    for (const t of times) expect(opacityAt(q, t)).toBeCloseTo(opacityAt(p, t), 6)
  })

  it('trimming the start keeps the rest of the fade', () => {
    const { p, id } = fadeIn()
    const q = trimItem(p, id, 'start', 1) // the main track re-packs: what played at t now plays at t - 1
    for (const t of times.filter((t) => t >= 1)) expect(opacityAt(q, t - 1)).toBeCloseTo(opacityAt(p, t), 6)
  })

  it('each piece keeps only the keyframes that shape it', () => {
    let p = twoClips()
    const id = mainTrack(p)!.items[0].id
    for (let t = 0; t <= 8; t++) p = setKeyframe(p, id, 'opacity', t, t % 2)
    const { project: q, rightId } = splitItem(p, id, 4.5)
    const kfs = (i: string) => (findItem(q, i)!.item as VideoItem).keyframes.opacity!.map((k) => k.t)
    expect(kfs(id)).toEqual([0, 1, 2, 3, 4, 5])
    expect(kfs(rightId!)).toEqual([-0.5, 0.5, 1.5, 2.5, 3.5])
    for (const t of times) expect(opacityAt(q, t)).toBeCloseTo(opacityAt(p, t), 6)
  })
})
describe('reversed clips (EDT-14)', () => {
  const frameAt = (p: Project, t: number, trackId = mainTrack(p)!.id) => evaluate(p, t).layers.find((l) => l.trackId === trackId)!.mediaTime!
  const times = [0, 0.5, 1, 2, 3.9, 4, 4.1, 5, 7, 7.9, 8.5, 9.5]
  function reversed() {
    const p = twoClips()
    const id = mainTrack(p)!.items[0].id
    return { p: updateItem<VideoItem>(p, id, { reverse: true }), id }
  }

  it('show the same footage after a split', () => {
    const { p, id } = reversed()
    const { project: q, rightId } = splitItem(p, id, 4)
    for (const t of times) expect(frameAt(q, t)).toBeCloseTo(frameAt(p, t), 6)
    expect((findItem(q, id)!.item as VideoItem).in).toBe(6) // the left piece plays the later part of the source
    expect((findItem(q, rightId!)!.item as VideoItem).in).toBe(0)
  })

  it('show the same footage after trimming either end', () => {
    const { p, id } = reversed()
    const end = trimItem(p, id, 'end', 8)
    for (const t of times.filter((t) => t < 8)) expect(frameAt(end, t)).toBeCloseTo(frameAt(p, t), 6)
    const start = trimItem(p, id, 'start', 2)
    for (const t of times.filter((t) => t >= 2)) expect(frameAt(start, t - 2)).toBeCloseTo(frameAt(p, t), 6)
  })

  it('extend only as far as the source reaches', () => {
    let p = createProject()
    p = addAsset(p, asset('a'))
    p = addItem(p, createVideoItem(p.assets.a, 0))
    // plays source 0..8 backwards from 5 s: 2 s of source left after the range, none before it
    const v = createVideoItem(p.assets.a, 5, { reverse: true, duration: 8 })
    p = addItem(p, v, 'nope')
    const track = findItem(p, v.id)!.track.id
    const earlier = trimItem(p, v.id, 'start', 0)
    expect(findItem(earlier, v.id)!.item).toMatchObject({ start: 3, duration: 10, in: 0 })
    for (const t of [5, 6, 9, 12.5]) expect(frameAt(earlier, t, track)).toBeCloseTo(frameAt(p, t, track), 6)
    const later = trimItem(earlier, v.id, 'end', 30)
    expect(findItem(later, v.id)!.item.duration).toBe(10)
  })
})

describe('freeze frames and reversed clips in the transcript (EDT-17)', () => {
  function frozen() {
    const p0 = twoClips()
    const p = freezeFrame(p0, mainTrack(p0)!.items[0].id, 3, 2)
    return { p, freeze: mainTrack(p)!.items.find((i) => i.type === 'video' && i.freezeAt !== undefined)! }
  }

  it('a freeze frame has no words and gets no captions', () => {
    const { p, freeze } = frozen()
    expect(itemWords(p, freeze.id)).toEqual([])
    const caps = generateCaptions(p).tracks.find((t) => t.kind === 'caption')!.items
    expect(caps.filter((c) => c.start < 5 && itemEnd(c) > 3).map((c) => (c as CaptionItem).text)).toEqual([])
  })

  it('removing pauses leaves a freeze frame whole', () => {
    const { p, freeze } = frozen()
    const q = removeSilences(p, freeze.id)
    expect(findItem(q, freeze.id)!.item.duration).toBe(2)
    expect(projectDuration(q)).toBe(projectDuration(p))
  })

  it("puts a reversed clip's words where they are on screen", () => {
    const p0 = twoClips()
    const id = mainTrack(p0)!.items[0].id
    const p = updateItem<VideoItem>(p0, id, { reverse: true })
    const hello = itemWords(p, id).find((w) => w.w === 'hello')!
    expect([hello.start, hello.end]).toEqual([9.4, 9.8])
    const shown = evaluate(p, (hello.start + hello.end) / 2).layers[0].mediaTime!
    expect(shown).toBeGreaterThan(0.2)
    expect(shown).toBeLessThan(0.6)
  })

  it('cutting a word from a reversed clip removes the footage of that word', () => {
    const p0 = twoClips()
    const id = mainTrack(p0)!.items[0].id
    const p = cutSourceRanges(updateItem<VideoItem>(p0, id, { reverse: true }), id, [{ start: 1.1, end: 1.5 }])
    expect(projectDuration(p)).toBeCloseTo(16 - 0.4, 3)
    const frame = (t: number) => evaluate(p, t).layers[0].mediaTime!
    for (let t = 0; t < 9.6; t += 0.01) expect(frame(t) <= 1.1 + 1e-3 || frame(t) >= 1.5 - 1e-3).toBe(true)
    // still backwards from the end, jumping from 1.5 straight to 1.1
    for (const [t, m] of [[0.5, 9.5], [4, 6], [8.4, 1.6], [8.6, 1.0], [9.5, 0.1]]) expect(frame(t)).toBeCloseTo(m, 3)
  })
})
describe('export pre-roll into a transition (EDT-3)', () => {
  const opts = { assetPath: (id: string) => `assets/${id}.mp4`, reversedPath: (id: string) => `reversed/${id}.mp4`, runtimePath: 'runtime.js', gsapPath: 'gsap.min.js', fontFaceCss: '' }
  function media(html: string, id: string, tag: 'video' | 'audio') {
    const el = html.match(new RegExp(`<${tag} id="${tag[0]}-${id}"[^>]*>`))![0]
    const num = (name: string) => Number(el.match(new RegExp(` ${name}="([-\\d.]+)"`))![1])
    return { start: num('data-start'), duration: num('data-duration'), mediaStart: num('data-media-start') }
  }
  function crossfadeInto(over: Partial<VideoItem>) {
    let p = twoClips()
    const [a, b] = mainTrack(p)!.items.map((i) => i.id)
    p = updateItem<VideoItem>(p, a, { transitionOut: { type: 'crossfade', duration: 1 } })
    return { p: updateItem<VideoItem>(p, b, over), b }
  }
  /** The exported picture shows what the preview shows at every moment it is on screen. */
  function expectMatchesPreview(p: Project, id: string, sourceAt: (fileTime: number) => number) {
    const v = media(compileToHyperFrames(p, opts), id, 'video')
    for (let t = v.start; t < v.start + v.duration; t += 0.1) {
      const preview = evaluate(p, t).layers.find((l) => l.itemId === id)
      if (preview) expect(sourceAt(v.mediaStart + (t - v.start))).toBeCloseTo(preview.mediaTime!, 2)
    }
    return v
  }

  it('plays a clip that starts at its source beginning in step with its own audio', () => {
    const { p, b } = crossfadeInto({})
    const html = compileToHyperFrames(p, opts)
    const v = media(html, b, 'video')
    const a = media(html, b, 'audio')
    expect(v.mediaStart + (a.start - v.start)).toBeCloseTo(a.mediaStart, 4)
    expectMatchesPreview(p, b, (f) => f)
  })

  it('pre-rolls only as much source as the clip has before its in-point', () => {
    const short = crossfadeInto({ in: 0.2, duration: 5 })
    expect(expectMatchesPreview(short.p, short.b, (f) => f)).toMatchObject({ start: 9.8, mediaStart: 0 })
    const long = crossfadeInto({ in: 2, duration: 4 })
    expect(expectMatchesPreview(long.p, long.b, (f) => f)).toMatchObject({ start: 9.5, mediaStart: 1.5 })
  })

  it('keeps a reversed clip in step with the preview', () => {
    const { p, b } = crossfadeInto({ reverse: true })
    const clip = findItem(p, b)!.item as VideoItem
    // the reversed copy starts at the end of the clip's source range and runs backwards
    const v = expectMatchesPreview(p, b, (f) => clip.in + clip.duration * clip.speed - f)
    expect(v.start).toBe(10)
  })
})
