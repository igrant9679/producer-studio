// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addAsset, addItem, compileToHyperFrames, createAudioItem, createProject, createVideoItem, mainTrack, setKeyframe, updateItem, type Asset, type Project } from './index'
import { StageRenderer, followRate } from './runtime'

const asset = (id: string, duration = 10): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `${id}.mp4`, duration, width: 1920, height: 1080, hasAudio: true })

/** A 1 s crossfade into a clip that starts at its source's first frame: the whole 0.5 s pre-roll holds that frame. */
function crossfadeIntoSourceStart(): { p: Project; b: string } {
  let p = createProject()
  p = addAsset(p, asset('a'))
  p = addAsset(p, asset('b', 6))
  p = addItem(p, createVideoItem(p.assets.a, 0, { transitionOut: { type: 'crossfade', duration: 1 } }))
  p = addItem(p, createVideoItem(p.assets.b, 999, { crop: { left: 0.1, right: 0, top: 0, bottom: 0 }, background: { type: 'blur', amount: 20 } }))
  return { p, b: mainTrack(p)!.items[1].id }
}

/** jsdom has no media playback: elements keep the time and rate they are given, and play() just un-pauses. */
function fakeMedia() {
  const P = HTMLMediaElement.prototype as unknown as Record<string, unknown>
  const state = new WeakMap<HTMLMediaElement, { paused: boolean; t: number }>()
  const get = (el: HTMLMediaElement) => state.get(el) ?? (state.set(el, { paused: true, t: 0 }), state.get(el)!)
  Object.defineProperty(P, 'paused', { configurable: true, get(this: HTMLMediaElement) { return get(this).paused } })
  Object.defineProperty(P, 'currentTime', { configurable: true, get(this: HTMLMediaElement) { return get(this).t }, set(this: HTMLMediaElement, v: number) { get(this).t = v } })
  Object.defineProperty(P, 'readyState', { configurable: true, get: () => 4 })
  Object.defineProperty(P, 'seeking', { configurable: true, get: () => false })
  P.play = function (this: HTMLMediaElement) { get(this).paused = false; return Promise.resolve() }
  P.pause = function (this: HTMLMediaElement) { get(this).paused = true }
  P.load = function () {}
}

function preview(p: Project, kinds: string[] = []) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const r = new StageRenderer(root, p, { mode: 'preview', resolveUrl: (id, kind) => (kinds.push(kind), `/api/media/${id}/${kind}`) })
  return { root, r }
}

