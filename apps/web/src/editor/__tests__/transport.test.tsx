// Review playback (E-8): JKL shuttle, in and out points with loop, preview speed, proxy or full-quality preview.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem } from '@producer/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyTransport, startPlaybackClock } from '../playback'
import { handleKey } from '../shortcuts'
import { useEditor } from '../store'
import { TransportControls } from '../TransportControls'
import { advance, inOutRange, previewVariant, rendererTransport, useTransport, type TransportState } from '../transport'

const S = () => useEditor.getState()
const T = () => useTransport.getState()

const press = (key: string, o: Partial<KeyboardEventInit> = {}) => act(() => handleKey(new KeyboardEvent('keydown', { key, cancelable: true, ...o })))

let frames: Array<(t: number) => void> = []
let now = 0
function run(n: number) {
  for (let i = 0; i < n; i++) {
    now += 1000 / 60
    const due = frames
    frames = []
    for (const f of due) f(now)
  }
}

let stop: () => void
beforeEach(() => {
  frames = []
  now = 1000
  vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => (frames.push(f), frames.length))
  vi.stubGlobal('cancelAnimationFrame', () => (frames = []))
  let p = createProject({ id: 'p1' })
  p = addAsset(p, { id: 'a', kind: 'video', name: 'a.mp4', src: '/api/media/a/source', duration: 20 })
  p = addItem(p, createVideoItem(p.assets.a, 0))
  useTransport.setState({ shuttle: 1, speed: 1, loop: false, fullQuality: false, inPoint: undefined, outPoint: undefined })
  stop = startPlaybackClock()
  S().load({ project: p, version: 1, projectId: 'p1', demo: true })
})
afterEach(() => {
  stop()
  cleanup()
  useEditor.setState({ playing: false })
  vi.unstubAllGlobals()
})

const state = (o: Partial<TransportState>): TransportState => ({ shuttle: 1, speed: 1, loop: false, fullQuality: false, ...o })

describe('the transport clock', () => {
  it('plays at the shuttle and preview speed, backwards too, and stops at either end', () => {
    expect(advance(5, 1, 20, state({}))).toEqual({ t: 6, playing: true })
    expect(advance(5, 1, 20, state({ shuttle: 4, speed: 0.5 }))).toEqual({ t: 7, playing: true })
    expect(advance(5, 1, 20, state({ shuttle: -2 }))).toEqual({ t: 3, playing: true })
    expect(advance(0.5, 1, 20, state({ shuttle: -1 }))).toEqual({ t: 0, playing: false })
    expect(advance(19.5, 1, 20, state({}))).toEqual({ t: 20, playing: false })
  })

  it('loops in to out, forwards and backwards, and jumps in from outside it', () => {
    const loop = state({ loop: true, inPoint: 4, outPoint: 8 })
    expect(advance(7.5, 1, 20, loop).t).toBeCloseTo(4.5)
    expect(advance(4.5, 1, 20, { ...loop, shuttle: -1 }).t).toBeCloseTo(7.5)
    expect(advance(12, 0.01, 20, loop)).toEqual({ t: 4, playing: true })
    // without in and out, the whole video
    expect(advance(19.5, 1, 20, state({ loop: true })).t).toBeCloseTo(0.5)
    // only an in point: in to the end
    expect(inOutRange(state({ inPoint: 4 }), 20)).toEqual({ from: 4, to: 20 })
    expect(inOutRange(state({}), 20)).toBeUndefined()
  })

  it('runs the playhead round the loop in real time', () => {
    useTransport.setState({ loop: true, inPoint: 2, outPoint: 3 })
    act(() => S().setPlayhead(2.5))
    act(() => S().setPlaying(true))
    act(() => run(60))
    expect(S().playing).toBe(true)
    expect(S().playhead).toBeGreaterThan(2.4)
    expect(S().playhead).toBeLessThan(2.6)
  })

  it('the canvas media play forward at the rate, and hold while the playhead goes back', () => {
    expect(rendererTransport(true, state({ shuttle: 2, speed: 0.5 }))).toEqual({ playing: true, rate: 1 })
    expect(rendererTransport(true, state({ shuttle: -2 }))).toEqual({ playing: false, rate: 2 })
    const r = { setPlaying: vi.fn() }
    useTransport.setState({ speed: 1.5 })
    applyTransport(r, true)
    expect(r.setPlaying).toHaveBeenCalledWith(true, 1.5)
  })

  it('the full-quality preview asks for the original files', () => {
    expect(previewVariant('proxy', state({}))).toBe('proxy')
    expect(previewVariant('proxy', state({ fullQuality: true }))).toBe('media')
    expect(previewVariant('audio', state({ fullQuality: true }))).toBe('audio')
  })
})

