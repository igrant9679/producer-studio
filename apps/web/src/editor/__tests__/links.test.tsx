// Linked groups on the timeline (E-1): a video and its separated audio move, trim and delete together whichever is
// grabbed, Link and Unlink from the clip menu and Ctrl+L.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addAsset, addItem, createAudioItem, createProject, createVideoItem, findItem, itemEnd, mainTrack, separateAudio, type Asset, type Project } from '@producer/core'
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

/** a (0-10) and b (10-20) on the main track; b's sound separated. */
function separated(): { p: Project; audio: string } {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, video('a'))
  p = addAsset(p, video('b'))
  p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va' }))
  p = addItem(p, createVideoItem(p.assets.b, 10, { id: 'vb' }))
  p = separateAudio(p, 'vb')
  return { p, audio: p.tracks.find((t) => t.kind === 'audio')!.items[0].id }
}

function show(p: Project) {
  S().load({ project: p, version: 1, projectId: 'p1', demo: true })
  render(
    <>
      <Shortcuts />
      <Timeline />
    </>,
  )
  act(() => useEditor.setState({ zoom: 80, snapping: false }))
}

const clipEl = (id: string) => document.querySelector(`.tl-clip[data-item="${id}"]`) as HTMLElement
const at = (id: string) => findItem(S().project, id)?.item

function drag(el: Element, dx: number) {
  fireEvent.pointerDown(el, { button: 0, clientX: 500, clientY: 50 })
  fireEvent.pointerMove(window, { clientX: 500 + dx / 2, clientY: 50 })
  fireEvent.pointerMove(window, { clientX: 500 + dx, clientY: 50 })
  fireEvent.pointerUp(window, { clientX: 500 + dx, clientY: 50 })
}

describe('linked clips on the timeline (E-1)', () => {
  it('says which clips are linked', () => {
    const { p, audio } = separated()
    show(p)
    expect(clipEl(audio).getAttribute('aria-label')).toMatch(/, linked/)
    expect(clipEl('va').getAttribute('aria-label')).not.toMatch(/linked/)
  })

  it('dragging the separated audio to the start takes its video along', () => {
    const { p, audio } = separated()
    show(p)
    act(() => drag(clipEl(audio), -800))
    expect(at('vb')!.start).toBe(0)
    expect(at(audio)!.start).toBe(0)
    expect(at('va')!.start).toBe(10)
  })

  it('the trim handle trims the video and its audio together; Alt+arrows on the audio cannot pull it out of sync', () => {
    const { p, audio } = separated()
    show(p)
    const handle = clipEl('vb').querySelector('.tl-trim.r')!
    act(() => {
      fireEvent.pointerDown(handle, { button: 0, clientX: 500, clientY: 50 })
      fireEvent.pointerMove(window, { clientX: 340, clientY: 50 })
      fireEvent.pointerUp(window, { clientX: 340, clientY: 50 })
    })
    expect(itemEnd(at('vb')!)).toBe(18)
    expect(itemEnd(at(audio)!)).toBe(18)
    act(() => clipEl(audio).focus())
    fireEvent.keyDown(clipEl(audio), { key: 'ArrowRight', altKey: true })
    expect(at(audio)!.start).toBe(at('vb')!.start)
  })

  it('Delete on the video removes its audio too', () => {
    const { p, audio } = separated()
    show(p)
    S().select(['vb'])
    act(() => clipEl('vb').focus())
    fireEvent.keyDown(clipEl('vb'), { key: 'Delete' })
    expect(at('vb')).toBeUndefined()
    expect(at(audio)).toBeUndefined()
    expect(mainTrack(S().project)!.items.map((i) => i.id)).toEqual(['va'])
  })

  it('Unlink in the clip menu frees the audio; Ctrl+L attaches a selected video and audio', () => {
    const { p, audio } = separated()
    show(p)
    fireEvent.contextMenu(clipEl(audio), { clientX: 100, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: /Unlink/ }))
    expect(at(audio)!.linkId).toBeUndefined()
    expect(at('vb')!.linkId).toBeUndefined()
    // now the audio moves on its own
    act(() => drag(clipEl(audio), 160))
    expect(at(audio)!.start).toBe(12)
    expect(at('vb')!.start).toBe(10)
    act(() => S().select(['vb', audio]))
    fireEvent.keyDown(window, { key: 'l', ctrlKey: true })
    expect(at('vb')!.linkId).toBeTruthy()
    expect(at(audio)!.linkId).toBe(at('vb')!.linkId)
    expect(S().history.past.at(-1)!.label).toBe('Link clips')
    // the menu offers Unlink on a linked selection, Link clips on two unlinked ones
    fireEvent.contextMenu(clipEl('vb'), { clientX: 100, clientY: 100 })
    expect(screen.getByRole('menuitem', { name: /Unlink/ })).toBeTruthy()
  })

  it('Link clips in the menu for two clips recorded apart', () => {
    let p = createProject({ id: 'p1' })
    p = addAsset(p, video('a'))
    p = addAsset(p, { id: 'm', kind: 'audio', name: 'take.wav', src: '/api/media/m/source', duration: 30 })
    p = addItem(p, createVideoItem(p.assets.a, 0, { id: 'va' }))
    p = addItem(p, createAudioItem(p.assets.m, 0, { id: 'au', duration: 10 }))
    show(p)
    act(() => S().select(['va', 'au']))
    fireEvent.contextMenu(clipEl('au'), { clientX: 100, clientY: 100 })
    fireEvent.click(screen.getByRole('menuitem', { name: /Link clips/ }))
    expect(at('va')!.linkId).toBe(at('au')!.linkId)
    expect(at('au')!.linkId).toBeTruthy()
  })
})