describe('preview renderer', () => {
  fakeMedia()

  it("plays a video clip's sound from its audio copy, the picture from the proxy (EDT-25)", () => {
    let p = createProject()
    p = addAsset(p, asset('a'))
    p = addItem(p, createVideoItem(p.assets.a, 0))
    const kinds: string[] = []
    const { root, r } = preview(p, kinds)
    r.setPlaying(true)
    r.render(1)
    expect(root.querySelector('video')!.getAttribute('src')).toBe('/api/media/a/proxy')
    expect(kinds).toContain('audio')
    expect(kinds).not.toContain('media')
    r.destroy()
  })

  it('keeps only the players near the playhead and makes the next ones ahead of time (EDT-9)', () => {
    let p = createProject()
    p = addAsset(p, asset('a', 600))
    // 120 one-second clips of one long file on the main track
    for (let i = 0; i < 120; i++) p = addItem(p, createVideoItem(p.assets.a, i, { in: i, duration: 1 }))
    const created: HTMLAudioElement[] = []
    const Orig = window.Audio
    window.Audio = function () { const a = new Orig(); created.push(a); return a } as unknown as typeof Audio
    try {
      const { root, r } = preview(p)
      r.setPlaying(true)
      let most = 0
      for (let t = 0; t < 120; t += 0.25) {
        r.render(t)
        const live = [...root.querySelectorAll('video')].filter((v) => v.getAttribute('src')).length
        most = Math.max(most, live)
        // the clip after next already has its player, parked on its first frame and hidden
        if (t === 50) {
          const next = mainTrack(p)!.items[52]
          const wrap = root.querySelector(`[data-ps-layer="${next.id}"]`) as HTMLElement
          expect(wrap).not.toBeNull()
          expect(wrap.style.display).toBe('none')
          expect(wrap.querySelector('video')!.currentTime).toBe(52)
        }
      }
      expect(most).toBeLessThanOrEqual(16)
      // sound players too: every clip had one at some point, but few at once
      const liveAudio = created.filter((a) => a.getAttribute('src')).length
      expect(created.length).toBeGreaterThan(100)
      expect(liveAudio).toBeLessThanOrEqual(16)
      r.destroy()
    } finally {
      window.Audio = Orig
    }
  })

  describe('buffering and drift (EDT-24)', () => {
    function talk() {
      let p = createProject()
      p = addAsset(p, asset('a', 60))
      p = addAsset(p, { id: 'm', kind: 'audio', name: 'm.mp3', src: 'm.mp3', duration: 60 })
      p = addItem(p, createVideoItem(p.assets.a, 0, { duration: 30 }))
      return addItem(p, createAudioItem(p.assets.m, 0, { duration: 30 }))
    }
    const created: HTMLAudioElement[] = []
    const Orig = window.Audio
    beforeEach(() => {
      created.length = 0
      window.Audio = function () { const a = new Orig(); created.push(a); return a } as unknown as typeof Audio
    })
    afterEach(() => {
      window.Audio = Orig
    })

    it('takes up a small drift with the playback rate and seeks only a large one', () => {
      expect(followRate(1, 0)).toBe(1)
      expect(followRate(1, 0.2)).toBeCloseTo(0.9)
      expect(followRate(1, -0.04)).toBeCloseTo(1.02)
      expect(followRate(2, 1)).toBeCloseTo(1.8)
      const { root, r } = preview(talk())
      r.setPlaying(true)
      r.render(10)
      const v = root.querySelector('video')!
      v.currentTime = 10.2 // 0.2 s ahead
      r.render(10)
      expect(v.currentTime).toBe(10.2)
      expect(v.playbackRate).toBeCloseTo(0.9)
      v.currentTime = 12 // 2 s off: seek
      r.render(10)
      expect(v.currentTime).toBe(10)
      expect(v.playbackRate).toBe(1)
      r.destroy()
    })

    it('holds the other media while one buffers, and says so', () => {
      const calls: boolean[] = []
      let p = talk()
      const root = document.createElement('div')
      const r = new StageRenderer(root, p, { mode: 'preview', resolveUrl: (id) => id, onBuffering: (b) => calls.push(b) })
      r.setPlaying(true)
      r.render(5)
      const v = root.querySelector('video')!
      const sound = created.find((a) => a.getAttribute('src') === 'm')!
      expect(sound.paused).toBe(false)
      v.dispatchEvent(new Event('waiting'))
      expect(calls).toEqual([true])
      expect(r.mediaClock()).toBeUndefined()
      r.render(5)
      expect(sound.paused).toBe(true)
      expect(v.paused).toBe(false) // the stalled one carries on loading
      v.dispatchEvent(new Event('playing'))
      expect(calls).toEqual([true, false])
      r.render(5)
      expect(sound.paused).toBe(false)
      // a clip removed while it buffers doesn't leave the preview buffering for good
      v.dispatchEvent(new Event('waiting'))
      p = { ...p, tracks: p.tracks.map((t) => ({ ...t, items: t.items.filter((i) => i.type !== 'video') })) }
      r.setProject(p)
      expect(calls.at(-1)).toBe(false)
      r.destroy()
    })

    it('reports where the playing sound is, for the transport clock to follow', () => {
      const { r } = preview(talk())
      expect(r.mediaClock()).toBeUndefined() // stopped
      r.setPlaying(true)
      r.render(3)
      // the sound has run 0.3 s ahead of the playhead
      for (const a of created) a.currentTime = 3.3
      expect(r.mediaClock()).toBeCloseTo(3.3)
      r.destroy()
    })
  })

  describe('volume above 100 % (EDT-16)', () => {
    const gains: Array<{ gain: { value: number } }> = []
    class FakeContext {
      state = 'running'
      destination = {}
      createGain() {
        const g = { gain: { value: 1 }, connect() {}, disconnect() {} }
        gains.push(g)
        return g
      }
      createMediaElementSource() {
        return { connect: (n: unknown) => n }
      }
      resume() { return Promise.resolve() }
      close() { return Promise.resolve() }
    }
    const loud = () => {
      let p = createProject()
      p = addAsset(p, { id: 'm', kind: 'audio', name: 'm.mp3', src: 'm.mp3', duration: 10 })
      return addItem(p, createAudioItem(p.assets.m, 0, { volume: 1.5 }))
    }
    afterEach(() => {
      delete (window as { AudioContext?: unknown }).AudioContext
      gains.length = 0
    })

    it('plays through a gain node at the clip level, as the export does', () => {
      ;(window as { AudioContext?: unknown }).AudioContext = FakeContext
      const { root, r } = preview(loud())
      r.render(1)
      expect(gains).toHaveLength(1)
      expect(gains[0].gain.value).toBe(1.5)
      void root
      r.destroy()
    })

    it("falls back to the element's own volume (at most 100 %) when the file can't be played through Web Audio", () => {
      ;(window as { AudioContext?: unknown }).AudioContext = FakeContext
      const created: HTMLAudioElement[] = []
      const Orig = window.Audio
      window.Audio = function () { const a = new Orig(); created.push(a); return a } as unknown as typeof Audio
      try {
        const { r } = preview(loud())
        r.render(1)
        expect(created[0].crossOrigin).toBe('anonymous')
        // the bucket doesn't answer CORS: the routed element fails and a plain one takes over
        created[0].dispatchEvent(new Event('error'))
        r.render(1.1)
        expect(created).toHaveLength(2)
        expect(created[1].crossOrigin).toBeNull()
        expect(created[1].volume).toBe(1)
        r.destroy()
      } finally {
        window.Audio = Orig
      }
    })
  })
})

