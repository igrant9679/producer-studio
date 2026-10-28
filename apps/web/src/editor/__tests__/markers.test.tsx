// Markers on the ruler and snapping to them (E-6): M adds one, the arrows and Shift+M / Alt+M jump between them, F2
// names one, Delete removes it, a clip drag snaps to it, and Detect beats marks a music clip's beats.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { addAsset, addItem, addMarker, createAudioItem, createProject, createVideoItem, findItem, type Asset, type Project } from '@producer/core'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useShortcuts } from '../shortcuts'
import { useEditor } from '../store'
import { Timeline } from '../Timeline'

const S = () => useEditor.getState()
const video = (id: string, duration = 10): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/api/media/${id}/source`, duration, width: 1920, height: 1080, hasAudio: true })

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})
afterEach(cleanup)

function Shortcuts() {
  useShortcuts()
  return null
}

function project(): Project {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, video('a', 20))
  p = addAsset(p, { id: 'm', kind: 'audio', name: 'song.mp3', src: '/api/media/m/source', duration: 30, waveformRate: 50, waveform: Array.from({ length: 1500 }, (_, k) => 0.1 + 0.8 * Math.exp(-(k % 50) / 4)) })
  p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va' }))
  return addItem(p, createAudioItem(p.assets.m, 0, { id: 'mu', duration: 8, name: 'Song' }))
}

function show(p: Project) {
  S().load({ project: p, version: 1, projectId: 'p1', demo: true })
  render(
    <>
      <Shortcuts />
      <Timeline />
    </>,
  )
  act(() => useEditor.setState({ zoom: 80, snapping: true }))
}

const marker = (name: RegExp) => screen.getByRole('button', { name })
const press = (key: string, more: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(window, { key, ...more })

describe('markers (E-6)', () => {
  it('M adds a marker at the playhead on the ruler; Shift+M and Alt+M jump between markers', () => {
    show(project())
    act(() => S().setPlayhead(2))
    press('m')
    act(() => S().setPlayhead(6))
    press('m')
    expect(S().project.markers!.map((m) => m.t)).toEqual([2, 6])
    expect(screen.getByRole('toolbar', { name: 'Markers' })).toBeTruthy()
    expect(marker(/^Marker at 00:02:00/)).toBeTruthy()
    // pressing M again where one is adds nothing
    press('m')
    expect(S().project.markers).toHaveLength(2)
    act(() => S().setPlayhead(0))
    press('M', { shiftKey: true })
    expect(S().playhead).toBe(2)
    press('M', { shiftKey: true })
    expect(S().playhead).toBe(6)
    press('m', { altKey: true })
    expect(S().playhead).toBe(2)
  })

  it('a marker by keyboard: one Tab stop, arrows jump, Alt+arrows move it, F2 names it, Delete removes it', () => {
    let p = project()
    p = addMarker(p, 3).project
    p = addMarker(p, 5).project
    show(p)
    const flags = screen.getAllByRole('button', { name: /^Marker at/ })
    expect(flags.map((f) => f.tabIndex)).toEqual([0, -1])
    act(() => flags[0].focus())
    fireEvent.keyDown(flags[0], { key: 'ArrowRight' })
    expect(S().playhead).toBe(5)
    expect(document.activeElement).toBe(screen.getAllByRole('button', { name: /^Marker at/ })[1])
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight', altKey: true, shiftKey: true })
    expect(S().project.markers!.map((m) => m.t)).toEqual([3, 6])
    fireEvent.keyDown(document.activeElement!, { key: 'F2' })
    const input = screen.getByRole('textbox', { name: 'Marker name' })
    fireEvent.change(input, { target: { value: 'Chorus' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(S().project.markers![1].name).toBe('Chorus')
    const chorus = marker(/^Chorus marker/)
    expect(document.activeElement).toBe(chorus)
    // Escape leaves the name as it was
    fireEvent.keyDown(chorus, { key: 'F2' })
    fireEvent.change(screen.getByRole('textbox', { name: 'Marker name' }), { target: { value: 'Nope' } })
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Marker name' }), { key: 'Escape' })
    expect(S().project.markers![1].name).toBe('Chorus')
    fireEvent.keyDown(marker(/^Chorus marker/), { key: 'Delete' })
    expect(S().project.markers!.map((m) => m.t)).toEqual([3])
    // the clips weren't touched by the marker's Delete
    expect(findItem(S().project, 'va')).toBeTruthy()
    expect(document.activeElement).toBe(marker(/^Marker at 00:03:00/))
  })

  it('a marker is clicked to jump to it and dragged to move it, snapping to a clip edge', () => {
    show(addMarker(project(), 3).project)
    const flag = () => marker(/^Marker at/)
    act(() => {
      fireEvent.pointerDown(flag(), { button: 0, clientX: 300, clientY: 10 })
      fireEvent.pointerUp(window, { clientX: 300, clientY: 10 })
    })
    expect(S().playhead).toBe(3)
    // 4.95 s right (396 px) lands within snapping distance of the music's end at 8 s
    act(() => {
      fireEvent.pointerDown(flag(), { button: 0, clientX: 300, clientY: 10 })
      fireEvent.pointerMove(window, { clientX: 500, clientY: 10 })
      fireEvent.pointerMove(window, { clientX: 696, clientY: 10 })
      fireEvent.pointerUp(window, { clientX: 696, clientY: 10 })
    })
    expect(S().project.markers![0].t).toBe(8)
    expect(S().history.past.filter((h) => h.label === 'Move marker')).toHaveLength(1)
  })

  it('a clip dragged near a marker snaps to it', () => {
    let p = project()
    p = addMarker(p, 4.05).project
    show(p)
    const clip = document.querySelector('.tl-clip[data-item="mu"]') as HTMLElement
    // drag the music 4 s right (320 px): its start lands on the marker at 4.05 s
    act(() => {
      fireEvent.pointerDown(clip, { button: 0, clientX: 500, clientY: 50 })
      fireEvent.pointerMove(window, { clientX: 660, clientY: 50 })
      fireEvent.pointerMove(window, { clientX: 820, clientY: 50 })
      fireEvent.pointerUp(window, { clientX: 820, clientY: 50 })
    })
    expect(findItem(S().project, 'mu')!.item.start).toBe(4.05)
  })

  it('Detect beats in the clip menu marks the music clip’s beats on the ruler', async () => {
    show(project())
    fireEvent.contextMenu(document.querySelector('.tl-clip[data-item="mu"]')!, { clientX: 100, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: /Detect beats/ }))
    await waitFor(() => expect(S().project.markers?.length).toBeGreaterThanOrEqual(7))
    expect(S().project.markers!.every((m) => m.beat)).toBe(true)
    expect(screen.getAllByRole('button', { name: /^Beat marker at/ }).length).toBe(S().project.markers!.length)
    // the timeline menu removes them again
    fireEvent.contextMenu(document.querySelector('.tl-rows')!, { clientX: 100, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: /Remove beat markers/ }))
    expect(S().project.markers).toEqual([])
  })
})
