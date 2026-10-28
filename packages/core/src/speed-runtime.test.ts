// @vitest-environment jsdom
// The preview player along a speed ramp, with the pitch toggle and a smooth slow-motion copy (E-17).
import { describe, expect, it } from 'vitest'
import { addAsset, addItem, applyRampPreset, applySmoothCopy, clipSourceAt, createProject, createVideoItem, findItem, mainTrack, setPitchShift, setSmoothJob, smoothRange, speedAt, type Asset, type Project, type VideoItem } from './index'
import { StageRenderer } from './runtime'

const video = (id: string, duration = 30): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `${id}.mp4`, duration, width: 1920, height: 1080, fps: 30, hasAudio: true })

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

function setup(): { p: Project; id: string } {
  let p = createProject()
  p = addAsset(p, video('rec'))
  p = addItem(p, createVideoItem(p.assets.rec, 0, { in: 5, duration: 8 }))
  const id = mainTrack(p)!.items[0].id
  return { p: applyRampPreset(p, id, 'hero'), id }
}

function preview(p: Project) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const voices: HTMLAudioElement[] = []
  const Orig = window.Audio
  window.Audio = function () { const a = new Orig(); voices.push(a); return a } as unknown as typeof Audio
  const r = new StageRenderer(root, p, { mode: 'preview', resolveUrl: (id, kind) => `/api/media/${id}/${kind}` })
  return { root, r, voices, done: () => ((window.Audio = Orig), r.destroy()) }
}

describe('the preview along a speed ramp (E-17)', () => {
  fakeMedia()

  it('plays the picture and the sound at the speed of each moment, from the frame the ramp reaches', () => {
    const { p, id } = setup()
    const it = findItem(p, id)!.item as VideoItem
    const { root, r, voices, done } = preview(p)
    r.setPlaying(true)
    for (const t of [0.2, it.duration * 0.4, it.duration * 0.5, it.duration * 0.9]) {
      r.render(t)
      const v = root.querySelector('video')!
      const a = voices[0]
      expect(v.playbackRate).toBeCloseTo(speedAt(it, t), 1)
      expect(a.playbackRate).toBeCloseTo(speedAt(it, t), 1)
      // a seek puts them on the frame the ramp has reached
      v.currentTime = 0
      a.currentTime = 0
      r.render(t)
      expect(v.currentTime).toBeCloseTo(clipSourceAt(it, t), 6)
      expect(a.currentTime).toBeCloseTo(clipSourceAt(it, t), 6)
      // and the transport clock reads the moment back from the sound
      expect(r.mediaClock()).toBeCloseTo(t, 6)
    }
    done()
  })

  it('keeps the pitch unless the clip is set to let it follow the speed', () => {
    const { p, id } = setup()
    const a = preview(p)
    a.r.setPlaying(true)
    a.r.render(1)
    expect(a.voices[0].preservesPitch).toBe(true)
    a.done()
    const b = preview(setPitchShift(p, id, true))
    b.r.setPlaying(true)
    b.r.render(1)
    expect(b.voices[0].preservesPitch).toBe(false)
    b.done()
  })

  it('switches the picture to the smooth copy when it arrives, on the same frame', () => {
    const { p, id } = setup()
    const it = findItem(p, id)!.item as VideoItem
    const range = smoothRange(p, it)
    const making = setSmoothJob(p, id, { ...range, fps: 100, jobId: 'jb_1' })
    const { root, r, done } = preview(making)
    r.render(2)
    expect(root.querySelector('video')!.getAttribute('src')).toBe('/api/media/rec/proxy')
    const copy: Asset = { id: 'sm1', kind: 'video', name: 'smooth', src: 'sm1.mp4', duration: range.to - range.from, fps: 100 }
    r.setProject(applySmoothCopy(making, 'jb_1', copy))
    r.render(2)
    const players = root.querySelectorAll('video')
    expect(players).toHaveLength(1)
    expect(players[0].getAttribute('src')).toBe('/api/media/sm1/proxy')
    expect(players[0].currentTime).toBeCloseTo(clipSourceAt(it, 2) - range.from, 6)
    done()
  })
})