describe('export volume (EDT-16)', () => {
  const lanePoints = (html: string) => JSON.parse(html.match(/data-automation='([^']+)'/)![1]).lanes[0].points as Array<{ t: number; v: number }>
  const compile = (p: Project) => compileToHyperFrames(p, { assetPath: (id) => `assets/${id}`, runtimePath: 'runtime.js', gsapPath: 'gsap.min.js', fontFaceCss: '' })
  const music = () => {
    let p = createProject()
    p = addAsset(p, { id: 'm', kind: 'audio', name: 'm.mp3', src: 'm.mp3', duration: 10 })
    return addItem(p, createAudioItem(p.assets.m, 0, { duration: 4 }))
  }

  it('a ramp from a base level of 0 is heard, at the levels its keyframes give', () => {
    let p = music()
    const id = p.tracks.find((t) => t.kind === 'audio')!.items[0].id
    p = updateItem(p, id, { volume: 0 })
    p = setKeyframe(p, id, 'volume', 0, 0, 'linear')
    p = setKeyframe(p, id, 'volume', 2, 1, 'linear')
    const pts = lanePoints(compile(p))
    expect(pts[0].v).toBe(0)
    expect(pts.find((x) => x.t === 1)!.v).toBeCloseTo(0.5, 3)
    expect(pts.at(-1)!.v).toBe(1)
  })

  it('a fade on a clip at 50 % rises to 50 %, not 100 %', () => {
    let p = music()
    const id = p.tracks.find((t) => t.kind === 'audio')!.items[0].id
    p = updateItem(p, id, { volume: 0.5, fadeIn: 1 })
    const pts = lanePoints(compile(p))
    expect(Math.max(...pts.map((x) => x.v))).toBe(0.5)
  })
})

describe('export renderer', () => {
  it("shows the held first frame until the incoming clip's file starts (PIP-5 / EDT-3)", () => {
    const { p, b } = crossfadeIntoSourceStart()
    const html = compileToHyperFrames(p, { assetPath: (id) => `assets/${id}.mp4`, holdFramePath: (id) => `stills/${id}-hold.png`, runtimePath: 'runtime.js', gsapPath: 'gsap.min.js', fontFaceCss: '' })
    document.body.innerHTML = html.slice(html.indexOf('<div id="root"'), html.indexOf('<script>\n(function'))
    const stage = document.getElementById('stage')!
    const renderer = new StageRenderer(stage, p, { mode: 'export', resolveUrl: (id) => `assets/${id}.mp4` })
    const holds = [...stage.querySelectorAll<HTMLImageElement>('[data-ps-hold]')]
    expect(holds.map((h) => h.closest('[data-ps-layer],[data-ps-bg]')!.getAttribute('data-ps-layer') ?? 'bg')).toEqual([b, 'bg'])
    const shown = () => holds.map((h) => h.style.display)
    renderer.render(9.7)
    expect(shown()).toEqual(['block', 'block'])
    expect(holds[0].style.width).toBe('100%')
    renderer.render(10.2)
    expect(shown()).toEqual(['none', 'none'])
    renderer.render(9.9)
    expect(shown()).toEqual(['block', 'block'])
  })
})
