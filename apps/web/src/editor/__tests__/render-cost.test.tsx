// What re-renders per edit, per pointer move and per frame (EDT-27), and long clips' waveforms and filmstrips (EDT-28).
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { addAsset, addItem, createAudioItem, createProject, createVideoItem, findItem, updateItem, type Asset, type Project } from '@producer/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const spies = vi.hoisted(() => ({ peaks: 0, evaluate: 0, clsx: 0 }))
vi.mock('../waveform', async (orig) => {
  const real = await orig<typeof import('../waveform')>()
  return { ...real, useWaveformPeaks: (...a: Parameters<typeof real.useWaveformPeaks>) => (spies.peaks++, real.useWaveformPeaks(...a)) }
})
vi.mock('@producer/core', async (orig) => {
  const real = await orig<typeof import('@producer/core')>()
  return { ...real, evaluate: (...a: Parameters<typeof real.evaluate>) => (spies.evaluate++, real.evaluate(...a)) }
})
vi.mock('clsx', async (orig) => {
  const real = (await orig<{ default: (...a: unknown[]) => string }>()).default
  return { default: (...a: unknown[]) => (spies.clsx++, real(...a)) }
})

import { Canvas } from '../Canvas'
import { TranscriptPanel } from '../panels/TranscriptPanel'
import { useEditor } from '../store'
import { Timeline } from '../Timeline'

const S = () => useEditor.getState()

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
  const P = HTMLMediaElement.prototype as unknown as Record<string, unknown>
  P.play = () => Promise.resolve()
  P.pause = () => {}
  P.load = () => {}
})
beforeEach(() => {
  spies.peaks = spies.evaluate = spies.clsx = 0
})
afterEach(cleanup)

const music = (id: string, duration: number): Asset => ({ id, kind: 'audio', name: `${id}.mp3`, src: `/api/media/${id}/source`, duration, waveform: Array.from({ length: Math.round(duration * 50) }, (_, i) => 0.2 + (i % 7) / 10), waveformRate: 50 })

function show(p: Project, zoom: number) {
  S().load({ project: p, version: 1, projectId: 'p1', demo: true })
  const r = render(<Timeline />)
  act(() => useEditor.setState({ zoom }))
  return r
}

describe('the timeline re-renders only what changed (EDT-27)', { timeout: 30_000 }, () => {
  function sixty() {
    let p = createProject({ id: 'p1' })
    p = addAsset(p, music('m', 600))
    for (let i = 0; i < 60; i++) p = addItem(p, createAudioItem(p.assets.m, i, { in: i, duration: 1 }), undefined)
    return p
  }

  it('an edit to one clip redraws that clip, not all sixty', () => {
    show(sixty(), 20)
    const items = S().project.tracks.flatMap((t) => t.items)
    expect(document.querySelectorAll('.tl-clip')).toHaveLength(60)
    spies.peaks = 0
    act(() => S().commit(updateItem(S().project, items[30].id, { volume: 0.5 }), 'Volume'))
    expect(spies.peaks).toBeGreaterThan(0)
    expect(spies.peaks).toBeLessThanOrEqual(2)
  })

  it('selecting a clip or moving the pointer in a drag redraws no other clip', () => {
    show(sixty(), 20)
    const items = S().project.tracks.flatMap((t) => t.items)
    spies.peaks = 0
    act(() => S().select([items[5].id]))
    expect(spies.peaks).toBeLessThanOrEqual(2)
    const el = document.querySelector(`[data-item="${items[10].id}"]`)!
    fireEvent.pointerDown(el, { button: 0, clientX: 400, clientY: 50 })
    fireEvent.pointerMove(window, { clientX: 420, clientY: 50 })
    spies.peaks = 0
    for (let x = 421; x < 460; x++) fireEvent.pointerMove(window, { clientX: x, clientY: 50 })
    expect(spies.peaks).toBe(0)
    fireEvent.pointerUp(window, { clientX: 460, clientY: 50 })
  })

  it('draws only the clips near the view', () => {
    let p = createProject({ id: 'p1' })
    p = addAsset(p, music('m', 600))
    for (let i = 0; i < 300; i++) p = addItem(p, createAudioItem(p.assets.m, i, { in: i, duration: 1 }), undefined)
    show(p, 80)
    // 300 clips over 24,000 px; the view and its margin hold a few dozen
    const drawn = document.querySelectorAll('.tl-clip').length
    expect(drawn).toBeGreaterThan(10)
    expect(drawn).toBeLessThan(60)
    const scroller = document.querySelector('.tl-scroll') as HTMLElement
    scroller.scrollLeft = 20_000
    act(() => void fireEvent.scroll(scroller))
    const last = S().project.tracks.flatMap((t) => t.items)[255]
    expect(document.querySelector(`[data-item="${last.id}"]`)).not.toBeNull()
  })
})

