// The timeline: grabbing narrow clips, fades inside their clip, moving a clip with its linked audio (EDT-36).
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem, findItem, mainTrack, separateAudio, type Asset, type Project } from '@producer/core'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { useEditor } from '../store'
import { Timeline } from '../Timeline'
import { shortDuration } from '../timelineMath'

const S = () => useEditor.getState()

const video = (id: string, duration = 10): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/api/media/${id}/source`, duration, width: 1920, height: 1080, hasAudio: true })

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  // jsdom has no PointerEvent: a mouse event carries the button and position the timeline reads
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
})
afterEach(cleanup)

function load(p: Project) {
  S().load({ project: p, version: 1, projectId: 'p1', demo: true })
}

/** Render the timeline at `zoom` px per second (after its first fit to the view). */
function show(zoom = 80) {
  const r = render(<Timeline />)
  act(() => useEditor.setState({ zoom }))
  return r
}

function twoClips(): Project {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, video('a'))
  p = addAsset(p, video('b'))
  p = addItem(p, createVideoItem(p.assets.a, 0))
  return addItem(p, createVideoItem(p.assets.b, 10))
}

const clipEl = (id: string) => document.querySelector(`.tl-clip[data-item="${id}"]`) as HTMLElement

/** Drag with the pointer: down on `el`, then move and release on the window. */
function drag(el: Element, dx: number) {
  fireEvent.pointerDown(el, { button: 0, clientX: 500, clientY: 50 })
  fireEvent.pointerMove(window, { clientX: 500 + dx / 2, clientY: 50 })
  fireEvent.pointerMove(window, { clientX: 500 + dx, clientY: 50 })
  fireEvent.pointerUp(window, { clientX: 500 + dx, clientY: 50 })
}

describe('small timeline fixes (EDT-36)', () => {
  beforeEach(() => load(twoClips()))

  it('a clip length rounds as a whole: 119.6 s is 2:00, not 1:60', () => {
    expect(shortDuration(119.6)).toBe('2:00')
    expect(shortDuration(59.7)).toBe('1:00')
    expect(shortDuration(65)).toBe('1:05')
    expect(shortDuration(9.97)).toBe('10s')
    expect(shortDuration(4.24)).toBe('4.2s')
  })

  it('the trim edges leave the middle of a 14 px clip free to grab', () => {
    show(1.4) // 10 s clips at 1.4 px/s: 14 px wide
    const id = mainTrack(S().project)!.items[0].id
    const handles = [...clipEl(id).querySelectorAll<HTMLElement>('.tl-trim')]
    expect(handles).toHaveLength(2)
    const each = parseFloat(handles[0].style.width)
    expect(each * 2).toBeLessThan(14)
    // a 6 px clip has no trim edges at all: the whole clip moves
    act(() => useEditor.setState({ zoom: 0.6 }))
    expect(clipEl(id).querySelectorAll('.tl-trim')).toHaveLength(0)
  })

  it('a fade longer than a trimmed clip is drawn inside the clip', () => {
    const p = S().project
    const id = mainTrack(p)!.items[0].id
    const next = structuredClone(p)
    const it = findItem(next, id)!.item as { fadeIn: number; duration: number }
    it.fadeIn = 8
    it.duration = 2
    S().commit(next, 'Fade')
    show()
    const fade = clipEl(id).querySelector('.tl-fade.in') as HTMLElement
    expect(parseFloat(fade.style.width)).toBeLessThanOrEqual(parseFloat(clipEl(id).style.width))
  })

  it('dragging a main-track clip together with its linked audio moves both, in step', () => {
    let p = twoClips()
    const b = mainTrack(p)!.items[1].id
    p = separateAudio(p, b)
    load(p)
    const audio = p.tracks.find((t) => t.kind === 'audio')!.items[0].id
    S().select([b, audio])
    show()
    // 2 s to the right: the magnetic main track keeps b where it is, so its audio stays under it
    act(() => drag(clipEl(b), 160))
    expect(findItem(S().project, b)!.item.start).toBe(10)
    expect(findItem(S().project, audio)!.item.start).toBe(10)
    // 10 s to the left at 80 px/s: b becomes the first clip and its audio goes with it
    act(() => drag(clipEl(b), -800))
    const now = S().project
    expect(findItem(now, b)!.item.start).toBe(0)
    expect(findItem(now, audio)!.item.start).toBe(0)
  })
})
