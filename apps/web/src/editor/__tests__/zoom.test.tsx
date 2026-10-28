// Timeline zoom (E-7): zooming by keys, buttons and Ctrl+wheel keeps the playhead where it is on screen, Shift+wheel
// scrolls sideways, Shift+Z fits the whole project.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { addAsset, addItem, createProject, createVideoItem, type Asset, type Project } from '@producer/core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useShortcuts } from '../shortcuts'
import { useEditor } from '../store'
import { Timeline } from '../Timeline'
import { HEADER_W, fitZoom, scrollForZoom } from '../timelineMath'

const S = () => useEditor.getState()
const video = (id: string, duration: number): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `/api/media/${id}/source`, duration, width: 1920, height: 1080, hasAudio: true })
const VIEW = 1000

const clientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  globalThis.PointerEvent ??= class extends MouseEvent {} as unknown as typeof PointerEvent
  // jsdom has no layout: the timeline's scroller is VIEW px wide
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return (this as HTMLElement).classList.contains('tl-scroll') ? VIEW : 0
    },
  })
})
afterAll(() => {
  if (clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', clientWidth)
})
afterEach(cleanup)

function Shortcuts() {
  useShortcuts()
  return null
}

function long(): Project {
  let p = createProject({ id: 'p1' })
  p = addAsset(p, video('a', 120))
  return addItem(p, createVideoItem(p.assets.a, 0))
}

function show() {
  S().load({ project: long(), version: 1, projectId: 'p1', demo: true })
  render(
    <>
      <Shortcuts />
      <Timeline />
    </>,
  )
  return document.querySelector('.tl-scroll') as HTMLElement
}

/** Where the playhead is drawn, px from the left of the clip area. */
const playheadOnScreen = (el: HTMLElement) => S().playhead * S().zoom - el.scrollLeft

describe('zooming around the playhead (E-7)', () => {
  it('works out the scroll that keeps the playhead in place, or brings it into the middle', () => {
    expect(scrollForZoom(10, 50, 100, 200, 800)).toBe(700) // on screen at 300 px before and after
    expect(scrollForZoom(30, 50, 100, 0, 800)).toBe(2600) // off screen (1500 px): centred
    expect(scrollForZoom(1, 50, 10, 0, 800)).toBe(0)
  })

  it('opens fitted to the project, from the start', () => {
    const el = show()
    expect(S().zoom).toBeCloseTo(fitZoom(120, VIEW - HEADER_W), 6)
    expect(el.scrollLeft).toBe(0)
  })

  it('Ctrl+= and Ctrl+-, the zoom buttons and Ctrl+wheel keep the playhead where it is on screen', () => {
    const el = show()
    act(() => useEditor.setState({ zoom: 20 }))
    act(() => {
      el.scrollLeft = 300
      S().setPlayhead(30) // drawn at 300 px
    })
    expect(playheadOnScreen(el)).toBe(300)
    fireEvent.keyDown(window, { key: '=', ctrlKey: true })
    expect(S().zoom).toBeCloseTo(28, 6)
    expect(playheadOnScreen(el)).toBeCloseTo(300, 6)
    fireEvent.click(screen.getByRole('button', { name: /^Zoom in/ }))
    expect(playheadOnScreen(el)).toBeCloseTo(300, 6)
    fireEvent.keyDown(window, { key: '-', ctrlKey: true })
    expect(playheadOnScreen(el)).toBeCloseTo(300, 6)
    fireEvent.wheel(el, { deltaY: -100, ctrlKey: true, clientX: 50 })
    expect(playheadOnScreen(el)).toBeCloseTo(300, 6)
  })

  it('Shift+wheel scrolls the timeline sideways', () => {
    const el = show()
    act(() => useEditor.setState({ zoom: 40 }))
    el.scrollLeft = 0
    fireEvent.wheel(el, { deltaY: 120, shiftKey: true })
    expect(el.scrollLeft).toBe(120)
    fireEvent.wheel(el, { deltaY: -500, shiftKey: true })
    expect(el.scrollLeft).toBe(0)
  })

  it('Shift+Z fits the whole project and goes back to the start', () => {
    const el = show()
    act(() => useEditor.setState({ zoom: 300 }))
    el.scrollLeft = 5000
    fireEvent.keyDown(window, { key: 'Z', shiftKey: true })
    expect(S().zoom).toBeCloseTo(fitZoom(120, VIEW - HEADER_W), 6)
    expect(el.scrollLeft).toBe(0)
    expect(screen.getByRole('button', { name: 'Fit timeline (Shift+Z)' })).toBeTruthy()
  })
})