describe('long clips show their whole waveform and filmstrip (EDT-28)', { timeout: 30_000 }, () => {
  /** Largest x a waveform path draws a bar at. */
  const lastBar = (svg: Element | null) => Math.max(...[...(svg?.querySelector('path')?.getAttribute('d') ?? '').matchAll(/M([\d.]+) /g)].map((m) => +m[1]))

  it('a 3-minute music clip at zoom 80 has bars to its end', () => {
    let p = createProject({ id: 'p1' })
    p = addAsset(p, music('m', 180))
    p = addItem(p, createAudioItem(p.assets.m, 0, { duration: 180 }))
    show(p, 80)
    const scroller = document.querySelector('.tl-scroll') as HTMLElement
    // 14,400 px wide; scrolled to its end
    scroller.scrollLeft = 13_400
    act(() => void fireEvent.scroll(scroller))
    expect(lastBar(document.querySelector('.tl-wave'))).toBeGreaterThan(14_300)
  })

  it('a long video shows filmstrip frames at its end', () => {
    let p = createProject({ id: 'p1' })
    p = addAsset(p, { id: 'v', kind: 'video', name: 'v.mp4', src: '/api/media/v/source', duration: 600, width: 1920, height: 1080, filmstrip: { src: '/api/media/v/filmstrip', frames: 60, frameWidth: 160, frameHeight: 90 } })
    p = addItem(p, createVideoItem(p.assets.v, 0))
    show(p, 80)
    const scroller = document.querySelector('.tl-scroll') as HTMLElement
    scroller.scrollLeft = 47_000
    act(() => void fireEvent.scroll(scroller))
    const lefts = [...document.querySelectorAll<HTMLElement>('.tl-tile')].map((t) => parseFloat(t.style.left))
    expect(Math.max(...lefts)).toBeGreaterThan(47_000)
  })
})

describe('the preview overlay and the transcript during playback (EDT-27)', { timeout: 30_000 }, () => {
  it('a selected clip does not make the canvas evaluate the whole project every frame', () => {
    let p = createProject({ id: 'p1' })
    p = addAsset(p, { id: 'v', kind: 'video', name: 'v.mp4', src: '/api/media/v/source', duration: 60, width: 1920, height: 1080 })
    p = addItem(p, createVideoItem(p.assets.v, 0))
    S().load({ project: p, version: 1, projectId: 'p1', demo: true })
    S().select([p.tracks[0].items[0].id])
    render(<Canvas />)
    act(() => S().setPlaying(true))
    spies.evaluate = 0
    // a frame at a time, as the clock does
    for (let f = 1; f <= 60; f++) act(() => S().setPlayhead(f / 60))
    expect(spies.evaluate).toBeLessThanOrEqual(3)
    act(() => S().setPlaying(false))
  })

  it('the transcript marks the spoken word without re-rendering every word', () => {
    const words = Array.from({ length: 200 }, (_, i) => ({ w: `w${i}`, start: i * 0.25, end: i * 0.25 + 0.2 }))
    let p = createProject({ id: 'p1' })
    p = addAsset(p, { id: 'v', kind: 'video', name: 'v.mp4', src: '/api/media/v/source', duration: 60, hasAudio: true, transcript: { language: 'en', engine: 'x', segments: [{ start: 0, end: 50, text: '', words }] } })
    p = addItem(p, createVideoItem(p.assets.v, 0))
    S().load({ project: p, version: 1, projectId: 'p1', demo: true })
    render(<TranscriptPanel />)
    act(() => S().setPlaying(true))
    spies.clsx = 0
    for (let f = 0; f <= 48; f++) act(() => S().setPlayhead(10 + f / 60))
    expect(spies.clsx).toBe(0)
    expect(document.querySelector('.w.cur')?.textContent).toBe('w43')
    act(() => S().setPlaying(false))
    // an edit to another clip leaves the words alone
    let q = addAsset(S().project, music('m', 30))
    q = addItem(q, createAudioItem(q.assets.m, 0))
    spies.clsx = 0
    act(() => S().commit(q, 'Add music'))
    act(() => S().commit(updateItem(S().project, findItem(S().project, q.tracks.find((t) => t.kind === 'audio')!.items[0].id)!.item.id, { volume: 0.4 }), 'Volume'))
    expect(spies.clsx).toBeLessThan(20)
  })
})
