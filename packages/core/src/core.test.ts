import { describe, expect, it } from 'vitest'
import {
  addAsset,
  addItem,
  compileToHyperFrames,
  createProject,
  createTextItem,
  createVideoItem,
  cutSourceRanges,
  deleteItems,
  evaluate,
  findItem,
  freezeFrame,
  generateCaptions,
  importSrt,
  exportSrt,
  mainTrack,
  moveItem,
  projectDuration,
  separateAudio,
  presetCanvasSize,
  setAspect,
  setCanvasSize,
  setKeyframe,
  splitItem,
  trimItem,
  updateItem,
  type Asset,
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