describe('JKL shuttle and in and out points', () => {
  it('L plays, and again plays faster; J turns backwards; K stops at normal speed', () => {
    act(() => S().setPlayhead(5))
    press('l')
    expect([S().playing, T().shuttle]).toEqual([true, 1])
    press('l')
    press('l')
    expect(T().shuttle).toBe(4)
    press('l')
    press('l')
    expect(T().shuttle).toBe(8)
    press('j')
    expect([S().playing, T().shuttle]).toEqual([true, -1])
    press('j')
    expect(T().shuttle).toBe(-2)
    act(() => run(30))
    expect(S().playhead).toBeLessThan(5)
    press('k')
    expect([S().playing, T().shuttle]).toEqual([false, 1])
  })

  it('stopping any other way brings the next play back to normal speed', () => {
    press('l')
    press('l')
    press(' ')
    expect(S().playing).toBe(false)
    expect(T().shuttle).toBe(1)
  })

  it('I and O mark the playhead, an out before the in clears the in, Alt+X clears both', () => {
    act(() => S().setPlayhead(3))
    press('i')
    act(() => S().setPlayhead(7))
    press('o')
    expect([T().inPoint, T().outPoint]).toEqual([3, 7])
    act(() => S().setPlayhead(2))
    press('o')
    expect([T().inPoint, T().outPoint]).toEqual([undefined, 2])
    press('≈', { altKey: true, code: 'KeyX' })
    expect([T().inPoint, T().outPoint]).toEqual([undefined, undefined])
  })

  it('the keys are left alone while typing', () => {
    render(<input aria-label="Name" />)
    const box = screen.getByRole('textbox', { name: 'Name' })
    box.focus()
    window.addEventListener('keydown', handleKey)
    act(() => void fireEvent.keyDown(box, { key: 'l' }))
    act(() => void fireEvent.keyDown(box, { key: 'i' }))
    expect([S().playing, T().inPoint]).toEqual([false, undefined])
    // the same key outside the box plays
    act(() => void fireEvent.keyDown(document.body, { key: 'l' }))
    window.removeEventListener('keydown', handleKey)
    expect(S().playing).toBe(true)
  })

  it('another project starts without the last one’s in and out', () => {
    useTransport.setState({ inPoint: 1, outPoint: 2, speed: 1.5 })
    act(() => S().load({ project: createProject({ id: 'p2' }), version: 1, projectId: 'p2', demo: true }))
    expect([T().inPoint, T().outPoint, T().speed]).toEqual([undefined, undefined, 1.5])
  })
})

describe('the playback controls', () => {
  it('mark in and out, loop, speed and quality by keyboard and mouse', async () => {
    render(<TransportControls />)
    act(() => S().setPlayhead(1))
    fireEvent.click(screen.getByRole('button', { name: 'Mark in (I)' }))
    act(() => S().setPlayhead(4))
    fireEvent.click(screen.getByRole('button', { name: 'Mark out (O)' }))
    expect(inOutRange()).toEqual({ from: 1, to: 4 })
    const loop = screen.getByRole('button', { name: 'Loop playback' })
    expect(loop.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(loop)
    expect([T().loop, loop.getAttribute('aria-pressed')]).toEqual([true, 'true'])
    const menuBtn = screen.getByRole('button', { name: 'Playback speed and quality' })
    menuBtn.focus()
    fireEvent.click(menuBtn)
    const two = screen.getByRole('menuitemradio', { name: 'Speed 2×' })
    // the menu takes focus; Escape closes it and focus goes back
    expect(document.activeElement?.getAttribute('role')).toMatch(/menuitem/)
    fireEvent.click(two)
    expect(T().speed).toBe(2)
    expect(document.activeElement).toBe(menuBtn)
    fireEvent.click(menuBtn)
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Full-quality preview' }))
    expect(T().fullQuality).toBe(true)
    expect(menuBtn.textContent).toMatch(/2×.*HQ/)
    fireEvent.click(menuBtn)
    fireEvent.click(screen.getByRole('menuitem', { name: /Clear in and out/ }))
    expect(inOutRange()).toBeUndefined()
    fireEvent.click(menuBtn)
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Playback' }), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(menuBtn)
  })
})
